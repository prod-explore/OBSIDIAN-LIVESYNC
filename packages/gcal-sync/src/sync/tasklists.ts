import { tasks_v1 } from 'googleapis';
import { sanitizeTitle } from '../markdown/paths.js';
import type { SyncContext } from './context.js';

export interface TasklistInfo {
  lists: tasks_v1.Schema$TaskList[];
  /** The id behind the alias "@default"; its tasks live directly in {Tasks}/, other lists in a subfolder named after them. */
  defaultId: string | undefined;
}

// One lookup per Google client. A client lives for one sync cycle, so a list created or renamed in Google
// is seen on the next cycle. (A process-wide cache only saw it after a restart.)
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

/**
 * The Google id of the list a vault folder stands for: "@default" is the default list, any other name is
 * matched against list titles as they appear on disk (illegal filename characters already replaced) and
 * created when missing. Returns undefined only when Google cannot be reached.
 */
export async function resolveTasklistId(ctx: SyncContext, listName: string): Promise<string | undefined> {
  const info = await getTasklists(ctx);
  if (!info) return undefined;
  if (listName === '@default') return info.defaultId;

  const existing = info.lists.find((l) => sanitizeTitle(l.title || 'Untitled List') === listName);
  if (existing) return existing.id!;

  ctx.log.info('Creating a new list in Google Tasks', { list: listName });
  try {
    const res = await ctx.tasks.tasklists.insert({ requestBody: { title: listName } });
    info.lists.push(res.data);
    return res.data.id!;
  } catch (err) {
    ctx.fail(`Could not create the list "${listName}"`, err);
    return undefined;
  }
}
