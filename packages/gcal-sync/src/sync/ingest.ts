import type { calendar_v3, tasks_v1 } from 'googleapis';
import * as fs from 'fs/promises';
import * as path from 'path';
import { errorMessage, isFileMissing, isGone } from '../errors.js';
import { serializeNote } from '../markdown/frontmatter.js';
import { readEventNote, readTaskNote, type EventNote, type RawFrontmatter, type TaskNote } from '../markdown/notes.js';
import { resolveVaultPath, sanitizeTitle } from '../markdown/paths.js';
import { eventNotePath } from './archive.js';
import { logConflict } from './conflicts.js';
import type { SyncContext } from './context.js';
import { indexWinners } from './duplicates.js';
import { DEFAULT_LIST, isArchivedPath, taskFolder, toActive, toArchive } from './folders.js';
import { computeSyncHash, isLocallyModified } from './hash.js';
import { renameAndRefactorLinks } from './refactor.js';
import { readEventFile, readTaskFile, scanEvents, scanTasks } from './scan.js';
import { getTasklists } from './tasklists.js';

/** Events further ahead than this are not brought in: an endless recurrence would otherwise fill the vault. */
const MAX_DAYS_AHEAD = 730;
/** The very first calendar sync only looks this far back, so connecting an old account does not dump its history. */
const FIRST_SYNC_LOOKBACK_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

/** google_id → vault-relative path of the note that stands for it. */
type Index = Map<string, string>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function addToManifest(manifest: Record<string, string[]>, key: string, id: string) {
  if (!manifest[key]) manifest[key] = [];
  if (!manifest[key].includes(id)) manifest[key].push(id);
}

/** Runs `build` on first use only, so a cycle in which Google has nothing new never walks the vault. */
function lazy<T>(build: () => Promise<T>): () => Promise<T> {
  let value: Promise<T> | undefined;
  return () => (value ??= build());
}

async function writeNoteFile(fullPath: string, frontmatter: RawFrontmatter, body: string) {
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, serializeNote(frontmatter, body), 'utf-8');
}

const verbOf = (from: string, to: string) =>
  !isArchivedPath(from) && isArchivedPath(to)
    ? 'Archived'
    : isArchivedPath(from) && !isArchivedPath(to)
      ? 'Unarchived'
      : 'Relocated';

// ---------------------------------------------------------------------------
// Main ingest function
// ---------------------------------------------------------------------------

/**
 * Pulls what changed in Google since the last cycle into the vault. Each item is applied on its own: one that
 * cannot be written is logged and skipped, and the progress marker (sync token / watermark) is only moved
 * forward after a pass with no failure, so the skipped one is fetched again next cycle instead of being lost.
 */
export async function ingestGoogleData(ctx: SyncContext): Promise<void> {
  await ingestCalendars(ctx);
  await ingestTasks(ctx);
}

// ---------------------------------------------------------------------------
// Calendars
// ---------------------------------------------------------------------------

