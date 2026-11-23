#!/usr/bin/env bash
# Install (or update) the Text Stash GNOME Shell extension for the current user.
set -euo pipefail

UUID="text-stash@aydin.tech"
SRC="$(cd "$(dirname "$0")" && pwd)/$UUID"
DEST="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/$UUID"

mkdir -p "$DEST"
rm -rf "${DEST:?}"/*
cp -r "$SRC"/. "$DEST"/
glib-compile-schemas "$DEST/schemas"
echo "Installed to $DEST"

if gnome-extensions info "$UUID" >/dev/null 2>&1; then
    gnome-extensions enable "$UUID"
    echo "Enabled. If it was already running, log out and back in to load the new version."
else
    gsettings set org.gnome.shell enabled-extensions \
        "$(python3 - "$UUID" <<'EOF'
import ast, subprocess, sys
cur = ast.literal_eval(subprocess.check_output(
    ['gsettings', 'get', 'org.gnome.shell', 'enabled-extensions'], text=True).replace('@as ', ''))
if sys.argv[1] not in cur:
    cur.append(sys.argv[1])
print(cur)
EOF
)"
    echo "Marked as enabled. GNOME Shell on Wayland only discovers new extensions at login:"
    echo "log out and back in, then press Super+Shift+V."
fi
