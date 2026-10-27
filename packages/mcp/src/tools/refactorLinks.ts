import * as fs from 'fs/promises';
import * as path from 'path';
import { isInTrash } from 'obsidian-livesync-shared';
import { errorMessage } from '../errors.js';

/** What a link rewrite did; paths are vault-relative with forward slashes. */
export interface BacklinkUpdate {
  /** Links rewritten, over all notes. */
  links: number;
  /** Notes that were rewritten. */
  files: string[];
  /** Notes that could not be read or written; any link to the old path in them still points there. */
  failed: { file: string; error: string }[];
}

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
 * Each note is read and written on its own: one that cannot be rewritten is recorded in `failed` and the rest are
 * still updated, so the caller can tell the client exactly which notes still point at the old path.
 * `options.backup` runs before each note is rewritten; if it fails, that note is left as it was and counted as failed.
 *
 * @param vaultRoot Absolute path to the vault root
 * @param oldRelPath Relative path to the old note (e.g. 'folder/old.md' or 'old.md')
 * @param newRelPath Relative path to the new note (e.g. 'folder/new.md' or 'new.md')
 * @param options.backup Keeps a copy of a note (vault-relative path) before it is rewritten
 * @param options.trashDir The trash folder: the copies in it are never read or rewritten
 */
export async function updateBacklinks(
  vaultRoot: string,
  oldRelPath: string,
  newRelPath: string,
  options: { backup?: (relPath: string) => Promise<unknown>; trashDir?: string } = {},
): Promise<BacklinkUpdate> {
  const files = await getAllMdFiles(vaultRoot, vaultRoot, options.trashDir);

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

  const result: BacklinkUpdate = { links: 0, files: [], failed: [] };
  if (wikiTargets.length === 0 && mdTargets.length === 0) return result;

  // [[Target]], [[Target#heading]], [[Target|alias]], [[Target#heading|alias]]
  const wikilinkRegex = wikiTargets.length
    ? new RegExp(`\\[\\[(${wikiTargets.map(escapeRegExp).join('|')})(#[^|\\]]*)?(\\|[^\\]]*)?\\]\\]`, 'gi')
    : null;
  // [alias](Target)
  const mdLinkRegex = mdTargets.length
    ? new RegExp(`\\[([^\\]]*)\\]\\((${mdTargets.map(escapeRegExp).join('|')})\\)`, 'gi')
    : null;

  for (const file of files) {
    const rel = path.relative(vaultRoot, file).split(path.sep).join('/');
    try {
      const content = await fs.readFile(file, 'utf-8');
      let links = 0;
      let newContent = content;

      if (wikilinkRegex) {
        newContent = newContent.replace(wikilinkRegex, (match, target: string, heading?: string, alias?: string) => {
          // A link that spelled out the folder keeps doing so; a bare name stays bare.
          const to = target.includes('/') ? newRelPathWithoutExt : newName;
          const replaced = `[[${to}${heading ?? ''}${alias ?? ''}]]`;
          if (replaced !== match) links++;
          return replaced;
        });
      }
      if (mdLinkRegex) {
        newContent = newContent.replace(mdLinkRegex, (match, text: string, target: string) => {
          const to = target.includes('/') ? newRelPathForward : newName + '.md';
          const replaced = `[${text}](${encodeURI(to)})`;
          if (replaced !== match) links++;
          return replaced;
        });
      }

      if (newContent !== content) {
        await options.backup?.(rel);
        await fs.writeFile(file, newContent, 'utf-8');
        result.links += links;
        result.files.push(rel);
      }
    } catch (err) {
      result.failed.push({ file: rel, error: errorMessage(err) });
    }
  }

  return result;
}

async function getAllMdFiles(
  vaultRoot: string,
  dir: string,
  trashDir: string | undefined,
  fileList: string[] = [],
): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue; // hidden folders (.obsidian, the default .trash) hold no notes to rewrite

    const fullPath = path.join(dir, entry.name);
    // Dirent.isDirectory() is false for a link, so links are not followed and the path as written is the real one.
    if (trashDir !== undefined && isInTrash(path.relative(vaultRoot, fullPath), trashDir)) continue;
    if (entry.isDirectory()) {
      await getAllMdFiles(vaultRoot, fullPath, trashDir, fileList);
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      fileList.push(fullPath);
    }
  }
  return fileList;
}
