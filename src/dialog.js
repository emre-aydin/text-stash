// SPDX-FileCopyrightText: 2026 Emre Aydin
// SPDX-License-Identifier: GPL-2.0-or-later
// The history popup: search field, list of entries, and a preview pane.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as Config from 'resource:///org/gnome/shell/misc/config.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';

import {HEAD_CHARS} from './store.js';

const SHELL_MAJOR = parseInt(Config.PACKAGE_VERSION.split('.')[0], 10);

// St.BoxLayout gained `orientation` in GNOME 48; older versions only have `vertical`.
const VERTICAL = SHELL_MAJOR >= 48
    ? {orientation: Clutter.Orientation.VERTICAL}
    : {vertical: true};

const MAX_ROWS = 200;
const PREVIEW_MAX_CHARS = 20000;
const FILTER_DELAY_MS = 80;

function formatAge(ms) {
    const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (s < 60)
        return 'just now';
    const m = Math.round(s / 60);
    if (m < 60)
        return `${m} min ago`;
    const h = Math.round(m / 60);
    if (h < 24)
        return `${h} h ago`;
    const d = GLib.DateTime.new_from_unix_local(Math.floor(ms / 1000));
    const days = Math.round(h / 24);
    if (days < 7)
        return d.format('%a %H:%M');
    return d.format('%b %e, %H:%M');
}

function formatSize(entry) {
    const parts = [];
    if (entry.bytes >= 1024 * 1024)
        parts.push(`${(entry.bytes / (1024 * 1024)).toFixed(1)} MB`);
    else if (entry.bytes >= 1024)
        parts.push(`${(entry.bytes / 1024).toFixed(1)} KB`);
    else
        parts.push(`${entry.chars} chars`);
    if (entry.lines > 1)
        parts.push(`${entry.lines.toLocaleString()} lines`);
    return parts.join(' · ');
}

