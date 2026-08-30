import { calendar_v3, tasks_v1 } from 'googleapis';
import * as fs from 'fs/promises';
import { Config } from '../config.js';
import { SyncState } from './state.js';
import { parseNote, serializeNote } from '../markdown/frontmatter.js';
import { resolveVaultPath, sanitizeTitle } from '../markdown/paths.js';
import { computeSyncHash } from './hash.js';

// ---------------------------------------------------------------------------
// Main push function
// ---------------------------------------------------------------------------

export async function pushVaultData(
  config: Config,
  state: SyncState,
  calendar: calendar_v3.Calendar,
  tasks: tasks_v1.Tasks
) {
  await pushFolder('{Tasks}',    config, state, calendar, tasks);
  await pushFolder('{Calendar}', config, state, calendar, tasks);
}

// ---------------------------------------------------------------------------
// Per-folder orchestration
// ---------------------------------------------------------------------------

async function pushFolder(
  folder: '{Tasks}' | '{Calendar}',
  config: Config,
  state: SyncState,
  calendar: calendar_v3.Calendar,
  tasks: tasks_v1.Tasks
) {
  let folderPath: string;
  try {
    folderPath = resolveVaultPath(config.vaultResolved, folder);
  } catch {
    return;
  }

  let files: string[] = [];
  try {
    files = await fs.readdir(folderPath);
  } catch {
    return; // Folder doesn't exist yet — nothing to push.
  }

  // Collect every google_id currently present in the folder (per list/calendar).
  // We'll use this to diff against the known-ID manifest and detect deletions.
  const presentIdsByList = new Map<string, Set<string>>();

  for (const file of files) {
    if (!file.endsWith('.md') || file.startsWith('README')) continue;

    let fullPath: string;
    try {
      fullPath = resolveVaultPath(config.vaultResolved, `${folder}/${file}`);
    } catch {
      continue;
    }

    const stat    = await fs.stat(fullPath);
    const content = await fs.readFile(fullPath, 'utf-8');
    const { frontmatter, body } = parseNote(content);

    // Determine which list/calendar this file belongs to.
    const listId: string =
      folder === '{Tasks}'
        ? (frontmatter.tasklist_id || config.tasklistIds[0])
        : (frontmatter.calendar_id || config.calendarIds[0]);

    // Track presence (before any mutations that might add a google_id).
    if (frontmatter.google_id) {
      if (!presentIdsByList.has(listId)) presentIdsByList.set(listId, new Set());
      presentIdsByList.get(listId)!.add(frontmatter.google_id);
    }

    // ------------------------------------------------------------------
    // Crash-recovery: a previous insert completed but the local write
    // of google_id didn't (push_pending=true, no google_id).
    // ------------------------------------------------------------------
    if (frontmatter.push_pending === true && !frontmatter.google_id) {
      // Re-attempt the insert. Worst case: one extra duplicate in Google
      // (very rare — crash must happen in a sub-second window).
      await handleFile(folder, file, fullPath, frontmatter, body, config, state, calendar, tasks, true);
      // Re-read to pick up the now-written google_id for present-set tracking.
      try {
        const updated = parseNote(await fs.readFile(fullPath, 'utf-8'));
        if (updated.frontmatter.google_id) {
          if (!presentIdsByList.has(listId)) presentIdsByList.set(listId, new Set());
          presentIdsByList.get(listId)!.add(updated.frontmatter.google_id);
        }
      } catch { /* ignore */ }
      continue;
    }

    // ------------------------------------------------------------------
    // Crash-recovery: insert succeeded, google_id written, but
    // push_pending flag was never cleared (extremely rare).
    // ------------------------------------------------------------------
    if (frontmatter.push_pending === true && frontmatter.google_id) {
      frontmatter.push_pending = undefined;
      frontmatter.synced_at    = new Date().toISOString();
      await fs.writeFile(fullPath, serializeNote(frontmatter, body), 'utf-8');
      continue;
    }

    // ------------------------------------------------------------------
    // Normal flow
    // ------------------------------------------------------------------
    const isNew = !frontmatter.google_id;
    
    const currentHash = computeSyncHash(frontmatter);
    const locallyModified = frontmatter.sync_hash
      ? frontmatter.sync_hash !== currentHash
      : (frontmatter.synced_at ? stat.mtimeMs > new Date(frontmatter.synced_at).getTime() + 2000 : false);

    // Skip files that were created by Google and haven't been locally touched.
    if (isNew && frontmatter.source === 'google') continue;

    // Nothing changed locally.
    if (!isNew && !locallyModified) continue;

    await handleFile(folder, file, fullPath, frontmatter, body, config, state, calendar, tasks, isNew);

    // Re-read to pick up google_id written during create.
    if (isNew) {
      try {
        const updated = parseNote(await fs.readFile(fullPath, 'utf-8'));
        if (updated.frontmatter.google_id) {
          if (!presentIdsByList.has(listId)) presentIdsByList.set(listId, new Set());
          presentIdsByList.get(listId)!.add(updated.frontmatter.google_id);
        }
      } catch { /* ignore */ }
    }
  }

  // ------------------------------------------------------------------
  // Deletion detection: IDs in the manifest that no longer have a
  // corresponding file → delete from Google.
  // ------------------------------------------------------------------
  const manifest =
    folder === '{Tasks}' ? state.knownTaskIds : state.knownEventIds;

  for (const [listId, knownIds] of Object.entries(manifest)) {
    const present = presentIdsByList.get(listId) ?? new Set<string>();

    for (const knownId of knownIds) {
      if (present.has(knownId)) continue;

      // File is gone — delete the corresponding Google record.
      try {
        if (folder === '{Tasks}') {
          await tasks.tasks.delete({ tasklist: listId, task: knownId });
        } else {
          await calendar.events.delete({ calendarId: listId, eventId: knownId });
        }
        console.log(`[Push] Deleted ${folder === '{Tasks}' ? 'task' : 'event'} ${knownId} (file removed from vault)`);
      } catch (err: any) {
        const code = err.status ?? err.code;
        // 404 / 410 = already gone from Google — that's fine, continue.
        if (code !== 404 && code !== 410) {
          console.error(`[Push] Failed to delete ${knownId}:`, err.message);
          continue; // Don't remove from manifest — retry next cycle.
        }
      }

      // Remove from manifest.
      manifest[listId] = knownIds.filter(id => id !== knownId);
    }
  }
}

