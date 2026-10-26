/** Pushing task notes: {Tasks}/… to Google Tasks, one subfolder per list other than the default one. */
import type { tasks_v1 } from 'googleapis';
import * as fs from 'fs/promises';
import * as path from 'path';
import { errorMessage } from '../../errors.js';
import type { TaskNote } from '../../markdown/notes.js';
import { resolveVaultPath, sanitizeTitle } from '../../markdown/paths.js';
import type { SyncContext } from '../context.js';
import { isArchivedPath, listNameOfFolder, toActive, toArchive } from '../folders.js';
import { computeSyncHash } from '../hash.js';
import type { ScannedNote } from '../scan.js';
import { scanTasks } from '../scan.js';
import { findTasklistId, getTasklists, resolveTasklistId } from '../tasklists.js';
import type { NoteKind } from './folder.js';
import { fallbackTitle, insertWithMarker, saveNote, type PushOutcome } from './shared.js';

export const taskKind: NoteKind<TaskNote> = {
  noun: 'task',
  scan: scanTasks,
  // A note without tasklist_id (written by hand) belongs to the list of its folder.
  containerOf: async (ctx, entry) => entry.note.tasklist_id || findTasklistId(ctx, listNameOfFolder(entry.relFolder)),
  manifest: (state) => state.knownTaskIds,
  async hasMoved(ctx, entry) {
    const target = await listOfFolder(ctx, entry.relFolder);
    return Boolean(target && entry.note.tasklist_id && entry.note.tasklist_id !== target);
  },
  push: pushTaskNote,
  async deleteRemote(ctx, listId, id) {
    await ctx.tasks.tasks.delete({ tasklist: listId, task: id });
  },
};

/**
 * The list a note's folder stands for. An active folder with no list gets one; an archive folder never does
 * (archived means archived), so for one that matches no list this is undefined.
 */
function listOfFolder(ctx: SyncContext, relFolder: string): Promise<string | undefined> {
  const listName = listNameOfFolder(relFolder);
  return isArchivedPath(relFolder) ? findTasklistId(ctx, listName) : resolveTasklistId(ctx, listName);
}

/**
 * Creates or updates the task on Google, then files the note under 04-Archive or back out of it to match its status.
 * Returns undefined, with the note flagged, when its folder stands for no list the task may go to.
 */
async function pushTaskNote(
  ctx: SyncContext,
  entry: ScannedNote<TaskNote>,
  isNew: boolean,
): Promise<PushOutcome | undefined> {
  const { tasks, config, state } = ctx;
  const note: TaskNote = { ...entry.note };

  // "{Tasks}" and "04-Archive/{Tasks}" are the default list; "{Tasks}/Project A" and its archive mirror are
  // "Project A".
  // No fallback to some other list when Google cannot be asked: filing the task in the wrong list now would
  // only be undone (delete and re-create) by the next cycle. The error is logged by the caller and retried.
  const listName = listNameOfFolder(entry.relFolder);
  const tasklistId = await listOfFolder(ctx, entry.relFolder);
  if (!tasklistId) {
    if (!(await getTasklists(ctx))) throw new Error(`could not determine the Google task list for "${listName}"`);
    ctx.flag(
      entry.relative,
      isArchivedPath(entry.relFolder)
        ? `its archive folder "${listName}" stands for no task list, and archived folders never create one`
        : `the list of its folder "${listName}" was deleted in Google; the folder goes to the trash once the vault is fully readable`,
    );
    return undefined;
  }

  let create = isNew;
  if (!create && note.google_id && note.tasklist_id && note.tasklist_id !== tasklistId) {
    // The note was moved to another list's folder in Obsidian: the task is deleted from the old list and created in
    // the new one.
    try {
      await tasks.tasks.delete({ tasklist: note.tasklist_id, task: note.google_id });
      ctx.log.info('Task moved to another list; deleted it from the old one', {
        googleId: note.google_id,
        from: note.tasklist_id,
        to: tasklistId,
      });
    } catch (err) {
      ctx.log.warn('Task moved to another list, but deleting it from the old one failed; continuing', {
        googleId: note.google_id,
        error: errorMessage(err),
      });
    }
    delete note.google_id;
    create = true;
  }

  const title = note.title || fallbackTitle(entry.file, sanitizeTitle);
  const payload: tasks_v1.Schema$Task = { title };
  // Google Tasks only knows "needsAction" and "completed": a note marked cancelled stays a note-side state.
  if (note.status && note.status !== 'cancelled') payload.status = note.status;
  if (note.due) payload.due = new Date(note.due).toISOString();
  // The description syncs to Google's notes. The Markdown body (below ---) stays private to Obsidian and is never sent.
  if (note.description != null) payload.notes = note.description;

  let res: { data: tasks_v1.Schema$Task };
  let googleId: string;
  if (create) {
    note.tasklist_id = tasklistId;
    note.type = 'task';
    res = await insertWithMarker(entry, note, () => tasks.tasks.insert({ tasklist: tasklistId, requestBody: payload }));

    if (!res.data.id) throw new Error('Google did not return an id for the new task');
    googleId = res.data.id;
    note.google_id = googleId;
    delete note.push_pending;
    note.source = 'obsidian';
    ctx.log.info('Created task', { googleId, path: entry.relative });
  } else {
    if (!note.google_id) throw new Error('an existing task has no google_id'); // cannot happen: create is true without one
    googleId = note.google_id;
    payload.id = googleId;
    res = await tasks.tasks.patch({ tasklist: tasklistId, task: googleId, requestBody: payload });
    ctx.log.info('Updated task', { googleId, path: entry.relative });
  }

  note.updated = res.data.updated || ctx.now().toISOString();
  note.synced_at = ctx.now().toISOString();
  note.sync_hash = computeSyncHash(note);

  // A finished task goes into the archive and a re-opened one comes back out. The note is written in place first
  // and renamed after: a crash in between leaves the right content in the old place, and the next ingest moves it.
  const fromArchive = isArchivedPath(entry.relFolder);
  const isFinished = note.status === 'completed' || note.status === 'cancelled';
  const shouldArchive = isFinished && !fromArchive;
  const shouldUnarchive = !isFinished && fromArchive;

  await saveNote(entry.fullPath, note, entry.body);

  if (shouldArchive || shouldUnarchive) {
    // Same list folder, other side of the archive boundary: a task never changes list by being completed.
    const targetRelative = `${shouldArchive ? toArchive(entry.relFolder) : toActive(entry.relFolder)}/${entry.file}`;
    const targetPath = resolveVaultPath(config.vaultResolved, targetRelative);
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    try {
      await fs.rename(entry.fullPath, targetPath);
      ctx.log.info(shouldArchive ? 'Archived task' : 'Unarchived task', { path: targetRelative });
    } catch (err) {
      // Non-fatal: the content is written correctly where the file is; the next ingest moves it once Google confirms
      // the status.
      ctx.log.warn(`Could not ${shouldArchive ? 'archive' : 'unarchive'} ${entry.file}`, { error: errorMessage(err) });
    }
  }

  const known = (state.knownTaskIds[tasklistId] ??= []);
  if (!known.includes(googleId)) known.push(googleId);

  return { googleId, containerId: tasklistId };
}
