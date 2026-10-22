import { calendar_v3, tasks_v1 } from 'googleapis';
import * as fs from 'fs/promises';
import * as path from 'path';
import { Config } from '../config.js';
import { SyncState } from './state.js';
import { parseNote, serializeNote } from '../markdown/frontmatter.js';
import { sanitizeTitle, resolveVaultPath } from '../markdown/paths.js';
import { computeSyncHash, isLocallyModified } from './hash.js';
import { ARCHIVE_PREFIX, eventNotePath } from './archive.js';
import { getTasklists } from './tasklists.js';
import { logConflict } from './conflicts.js';
import { renameAndRefactorLinks } from './refactor.js';
import { DEFAULT_LIST, toActive, toArchive, isArchivedPath, taskFolder } from './folders.js';

/** Events further ahead than this are not brought in: an endless recurrence would otherwise fill the vault. */
const MAX_DAYS_AHEAD = 730;
/** The very first calendar sync only looks this far back, so connecting an old account does not dump its history. */
const FIRST_SYNC_LOOKBACK_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

type Frontmatter = Record<string, any>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function addToManifest(manifest: Record<string, string[]>, key: string, id: string) {
  if (!manifest[key]) manifest[key] = [];
  if (!manifest[key].includes(id)) manifest[key].push(id);
}

const isGone = (err: any) => err?.code === 410 || err?.status === 410;

/**
 * Maps google_id → vault-relative path for every note under `folder` and its archive mirror (recursive, so
 * {Calendar}/YYYY-MM/ is covered). Built once per ingest instead of searching the tree for every item. The
 * active folder is read first and wins, so a stale copy left by an interrupted move resolves to the live one.
 */
async function indexByGoogleId(vaultRoot: string, folder: string): Promise<Map<string, string>> {
  const index = new Map<string, string>();

  async function walk(relFolder: string): Promise<void> {
    let dir: string;
    try {
      dir = resolveVaultPath(vaultRoot, relFolder);
    } catch {
      return; // path traversal guard
    }
    let entries: import('fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (err: any) {
      if (err.code !== 'ENOENT') console.error(`[Ingest] Error reading ${relFolder}:`, err.message);
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const rel = `${relFolder}/${entry.name}`;
      if (entry.isDirectory()) {
        await walk(rel);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        let content: string;
        try {
          content = await fs.readFile(path.join(dir, entry.name), 'utf-8');
        } catch {
          continue;
        }
        const id = parseNote(content).frontmatter.google_id;
        if (id != null && !index.has(String(id))) index.set(String(id), rel);
      }
    }
  }

  await walk(folder);
  await walk(`${ARCHIVE_PREFIX}/${folder}`);
  return index;
}

/** Runs `build` on first use only, so a cycle in which Google has nothing new never walks the vault. */
function lazy<T>(build: () => Promise<T>): () => Promise<T> {
  let value: Promise<T> | undefined;
  return () => (value ??= build());
}

async function writeNoteFile(fullPath: string, frontmatter: Frontmatter, body: string) {
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, serializeNote(frontmatter, body), 'utf-8');
}

// ---------------------------------------------------------------------------
// Main ingest function
// ---------------------------------------------------------------------------

/**
 * Pulls what changed in Google since the last cycle into the vault. Each item is applied on its own: one that
 * cannot be written is logged and skipped, and the progress marker (sync token / watermark) is only moved
 * forward after a pass with no failure, so the skipped one is fetched again next cycle instead of being lost.
 */
export async function ingestGoogleData(
  config: Config,
  state: SyncState,
  calendar: calendar_v3.Calendar,
  tasks: tasks_v1.Tasks
) {
  await ingestCalendars(config, state, calendar);
  await ingestTasks(config, state, tasks);
}

// ---------------------------------------------------------------------------
// Calendars
// ---------------------------------------------------------------------------