async function ingestCalendars(ctx: SyncContext) {
  const { config, state, calendar } = ctx;
  const getIndex: () => Promise<Index> = lazy(async () => indexWinners('event', (await scanEvents(ctx)).notes));

  for (const calId of config.calendarIds) {
    let syncToken: string | undefined = state.calendarTokens[calId];
    let pageToken: string | undefined;
    let nextSyncToken: string | undefined;
    let clean = true;

    for (;;) {
      let data: calendar_v3.Schema$Events;
      try {
        const response = await calendar.events.list({
          calendarId: calId,
          syncToken,
          pageToken,
          singleEvents: true,
          ...(!syncToken
            ? { timeMin: new Date(ctx.now().getTime() - FIRST_SYNC_LOOKBACK_DAYS * DAY_MS).toISOString() }
            : {}),
        });
        data = response.data;
      } catch (err) {
        if (isGone(err) && syncToken) {
          // Google no longer honours this token (idle for weeks, access changed). The documented answer is
          // to forget it and sync from scratch; notes are matched by id, so redoing work is harmless.
          ctx.log.warn('Sync token expired; starting a full sync', { calendar: calId });
          delete state.calendarTokens[calId];
          syncToken = undefined;
          pageToken = undefined;
          continue;
        }
        ctx.fail(`Could not pull calendar ${calId}`, err);
        clean = false;
        break;
      }

      const index = (data.items?.length ?? 0) > 0 ? await getIndex() : new Map<string, string>();
      for (const event of data.items ?? []) {
        try {
          await ingestEvent(ctx, calId, event, index);
        } catch (err) {
          ctx.fail(`Could not apply event ${event.id ?? '(no id)'}`, err);
          clean = false;
        }
      }

      nextSyncToken = data.nextSyncToken ?? nextSyncToken;
      pageToken = data.nextPageToken ?? undefined;
      if (!pageToken) break;
    }

    if (clean && nextSyncToken) state.calendarTokens[calId] = nextSyncToken;
  }
}

function remindersFromGoogle(reminders: calendar_v3.Schema$Event['reminders']): string[] | undefined {
  if (!reminders) return undefined;
  if (reminders.useDefault) return ['default'];
  return reminders.overrides?.map((r) => {
    const m = r.minutes || 0;
    if (m > 0 && m % 1440 === 0) return `${m / 1440}d`;
    if (m > 0 && m % 60 === 0) return `${m / 60}h`;
    return `${m}m`;
  });
}

