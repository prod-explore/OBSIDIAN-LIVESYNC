import { tasks_v1 } from 'googleapis';
import { sanitizeTitle } from '../markdown/paths.js';

export interface TasklistInfo {
  lists: tasks_v1.Schema$TaskList[];
  /** The id behind the alias "@default"; its tasks live directly in {Tasks}/, other lists in a subfolder named after them. */
  defaultId: string | undefined;
}

// One lookup per Google client. A client lives for one sync cycle, so a list created or renamed in Google
// is seen on the next cycle. (A process-wide cache only saw it after a restart.)
const lookups = new WeakMap<tasks_v1.Tasks, TasklistInfo>();

/** All task lists of the account, or null when Google could not be asked (callers skip the work and retry next cycle). */
export async function getTasklists(tasks: tasks_v1.Tasks): Promise<TasklistInfo | null> {
  const known = lookups.get(tasks);
  if (known) return known;
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
  } catch (err: any) {
    console.error(`[TaskLists] Failed to fetch task lists:`, err.message);
    return null;
  }
}

/**
 * The Google id of the list a vault folder stands for: "@default" is the default list, any other name is
 * matched against list titles as they appear on disk (illegal filename characters already replaced) and
 * created when missing. Returns undefined only when Google cannot be reached.
 */
export async function resolveTasklistId(tasks: tasks_v1.Tasks, listName: string): Promise<string | undefined> {
  const info = await getTasklists(tasks);
  if (!info) return undefined;
  if (listName === '@default') return info.defaultId;

  const existing = info.lists.find((l) => sanitizeTitle(l.title || 'Untitled List') === listName);
  if (existing) return existing.id!;

  console.log(`[TaskLists] Creating new list in Google Tasks: ${listName}`);
  try {
    const res = await tasks.tasklists.insert({ requestBody: { title: listName } });
    info.lists.push(res.data);
    return res.data.id!;
  } catch (err: any) {
    console.error(`[TaskLists] Failed to create list ${listName}:`, err.message);
    return undefined;
  }
}
