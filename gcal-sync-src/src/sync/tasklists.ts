import { tasks_v1 } from 'googleapis';

export let tasklistsCache: tasks_v1.Schema$TaskList[] | null = null;
export let defaultTasklistId: string | undefined = undefined;

export async function fetchTasklists(tasks: tasks_v1.Tasks): Promise<void> {
  try {
    const listsRes = await tasks.tasklists.list();
    tasklistsCache = listsRes.data.items || [];
    const defRes = await tasks.tasklists.get({ tasklist: '@default' });
    defaultTasklistId = defRes.data.id || undefined;
  } catch (err: any) {
    console.error(`[TaskLists] Failed to fetch task lists:`, err.message);
  }
}

export async function resolveTasklistId(tasks: tasks_v1.Tasks, listName: string): Promise<string | undefined> {
  if (!tasklistsCache) await fetchTasklists(tasks);
  if (listName === '@default') return defaultTasklistId;
  
  let list = tasklistsCache?.find(l => l.title === listName);
  if (list) return list.id!;
  
  // Create it
  console.log(`[TaskLists] Creating new list in Google Tasks: ${listName}`);
  try {
    const res = await tasks.tasklists.insert({ requestBody: { title: listName } });
    const newList = res.data;
    tasklistsCache?.push(newList);
    return newList.id!;
  } catch (err: any) {
    console.error(`[TaskLists] Failed to create list ${listName}:`, err.message);
    return undefined;
  }
}
