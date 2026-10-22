import { ARCHIVE_PREFIX } from './archive.js';

/** The two synced folders. Their names are fixed. */
export const TASKS_FOLDER = '{Tasks}';
export const CALENDAR_FOLDER = '{Calendar}';

/** The name Google Tasks gives its default list; its tasks live directly in {Tasks}/, any other list in a subfolder. */
export const DEFAULT_LIST = '@default';

export const isArchivedPath = (relative: string): boolean => relative.startsWith(`${ARCHIVE_PREFIX}/`);

/** A folder or note path outside the archive: `04-Archive/{Tasks}/Project A` -> `{Tasks}/Project A` (a path that is not archived is returned as it is). */
export function toActive(relFolder: string): string {
  return isArchivedPath(relFolder) ? relFolder.slice(ARCHIVE_PREFIX.length + 1) : relFolder;
}

/** The same path inside the archive: `{Tasks}/Project A` -> `04-Archive/{Tasks}/Project A` (a path that is already archived is returned as it is). */
export function toArchive(relFolder: string): string {
  return isArchivedPath(relFolder) ? relFolder : `${ARCHIVE_PREFIX}/${relFolder}`;
}

/** The task list a folder stands for: `{Tasks}` is the default list, `{Tasks}/Project A` is "Project A", the archive mirrors both. */
export function listNameOfFolder(relFolder: string): string {
  const parts = toActive(relFolder).split('/');
  return parts[0] === TASKS_FOLDER && parts.length > 1 ? parts[1] : DEFAULT_LIST;
}

/** The active folder of a task list (the inverse of `listNameOfFolder`). `listName` is already safe for a file name. */
export function taskFolder(listName: string): string {
  return listName === DEFAULT_LIST ? TASKS_FOLDER : `${TASKS_FOLDER}/${listName}`;
}