async function ingestEvent(ctx: SyncContext, calId: string, event: calendar_v3.Schema$Event, index: Index) {
  const { config, state } = ctx;
  if (!event.id) return;

  const startRaw = event.start?.dateTime || event.start?.date;
  if (startRaw && (new Date(startRaw).getTime() - ctx.now().getTime()) / DAY_MS > MAX_DAYS_AHEAD) {
    return; // not ingested, not added to the manifest
  }

  const existingFile = index.get(event.id);

  // Cancelled in Google and never seen here: nothing to mark, so no note.
  if (event.status === 'cancelled' && !existingFile) return;

  let note: EventNote = {
    type: 'event',
    google_id: event.id,
    calendar_id: calId,
    source: 'google',
  };
  let body = ''; // the Markdown body belongs to Obsidian: Google data never overwrites it

  if (existingFile) {
    const found = await readEventFile(ctx, existingFile);
    // Start from the note as it is on disk, so properties the user added survive.
    note = { ...(found.raw as EventNote), ...note };
    body = found.body;

    const locallyModified = isLocallyModified(found.note, found.mtimeMs);
    const googleUpdatedMs = event.updated ? new Date(event.updated).getTime() : 0;

    if (locallyModified && found.mtimeMs >= googleUpdatedMs) {
      // Obsidian is the newer side: leave the note alone, push (which runs right after) sends it up.
      ctx.log.info('Obsidian is newer; leaving the note for push', { path: existingFile });
      addToManifest(state.knownEventIds, calId, event.id);
      return;
    }

    if (locallyModified) {
      // Genuine conflict and Google is newer: Google wins, the losing local version is logged.
      await logConflict(
        ctx,
        existingFile,
        { ...found.raw, mtime: new Date(found.mtimeMs).toISOString() }, // the whole front matter, so nothing the edit set is lost
        { title: event.summary, updated: event.updated },
        'Google is newer (Last-Write-Wins)',
      );
    }
  }

  // Google's data is authoritative for the synced fields.
  if (event.status === 'cancelled') {
    note.status = 'cancelled';
  } else {
    note.status = event.status === 'tentative' ? 'tentative' : 'confirmed';
    note.start = event.start?.dateTime || event.start?.date || '';
    note.end = event.end?.dateTime || event.end?.date || '';
  }

  note.title = event.summary || 'Untitled Event';
  // Google's description goes to the frontmatter, never to the body.
  if (event.description != null) note.description = event.description;

  if (event.reminders) {
    const reminders = remindersFromGoogle(event.reminders);
    if (reminders) note.reminders = reminders;
    else delete note.reminders;
  }

  note.updated = event.updated || ctx.now().toISOString();
  note.synced_at = ctx.now().toISOString();
  note.sync_hash = computeSyncHash(readEventNote(note).note);

  // Cancelled events arrive without start or title; renaming them would collapse every cancelled instance
  // into one "Untitled Event" dated today, so they stay where they are.
  const idealRelative =
    event.status === 'cancelled' && existingFile
      ? existingFile
      : eventNotePath(startRaw || '', event.summary || 'Untitled Event', event.id, ctx.now());

  // Write in place first (crash-safe), then move: a crash in between leaves a correct note at the old path.
  const writeRelative = existingFile ?? idealRelative;
  await writeNoteFile(resolveVaultPath(config.vaultResolved, writeRelative), note, body);

  let finalRelative = writeRelative;
  if (existingFile && existingFile !== idealRelative) {
    await renameAndRefactorLinks(ctx, existingFile, idealRelative);
    finalRelative = idealRelative;
    ctx.log.info(`${verbOf(existingFile, idealRelative)} event`, { from: existingFile, to: idealRelative });
  }

  index.set(event.id, finalRelative);
  addToManifest(state.knownEventIds, calId, event.id);
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

async function ingestTasks(ctx: SyncContext) {
  const { state, tasks } = ctx;
  const tasklists = await getTasklists(ctx);
  if (!tasklists) return; // Google could not be asked for the lists; the next cycle retries

  const getIndex: () => Promise<Index> = lazy(async () => indexWinners('task', (await scanTasks(ctx)).notes));

  for (const listObj of tasklists.lists) {
    const tasklistId = listObj.id;
    if (!tasklistId) continue;
    const isDefault = tasklistId === tasklists.defaultId;
    const listName = sanitizeTitle(listObj.title || 'Untitled List');
    const lastSync = state.tasksTokens[tasklistId];
    let pageToken: string | undefined;
    let newest: string | undefined; // highest `updated` seen in this pass
    let clean = true;

    for (;;) {
      let data: tasks_v1.Schema$Tasks;
      try {
        const response = await tasks.tasks.list({
          tasklist: tasklistId,
          showDeleted: true,
          showHidden: true,
          updatedMin: lastSync || undefined,
          pageToken,
          maxResults: 100,
        });
        data = response.data;
      } catch (err) {
        ctx.fail(`Could not pull task list ${tasklistId}`, err);
        clean = false;
        break;
      }

      const index = (data.items?.length ?? 0) > 0 ? await getIndex() : new Map<string, string>();
      for (const task of data.items ?? []) {
        if (task.updated && (!newest || task.updated > newest)) newest = task.updated;
        try {
          await ingestTask(ctx, { tasklistId, isDefault, listName }, task, index);
        } catch (err) {
          ctx.fail(`Could not apply task ${task.id ?? '(no id)'}`, err);
          clean = false;
        }
      }

      pageToken = data.nextPageToken || undefined;
      if (!pageToken) break;
    }

    // +1 ms because Google's updatedMin is inclusive: without it the newest task is fetched again every cycle.
    if (clean && newest) state.tasksTokens[tasklistId] = new Date(new Date(newest).getTime() + 1).toISOString();
  }
}

interface TaskList {
  tasklistId: string;
  isDefault: boolean;
  /** The list's title as a file name. */
  listName: string;
}

async function ingestTask(ctx: SyncContext, list: TaskList, task: tasks_v1.Schema$Task, index: Index) {
  const { config, state } = ctx;
  if (!task.id) return;

  const existingFile = index.get(task.id);

  // Deleted in Google and never seen here. That includes tasks this very sync deleted after a note was
  // removed: Google reports them on the next pull, and they must not come back as notes.
  if (task.deleted && !existingFile) return;

  let note: TaskNote = {
    type: 'task',
    google_id: task.id,
    tasklist_id: list.tasklistId,
    source: 'google',
  };
  let body = ''; // private Obsidian area

  if (existingFile) {
    const found = await readTaskFile(ctx, existingFile);
    note = { ...(found.raw as TaskNote), ...note };
    body = found.body;

    const locallyModified = isLocallyModified(found.note, found.mtimeMs);
    const googleUpdatedMs = task.updated ? new Date(task.updated).getTime() : 0;

    if (locallyModified && found.mtimeMs >= googleUpdatedMs) {
      ctx.log.info('Obsidian is newer; leaving the note for push', { path: existingFile });
      addToManifest(state.knownTaskIds, list.tasklistId, task.id);
      return;
    }

    if (locallyModified) {
      await logConflict(
        ctx,
        existingFile,
        { ...found.raw, mtime: new Date(found.mtimeMs).toISOString() }, // the whole front matter, so nothing the edit set is lost
        { title: task.title, updated: task.updated },
        'Google is newer (Last-Write-Wins)',
      );
    }
  }

  // Google's data is authoritative for the synced fields.
  if (task.deleted) {
    note.status = 'cancelled';
  } else {
    note.status = task.status === 'completed' ? 'completed' : 'needsAction';
    if (task.due) note.due = task.due.substring(0, 10); // YYYY-MM-DD
  }

  note.title = task.title || 'Untitled Task';
  // Google's notes go to the frontmatter description, never to the body.
  if (task.notes != null) note.description = task.notes;

  note.updated = task.updated || ctx.now().toISOString();
  note.synced_at = ctx.now().toISOString();
  note.sync_hash = computeSyncHash(readTaskNote(note).note);

  // The note's folder follows the task's status in both directions: open → {Tasks}, completed or
  // cancelled → 04-Archive/{Tasks}, and back if a task is re-opened in Google.
  const isArchived = note.status === 'completed' || note.status === 'cancelled';
  const currentlyArchived = existingFile ? isArchivedPath(existingFile) : false;

  let targetRelative: string;
  if (existingFile) {
    if (isArchived && !currentlyArchived) {
      targetRelative = toArchive(existingFile);
    } else if (!isArchived && currentlyArchived) {
      targetRelative = toActive(existingFile);
    } else {
      targetRelative = existingFile;
    }
  } else {
    // A new note gets a creation-date prefix that never changes, so the explorer sorts chronologically
    // without encoding anything mutable in the name.
    const createdPrefix = ctx.now().toISOString().slice(0, 10);
    const folder = taskFolder(list.isDefault ? DEFAULT_LIST : list.listName);
    const dir = isArchived ? toArchive(folder) : folder;
    targetRelative = `${dir}/${createdPrefix}-${sanitizeTitle(task.title || 'Untitled Task')}-${task.id.substring(0, 8)}.md`;
  }

  // Write the target first. If we crash before removing the old file, the next cycle finds the new one
  // (the active folder wins in the index) and removes the stale copy then.
  await writeNoteFile(resolveVaultPath(config.vaultResolved, targetRelative), note, body);

  if (existingFile && targetRelative !== existingFile) {
    try {
      await fs.unlink(resolveVaultPath(config.vaultResolved, existingFile));
      ctx.log.info(`${isArchived ? 'Archived' : 'Unarchived'} task`, { from: existingFile, to: targetRelative });
    } catch (err) {
      // ENOENT: already gone (double-cycle race), the new file is correct. Anything else is worth a line.
      if (!isFileMissing(err))
        ctx.log.warn(`Could not remove the old task file ${existingFile}`, { error: errorMessage(err) });
    }
  }

  index.set(task.id, targetRelative);
  addToManifest(state.knownTaskIds, list.tasklistId, task.id);
}
