// SPDX-FileCopyrightText: 2026 Emre Aydin
// SPDX-License-Identifier: GPL-2.0-or-later
import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class TextStashPrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window._settings = settings;

        const page = new Adw.PreferencesPage();
        window.add(page);

        // History
        const history = new Adw.PreferencesGroup({title: 'History'});
        page.add(history);

        const retention = new Adw.SpinRow({
            title: 'Keep history for (days)',
            subtitle: 'Unpinned items not used within this period are deleted',
            adjustment: new Gtk.Adjustment({lower: 1, upper: 3650, step_increment: 1, page_increment: 7}),
        });
        settings.bind('retention-days', retention, 'value', Gio.SettingsBindFlags.DEFAULT);
        history.add(retention);

        const maxSize = new Adw.SpinRow({
            title: 'Largest item to save (MB)',
            subtitle: 'Bigger copies are not recorded',
            adjustment: new Gtk.Adjustment({lower: 1, upper: 512, step_increment: 1, page_increment: 16}),
        });
        settings.bind('max-entry-mb', maxSize, 'value', Gio.SettingsBindFlags.DEFAULT);
        history.add(maxSize);

        const skip = new Adw.SwitchRow({
            title: 'Ignore password manager copies',
            subtitle: 'Skips copies marked as secret (KeePassXC, Bitwarden, …)',
        });
        settings.bind('skip-password-hints', skip, 'active', Gio.SettingsBindFlags.DEFAULT);
        history.add(skip);

        const paused = new Adw.SwitchRow({title: 'Pause recording'});
        settings.bind('paused', paused, 'active', Gio.SettingsBindFlags.DEFAULT);
        history.add(paused);

        const dir = GLib.build_filenamev([GLib.get_user_data_dir(), 'text-stash']);
        history.add(new Adw.ActionRow({title: 'Stored in', subtitle: dir, subtitle_selectable: true}));

        // Behaviour
        const behaviour = new Adw.PreferencesGroup({title: 'Behaviour'});
        page.add(behaviour);

        const paste = new Adw.SwitchRow({
            title: 'Paste after choosing an item',
            subtitle: 'Off: only copy it. Shift+Enter always does the opposite',
        });
        settings.bind('paste-on-select', paste, 'active', Gio.SettingsBindFlags.DEFAULT);
        behaviour.add(paste);

        const indicator = new Adw.SwitchRow({title: 'Show top bar icon'});
        settings.bind('show-indicator', indicator, 'active', Gio.SettingsBindFlags.DEFAULT);
        behaviour.add(indicator);

        const shortcut = new Adw.EntryRow({
            title: 'Shortcut, e.g. <Super><Shift>v (empty for none)',
            use_markup: false,
            show_apply_button: true,
            text: settings.get_strv('toggle-history')[0] ?? '',
        });
        shortcut.connect('apply', () => {
            const accel = shortcut.text.trim();
            if (!accel) {
                settings.set_strv('toggle-history', []);
                shortcut.remove_css_class('error');
                return;
            }
            const [ok] = Gtk.accelerator_parse(accel);
            if (ok) {
                settings.set_strv('toggle-history', [accel]);
                shortcut.remove_css_class('error');
            } else {
                shortcut.add_css_class('error');
            }
        });
        behaviour.add(shortcut);
    }
}
