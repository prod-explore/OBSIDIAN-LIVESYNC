import * as fs from 'fs/promises';
import * as path from 'path';
import { resolveVaultPath } from '../markdown/paths.js';

/**
 * Moves a file from oldRelativePath to newRelativePath inside the vault,
 * then — if the basename (stem) changed — scans every .md file in the vault
 * and rewrites [[OldStem]], [[OldStem|Alias]], and [[OldStem#Heading]] links
 * to use the new stem.
 *
 * Safety invariants:
 *  - Both paths go through resolveVaultPath() to prevent traversal.
 *  - If oldAbs === newAbs the function is a no-op.
 *  - Hidden directories (starting with ".") are skipped during the scan.
 */
export async function renameAndRefactorLinks(
  vaultRoot: string,
  oldRelativePath: string,
  newRelativePath: string
): Promise<void> {
  if (oldRelativePath === newRelativePath) return;

  const oldAbs = resolveVaultPath(vaultRoot, oldRelativePath);
  const newAbs = resolveVaultPath(vaultRoot, newRelativePath);

  // Ensure destination directory exists before moving.
  await fs.mkdir(path.dirname(newAbs), { recursive: true });
  await fs.rename(oldAbs, newAbs);

  const oldStem = path.basename(oldAbs, '.md');
  const newStem = path.basename(newAbs, '.md');

  // If only the folder changed but the filename is identical, Obsidian's
  // shortest-path resolver still finds the file — no link rewrite needed.
  if (oldStem === newStem) return;

  console.log(`[Refactor] Rewriting links: [[${oldStem}]] → [[${newStem}]]`);

  // Escape for use inside a RegExp.
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // Matches: [[OldStem]]  [[OldStem|Alias]]  [[OldStem#Heading]]
  const regex = new RegExp(`\\[\\[${esc(oldStem)}([\\]|#])`, 'g');

  let updatedCount = 0;

  async function walk(dir: string): Promise<void> {
    let entries: import('fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return; // directory disappeared mid-walk — safe to skip
    }

    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue; // skip .git, .obsidian, .trash …

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
        regex.lastIndex = 0; // reset after the test() above

        const rewritten = content.replace(regex, `[[${newStem}$1`);
        await fs.writeFile(fullPath, rewritten, 'utf-8');
        updatedCount++;
      }
    }
  }

  await walk(vaultRoot);
  if (updatedCount > 0) {
    console.log(`[Refactor] Updated ${updatedCount} file(s).`);
  }
}
