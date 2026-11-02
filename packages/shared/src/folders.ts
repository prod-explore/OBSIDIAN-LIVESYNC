/**
 * The vault's fixed layout, as the Google sync lays it out and the MCP server must respect it. The names are fixed:
 * the sync reads notes only from these folders, and renaming one would look to it like every note in it was deleted.
 */
import * as path from 'path';

/** Open tasks: the default list's directly, every other list's in a subfolder named after the list. */
export const TASKS_FOLDER = '{Tasks}';

/** Events of the current and future months, one `YYYY-MM` subfolder per month. */
export const CALENDAR_FOLDER = '{Calendar}';

/** Mirrors {Tasks} and {Calendar} for finished tasks and past events. */
export const ARCHIVE_PREFIX = '04-Archive';

/** The sync's log of the edits it decided against, the copies of duplicate notes, and the vault owner's AGENTS.md. */
export const SYSTEMS_FOLDER = '_Systems';

/** The folders the sync reads notes from (the archive covers both of its mirrors). */
export const SYNCED_ROOTS: readonly string[] = [TASKS_FOLDER, CALENDAR_FOLDER, ARCHIVE_PREFIX];

/** The name of a month folder under {Calendar} and its archive mirror. */
const MONTH = /^\d{4}-\d{2}$/;

/** A folder the sync's layout is made of; see syncFolderKind. */
export type SyncFolderKind = 'layout' | 'task-list' | 'calendar-month';

/**
 * What a folder is to the sync, by its vault-relative path (either separator):
 *
 * - `layout`: the synced roots, the two archive mirrors and `_Systems`. The sync expects them to be there.
 * - `task-list`: a first-level folder of {Tasks} or its archive mirror. It stands for a Google Tasks list; deleting
 *   the active one deletes that list in Google, with every task in it.
 * - `calendar-month`: a `YYYY-MM` folder of {Calendar} or its archive mirror. Ingest and the archive sweep write
 *   notes into it as events arrive or months end; removing one, even empty, could race such a write.
 *
 * Undefined for every other folder, including those deeper inside the synced roots (a nested folder of a list belongs
 * to the list, but is not the list). Case-insensitive, like isInTrash: refusing `{tasks}` on a case-sensitive disk
 * is the cheaper mistake.
 */
export function syncFolderKind(relativePath: string): SyncFolderKind | undefined {
  const normalized = path.posix.normalize(relativePath.replace(/\\/g, '/')).replace(/^\.\/|\/+$/g, '');
  const parts = normalized.toLowerCase().split('/');
  const archived = parts[0] === ARCHIVE_PREFIX.toLowerCase();
  const [root, child, ...deeper] = archived ? parts.slice(1) : parts;

  if (root === undefined) return archived ? 'layout' : undefined; // `04-Archive` itself
  if (deeper.length > 0) return undefined;
  const tasks = root === TASKS_FOLDER.toLowerCase();
  const calendar = root === CALENDAR_FOLDER.toLowerCase();
  if (child === undefined) {
    return tasks || calendar || (!archived && root === SYSTEMS_FOLDER.toLowerCase()) ? 'layout' : undefined;
  }
  if (tasks) return 'task-list';
  if (calendar && MONTH.test(child)) return 'calendar-month';
  return undefined;
}
