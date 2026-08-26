import * as path from 'path';

/**
 * Sanitizes an event or task title into a safe filename.
 * Replaces characters that are illegal in Windows/Linux filesystems.
 */
export function sanitizeTitle(title: string): string {
  return title.replace(/[<>:"/\\|?*\x00-\x1F]/g, '-').trim() || 'Untitled';
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
