// SPDX-FileCopyrightText: 2026 Emre Aydin
// SPDX-License-Identifier: GPL-2.0-or-later
// Persistent clipboard history.
//
// Layout on disk (~/.local/share/text-stash/):
//   index.json        metadata for every entry (id, hash, timestamps, sizes,
//                     the first HEAD_CHARS characters for preview/search)
//   entries/<id>.txt  the full text of each entry
//
// Keeping full texts in separate files means a multi-megabyte copy never has
// to live in gnome-shell's memory or be rewritten when the index changes.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

Gio._promisify(Gio.File.prototype, 'load_contents_async');
Gio._promisify(Gio.File.prototype, 'replace_contents_bytes_async', 'replace_contents_finish');
Gio._promisify(Gio.File.prototype, 'delete_async');
Gio._promisify(Gio.File.prototype, 'enumerate_children_async');
Gio._promisify(Gio.FileEnumerator.prototype, 'next_files_async');
Gio._promisify(Gio.File.prototype, 'make_directory_async');
Gio._promisify(Gio.File.prototype, 'set_attributes_async');

const INDEX_VERSION = 1;
export const HEAD_CHARS = 1024;
const PREVIEW_CHARS = 300;
const SAVE_DELAY_MS = 1000;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function countLines(text) {
    let n = 1;
    let i = -1;
    while ((i = text.indexOf('\n', i + 1)) !== -1)
        n++;
    return n;
}

function makePreview(head) {
    return head.slice(0, PREVIEW_CHARS).replace(/\s+/g, ' ').trim();
}

function newId() {
    const rand = GLib.random_int_range(0, 0x7fffffff).toString(36);
    return `${Date.now().toString(36)}-${rand}`;
}

export class HistoryStore {
    constructor() {
        this.dir = GLib.build_filenamev([GLib.get_user_data_dir(), 'text-stash']);
        this._entriesDir = GLib.build_filenamev([this.dir, 'entries']);
        this._indexFile = Gio.File.new_for_path(GLib.build_filenamev([this.dir, 'index.json']));

        this._entries = [];
        this._byHash = new Map();
        this._pendingHashes = new Set();
        this._pendingIds = new Set();
        this._loaded = false;
        this._destroyed = false;
        this._saveId = 0;
        this._saving = false;
        this._dirty = false;

        // Called (with no arguments) whenever the history changes.
        this.onChanged = null;
    }

    get loaded() {
        return this._loaded;
    }

    get size() {
        return this._entries.length;
    }

    async load() {
        await this._ensureDir(Gio.File.new_for_path(this.dir));
        await this._ensureDir(Gio.File.new_for_path(this._entriesDir));
        try {
            const [bytes] = await this._indexFile.load_contents_async(null);
            const data = JSON.parse(decoder.decode(bytes));
            if (data?.version === INDEX_VERSION && Array.isArray(data.entries)) {
                for (const e of data.entries)
                    this._insert(e);
            }
        } catch (e) {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
                logError(e, 'text-stash: could not read index, starting empty');
        }
        if (this._destroyed)
            return;
        this._loaded = true;
        this._emitChanged();
        this._removeOrphans().catch(e => logError(e, 'text-stash: orphan cleanup'));
    }

    // Newest first, pinned entries on top.
    sorted() {
        return [...this._entries].sort((a, b) =>
            (b.pinned - a.pinned) || (b.lastUsed - a.lastUsed));
    }

    // Returns true if the text was recorded (or an identical entry was bumped).
    async add(text, maxBytes) {
        if (!this._loaded || this._destroyed)
            return false;

        const hash = GLib.compute_checksum_for_string(GLib.ChecksumType.SHA256, text, -1);
        const existing = this._byHash.get(hash);
        if (existing) {
            this.touch(existing);
            return true;
        }
        if (this._pendingHashes.has(hash))
            return false;

        const bytes = encoder.encode(text);
        if (bytes.length > maxBytes)
            return false;

        const id = newId();
        this._pendingHashes.add(hash);
        this._pendingIds.add(id);
        try {
            await this._fileFor(id).replace_contents_bytes_async(
                new GLib.Bytes(bytes), null, false,
                Gio.FileCreateFlags.PRIVATE | Gio.FileCreateFlags.REPLACE_DESTINATION, null);
        } finally {
            this._pendingHashes.delete(hash);
            this._pendingIds.delete(id);
        }
        if (this._destroyed)
            return false;

        const now = Date.now();
        this._insert({
            id,
            hash,
            created: now,
            lastUsed: now,
            chars: text.length,
            lines: countLines(text),
            bytes: bytes.length,
            head: text.slice(0, HEAD_CHARS),
            pinned: false,
        });
        this._changed();
        return true;
    }

    async getText(entry) {
        if (entry.chars <= HEAD_CHARS)
            return entry.head;
        const [bytes] = await this._fileFor(entry.id).load_contents_async(null);
        return decoder.decode(bytes);
    }

    touch(entry) {
        entry.lastUsed = Date.now();
        this._changed();
    }

