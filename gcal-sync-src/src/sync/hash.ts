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
