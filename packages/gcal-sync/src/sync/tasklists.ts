/**
 * Task lists and their folders: the default list is {Tasks}/ itself, every other list is one subfolder of it, named
 * after the list. The mapping is kept in both directions, like the notes: a list made in Google gets a folder, a
 * folder made in the vault gets a list, and a rename on either side is carried over. Nothing here ever deletes a
 * list or a folder.
 */
import { tasks_v1 } from 'googleapis';
import * as fs from 'fs/promises';
import { isFileMissing } from '../errors.js';
import { resolveVaultPath, sanitizeTitle } from '../markdown/paths.js';
import type { SyncContext } from './context.js';
import { DEFAULT_LIST, isArchivedPath, listNameOfFolder, taskFolder, toArchive } from './folders.js';
import { scanTasks } from './scan.js';

export interface TasklistInfo {
  lists: tasks_v1.Schema$TaskList[];
  /** The id behind the alias "@default"; its tasks live directly in {Tasks}/, other lists in a subfolder named after them. */
  defaultId: string | undefined;
}

// One lookup per Google client. A client lives for one sync cycle, so a list created or renamed in Google
// is seen on the next cycle.
const lookups = new WeakMap<tasks_v1.Tasks, TasklistInfo>();
// A failed lookup is remembered the same way, so one outage is one error in the log, not one per note.
const failed = new WeakSet<tasks_v1.Tasks>();

/** All task lists of the account, or null when Google could not be asked (callers skip the work and retry next cycle). */
export async function getTasklists(ctx: SyncContext): Promise<TasklistInfo | null> {
  const { tasks } = ctx;
  const known = lookups.get(tasks);
  if (known) return known;
  if (failed.has(tasks)) return null;
  try {
    const lists: tasks_v1.Schema$TaskList[] = [];
    let pageToken: string | undefined;
    do {
      const res = await tasks.tasklists.list({ maxResults: 100, pageToken });
      lists.push(...(res.data.items ?? []));
      pageToken = res.data.nextPageToken || undefined;
    } while (pageToken);
    const def = await tasks.tasklists.get({ tasklist: '@default' });
    const info: TasklistInfo = { lists, defaultId: def.data.id || undefined };
    lookups.set(tasks, info);
    return info;
  } catch (err) {
    failed.add(tasks);
    ctx.fail('Could not fetch the task lists', err);
    return null;
  }
}

/** A list's title as a folder name. */
const titleAsFolder = (list: tasks_v1.Schema$TaskList) => sanitizeTitle(list.title || 'Untitled List');

/** The folder name of a list other than the default one: the one recorded for it, else its title. */
export function folderOfList(ctx: SyncContext, list: tasks_v1.Schema$TaskList): string {
  return (list.id && ctx.state.tasklistFolders[list.id]) || titleAsFolder(list);
}

/**
 * The id of the list a folder name stands for, without creating anything: "@default" is the default list; any other
 * name is looked up in the recorded folders first (so a list keeps its folder while its title catches up), then
 * among the list titles. Undefined when no list matches or Google cannot be reached.
 */
export async function findTasklistId(ctx: SyncContext, listName: string): Promise<string | undefined> {
  const info = await getTasklists(ctx);
  if (!info) return undefined;
  if (listName === DEFAULT_LIST) return info.defaultId;
  const existing = (id: string | null | undefined) => Boolean(id && info.lists.some((l) => l.id === id));

  const recorded = Object.entries(ctx.state.tasklistFolders).find(
    ([id, folder]) => folder === listName && existing(id),
  );
  if (recorded) return recorded[0];
  return info.lists.find((l) => titleAsFolder(l) === listName)?.id ?? undefined;
}

/**
 * The Google id of the list a vault folder stands for (see findTasklistId), created when there is none. Returns
 * undefined only when Google cannot be reached.
 */
export async function resolveTasklistId(ctx: SyncContext, listName: string): Promise<string | undefined> {
  const info = await getTasklists(ctx);
  if (!info) return undefined;
  const found = await findTasklistId(ctx, listName);
  if (found || listName === DEFAULT_LIST) return found;
  return createList(ctx, info, listName);
}

async function createList(ctx: SyncContext, info: TasklistInfo, title: string): Promise<string | undefined> {
  ctx.log.info('Creating a new list in Google Tasks', { list: title });
  try {
    const res = await ctx.tasks.tasklists.insert({ requestBody: { title } });
    if (!res.data.id) throw new Error('Google did not return an id for the new list');
    info.lists.push(res.data);
    ctx.state.tasklistFolders[res.data.id] = title;
    return res.data.id;
  } catch (err) {
    ctx.fail(`Could not create the list "${title}"`, err);
    return undefined;
  }
}

/** The names of the subfolders of a folder; undefined when it cannot be listed (a missing folder has none). */
async function subfolders(ctx: SyncContext, relFolder: string): Promise<Set<string> | undefined> {
  try {
    const entries = await fs.readdir(resolveVaultPath(ctx.config.vaultResolved, relFolder), { withFileTypes: true });
    return new Set(entries.filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name));
  } catch (err) {
    if (isFileMissing(err)) return new Set();
    ctx.fail(`Cannot read ${relFolder}`, err);
    return undefined;
  }
}

/**
 * Brings the lists and the folders in line, before any task is pulled (so a task of a renamed list lands in the
 * renamed folder). In this order:
 *
 * 1. A list Google has and the vault does not know gets its folder. A list renamed in Google has its folder (and the
 *    folder's archive mirror) renamed, unless a folder with the new name is already there. Two lists whose titles make
 *    the same folder name get one folder each: the one recorded first keeps the name, the next gets " (2)", and so on.
 * 2. A known list whose folder is gone was renamed in the vault if its notes are now all in one folder that stands for
 *    no list: the list is renamed in Google. Without that evidence the folder is created again, empty: the list still
 *    exists, and deleting it is never done automatically.
 * 3. A folder that stands for no list gets a new list.
 *
 * Steps 2 and 3 need a full view of the vault, so they wait for a cycle in which every task note could be read.
 */