    setPinned(entry, pinned) {
        entry.pinned = pinned;
        this._changed();
    }

    remove(entry) {
        this._drop(entry);
        this._changed();
    }

    clear({keepPinned = true} = {}) {
        for (const e of [...this._entries]) {
            if (!(keepPinned && e.pinned))
                this._drop(e);
        }
        this._changed();
    }

    // Remove unpinned entries not used within the last `days` days.
    prune(days) {
        const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
        let removed = 0;
        for (const e of [...this._entries]) {
            if (!e.pinned && e.lastUsed < cutoff) {
                this._drop(e);
                removed++;
            }
        }
        if (removed)
            this._changed();
        return removed;
    }

    // Write any pending index change immediately (used on disable/logout).
    //
    // This is the only blocking file operation: the extension is being torn
    // down, so an async write could be cut short and lose the last second of
    // history. It only runs when a change is still waiting to be saved, and
    // writes the small index file, never the entry texts.
    destroy() {
        this._destroyed = true;
        if (this._saveId) {
            GLib.source_remove(this._saveId);
            this._saveId = 0;
            this._dirty = true;
        }
        if (this._dirty && this._loaded) {
            try {
                this._indexFile.replace_contents(this._serialize(), null, false,
                    Gio.FileCreateFlags.PRIVATE | Gio.FileCreateFlags.REPLACE_DESTINATION, null);
            } catch (e) {
                logError(e, 'text-stash: final save failed');
            }
        }
        this.onChanged = null;
    }

    // Create a private (0700) directory unless it already exists.
    async _ensureDir(dir) {
        try {
            await dir.make_directory_async(GLib.PRIORITY_DEFAULT, null);
        } catch (e) {
            if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS))
                return;
            throw e;
        }
        const info = new Gio.FileInfo();
        info.set_attribute_uint32('unix::mode', 0o700);
        await dir.set_attributes_async(info, Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, null);
    }

    _fileFor(id) {
        return Gio.File.new_for_path(GLib.build_filenamev([this._entriesDir, `${id}.txt`]));
    }

    _insert(e) {
        if (!e?.id || !e.hash || this._byHash.has(e.hash))
            return;
        e.head ??= '';
        e.preview = makePreview(e.head);
        e.headLower = e.head.toLowerCase();
        this._entries.push(e);
        this._byHash.set(e.hash, e);
    }

    _drop(e) {
        const i = this._entries.indexOf(e);
        if (i === -1)
            return;
        this._entries.splice(i, 1);
        this._byHash.delete(e.hash);
        this._fileFor(e.id).delete_async(GLib.PRIORITY_LOW, null).catch(() => {});
    }

    _changed() {
        this._dirty = true;
        if (!this._saveId && !this._destroyed) {
            this._saveId = GLib.timeout_add(GLib.PRIORITY_LOW, SAVE_DELAY_MS, () => {
                this._saveId = 0;
                this._save().catch(e => logError(e, 'text-stash: save failed'));
                return GLib.SOURCE_REMOVE;
            });
        }
        this._emitChanged();
    }

    _emitChanged() {
        try {
            this.onChanged?.();
        } catch (e) {
            logError(e);
        }
    }

    _serialize() {
        const entries = this._entries.map(e => ({
            id: e.id,
            hash: e.hash,
            created: e.created,
            lastUsed: e.lastUsed,
            chars: e.chars,
            lines: e.lines,
            bytes: e.bytes,
            head: e.head,
            pinned: e.pinned,
        }));
        return encoder.encode(JSON.stringify({version: INDEX_VERSION, entries}));
    }

    async _save() {
        if (this._saving || this._destroyed)
            return;
        this._saving = true;
        try {
            while (this._dirty && !this._destroyed) {
                this._dirty = false;
                // Gio writes to a temp file and renames, so the index is never half-written.
                await this._indexFile.replace_contents_bytes_async(
                    new GLib.Bytes(this._serialize()), null, false,
                    Gio.FileCreateFlags.PRIVATE | Gio.FileCreateFlags.REPLACE_DESTINATION, null);
            }
        } finally {
            this._saving = false;
        }
    }

    // Delete entry files that the index doesn't know about (e.g. after a crash).
    async _removeOrphans() {
        const known = new Set(this._entries.map(e => `${e.id}.txt`));
        const dir = Gio.File.new_for_path(this._entriesDir);
        const enumerator = await dir.enumerate_children_async('standard::name',
            Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_LOW, null);
        for (;;) {
            const infos = await enumerator.next_files_async(100, GLib.PRIORITY_LOW, null);
            if (!infos.length || this._destroyed)
                break;
            for (const info of infos) {
                const name = info.get_name();
                const id = name.replace(/\.txt$/, '');
                if (!known.has(name) && !this._pendingIds.has(id) &&
                    !this._entries.some(e => e.id === id))
                    dir.get_child(name).delete_async(GLib.PRIORITY_LOW, null).catch(() => {});
            }
        }
        enumerator.close(null);
    }
}
