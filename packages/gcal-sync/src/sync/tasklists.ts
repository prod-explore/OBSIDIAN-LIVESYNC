/**
 * Task lists and their folders: the default list is {Tasks}/ itself, every other list is one subfolder of it, named
 * after the list. The mapping is kept in both directions, like the notes: a list made, renamed or deleted in Google
 * is made, renamed or trashed in the vault, and the other way round. An empty list or folder is still there and stays.
 */
import { tasks_v1 } from 'googleapis';
import { trashedName } from 'obsidian-livesync-shared';
import * as fs from 'fs/promises';
import { isAlreadyGone, isFileMissing } from '../errors.js';
import { resolveVaultPath, sanitizeTitle } from '../markdown/paths.js';
import type { SyncContext } from './context.js';
import { DEFAULT_LIST, isArchivedPath, listNameOfFolder, taskFolder, toArchive } from './folders.js';
import { isMassDeletion } from './safety.js';
import { scanTasks } from './scan.js';

export interface TasklistInfo {
  lists: tasks_v1.Schema$TaskList[];
  /**
   * The id behind the alias "@default"; its tasks live directly in {Tasks}/, other lists in a subfolder named after
   * them.
   */
  defaultId: string | undefined;
}

// One lookup per Google client. A client lives for one sync cycle, so a list created or renamed in Google
// is seen on the next cycle.
const lookups = new WeakMap<tasks_v1.Tasks, TasklistInfo>();
// A failed lookup is remembered the same way, so one outage is one error in the log, not one per note.
const failed = new WeakSet<tasks_v1.Tasks>();

/**
 * All task lists of the account, or null when Google could not be asked (callers skip the work and retry next cycle).
 */
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
 * The Google id of the list a vault folder stands for (see findTasklistId), created when there is none. Undefined
 * when Google cannot be reached, and for the folder of a list deleted in Google: that folder is on its way to the
 * trash (see syncTasklistFolders), and making a new list for it would undo the deletion.
 */
export async function resolveTasklistId(ctx: SyncContext, listName: string): Promise<string | undefined> {
  const info = await getTasklists(ctx);
  if (!info) return undefined;
  const found = await findTasklistId(ctx, listName);
  if (found || listName === DEFAULT_LIST) return found;
  if (Object.values(ctx.state.tasklistFolders).includes(listName)) return undefined;
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

/**
 * The names of the subfolders of a folder, and whether the folder is there at all; undefined when it cannot be
 * listed.
 */
async function subfolders(
  ctx: SyncContext,
  relFolder: string,
): Promise<{ names: Set<string>; exists: boolean } | undefined> {
  try {
    const entries = await fs.readdir(resolveVaultPath(ctx.config.vaultResolved, relFolder), { withFileTypes: true });
    return {
      names: new Set(entries.filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name)),
      exists: true,
    };
  } catch (err) {
    if (isFileMissing(err)) return { names: new Set(), exists: false };
    ctx.fail(`Cannot read ${relFolder}`, err);
    return undefined;
  }
}

/** Moves a folder into the trash (TRASH_DIR) under the name the MCP server gives what it trashes. */
async function moveFolderToTrash(ctx: SyncContext, relFolder: string): Promise<string> {
  const { trashDir, vaultResolved: vault } = ctx.config;
  const trashed = `${trashDir}/${trashedName(relFolder, ctx.now())}`;
  await fs.mkdir(resolveVaultPath(vault, trashDir), { recursive: true });
  await fs.rename(resolveVaultPath(vault, relFolder), resolveVaultPath(vault, trashed));
  return trashed;
}

/** Forgets what the sync knew about a list's tasks, so its deletion is not followed by one deletion per task. */
function forgetList(ctx: SyncContext, id: string) {
  delete ctx.state.tasklistFolders[id];
  delete ctx.state.knownTaskIds[id];
  delete ctx.state.tasksTokens[id];
}

/**
 * Brings the lists and the folders in line, before any task is pulled (so a task of a renamed list lands in the
 * renamed folder). In this order:
 *
 * 1. A list Google has and the vault does not know gets its folder. A list renamed in Google has its folder (and the
 *    folder's archive mirror) renamed. Two lists whose titles make the same folder name get one folder each: the one
 *    recorded first keeps the name, the next gets " (2)", and so on; a rename onto a folder that is already there gets
 *    a number the same way.
 * 2. A list renamed in Google whose folder is gone from the vault too was renamed on both sides. Google's name wins,
 *    the list stays the same list: the folder that now holds its notes is moved to Google's name.
 * 3. A list deleted in Google has its folder and archive mirror moved to the vault's trash.
 * 4. A known list whose folder is gone was renamed in the vault if its notes are now all in one folder that stands for
 *    no list: the list is renamed in Google. Without that evidence the folder was deleted, and so is the list in
 *    Google, its archive mirror going to the trash. An empty folder or list is not a deleted one: it stays.
 * 5. A folder that stands for no list gets a new list.
 *
 * Steps 3 to 5, and step 2 unless exactly one folder holds the list's notes, need a full view of the vault and wait
 * for a cycle in which every task note could be read; nothing runs until Google's lists were listed. A deletion in the
 * vault also needs {Tasks}/ itself to be there and is held back, like push's, when most lists vanish at once (an
 * unmounted volume looks exactly like that) unless ALLOW_MASS_DELETE is set.
 *
 * Returns the lists whose folder is not settled yet: their tasks are not pulled this cycle, so a pulled task cannot
 * bring back a folder that was renamed.
 */
