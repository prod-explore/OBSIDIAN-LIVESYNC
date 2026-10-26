/**
 * The vault's trash folder, as both services read it. The MCP server moves deleted and overwritten notes there, the
 * Google sync the folders of deleted task lists; one setting keeps everything removed in one place.
 */
import * as path from 'path';

/** Hidden, so it is not part of the notes: Obsidian, the MCP server's tools and the sync's scans all skip it. */
export const DEFAULT_TRASH_DIR = '.trash';

/**
 * TRASH_DIR as a vault-relative folder with forward slashes (`.trash`, `_System/deleted`). Unset or blank is the
 * default. Throws, naming the variable, for a value that is not a folder inside the vault: an absolute path, one
 * that climbs out with `..`, or the vault root itself.
 */
export function resolveTrashDir(value: string | undefined): string {
  const raw = value?.trim();
  if (!raw) return DEFAULT_TRASH_DIR;
  const slashed = raw.replace(/\\/g, '/');
  const normalized = path.posix.normalize(slashed).replace(/\/+$/, '');
  if (
    path.posix.isAbsolute(slashed) ||
    path.win32.isAbsolute(raw) ||
    normalized === '.' ||
    normalized === '' ||
    normalized === '..' ||
    normalized.startsWith('../')
  ) {
    throw new Error(
      `TRASH_DIR must be a folder inside the vault, relative to its root (e.g. ${DEFAULT_TRASH_DIR}); got "${raw}"`,
    );
  }
  return normalized;
}

/**
 * The name a note or folder gets in the trash: a timestamp, then its vault-relative path flattened (`Folder/Note.md`
 * -> `Folder__Note.md`), so two things with one name in different folders, or two versions of one, never collide.
 */
export function trashedName(relativePath: string, at: Date = new Date()): string {
  const timestamp = at.toISOString().replace(/[:.]/g, '-');
  return `${timestamp}__${relativePath.replace(/[/\\]/g, '__')}`;
}
