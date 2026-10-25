import * as fs from 'fs/promises';
import * as path from 'path';

function escapeRegExp(string: string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Scans the vault for links pointing to `oldRelPath` and updates them to `newRelPath`.
 *
 * Obsidian resolves a link that is just a name (`[[Index]]`) to *a* note with that name, so a
 * bare-name link is only safe to rewrite while the moved note is the only one carrying the name.
 * When another note shares it, such links are left alone — they may well mean the other note —
 * and only links that spell out the old folder path are rewritten. Files whose content would not
 * change are not touched, so a pure folder move does not make LiveSync re-upload half the vault.
 *
 * @param vaultRoot Absolute path to the vault root
 * @param oldRelPath Relative path to the old note (e.g. 'folder/old.md' or 'old.md')
 * @param newRelPath Relative path to the new note (e.g. 'folder/new.md' or 'new.md')
 * @returns number of files updated
 */
export async function updateBacklinks(vaultRoot: string, oldRelPath: string, newRelPath: string): Promise<number> {
  const files = await getAllMdFiles(vaultRoot);

  const oldName = path.basename(oldRelPath, '.md');
  const newName = path.basename(newRelPath, '.md');

  // Links always use forward slashes, whatever the platform's separator.
  const oldRelPathForward = oldRelPath.replace(/\\/g, '/');
  const newRelPathForward = newRelPath.replace(/\\/g, '/');
  const stripMd = (p: string) => (p.endsWith('.md') ? p.slice(0, -3) : p);
  const oldRelPathWithoutExt = stripMd(oldRelPathForward);
  const newRelPathWithoutExt = stripMd(newRelPathForward);

  const movedTo = path.resolve(vaultRoot, newRelPath);
  const nameIsShared = files.some(
    (f) => path.resolve(f) !== movedTo && path.basename(f, '.md').toLowerCase() === oldName.toLowerCase(),
  );
  // With a shared name only path-qualified links are unambiguous.
  const usable = (target: string) => !nameIsShared || target.includes('/');
  const wikiTargets = [...new Set([oldName, oldName + '.md', oldRelPathWithoutExt, oldRelPathForward])].filter(usable);
  const mdTargets = [
    ...new Set([oldName + '.md', oldRelPathForward, encodeURI(oldName + '.md'), encodeURI(oldRelPathForward)]),
  ].filter(usable);

  if (wikiTargets.length === 0 && mdTargets.length === 0) return 0;

  // [[Target]], [[Target#heading]], [[Target|alias]], [[Target#heading|alias]]
  const wikilinkRegex = wikiTargets.length
    ? new RegExp(`\\[\\[(${wikiTargets.map(escapeRegExp).join('|')})(#[^|\\]]*)?(\\|[^\\]]*)?\\]\\]`, 'gi')
    : null;
  // [alias](Target)
  const mdLinkRegex = mdTargets.length
    ? new RegExp(`\\[([^\\]]*)\\]\\((${mdTargets.map(escapeRegExp).join('|')})\\)`, 'gi')
    : null;

  let updatedCount = 0;

  for (const file of files) {
    const content = await fs.readFile(file, 'utf-8');
    let newContent = content;

    if (wikilinkRegex) {
      newContent = newContent.replace(wikilinkRegex, (_match, target: string, heading?: string, alias?: string) => {
        // A link that spelled out the folder keeps doing so; a bare name stays bare.
        const to = target.includes('/') ? newRelPathWithoutExt : newName;
        return `[[${to}${heading ?? ''}${alias ?? ''}]]`;
      });
    }
    if (mdLinkRegex) {
      newContent = newContent.replace(mdLinkRegex, (_match, text: string, target: string) => {
        const to = target.includes('/') ? newRelPathForward : newName + '.md';
        return `[${text}](${encodeURI(to)})`;
      });
    }

    if (newContent !== content) {
      await fs.writeFile(file, newContent, 'utf-8');
      updatedCount++;
    }
  }

  return updatedCount;
}

async function getAllMdFiles(dir: string, fileList: string[] = []): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue; // hidden folders (.obsidian, the trash) hold no notes to rewrite

    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await getAllMdFiles(fullPath, fileList);
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      fileList.push(fullPath);
    }
  }
  return fileList;
}