async function ingestCalendars(config: Config, state: SyncState, calendar: calendar_v3.Calendar) {
  const getIndex = lazy(() => indexByGoogleId(config.vaultResolved, '{Calendar}'));

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
          ...(!syncToken ? { timeMin: new Date(Date.now() - FIRST_SYNC_LOOKBACK_DAYS * DAY_MS).toISOString() } : {}),
        });
        data = response.data;
      } catch (err: any) {
        if (isGone(err) && syncToken) {
          // Google no longer honours this token (idle for weeks, access changed). The documented answer is
          // to forget it and sync from scratch; notes are matched by id, so redoing work is harmless.
          console.warn(`[Ingest] Sync token for calendar ${calId} expired. Starting a full sync.`);
          delete state.calendarTokens[calId];
          syncToken = undefined;
          pageToken = undefined;
          continue;
        }
        console.error(`[Ingest] Error pulling calendar ${calId}:`, err.message);
        clean = false;
        break;
      }

      const index = (data.items?.length ?? 0) > 0 ? await getIndex() : new Map<string, string>();
      for (const event of data.items ?? []) {
        try {
          await ingestEvent(config, state, calId, event, index);
        } catch (err: any) {
          console.error(`[Ingest] Could not apply event ${event.id}:`, err.message);
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

async function ingestEvent(
  config: Config,
  state: SyncState,
  calId: string,
  event: calendar_v3.Schema$Event,
  index: Map<string, string>
) {
  if (!event.id) return;

  const startRaw = event.start?.dateTime || event.start?.date;
  if (startRaw && (new Date(startRaw).getTime() - Date.now()) / DAY_MS > MAX_DAYS_AHEAD) {
    return; // not ingested, not added to the manifest
  }

  const existingFile = index.get(event.id);

  // Cancelled in Google and never seen here: nothing to mark, so no note.
  if (event.status === 'cancelled' && !existingFile) return;

  let frontmatter: Frontmatter = {
    type: 'event',
    google_id: event.id,
    calendar_id: calId,
    source: 'google',
  };
  let body = ''; // the Markdown body belongs to Obsidian: Google data never overwrites it

  if (existingFile) {
    const fullPath = resolveVaultPath(config.vaultResolved, existingFile);
    const stat = await fs.stat(fullPath);
    const parsed = parseNote(await fs.readFile(fullPath, 'utf-8'));
    frontmatter = { ...parsed.frontmatter, ...frontmatter };
    body = parsed.body;

    const locallyModified = isLocallyModified(frontmatter, stat.mtimeMs);
    const googleUpdatedMs = event.updated ? new Date(event.updated).getTime() : 0;

    if (locallyModified && stat.mtimeMs >= googleUpdatedMs) {
      // Obsidian is the newer side: leave the note alone, push (which runs right after) sends it up.
      console.log(`[Ingest][LWW] Obsidian newer for ${existingFile} — deferring to push`);
      addToManifest(state.knownEventIds, calId, event.id);
      return;
    }

    if (locallyModified) {
      // Genuine conflict and Google is newer: Google wins, the losing local version is logged.
      await logConflict(
        config.vaultResolved,
        existingFile,
        { title: frontmatter.title, mtime: new Date(stat.mtimeMs).toISOString() },
        { title: event.summary, updated: event.updated },
        'Google is newer (Last-Write-Wins)'
      );
    }
  }

  // Google's data is authoritative for the synced fields.
  if (event.status === 'cancelled') {
    frontmatter.status = 'cancelled';
  } else {
    frontmatter.status = event.status || 'confirmed';
    frontmatter.start = event.start?.dateTime || event.start?.date || '';
    frontmatter.end = event.end?.dateTime || event.end?.date || '';
  }

  frontmatter.title = event.summary || 'Untitled Event';
  // Google's description goes to the frontmatter, never to the body.
  if (event.description != null) frontmatter.description = event.description;

  if (event.reminders) {
    if (event.reminders.useDefault) {
      frontmatter.reminders = ['default'];
    } else if (event.reminders.overrides) {
      frontmatter.reminders = event.reminders.overrides.map((r) => {
        const m = r.minutes || 0;
        if (m > 0 && m % 1440 === 0) return `${m / 1440}d`;
        if (m > 0 && m % 60 === 0) return `${m / 60}h`;
        return `${m}m`;
      });
    } else {
      delete frontmatter.reminders;
    }
  }

  frontmatter.updated = event.updated || new Date().toISOString();
  frontmatter.synced_at = new Date().toISOString();
  frontmatter.sync_hash = computeSyncHash(frontmatter);

  // Cancelled events arrive without start or title; renaming them would collapse every cancelled instance
  // into one "Untitled Event" dated today, so they stay where they are.
  const idealRelative =
    event.status === 'cancelled' && existingFile
      ? existingFile
      : eventNotePath(startRaw || '', event.summary || 'Untitled Event', event.id);

  // Write in place first (crash-safe), then move: a crash in between leaves a correct note at the old path.
  const writeRelative = existingFile ?? idealRelative;
  await writeNoteFile(resolveVaultPath(config.vaultResolved, writeRelative), frontmatter, body);

  let finalRelative = writeRelative;
  if (existingFile && existingFile !== idealRelative) {
    const wasArchived = existingFile.startsWith(`${ARCHIVE_PREFIX}/`);
    const nowArchived = idealRelative.startsWith(`${ARCHIVE_PREFIX}/`);
    const verb = !wasArchived && nowArchived ? 'Archived' : wasArchived && !nowArchived ? 'Unarchived' : 'Relocated';
    await renameAndRefactorLinks(config.vaultResolved, existingFile, idealRelative);
    finalRelative = idealRelative;
    console.log(`[Ingest] ${verb} event: ${existingFile} → ${idealRelative}`);
  }

  index.set(event.id, finalRelative);
  addToManifest(state.knownEventIds, calId, event.id);
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

async function ingestTasks(config: Config, state: SyncState, tasks: tasks_v1.Tasks) {
  const tasklists = await getTasklists(tasks);
  if (!tasklists) return; // Google could not be asked for the lists; the next cycle retries

  const getIndex = lazy(() => indexByGoogleId(config.vaultResolved, '{Tasks}'));

  for (const listObj of tasklists.lists) {
    const tasklistId = listObj.id!;
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
      } catch (err: any) {
        console.error(`[Ingest] Error pulling tasklist ${tasklistId}:`, err.message);
        clean = false;
        break;
      }

      const index = (data.items?.length ?? 0) > 0 ? await getIndex() : new Map<string, string>();
      for (const task of data.items ?? []) {
        if (task.updated && (!newest || task.updated > newest)) newest = task.updated;
        try {
          await ingestTask(config, state, tasklistId, isDefault, listName, task, index);
        } catch (err: any) {
          console.error(`[Ingest] Could not apply task ${task.id}:`, err.message);
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

async function ingestTask(
  config: Config,
  state: SyncState,
  tasklistId: string,
  isDefault: boolean,
  listName: string,
  task: tasks_v1.Schema$Task,
  index: Map<string, string>
) {
  if (!task.id) return;

  const existingFile = index.get(task.id);

  // Deleted in Google and never seen here. That includes tasks this very sync deleted after a note was
  // removed: Google reports them on the next pull, and they must not come back as notes.
  if (task.deleted && !existingFile) return;

  let frontmatter: Frontmatter = {
    type: 'task',
    google_id: task.id,
    tasklist_id: tasklistId,
    source: 'google',
  };
  let body = ''; // private Obsidian area

  if (existingFile) {
    const fullPath = resolveVaultPath(config.vaultResolved, existingFile);
    const stat = await fs.stat(fullPath);
    const parsed = parseNote(await fs.readFile(fullPath, 'utf-8'));
    frontmatter = { ...parsed.frontmatter, ...frontmatter };
    body = parsed.body;

    const locallyModified = isLocallyModified(frontmatter, stat.mtimeMs);
    const googleUpdatedMs = task.updated ? new Date(task.updated).getTime() : 0;

    if (locallyModified && stat.mtimeMs >= googleUpdatedMs) {
      console.log(`[Ingest][LWW] Obsidian newer for ${existingFile} — deferring to push`);
      addToManifest(state.knownTaskIds, tasklistId, task.id);
      return;
    }

    if (locallyModified) {
      await logConflict(
        config.vaultResolved,
        existingFile,
        { title: frontmatter.title, mtime: new Date(stat.mtimeMs).toISOString() },
        { title: task.title, updated: task.updated },
        'Google is newer (Last-Write-Wins)'
      );
    }
  }

  // Google's data is authoritative for the synced fields.
  if (task.deleted) {
    frontmatter.status = 'cancelled';
  } else {
    frontmatter.status = task.status || 'needsAction';
    if (task.due) frontmatter.due = task.due.substring(0, 10); // YYYY-MM-DD
  }

  frontmatter.title = task.title || 'Untitled Task';
  // Google's notes go to the frontmatter description, never to the body.
  if (task.notes != null) frontmatter.description = task.notes;

  frontmatter.updated = task.updated || new Date().toISOString();
  frontmatter.synced_at = new Date().toISOString();
  frontmatter.sync_hash = computeSyncHash(frontmatter);

  // The note's folder follows the task's status in both directions: open → {Tasks}, completed or
  // cancelled → 04-Archive/{Tasks}, and back if a task is re-opened in Google.
  const isArchived = frontmatter.status === 'completed' || frontmatter.status === 'cancelled';
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
    const createdPrefix = new Date().toISOString().slice(0, 10);
    const folder = taskFolder(isDefault ? DEFAULT_LIST : listName);
    const dir = isArchived ? toArchive(folder) : folder;
    targetRelative = `${dir}/${createdPrefix}-${sanitizeTitle(task.title || 'Untitled Task')}-${task.id.substring(0, 8)}.md`;
  }

  // Write the target first. If we crash before removing the old file, the next cycle finds the new one
  // (the active folder wins in the index) and removes the stale copy then.
  await writeNoteFile(resolveVaultPath(config.vaultResolved, targetRelative), frontmatter, body);

  if (existingFile && targetRelative !== existingFile) {
    try {
      await fs.unlink(resolveVaultPath(config.vaultResolved, existingFile));
      console.log(`[Ingest] ${isArchived ? 'Archived' : 'Unarchived'} task: ${existingFile} → ${targetRelative}`);
    } catch (err: any) {
      // ENOENT: already gone (double-cycle race), the new file is correct. Anything else is worth a line.
      if (err.code !== 'ENOENT') {
        console.error(`[Ingest] Could not remove old task file (${existingFile}):`, err.message);
      }
    }
  }

  index.set(task.id, targetRelative);
  addToManifest(state.knownTaskIds, tasklistId, task.id);
}