export async function syncTasklistFolders(ctx: SyncContext): Promise<Set<string>> {
  const unsettled = new Set<string>();
  const info = await getTasklists(ctx);
  if (!info) return unsettled;
  const activeListing = await subfolders(ctx, taskFolder(DEFAULT_LIST));
  const archiveListing = await subfolders(ctx, toArchive(taskFolder(DEFAULT_LIST)));
  // A folder that cannot be listed would look like a deleted one.
  if (!activeListing || !archiveListing) return unsettled;
  const active = activeListing.names;
  const archive = archiveListing.names;

  const recorded = ctx.state.tasklistFolders;
  const lists = info.lists.filter((l): l is tasks_v1.Schema$TaskList & { id: string } =>
    Boolean(l.id && l.id !== info.defaultId),
  );
  // Lists deleted in Google; they stay recorded until their folders are in the trash (step 3).
  const goneInGoogle = Object.entries(recorded).filter(([id]) => !lists.some((l) => l.id === id));

  const makeFolder = async (name: string) => {
    if (active.has(name)) return;
    await fs.mkdir(resolveVaultPath(ctx.config.vaultResolved, taskFolder(name)), { recursive: true });
    active.add(name);
  };
  /** A name for a list's folder that no other list has and no folder but `own` already uses. */
  const freeName = (title: string, id: string, own: string[]) =>
    freeFolderName(recorded, title, id, new Set([...active, ...archive].filter((name) => !own.includes(name))));

  // 1. Google → vault
  const missing: { id: string; folder: string }[] = [];
  const renamedBoth: { id: string; folder: string; title: string }[] = [];
  for (const list of lists) {
    const title = titleAsFolder(list);
    const folder = recorded[list.id];
    if (folder !== undefined && isFolderFor(folder, title)) {
      if (!active.has(folder)) missing.push({ id: list.id, folder });
      continue;
    }
    if (folder === undefined) {
      const name = freeFolderName(recorded, title, list.id); // an existing folder of that name is adopted
      recorded[list.id] = name;
      await makeFolder(name);
      continue;
    }
    if (!active.has(folder)) {
      renamedBoth.push({ id: list.id, folder, title });
      continue;
    }
    const target = freeName(title, list.id, [folder]);
    await renameFolder(ctx, folder, target, active, archive);
    recorded[list.id] = target;
    ctx.log.info('Renamed a list folder after the list was renamed in Google', { from: folder, to: target });
  }

  const known = new Set([...Object.values(recorded), ...info.lists.map(titleAsFolder)]);
  const unknown = [...active].filter((name) => !known.has(name));
  if (missing.length + renamedBoth.length + unknown.length + goneInGoogle.length === 0) return unsettled;

  const scan = await scanTasks(ctx);
  /** The active folders that hold notes of a list and stand for no other list. */
  const homesOf = (id: string) => {
    const others = new Set(Object.entries(recorded).flatMap(([other, folder]) => (other === id ? [] : [folder])));
    return new Set(
      scan.notes
        .filter((n) => n.note.tasklist_id === id && !isArchivedPath(n.relFolder))
        .map((n) => listNameOfFolder(n.relFolder))
        .filter((name) => name !== DEFAULT_LIST && !others.has(name)),
    );
  };
  const forget = (name: string) => {
    if (unknown.includes(name)) unknown.splice(unknown.indexOf(name), 1);
  };

  // 2. Renamed on both sides: Google's name, the same list
  for (const { id, folder, title } of renamedBoth) {
    const homes = homesOf(id);
    const [home] = homes;
    if (homes.size !== 1 && !scan.complete) {
      unsettled.add(id);
      continue;
    }
    const target = homes.size === 1 && isFolderFor(home, title) ? home : freeName(title, id, [folder, home]);
    if (homes.size === 1) {
      if (home !== target) await renameFolder(ctx, home, target, active, new Set());
      forget(home);
    }
    // When no folder holds its notes, its folder was removed in the vault as well: it comes back under the new name.
    await makeFolder(target);
    if (archive.has(folder)) await renameFolder(ctx, folder, target, new Set(), archive);
    recorded[id] = target;
    ctx.log.info('A list was renamed in Google and in the vault; its folder takes the name from Google', {
      from: homes.size === 1 ? home : folder,
      to: target,
    });
  }

  if (!scan.complete) {
    ctx.log.warn('Leaving task list folders as they are: the vault was not fully readable this cycle');
    for (const { id } of missing) unsettled.add(id);
    return unsettled;
  }

  // 3. Google → vault: a deleted list
  for (const [id, folder] of goneInGoogle) {
    try {
      for (const rel of [taskFolder(folder), toArchive(taskFolder(folder))]) {
        const names = rel === taskFolder(folder) ? active : archive;
        if (!names.has(folder)) continue;
        const trashed = await moveFolderToTrash(ctx, rel);
        names.delete(folder);
        ctx.log.info('Moved the folder of a list deleted in Google to the trash', { folder: rel, trashed });
      }
      forgetList(ctx, id);
    } catch (err) {
      ctx.fail(`Could not move the folder of the deleted list "${folder}" to the trash`, err);
    }
  }

  // 4. Vault → Google: a renamed or deleted folder
  const deletedInVault: { id: string; folder: string }[] = [];
  for (const { id, folder } of missing) {
    const homes = homesOf(id);
    const [renamedTo] = homes;
    if (homes.size === 1 && unknown.includes(renamedTo)) {
      try {
        await ctx.tasks.tasklists.patch({ tasklist: id, requestBody: { title: renamedTo } });
      } catch (err) {
        ctx.fail(`Could not rename the list "${folder}" to "${renamedTo}"`, err);
        forget(renamedTo); // not a new list either: retried next cycle
        unsettled.add(id);
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
      forget(renamedTo);
      ctx.log.info('Renamed a list in Google after its folder was renamed', { from: folder, to: renamedTo });
    } else {
      deletedInVault.push({ id, folder });
    }
  }
  await deleteLists(ctx, deletedInVault, activeListing.exists, archive, unsettled);

  // 5. Vault → Google: a new folder
  for (const name of unknown) await createList(ctx, info, name);
  return unsettled;
}

/** Deletes in Google the lists whose folders were deleted in the vault, unless that looks like a fault. */
async function deleteLists(
  ctx: SyncContext,
  deleted: { id: string; folder: string }[],
  tasksFolderExists: boolean,
  archive: Set<string>,
  unsettled: Set<string>,
): Promise<void> {
  if (deleted.length === 0) return;
  const known = Object.keys(ctx.state.tasklistFolders).length;
  const reason = !tasksFolderExists
    ? `${taskFolder(DEFAULT_LIST)} itself is missing`
    : !ctx.config.allowMassDelete && isMassDeletion(deleted.length, known)
      ? `${deleted.length} of ${known} list folders vanished at once`
      : undefined;
  if (reason) {
    // Not recreated either: the folders' absence is kept as the open question it is, and asked again next cycle.
    ctx.fail(
      `Refusing to delete ${deleted.length} task list(s) in Google: ${reason}, which looks like a missing mount rather ` +
        'than a decision. If the deletion is intended, run once with ALLOW_MASS_DELETE=true.',
    );
    for (const { id } of deleted) unsettled.add(id);
    return;
  }

  for (const { id, folder } of deleted) {
    try {
      await ctx.tasks.tasklists.delete({ tasklist: id });
    } catch (err) {
      if (!isAlreadyGone(err)) {
        ctx.fail(`Could not delete the list "${folder}" in Google`, err);
        unsettled.add(id);
        continue;
      }
    }
    ctx.log.info('Deleted a list in Google (its folder was deleted in the vault)', { list: folder });
    const archived = toArchive(taskFolder(folder));
    if (archive.has(folder)) {
      try {
        ctx.log.info('Moved the archive folder of the deleted list to the trash', {
          trashed: await moveFolderToTrash(ctx, archived),
        });
      } catch (err) {
        ctx.fail(`Could not move ${archived} to the trash`, err);
      }
    }
    forgetList(ctx, id);
  }
}

/** Is `folder` the folder of a list titled `title`: the title itself, or the title with a " (n)" suffix? */
function isFolderFor(folder: string, title: string): boolean {
  return folder === title || (folder.startsWith(`${title} (`) && /^ \(\d+\)$/.test(folder.slice(title.length)));
}

/** The title, or the first "title (n)" from 2 up that no other list's folder has taken and `inUse` does not hold. */
function freeFolderName(
  recorded: Record<string, string>,
  title: string,
  ownId: string,
  inUse: Set<string> = new Set(),
): string {
  const taken = new Set(Object.entries(recorded).flatMap(([id, folder]) => (id === ownId ? [] : [folder])));
  let name = title;
  for (let n = 2; taken.has(name) || inUse.has(name); n++) name = `${title} (${n})`;
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
