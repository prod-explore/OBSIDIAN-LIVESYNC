import * as crypto from 'crypto';

/** The fields whose content is synced; a change in any of them is a change the other side has to hear about. */
export interface Hashable {
  title?: string;
  status?: string;
  due?: string;
  start?: string;
  end?: string;
  description?: string;
}

/** What `isLocallyModified` needs from a note on top of the synced fields. */
export interface HashState extends Hashable {
  sync_hash?: string;
  synced_at?: string;
}

/**
 * A hash of the synced fields, stored in the note as `sync_hash` when the sync writes it. A change of content is
 * then detected from the content itself, not from the file time, which LiveSync changes without an edit.
 * MD5 is enough: the hash detects edits, it does not defend against anyone.
 */
export function computeSyncHash(note: Hashable): string {
  const payload = {
    title: note.title || '',
    status: note.status || '',
    due: note.due || '',
    start: note.start || '',
    end: note.end || '',
    description: note.description || '',
  };

  return crypto.createHash('md5').update(JSON.stringify(payload)).digest('hex');
}

/**
 * Has the note's own content been changed since the sync last wrote it?
 *
 * The hash of the synced fields decides, because file times are unreliable (LiveSync touches files it only
 * re-downloaded). A note without `sync_hash` falls back to comparing the file time with `synced_at`, with two
 * seconds of slack for the write itself.
 */
export function isLocallyModified(note: HashState, mtimeMs: number): boolean {
  if (note.sync_hash) return note.sync_hash !== computeSyncHash(note);
  return note.synced_at ? mtimeMs > new Date(note.synced_at).getTime() + 2000 : false;
}
