import * as crypto from 'crypto';

/**
 * Computes a deterministic MD5 hash of the syncable frontmatter fields.
 * This completely isolates us from filesystem `mtime` changes (e.g. from LiveSync),
 * ensuring we only trigger syncs when actual logical data has changed.
 */
export function computeSyncHash(frontmatter: Record<string, any>): string {
  const payload = {
    title:       frontmatter.title || '',
    status:      frontmatter.status || '',
    due:         frontmatter.due || '',
    start:       frontmatter.start || '',
    end:         frontmatter.end || '',
    description: frontmatter.description || ''
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
export function isLocallyModified(frontmatter: Record<string, any>, mtimeMs: number): boolean {
  if (frontmatter.sync_hash) return frontmatter.sync_hash !== computeSyncHash(frontmatter);
  return frontmatter.synced_at ? mtimeMs > new Date(frontmatter.synced_at).getTime() + 2000 : false;
}
