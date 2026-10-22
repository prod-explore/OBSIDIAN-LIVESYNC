import * as path from 'path';

/** File names are limited to 255 bytes; the date, id and extension around a title take about 30 of them. */
const MAX_TITLE_BYTES = 180;

function truncateToBytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text) <= maxBytes) return text;
  let out = '';
  let bytes = 0;
  for (const char of text) {
    // by code point, so a character is never cut in half
    const size = Buffer.byteLength(char);
    if (bytes + size > maxBytes) break;
    out += char;
    bytes += size;
  }
  return out;
}

/**
 * Sanitizes an event or task title into a safe filename part: characters that are illegal in
 * Windows/Linux filenames are replaced, and a very long title is cut so the whole name still fits.
 * (The full title stays in the note's frontmatter.)
 */
export function sanitizeTitle(title: string): string {
  // Control characters are exactly what is being removed here.
  // eslint-disable-next-line no-control-regex
  const cleaned = title.replace(/[<>:"/\\|?*\x00-\x1F]/g, '-').trim();
  return truncateToBytes(cleaned, MAX_TITLE_BYTES).trim() || 'Untitled';
}

/**
 * Secures a relative path within the vault root.
 * Throws an error if the path attempts to traverse outside the vault.
 */
export function resolveVaultPath(vaultRoot: string, notePathRelative: string): string {
  const root = path.normalize(path.resolve(vaultRoot));
  const target = path.normalize(path.resolve(root, notePathRelative));

  // The empty string gives the root directory itself, which ends with a trailing separator.
  // Standardizing ensures we don't accidentally match prefix substrings like '/vault-mcp-evil'
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  const targetWithSep = target.endsWith(path.sep) ? target : target + path.sep;

  if (!targetWithSep.startsWith(rootWithSep)) {
    throw new Error(`Path Traversal Error: ${notePathRelative} resolves outside the vault root.`);
  }

  return target;
}