// ---------------------------------------------------------------------------
// Route to the correct handler based on folder type
// ---------------------------------------------------------------------------

async function handleFile(
  folder: '{Tasks}' | '{Calendar}',
  file: string,
  fullPath: string,
  frontmatter: Record<string, any>,
  body: string,
  config: Config,
  state: SyncState,
  calendar: calendar_v3.Calendar,
  tasks: tasks_v1.Tasks,
  isNew: boolean
) {
  try {
    if (folder === '{Tasks}') {
      await pushTaskNote(tasks, config, state, fullPath, file, frontmatter, body, isNew);
    } else {
      await pushCalendarNote(calendar, config, state, fullPath, file, frontmatter, body, isNew);
    }
  } catch (err: any) {
    // Clear push_pending if we set it but then threw, so the next cycle retries cleanly.
    if (frontmatter.push_pending) {
      try {
        frontmatter.push_pending = undefined;
        await fs.writeFile(fullPath, serializeNote(frontmatter, body), 'utf-8');
      } catch { /* ignore secondary write failure */ }
    }
    console.error(`[Push] Failed to push ${file}:`, err.message);
  }
}

// ---------------------------------------------------------------------------
// Task: create or update
// ---------------------------------------------------------------------------

async function pushTaskNote(
  tasks: tasks_v1.Tasks,
  config: Config,
  state: SyncState,
  fullPath: string,
  file: string,
  frontmatter: Record<string, any>,
  body: string,
  isNew: boolean
) {
  const tasklistId: string = frontmatter.tasklist_id || config.tasklistIds[0];

  const title: string =
    frontmatter.title ||
    sanitizeTitle(file.replace(/\.md$/, '').replace(/-[a-z0-9]{8}$/i, ''));

  const payload: tasks_v1.Schema$Task = { title };
  if (frontmatter.status)      payload.status = frontmatter.status;
  if (frontmatter.due)         payload.due    = new Date(frontmatter.due).toISOString();
  // frontmatter.description syncs to Google notes.
  // The Markdown body (below ---) stays private to Obsidian and is never sent.
  if (frontmatter.description != null) payload.notes = String(frontmatter.description);

  let res: { data: tasks_v1.Schema$Task };

  if (isNew) {
    // Phase 1 — write crash-safe marker BEFORE the API call.
    // If the process dies here, the next cycle sees push_pending=true and retries.
    frontmatter.push_pending = true;
    frontmatter.tasklist_id  = tasklistId;
    frontmatter.type         = 'task';
    await fs.writeFile(fullPath, serializeNote(frontmatter, body), 'utf-8');

    res = await tasks.tasks.insert({ tasklist: tasklistId, requestBody: payload });

    // Phase 2 — commit the real google_id.
    frontmatter.google_id    = res.data.id!;
    frontmatter.push_pending = undefined;
    frontmatter.source       = 'obsidian';
    console.log(`[Push] Created task ${res.data.id} → ${file}`);
  } else {
    payload.id = frontmatter.google_id;
    res = await tasks.tasks.patch({
      tasklist:    tasklistId,
      task:        frontmatter.google_id,
      requestBody: payload,
    });
    console.log(`[Push] Updated task ${file}`);
  }

  frontmatter.updated   = res.data.updated || new Date().toISOString();
  frontmatter.synced_at = new Date().toISOString();
  frontmatter.sync_hash = computeSyncHash(frontmatter);
  await fs.writeFile(fullPath, serializeNote(frontmatter, body), 'utf-8');

  // Keep manifest in sync.
  if (frontmatter.google_id) {
    if (!state.knownTaskIds[tasklistId]) state.knownTaskIds[tasklistId] = [];
    if (!state.knownTaskIds[tasklistId].includes(frontmatter.google_id)) {
      state.knownTaskIds[tasklistId].push(frontmatter.google_id);
    }
  }
}

