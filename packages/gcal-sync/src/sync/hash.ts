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
 * Computes a deterministic MD5 hash of the syncable frontmatter fields.
 * This completely isolates us from filesystem `mtime` changes (e.g. from LiveSync),
 * ensuring we only trigger syncs when actual logical data has changed.
 */
export function computeSyncHash(note: Hashable): string {
  const payload = {
    title:       note.title || '',
    status:      note.status || '',
    due:         note.due || '',
    start:       note.start || '',
    end:         note.end || '',
    description: note.description || '',
  };

  return crypto.createHash('md5').update(JSON.stringify(payload)).digest('hex');
}

/**
 * Has the note's own content been changed since the sync last wrote it?
 *
 * The hash of the syncable fields decides, because file times are unreliable (LiveSync touches files it
 * only re-downloaded). Notes written before hashes existed fall back to comparing the file time with
 * `synced_at`, with a little slack for the write itself.
 */
export function isLocallyModified(note: HashState, mtimeMs: number): boolean {
  if (note.sync_hash) return note.sync_hash !== computeSyncHash(note);
  return note.synced_at ? mtimeMs > new Date(note.synced_at).getTime() + 2000 : false;
}
