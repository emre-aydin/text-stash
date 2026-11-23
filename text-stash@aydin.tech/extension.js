// SPDX-FileCopyrightText: 2026 Emre Aydin
// SPDX-License-Identifier: GPL-2.0-or-later
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {HistoryStore} from './store.js';
import {HistoryDialog} from './dialog.js';

const PRUNE_INTERVAL_S = 60 * 60;
const PASTE_DELAY_MS = 120;
const PASSWORD_HINT_MIME = 'x-kde-passwordManagerHint';
const TERMINAL_RE = /term|kitty|alacritty|wezterm|foot|konsole|tilix|ptyxis|ghostty|console|xterm|terminator|guake|tilda|warp/i;

const Indicator = GObject.registerClass(
class Indicator extends PanelMenu.Button {
    _init(ext) {
        super._init(0.0, 'Text Stash');
        this.add_child(new St.Icon({
            icon_name: 'edit-paste-symbolic',
            style_class: 'system-status-icon',
        }));

        const open = new PopupMenu.PopupMenuItem('Show History');
        open.connect('activate', () => ext.openDialog());
        this.menu.addMenuItem(open);

        this._pause = new PopupMenu.PopupSwitchMenuItem('Pause Recording',
            ext.settings.get_boolean('paused'));
        this._pause.connect('toggled', (_item, state) => ext.settings.set_boolean('paused', state));
        this.menu.addMenuItem(this._pause);

        const clear = new PopupMenu.PopupMenuItem('Clear History (keeps pinned)');
        clear.connect('activate', () => ext.store.clear({keepPinned: true}));
        this.menu.addMenuItem(clear);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        const prefs = new PopupMenu.PopupMenuItem('Settings');
        prefs.connect('activate', () => ext.openPreferences());
        this.menu.addMenuItem(prefs);

        this._settingsId = ext.settings.connect('changed::paused', () => {
            const paused = ext.settings.get_boolean('paused');
            this._pause.setToggleState(paused);
            this.opacity = paused ? 128 : 255;
        });
        this.opacity = ext.settings.get_boolean('paused') ? 128 : 255;
        this._settings = ext.settings;
    }

    destroy() {
        this._settings.disconnect(this._settingsId);
        super.destroy();
    }
});

export default class TextStash extends Extension {
    enable() {
        this.settings = this.getSettings();
        this.store = new HistoryStore();
        this._clipboard = St.Clipboard.get_default();
        this._timeouts = new Set();

        const seat = Clutter.get_default_backend().get_default_seat();
        this._keyboard = seat.create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);

        this._dialog = new HistoryDialog(this.store, this.settings,
            (entry, paste) => this._activate(entry, paste).catch(logError));
        this.store.onChanged = () => this._dialog?.refresh();

        this.store.load()
            .then(() => this._prune())
            .catch(e => logError(e, 'text-stash: load failed'));

        this._selection = global.display.get_selection();
        this._ownerChangedId = this._selection.connect('owner-changed',
            (_sel, type, source) => this._onOwnerChanged(type, source));

        Main.wm.addKeybinding('toggle-history', this.settings,
            Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
            () => this.toggleDialog());

        this._pruneId = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, PRUNE_INTERVAL_S, () => {
            this._prune();
            return GLib.SOURCE_CONTINUE;
        });

        this._settingsIds = [
            this.settings.connect('changed::retention-days', () => this._prune()),
            this.settings.connect('changed::show-indicator', () => this._syncIndicator()),
        ];
        this._syncIndicator();
    }

    disable() {
        for (const id of this._settingsIds)
            this.settings.disconnect(id);
        this._settingsIds = null;

        Main.wm.removeKeybinding('toggle-history');
        this._selection.disconnect(this._ownerChangedId);
        this._selection = null;

        GLib.source_remove(this._pruneId);
        for (const id of this._timeouts)
            GLib.source_remove(id);
        this._timeouts = null;

        this._indicator?.destroy();
        this._indicator = null;
        this._dialog.destroy();
        this._dialog = null;
        this.store.destroy();
        this.store = null;
        this._keyboard = null;
        this._clipboard = null;
        this.settings = null;
    }

    openDialog() {
        if (!this.store.loaded)
            return;
        this._dialog.open();
    }

    toggleDialog() {
        const {state} = this._dialog;
        if (state === ModalDialog.State.OPENED || state === ModalDialog.State.OPENING)
            this._dialog.close();
        else
            this.openDialog();
    }

    _syncIndicator() {
        const want = this.settings.get_boolean('show-indicator');
        if (want && !this._indicator) {
            this._indicator = new Indicator(this);
            Main.panel.addToStatusArea(this.uuid, this._indicator);
        } else if (!want && this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }
    }

    _prune() {
        this.store?.prune(this.settings.get_int('retention-days'));
    }

    _onOwnerChanged(type, source) {
        if (type !== Meta.SelectionType.SELECTION_CLIPBOARD || !source)
            return;
        if (this.settings.get_boolean('paused'))
            return;

        const mimes = source.get_mimetypes();
        if (this.settings.get_boolean('skip-password-hints') && mimes.includes(PASSWORD_HINT_MIME))
            return;
        const hasText = mimes.some(m =>
            m.startsWith('text/plain') || m === 'UTF8_STRING' || m === 'STRING' || m === 'TEXT');
        if (!hasText)
            return;

        this._clipboard.get_text(St.ClipboardType.CLIPBOARD, (_cb, text) => {
            if (!text || !this.store || !text.trim())
                return;
            const maxBytes = this.settings.get_int('max-entry-mb') * 1024 * 1024;
            this.store.add(text, maxBytes).catch(e =>
                logError(e, 'text-stash: could not save entry'));
        });
    }

    async _activate(entry, paste) {
        const text = await this.store.getText(entry);
        if (!this.store)
            return;
        // This also fires owner-changed, which bumps the entry to the top.
        this._clipboard.set_text(St.ClipboardType.CLIPBOARD, text);
        this.store.touch(entry);
        if (!paste)
            return;
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, PASTE_DELAY_MS, () => {
            this._timeouts?.delete(id);
            this._sendPaste();
            return GLib.SOURCE_REMOVE;
        });
        this._timeouts.add(id);
    }

    _sendPaste() {
        if (!this._keyboard)
            return;
        const win = global.display.focus_window;
        const ident = `${win?.get_wm_class() ?? ''} ${win?.get_gtk_application_id() ?? ''}`;
        const terminal = TERMINAL_RE.test(ident);

        const kb = this._keyboard;
        const t = GLib.get_monotonic_time();
        const press = k => kb.notify_keyval(t, k, Clutter.KeyState.PRESSED);
        const release = k => kb.notify_keyval(t, k, Clutter.KeyState.RELEASED);

        press(Clutter.KEY_Control_L);
        if (terminal)
            press(Clutter.KEY_Shift_L);
        press(Clutter.KEY_v);
        release(Clutter.KEY_v);
        if (terminal)
            release(Clutter.KEY_Shift_L);
        release(Clutter.KEY_Control_L);
    }
}
