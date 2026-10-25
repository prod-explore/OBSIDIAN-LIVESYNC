/** The vault's trash folder: where a delete, an overwrite and an edit put the previous version of a note. */
import * as fs from 'fs/promises';
import * as path from 'path';
import { resolveVaultPath } from './security.js';

/**
 * Name of a trashed copy: a timestamp, then the note's path flattened (`Folder/Note.md` -> `Folder__Note.md`), so
 * two notes with one name in different folders, or two versions of one note, do not overwrite each other.
 */
function trashedName(notePathRelative: string): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `${timestamp}__${notePathRelative.replace(/[/\\]/g, '__')}`;
}

/**
 * Moves a note into the vault's trash folder; nothing this server does ever unlinks a note.
 * Returns the vault-relative path of the trashed file (`<trashDir>/<timestamp>__<flattened path>`).
 */
export async function moveToTrash(vaultRoot: string, trashDir: string, notePathRelative: string): Promise<string> {
  const fullPath = resolveVaultPath(vaultRoot, notePathRelative);
  const trashRoot = resolveVaultPath(vaultRoot, trashDir, { allowHidden: true });
  const trashPath = path.join(trashRoot, trashedName(notePathRelative));

  await fs.mkdir(trashRoot, { recursive: true });
  await fs.rename(fullPath, trashPath);

  return `${trashDir}/${path.basename(trashPath)}`;
}

/**
 * Keeps a copy of a note in the trash and leaves the note where it is; used before an edit changes it in place.
 * Returns the vault-relative path of the copy.
 */
export async function copyToTrash(vaultRoot: string, trashDir: string, notePathRelative: string): Promise<string> {
  const fullPath = resolveVaultPath(vaultRoot, notePathRelative);
  const trashRoot = resolveVaultPath(vaultRoot, trashDir, { allowHidden: true });
  const trashPath = path.join(trashRoot, trashedName(notePathRelative));

  await fs.mkdir(trashRoot, { recursive: true });
  await fs.copyFile(fullPath, trashPath);

  return `${trashDir}/${path.basename(trashPath)}`;
}