// ---------------------------------------------------------------------------
// Calendar event: create or update
// ---------------------------------------------------------------------------

async function pushCalendarNote(
  calendar: calendar_v3.Calendar,
  config: Config,
  state: SyncState,
  fullPath: string,
  file: string,
  frontmatter: Record<string, any>,
  body: string,
  isNew: boolean
) {
  const calendarId: string = frontmatter.calendar_id || config.calendarIds[0];

  const summary: string =
    frontmatter.title ||
    sanitizeTitle(file.replace(/\.md$/, '').replace(/-[a-z0-9]{8}$/i, ''));

  const payload: calendar_v3.Schema$Event = { summary };
  if (frontmatter.status) payload.status = frontmatter.status as calendar_v3.Schema$Event['status'];
  // frontmatter.description → Google description. Body stays private.
  if (frontmatter.description != null) payload.description = String(frontmatter.description);

  if (frontmatter.start) {
    payload.start = frontmatter.start.includes('T')
      ? { dateTime: frontmatter.start }
      : { date: frontmatter.start };
  }
  if (frontmatter.end) {
    payload.end = frontmatter.end.includes('T')
      ? { dateTime: frontmatter.end }
      : { date: frontmatter.end };
  }

  let res: { data: calendar_v3.Schema$Event };

  if (isNew) {
    // Phase 1 — crash-safe marker.
    frontmatter.push_pending = true;
    frontmatter.calendar_id  = calendarId;
    frontmatter.type         = 'event';
    await fs.writeFile(fullPath, serializeNote(frontmatter, body), 'utf-8');

    res = await calendar.events.insert({ calendarId, requestBody: payload });

    // Phase 2 — commit real ID.
    frontmatter.google_id    = res.data.id!;
    frontmatter.push_pending = undefined;
    frontmatter.source       = 'obsidian';
    console.log(`[Push] Created event ${res.data.id} → ${file}`);
  } else {
    res = await calendar.events.patch({
      calendarId:  calendarId,
      eventId:     frontmatter.google_id,
      requestBody: payload,
    });
    console.log(`[Push] Updated event ${file}`);
  }

  frontmatter.updated   = res.data.updated || new Date().toISOString();
  frontmatter.synced_at = new Date().toISOString();
  frontmatter.sync_hash = computeSyncHash(frontmatter);
  await fs.writeFile(fullPath, serializeNote(frontmatter, body), 'utf-8');

  // Keep manifest in sync.
  if (frontmatter.google_id) {
    if (!state.knownEventIds[calendarId]) state.knownEventIds[calendarId] = [];
    if (!state.knownEventIds[calendarId].includes(frontmatter.google_id)) {
      state.knownEventIds[calendarId].push(frontmatter.google_id);
    }
  }
}
