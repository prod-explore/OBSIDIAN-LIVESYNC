import * as fs from 'fs/promises';
import * as path from 'path';
import { resolveVaultPath } from '../markdown/paths.js';
import type { SyncContext } from './context.js';

/**
 * Moves a note inside the vault and, when its file name changed, rewrites `[[OldName]]`, `[[OldName|Alias]]` and
 * `[[OldName#Heading]]` in every note to the new name, whatever the case of the name in the link. Equal paths are a
 * no-op; hidden folders are not scanned.
 */
export async function renameAndRefactorLinks(
  ctx: SyncContext,
  oldRelativePath: string,
  newRelativePath: string,
): Promise<void> {
  if (oldRelativePath === newRelativePath) return;

  const vaultRoot = ctx.config.vaultResolved;
  const oldAbs = resolveVaultPath(vaultRoot, oldRelativePath);
  const newAbs = resolveVaultPath(vaultRoot, newRelativePath);

  await fs.mkdir(path.dirname(newAbs), { recursive: true });
  await fs.rename(oldAbs, newAbs);

  const oldStem = path.basename(oldAbs, '.md');
  const newStem = path.basename(newAbs, '.md');

  // Only the folder changed: Obsidian resolves a link by name, so every link still finds the note.
  if (oldStem === newStem) return;

  ctx.log.info('Rewriting links', { from: oldStem, to: newStem });

  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // [[OldStem]], [[OldStem|Alias]], [[OldStem#Heading]]; the character after the name is kept as $1.
  // Case-insensitive because Obsidian resolves [[old stem]] to `Old Stem.md` too; such a link would break otherwise.
  const regex = new RegExp(`\\[\\[${esc(oldStem)}([\\]|#])`, 'gi');

  let updatedCount = 0;

  async function walk(dir: string): Promise<void> {
    let entries: import('fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return; // removed since its parent was listed
    }

    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;

      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        let content: string;
        try {
          content = await fs.readFile(fullPath, 'utf-8');
        } catch {
          continue;
        }

        if (!regex.test(content)) continue;
        regex.lastIndex = 0; // test() on a global regex advances lastIndex

        const rewritten = content.replace(regex, `[[${newStem}$1`);
        await fs.writeFile(fullPath, rewritten, 'utf-8');
        updatedCount++;
      }
    }
  }

  await walk(vaultRoot);
  if (updatedCount > 0) {
    ctx.log.info('Rewrote links', { files: updatedCount });
  }
}
