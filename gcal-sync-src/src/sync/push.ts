import { calendar_v3, tasks_v1 } from 'googleapis';
import * as fs from 'fs/promises';
import * as path from 'path';
import { Config } from '../config.js';
import { SyncState } from './state.js';
import { parseNote, serializeNote } from '../markdown/frontmatter.js';
import { resolveVaultPath, sanitizeTitle } from '../markdown/paths.js';
import { computeSyncHash } from './hash.js';

const ARCHIVE_PREFIX = '04-Archive';

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
  // Scan both the active folder and its archive mirror so that archived tasks
  // are pushed (status updates) and not falsely detected as deletions.
  const foldersToScan = [folder, `${ARCHIVE_PREFIX}/${folder}`];

  // Maps listId → set of google_ids currently present in either location.
  // Built before any mutations so deletion detection has a stable snapshot.
  const presentIdsByList = new Map<string, Set<string>>();

  const allFiles: { file: string; relFolder: string }[] = [];

  // Recursive walker — needed for Calendar's YYYY/MM/ sub-structure.
  async function collectFiles(relFolder: string): Promise<void> {
    let folderPath: string;
    try {
      folderPath = resolveVaultPath(config.vaultResolved, relFolder);
    } catch {
      return; // path traversal guard
    }
    let entries: import('fs').Dirent[];
    try {
      entries = await fs.readdir(folderPath, { withFileTypes: true });
    } catch (err: any) {
      if (err.code !== 'ENOENT') console.error(`[Push] Error reading ${relFolder}:`, err.message);
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      if (entry.isDirectory()) {
        await collectFiles(`${relFolder}/${entry.name}`);
      } else if (entry.isFile() && entry.name.endsWith('.md') && !entry.name.startsWith('README')) {
        allFiles.push({ file: entry.name, relFolder });
      }
    }
  }

  for (const relFolder of foldersToScan) {
    await collectFiles(relFolder);
  }

  for (const { file, relFolder } of allFiles) {
    let fullPath: string;
    try {
      fullPath = resolveVaultPath(config.vaultResolved, `${relFolder}/${file}`);
    } catch {
      continue;
    }

    // Guard: ingest may have moved this file between our readdir and now.
    let stat: Awaited<ReturnType<typeof fs.stat>>;
    let content: string;
    try {
      stat    = await fs.stat(fullPath);
      content = await fs.readFile(fullPath, 'utf-8');
    } catch (err: any) {
      if (err.code === 'ENOENT') continue; // moved/deleted between scan and read
      throw err;
    }

    const { frontmatter, body } = parseNote(content);

    const listId: string =
      folder === '{Tasks}'
        ? (frontmatter.tasklist_id || config.tasklistIds[0])
        : (frontmatter.calendar_id || config.calendarIds[0]);

    // Track presence before any mutations.
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
      await handleFile(folder, relFolder, file, fullPath, frontmatter, body, config, state, calendar, tasks, true);
      // frontmatter is mutated by reference — pick up the new google_id directly.
      if (frontmatter.google_id) {
        if (!presentIdsByList.has(listId)) presentIdsByList.set(listId, new Set());
        presentIdsByList.get(listId)!.add(frontmatter.google_id);
      }
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

    // Skip Google-originated files that haven't been locally touched.
    if (isNew && frontmatter.source === 'google') continue;

    // Nothing changed locally.
    if (!isNew && !locallyModified) continue;

    await handleFile(folder, relFolder, file, fullPath, frontmatter, body, config, state, calendar, tasks, isNew);

    // frontmatter is mutated by handleFile (google_id written for new tasks).
    // Pick it up directly — no re-read needed, and this works correctly even
    // when pushTaskNote renamed the file to the archive (fullPath no longer exists).
    if (frontmatter.google_id) {
      if (!presentIdsByList.has(listId)) presentIdsByList.set(listId, new Set());
      presentIdsByList.get(listId)!.add(frontmatter.google_id);
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
  relFolder: string,
  file: string,
  fullPath: string,
  frontmatter: Record<string, any>, // mutated in-place — callers see google_id etc.
  body: string,
  config: Config,
  state: SyncState,
  calendar: calendar_v3.Calendar,
  tasks: tasks_v1.Tasks,
  isNew: boolean
) {
  try {
    if (folder === '{Tasks}') {
      const fromArchive = relFolder.startsWith(`${ARCHIVE_PREFIX}/`);
      await pushTaskNote(tasks, config, state, fullPath, file, frontmatter, body, isNew, fromArchive);
    } else {
      await pushCalendarNote(calendar, config, state, fullPath, relFolder, file, frontmatter, body, isNew);
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
// Task: create or update, then archive / unarchive if status warrants it
// ---------------------------------------------------------------------------

async function pushTaskNote(
  tasks: tasks_v1.Tasks,
  config: Config,
  state: SyncState,
  fullPath: string,
  file: string,
  frontmatter: Record<string, any>, // mutated in-place so callers see google_id etc.
  body: string,
  isNew: boolean,
  fromArchive: boolean
) {
  const tasklistId: string = frontmatter.tasklist_id || config.tasklistIds[0];

  const title: string =
    frontmatter.title ||
    sanitizeTitle(file.replace(/\.md$/, '').replace(/-[a-z0-9]{8}$/i, ''));

  const payload: tasks_v1.Schema$Task = { title };
  if (frontmatter.status)              payload.status = frontmatter.status;
  if (frontmatter.due)                 payload.due    = new Date(frontmatter.due).toISOString();
  // frontmatter.description syncs to Google notes.
  // The Markdown body (below ---) stays private to Obsidian and is never sent.
  if (frontmatter.description != null) payload.notes  = String(frontmatter.description);

  let res: { data: tasks_v1.Schema$Task };

  if (isNew) {
    // Phase 1 — crash-safe marker: written to disk before the API call so a
    // mid-flight crash is recoverable on the next cycle.
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

  // ---- Bidirectional archive management ----
  //
  // After syncing to Google, move the file if its location no longer matches
  // its status. Both directions are supported (active→archive, archive→active).
  //
  // Strategy: write the updated content to fullPath first (crash-safe), then
  // rename atomically. If we crash after writeFile but before rename, the file
  // at fullPath has correct content and will be retried next cycle.
  const isArchived      = frontmatter.status === 'completed' || frontmatter.status === 'cancelled';
  const shouldArchive   = isArchived && !fromArchive;
  const shouldUnarchive = !isArchived && fromArchive;

  await fs.writeFile(fullPath, serializeNote(frontmatter, body), 'utf-8');

  if (shouldArchive || shouldUnarchive) {
    const targetRelative = shouldArchive
      ? `${ARCHIVE_PREFIX}/{Tasks}/${file}`
      : `{Tasks}/${file}`;
    const targetPath = resolveVaultPath(config.vaultResolved, targetRelative);
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    try {
      await fs.rename(fullPath, targetPath);
      console.log(`[Push] ${shouldArchive ? 'Archived' : 'Unarchived'} task: ${file}`);
    } catch (err: any) {
      // Non-fatal: content is written correctly at fullPath. Next ingest cycle
      // will move the file once Google confirms the completed status.
      console.error(`[Push] Could not ${shouldArchive ? 'archive' : 'unarchive'} ${file}:`, err.message);
    }
  }

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
  relFolder: string,
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

  // After writing, check if this file should live at a different (canonical)
  // path: {Calendar}/YYYY/MM/YYYY-MM-DD-HHMM-title-shortId.md
  // This fires when the user edits the title or start time in Obsidian and
  // the change has just been pushed to Google.
  if (frontmatter.google_id && frontmatter.start) {
    const startRaw  = frontmatter.start as string;
    const datePart  = startRaw.slice(0, 10);
    const timePart  = startRaw.includes('T')
      ? startRaw.slice(11, 16).replace(':', '') // "HH:MM" → "HHMM"
      : '0000';
    const yearStr   = datePart.slice(0, 4);
    const monthStr  = datePart.slice(5, 7);
    const safeTitle = sanitizeTitle(summary);
    const shortId   = (frontmatter.google_id as string).substring(0, 8);
    const idealRelative = `{Calendar}/${yearStr}/${monthStr}/${datePart}-${timePart}-${safeTitle}-${shortId}.md`;

    // Build current relative path from the args we already have — this is
    // more reliable than path.relative() which can produce backslashes or
    // wrong case on Windows.
    const currentRelative = `${relFolder}/${file}`.replace(/\\/g, '/');

    if (currentRelative !== idealRelative) {
      // Guard: ingest may have already moved this file to idealRelative in the
      // same cycle (e.g. Google returned a reschedule that ingest processed
      // first). If fullPath is already gone, the refactor is a no-op.
      try {
        await fs.access(fullPath);
        const { renameAndRefactorLinks } = await import('./refactor.js');
        await renameAndRefactorLinks(config.vaultResolved, currentRelative, idealRelative);
        console.log(`[Push] Relocated event: ${currentRelative} → ${idealRelative}`);
      } catch (err: any) {
        if (err.code !== 'ENOENT') {
          console.error(`[Push] Could not relocate ${file}:`, err.message);
        }
        // ENOENT = ingest already moved it — nothing to do.
      }
    }
  }

  // Keep manifest in sync.
  if (frontmatter.google_id) {
    if (!state.knownEventIds[calendarId]) state.knownEventIds[calendarId] = [];
    if (!state.knownEventIds[calendarId].includes(frontmatter.google_id)) {
      state.knownEventIds[calendarId].push(frontmatter.google_id);
    }
  }
}
