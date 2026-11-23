# Text Stash

Clipboard history for text, built for large copies. It's a macOS-style clipboard manager for GNOME Shell 46–50 (Ubuntu 24.04 and later) on Wayland.

On GNOME Wayland, only the compositor can watch the clipboard in the background, so this is a GNOME Shell extension rather than a standalone app.

## Install

```bash
./install.sh
```

Then log out and back in. GNOME on Wayland only picks up new extensions at login.

## Use

- **Super+Shift+V** opens the history. You can also use the clipboard icon in the top bar.
  To use **Super+V** instead, first remove it from GNOME's notification list shortcut, which still opens with Super+M:
  ```bash
  gsettings set org.gnome.shell.keybindings toggle-message-tray "['<Super>m']"
  ```
  Then set Super+V as the shortcut in Settings.
- Type to search. Large items are searched in full, straight from disk.
- **Enter** pastes into the focused app. Terminals get Ctrl+Shift+V automatically.
- **Shift+Enter** copies without pasting.
- **Ctrl+1…9** pastes that row. **Ctrl+P** pins or unpins an item. **Shift+Delete** removes it.
- The top bar menu has Pause Recording, Clear History and Settings.

## Storage

The history is saved in `~/.local/share/text-stash/`:

- `index.json` holds the metadata and the first 1 KB of each item.
- `entries/<id>.txt` holds the full text of each item. Files are private (0600).

Copying the same text again moves the existing item to the top instead of saving a duplicate. Unpinned items are deleted when they haven't been used for `retention-days`, which defaults to 14. Copies larger than `max-entry-mb` (default 64 MB) are skipped, as are copies that password managers mark as secret.

All of these options are in Settings, or you can run `gnome-extensions prefs text-stash@aydin.tech`.

## License

Copyright © 2026 Emre Aydin.

Text Stash is licensed under the GNU General Public License, version 2 or (at your option) any later version. See [LICENSE](LICENSE).
