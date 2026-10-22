import * as fs from 'fs/promises';
import { errorMessage, isFileMissing } from '../errors.js';
import { parseNote } from '../markdown/frontmatter.js';
import {
  readEventNote,
  readTaskNote,
  type EventNote,
  type NoteFields,
  type RawFrontmatter,
  type Read,
  type TaskNote,
} from '../markdown/notes.js';
import { resolveVaultPath } from '../markdown/paths.js';
import { ARCHIVE_PREFIX } from './archive.js';
import type { SyncContext } from './context.js';
import { CALENDAR_FOLDER, TASKS_FOLDER } from './folders.js';

/** A note found in the vault, with the file it came from. */
export interface ScannedNote<N extends NoteFields> {
  /** Vault-relative, forward slashes: `{Tasks}/Project A/Plan.md`. */
  relative: string;
  /** The folder part of `relative`. */
  relFolder: string;
  /** The file name. */
  file: string;
  fullPath: string;
  mtimeMs: number;
  /** The front matter as parsed. Use it as the base when a note is rewritten, so the user's own properties survive. */
  raw: RawFrontmatter;
  /** The same, with the synced fields checked and typed. */
  note: N;
  /** Why the note cannot be synced as it is (see `Read`). */
  problems: string[];
  body: string;
}

export interface Scan<N extends NoteFields> {
  notes: ScannedNote<N>[];
  /**
   * False when something under the scanned folders could not be read or understood (a folder that cannot be
   * listed, a file with broken YAML). The notes found are still good, but the list is not the whole truth, so
   * anything that treats "no file for this id" as "the user deleted it" must not run on it.
   */
  complete: boolean;
}

/** Files that live beside the notes but are not notes. */
const isNoteFile = (name: string) => name.endsWith('.md') && !name.startsWith('README');

async function scanRoots<N extends NoteFields>(
  ctx: SyncContext,
  roots: string[],
  read: (raw: RawFrontmatter) => Read<N>,
): Promise<Scan<N>> {
  const notes: ScannedNote<N>[] = [];
  let complete = true;

  async function walk(relFolder: string): Promise<void> {
    let dir: string;
    try {
      dir = resolveVaultPath(ctx.config.vaultResolved, relFolder);
    } catch {
      return; // path traversal guard
    }

    let entries: import('fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (err) {
      if (!isFileMissing(err)) {
        ctx.fail(`Cannot read ${relFolder}`, err);
        complete = false;
      }
      return;
    }

    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const relative = `${relFolder}/${entry.name}`;

      if (entry.isDirectory()) {
        await walk(relative);
        continue;
      }
      if (!entry.isFile() || !isNoteFile(entry.name)) continue;

      const found = await readFile(ctx, relative, relFolder, entry.name, read);
      if (found === 'unreadable') complete = false;
      else if (found) notes.push(found);
    }
  }

  for (const root of roots) await walk(root);
  return { notes, complete };
}

async function readFile<N extends NoteFields>(
  ctx: SyncContext,
  relative: string,
  relFolder: string,
  file: string,
  read: (raw: RawFrontmatter) => Read<N>,
): Promise<ScannedNote<N> | 'unreadable' | undefined> {
  const fullPath = resolveVaultPath(ctx.config.vaultResolved, relative);
  let stat: Awaited<ReturnType<typeof fs.stat>>;
  let content: string;
  try {
    stat = await fs.stat(fullPath);
    content = await fs.readFile(fullPath, 'utf-8');
  } catch (err) {
    if (isFileMissing(err)) return undefined; // moved or deleted between listing and reading
    ctx.fail(`Cannot read ${relative}`, err);
    return 'unreadable';
  }

  let parsed: ReturnType<typeof parseNote>;
  try {
    parsed = parseNote(content);
  } catch (err) {
    ctx.flag(relative, `the front matter is not valid YAML (${errorMessage(err).split('\n')[0]})`);
    return 'unreadable';
  }

  const { note, problems } = read(parsed.frontmatter);
  return {
    relative,
    relFolder,
    file,
    fullPath,
    mtimeMs: stat.mtimeMs,
    raw: parsed.frontmatter,
    note,
    problems,
    body: parsed.body,
  };
}

/** Every task note: the active folders first, then the archive mirror. */
export const scanTasks = (ctx: SyncContext): Promise<Scan<TaskNote>> =>
  scanRoots(ctx, [TASKS_FOLDER, `${ARCHIVE_PREFIX}/${TASKS_FOLDER}`], readTaskNote);

/** Every event note: the active folders first, then the archive mirror. */
export const scanEvents = (ctx: SyncContext): Promise<Scan<EventNote>> =>
  scanRoots(ctx, [CALENDAR_FOLDER, `${ARCHIVE_PREFIX}/${CALENDAR_FOLDER}`], readEventNote);

/** One known note, read again just before it is changed. Throws when the file is gone or unreadable. */
export async function readTaskFile(ctx: SyncContext, relative: string): Promise<ScannedNote<TaskNote>> {
  return readOne(ctx, relative, readTaskNote);
}

export async function readEventFile(ctx: SyncContext, relative: string): Promise<ScannedNote<EventNote>> {
  return readOne(ctx, relative, readEventNote);
}

async function readOne<N extends NoteFields>(
  ctx: SyncContext,
  relative: string,
  read: (raw: RawFrontmatter) => Read<N>,
): Promise<ScannedNote<N>> {
  const slash = relative.lastIndexOf('/');
  const fullPath = resolveVaultPath(ctx.config.vaultResolved, relative);
  const stat = await fs.stat(fullPath);
  const parsed = parseNote(await fs.readFile(fullPath, 'utf-8'));
  const { note, problems } = read(parsed.frontmatter);
  return {
    relative,
    relFolder: relative.slice(0, slash),
    file: relative.slice(slash + 1),
    fullPath,
    mtimeMs: stat.mtimeMs,
    raw: parsed.frontmatter,
    note,
    problems,
    body: parsed.body,
  };
}