export async function syncTasklistFolders(ctx: SyncContext): Promise<void> {
  const info = await getTasklists(ctx);
  if (!info) return;
  const active = await subfolders(ctx, taskFolder(DEFAULT_LIST));
  const archive = await subfolders(ctx, toArchive(taskFolder(DEFAULT_LIST)));
  if (!active || !archive) return; // a folder that cannot be listed would look like a deleted one

  const recorded = ctx.state.tasklistFolders;
  const lists = info.lists.filter((l): l is tasks_v1.Schema$TaskList & { id: string } =>
    Boolean(l.id && l.id !== info.defaultId),
  );
  // Lists deleted in Google are forgotten; their folders stay, and step 3 gives them a list again.
  for (const id of Object.keys(recorded)) if (!lists.some((l) => l.id === id)) delete recorded[id];

  const makeFolder = async (name: string) => {
    if (active.has(name)) return;
    await fs.mkdir(resolveVaultPath(ctx.config.vaultResolved, taskFolder(name)), { recursive: true });
    active.add(name);
  };

  // 1. Google → vault
  const missing: { id: string; folder: string }[] = [];
  for (const list of lists) {
    const title = titleAsFolder(list);
    const folder = recorded[list.id];
    if (folder !== undefined && isFolderFor(folder, title)) {
      if (!active.has(folder)) missing.push({ id: list.id, folder });
      continue;
    }
    const target = freeFolderName(recorded, title, list.id);
    if (folder === undefined || (!active.has(folder) && !archive.has(folder))) {
      recorded[list.id] = target; // new to the sync, or renamed while its folder was gone
      await makeFolder(target);
      continue;
    }
    if (active.has(target) || archive.has(target)) {
      ctx.flag(taskFolder(target), `the list "${folder}" was renamed in Google to a name that already has a folder`);
      continue;
    }
    await renameFolder(ctx, folder, target, active, archive);
    await makeFolder(target); // when only the archive mirror existed
    recorded[list.id] = target;
    ctx.log.info('Renamed a list folder after the list was renamed in Google', { from: folder, to: target });
  }

  const known = new Set([...Object.values(recorded), ...info.lists.map(titleAsFolder)]);
  const unknown = [...active].filter((name) => !known.has(name));
  if (missing.length === 0 && unknown.length === 0) return;

  const scan = await scanTasks(ctx);
  if (!scan.complete) {
    ctx.log.warn('Leaving task list folders as they are: the vault was not fully readable this cycle');
    return;
  }

  // 2. Vault → Google: a renamed folder
  for (const { id, folder } of missing) {
    const homes = new Set(
      scan.notes
        .filter((n) => n.note.tasklist_id === id && !isArchivedPath(n.relFolder))
        .map((n) => listNameOfFolder(n.relFolder)),
    );
    const [renamedTo] = homes;
    if (homes.size === 1 && unknown.includes(renamedTo)) {
      try {
        await ctx.tasks.tasklists.patch({ tasklist: id, requestBody: { title: renamedTo } });
      } catch (err) {
        ctx.fail(`Could not rename the list "${folder}" to "${renamedTo}"`, err);
        unknown.splice(unknown.indexOf(renamedTo), 1); // not a new list either: retried next cycle
        continue;
      }
      const renamed = info.lists.find((l) => l.id === id);
      if (renamed) renamed.title = renamedTo;
      if (archive.has(renamedTo)) {
        if (archive.has(folder)) {
          ctx.flag(
            toArchive(taskFolder(folder)),
            `the list was renamed to "${renamedTo}", whose archive folder already exists`,
          );
        }
      } else {
        await renameFolder(ctx, folder, renamedTo, new Set(), archive);
      }
      recorded[id] = renamedTo;
      unknown.splice(unknown.indexOf(renamedTo), 1);
      ctx.log.info('Renamed a list in Google after its folder was renamed', { from: folder, to: renamedTo });
    } else {
      await makeFolder(folder);
    }
  }

  // 3. Vault → Google: a new folder
  for (const name of unknown) await createList(ctx, info, name);
}

/** Is `folder` the folder of a list titled `title`: the title itself, or the title with a " (n)" suffix? */
function isFolderFor(folder: string, title: string): boolean {
  return folder === title || (folder.startsWith(`${title} (`) && /^ \(\d+\)$/.test(folder.slice(title.length)));
}

/** The title, or the first "title (n)" from 2 up that no other list's folder has taken. */
function freeFolderName(recorded: Record<string, string>, title: string, ownId: string): string {
  const taken = new Set(Object.entries(recorded).flatMap(([id, folder]) => (id === ownId ? [] : [folder])));
  let name = title;
  for (let n = 2; taken.has(name); n++) name = `${title} (${n})`;
  return name;
}

/** Renames a list's folder and its archive mirror, each only where it exists. */
async function renameFolder(ctx: SyncContext, from: string, to: string, active: Set<string>, archive: Set<string>) {
  const vault = ctx.config.vaultResolved;
  for (const [names, folderOf] of [
    [active, taskFolder],
    [archive, (name: string) => toArchive(taskFolder(name))],
  ] as const) {
    if (!names.has(from)) continue;
    try {
      await fs.rename(resolveVaultPath(vault, folderOf(from)), resolveVaultPath(vault, folderOf(to)));
      names.delete(from);
      names.add(to);
    } catch (err) {
      ctx.fail(`Could not rename ${folderOf(from)} to ${folderOf(to)}`, err);
    }
  }
}
