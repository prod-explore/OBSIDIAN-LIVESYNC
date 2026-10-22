import * as fs from 'fs/promises';
import * as path from 'path';
import { resolveVaultPath } from './security.js';

/**
 * Safely moves a file to the vault's trash directory.
 * Generates a timestamped filename to prevent collisions in the trash.
 * Returns the relative path of the trashed file (e.g., ".trash/2026-08-26...__Note.md").
 */
export async function moveToTrash(
  vaultRoot: string,
  trashDir: string,
  notePathRelative: string
): Promise<string> {
  const fullPath = resolveVaultPath(vaultRoot, notePathRelative);
  const trashRoot = resolveVaultPath(vaultRoot, trashDir);

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  // Flatten the path for the trash directory (e.g. "Folder/Note.md" -> "Folder__Note.md")
  const safeName = notePathRelative.replace(/[/\\]/g, '__');
  const trashPath = path.join(trashRoot, `${timestamp}__${safeName}`);

  await fs.mkdir(trashRoot, { recursive: true });
  await fs.rename(fullPath, trashPath);

  return `${trashDir}/${path.basename(trashPath)}`;
}