export const HistoryDialog = GObject.registerClass(
class HistoryDialog extends ModalDialog.ModalDialog {
    _init(store, settings, onActivate) {
        super._init({styleClass: 'tch-dialog', destroyOnClose: false});
        // The system accent colour only exists in the shell theme from GNOME 47 on.
        this.dialogLayout.add_style_class_name(SHELL_MAJOR >= 47 ? 'tch-accent' : 'tch-no-accent');

        this._store = store;
        this._settings = settings;
        this._onActivate = onActivate;
        this._results = [];
        this._selected = 0;
        this._rows = [];
        this._filterId = 0;
        this._searchToken = 0;
        this._previewToken = 0;

        this._entry = new St.Entry({
            style_class: 'tch-search',
            hint_text: 'Search clipboard history…',
            can_focus: true,
            x_expand: true,
        });
        this._entry.clutter_text.connect('text-changed', () => this._scheduleFilter());
        this._entry.clutter_text.connect('key-press-event', (_a, event) => this._onKey(event));

        this._list = new St.BoxLayout({
            ...VERTICAL,
            style_class: 'tch-list',
            x_expand: true,
        });
        this._listScroll = new St.ScrollView({
            style_class: 'tch-list-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            child: this._list,
        });

        this._previewMeta = new St.Label({style_class: 'tch-preview-meta'});
        this._previewText = new St.Label({style_class: 'tch-preview-text', x_expand: true});
        const ct = this._previewText.clutter_text;
        ct.line_wrap = true;
        ct.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        ct.ellipsize = Pango.EllipsizeMode.NONE;
        const previewBox = new St.BoxLayout({
            ...VERTICAL,
            x_expand: true,
        });
        previewBox.add_child(this._previewText);
        this._previewScroll = new St.ScrollView({
            style_class: 'tch-preview-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            y_expand: true,
            child: previewBox,
        });
        const previewPane = new St.BoxLayout({
            ...VERTICAL,
            style_class: 'tch-preview',
        });
        previewPane.add_child(this._previewMeta);
        previewPane.add_child(this._previewScroll);

        const body = new St.BoxLayout({style_class: 'tch-body', x_expand: true, y_expand: true});
        body.add_child(this._listScroll);
        body.add_child(previewPane);

        this._status = new St.Label({style_class: 'tch-footer'});

        this.contentLayout.add_child(this._entry);
        this.contentLayout.add_child(body);
        this.contentLayout.add_child(this._status);
        this.buttonLayout?.hide();

        this.setInitialKeyFocus(this._entry);

        // Click outside the dialog closes it.
        this.connect('button-press-event', (_a, event) => {
            const target = global.stage.get_event_actor(event);
            if (target && !this.dialogLayout.contains(target)) {
                this.close();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
    }

    open() {
        this._entry.text = '';
        this._applyFilter();
        return super.open();
    }

    close() {
        this._searchToken++;
        this._previewToken++;
        super.close();
    }

    // Called by the extension when the history changes while we're open.
    refresh() {
        if (this.state === ModalDialog.State.OPENED || this.state === ModalDialog.State.OPENING)
            this._applyFilter(true);
    }

    _scheduleFilter() {
        if (this._filterId)
            GLib.source_remove(this._filterId);
        this._filterId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, FILTER_DELAY_MS, () => {
            this._filterId = 0;
            this._applyFilter();
            return GLib.SOURCE_REMOVE;
        });
    }

    _terms() {
        return this._entry.text.toLowerCase().split(/\s+/).filter(t => t.length);
    }

    _applyFilter(keepSelection = false) {
        const previous = keepSelection ? this._results[this._selected] : null;
        const terms = this._terms();
        const all = this._store.sorted();
        const token = ++this._searchToken;

        if (!terms.length) {
            this._results = all;
        } else {
            const matched = new Set();
            const deep = [];
            for (const e of all) {
                if (terms.every(t => e.headLower.includes(t)))
                    matched.add(e);
                else if (e.chars > HEAD_CHARS)
                    deep.push(e);
            }
            this._results = all.filter(e => matched.has(e));
            if (deep.length)
                this._deepSearch(token, terms, all, matched, deep).catch(logError);
        }

        const idx = previous ? this._results.indexOf(previous) : -1;
        if (idx >= 0)
            this._selected = idx;
        else if (!keepSelection)
            this._selected = 0;
        this._render();
    }

    // Large entries only keep their first HEAD_CHARS characters in memory,
    // so look through the full files on disk for the rest.
    async _deepSearch(token, terms, all, matched, candidates) {
        this._searching = true;
        this._updateStatus();
        let found = false;
        for (const e of candidates) {
            let text;
            try {
                text = await this._store.getText(e); // eslint-disable-line no-await-in-loop
            } catch {
                continue;
            }
            if (token !== this._searchToken)
                return;
            const lower = text.toLowerCase();
            if (terms.every(t => lower.includes(t))) {
                matched.add(e);
                found = true;
            }
        }
        this._searching = false;
        if (found) {
            const previous = this._results[this._selected];
            this._results = all.filter(e => matched.has(e));
            const idx = this._results.indexOf(previous);
            this._selected = idx >= 0 ? idx : 0;
            this._render();
        } else {
            this._updateStatus();
        }
    }

    _render() {
        this._list.destroy_all_children();
        this._rows = [];
        const shown = this._results.slice(0, MAX_ROWS);
        shown.forEach((entry, i) => {
            const row = this._makeRow(entry, i);
            this._rows.push(row);
            this._list.add_child(row);
        });

        if (!shown.length) {
            this._list.add_child(new St.Label({
                style_class: 'tch-empty',
                text: this._store.size ? 'No matches' : 'Nothing copied yet',
            }));
        }
        this._updateStatus();
        this._select(this._selected);
    }

    _updateStatus() {
        const total = this._results.length;
        let text = total > MAX_ROWS
            ? `Showing ${MAX_ROWS} of ${total} — type to narrow down`
            : `${total} item${total === 1 ? '' : 's'}`;
        if (this._searching)
            text += ' · searching large items…';
        const paste = this._settings.get_boolean('paste-on-select');
        text += `   ⏎ ${paste ? 'paste' : 'copy'}   ⇧⏎ ${paste ? 'copy only' : 'paste'}   Ctrl+P pin   ⇧Del delete   Esc close`;
        this._status.text = text;
    }

    _makeRow(entry, index) {
        const row = new St.Button({
            style_class: 'tch-row',
            x_expand: true,
            can_focus: false,
            reactive: true,
            track_hover: true,
        });
        const box = new St.BoxLayout({x_expand: true});
        const textBox = new St.BoxLayout({
            ...VERTICAL,
            x_expand: true,
        });
        const title = new St.Label({
            style_class: 'tch-row-title',
            text: entry.preview || '(whitespace)',
            x_expand: true,
        });
        title.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        const meta = new St.Label({
            style_class: 'tch-row-meta',
            text: `${entry.pinned ? '📌 ' : ''}${formatAge(entry.lastUsed)} · ${formatSize(entry)}`,
        });
        textBox.add_child(title);
        textBox.add_child(meta);
        box.add_child(textBox);
        if (index < 9) {
            box.add_child(new St.Label({
                style_class: 'tch-row-key',
                text: `Ctrl+${index + 1}`,
                y_align: Clutter.ActorAlign.CENTER,
            }));
        }
        row.child = box;
        row.connect('clicked', () => {
            this._select(index);
            this._activate(false);
        });
        return row;
    }

    _select(index) {
        if (!this._results.length) {
            this._selected = 0;
            this._showPreview(null);
            return;
        }
        index = Math.max(0, Math.min(index, Math.min(this._results.length, MAX_ROWS) - 1));
        this._rows[this._selected]?.remove_style_pseudo_class('selected');
        this._selected = index;
        const row = this._rows[index];
        if (row) {
            row.add_style_pseudo_class('selected');
            this._scrollTo(row);
        }
        this._showPreview(this._results[index]);
    }

    _scrollTo(row) {
        const adj = this._listScroll.vadjustment;
        if (!adj)
            return;
        const box = row.get_allocation_box();
        if (box.y2 === 0 && box.y1 === 0) {
            // Not allocated yet; try again after layout.
            let id = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                id = 0;
                if (this._rows.includes(row) && row.has_allocation())
                    this._scrollTo(row);
                return GLib.SOURCE_REMOVE;
            });
            row.connect('destroy', () => {
                if (id)
                    GLib.source_remove(id);
            });
            return;
        }
        if (box.y1 < adj.value)
            adj.value = box.y1;
        else if (box.y2 > adj.value + adj.page_size)
            adj.value = box.y2 - adj.page_size;
    }

    async _showPreview(entry) {
        const token = ++this._previewToken;
        this._previewScroll.vadjustment.value = 0;
        if (!entry) {
            this._previewMeta.text = '';
            this._previewText.text = '';
            return;
        }
        this._previewMeta.text = [
            entry.pinned ? 'Pinned' : null,
            `Copied ${formatAge(entry.created)}`,
            entry.lastUsed !== entry.created ? `last used ${formatAge(entry.lastUsed)}` : null,
            `${entry.chars.toLocaleString()} chars`,
            entry.lines > 1 ? `${entry.lines.toLocaleString()} lines` : null,
        ].filter(Boolean).join(' · ');

        this._previewText.text = entry.head;
        if (entry.chars <= HEAD_CHARS)
            return;
        this._previewText.text = `${entry.head}…`;
        try {
            const text = await this._store.getText(entry);
            if (token !== this._previewToken)
                return;
            this._previewText.text = text.length > PREVIEW_MAX_CHARS
                ? `${text.slice(0, PREVIEW_MAX_CHARS)}\n\n… ${(text.length - PREVIEW_MAX_CHARS).toLocaleString()} more characters`
                : text;
        } catch (e) {
            if (token === this._previewToken)
                this._previewText.text = `${entry.head}\n\n(could not load full text: ${e.message})`;
        }
    }

    _activate(invert) {
        const entry = this._results[this._selected];
        if (!entry)
            return;
        let paste = this._settings.get_boolean('paste-on-select');
        if (invert)
            paste = !paste;
        this.close();
        this._onActivate(entry, paste);
    }

    _onKey(event) {
        const sym = event.get_key_symbol();
        const state = event.get_state();
        const ctrl = (state & Clutter.ModifierType.CONTROL_MASK) !== 0;
        const shift = (state & Clutter.ModifierType.SHIFT_MASK) !== 0;

        switch (sym) {
        case Clutter.KEY_Escape:
            this.close();
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Up:
        case Clutter.KEY_KP_Up:
            this._select(this._selected - 1);
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Down:
        case Clutter.KEY_KP_Down:
            this._select(this._selected + 1);
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Page_Up:
            this._select(this._selected - 8);
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Page_Down:
            this._select(this._selected + 8);
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Return:
        case Clutter.KEY_KP_Enter:
        case Clutter.KEY_ISO_Enter:
            this._activate(shift);
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Delete:
        case Clutter.KEY_KP_Delete:
            if (shift) {
                const entry = this._results[this._selected];
                if (entry)
                    this._store.remove(entry); // triggers refresh()
                return Clutter.EVENT_STOP;
            }
            break;
        }

        if (ctrl) {
            if (sym === Clutter.KEY_p || sym === Clutter.KEY_P) {
                const entry = this._results[this._selected];
                if (entry)
                    this._store.setPinned(entry, !entry.pinned);
                return Clutter.EVENT_STOP;
            }
            if (sym === Clutter.KEY_Home) {
                this._select(0);
                return Clutter.EVENT_STOP;
            }
            if (sym === Clutter.KEY_End) {
                this._select(this._results.length - 1);
                return Clutter.EVENT_STOP;
            }
            const digit = sym - Clutter.KEY_1;
            if (digit >= 0 && digit < 9) {
                if (digit < this._results.length) {
                    this._selected = digit;
                    this._activate(shift);
                }
                return Clutter.EVENT_STOP;
            }
        }
        return Clutter.EVENT_PROPAGATE;
    }

    destroy() {
        if (this._filterId) {
            GLib.source_remove(this._filterId);
            this._filterId = 0;
        }
        this._searchToken++;
        this._previewToken++;
        super.destroy();
    }
});
