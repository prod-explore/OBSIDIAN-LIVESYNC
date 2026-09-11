import { calendar_v3, tasks_v1 } from 'googleapis';
import * as fs from 'fs/promises';
import * as path from 'path';
import { Config } from '../config.js';
import { SyncState } from './state.js';
import { parseNote, serializeNote } from '../markdown/frontmatter.js';
import { sanitizeTitle, resolveVaultPath } from '../markdown/paths.js';
import { computeSyncHash } from './hash.js';
import { ARCHIVE_PREFIX, isPastMonth } from './archive.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function addToManifest(manifest: Record<string, string[]>, key: string, id: string) {
  if (!manifest[key]) manifest[key] = [];
  if (!manifest[key].includes(id)) manifest[key].push(id);
}

/**
 * Recursively searches a folder (and its archive mirror) for a .md file whose
 * frontmatter contains the given google_id.  Recursion is needed so that
 * Calendar events stored under {Calendar}/YYYY/MM/ are found correctly.
 * Active folder is checked before the archive mirror so that any duplicate
 * from a previous failed unlink resolves to the active copy.
 *
 * Returns a vault-relative path (forward slashes), or null if not found.
 */
async function findFileByGoogleId(
  vaultRoot: string,
  folderRelative: string,
  googleId: string
): Promise<string | null> {
  const foldersToSearch = [folderRelative, `${ARCHIVE_PREFIX}/${folderRelative}`];

  async function walkFolder(folder: string): Promise<string | null> {
    let folderPath: string;
    try {
      folderPath = resolveVaultPath(vaultRoot, folder);
    } catch {
      return null; // path traversal guard
    }

    let entries: import('fs').Dirent[];
    try {
      entries = await fs.readdir(folderPath, { withFileTypes: true });
    } catch (err: any) {
      if (err.code !== 'ENOENT') console.error(`[Ingest] Error reading ${folder}:`, err.message);
      return null;
    }

    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;

      if (entry.isDirectory()) {
        const found = await walkFolder(`${folder}/${entry.name}`);
        if (found) return found;
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        const fullPath = path.join(folderPath, entry.name);
        let content: string;
        try {
          content = await fs.readFile(fullPath, 'utf-8');
        } catch {
          continue;
        }
        const { frontmatter } = parseNote(content);
        if (frontmatter.google_id === googleId) {
          return `${folder}/${entry.name}`.replace(/\\/g, '/');
        }
      }
    }
    return null;
  }

  for (const folder of foldersToSearch) {
    const found = await walkFolder(folder);
    if (found) return found;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Main ingest function
// ---------------------------------------------------------------------------

export async function ingestGoogleData(
  config: Config,
  state: SyncState,
  calendar: calendar_v3.Calendar,
  tasks: tasks_v1.Tasks
) {
  // =========================================================================
  // 1. INGEST CALENDARS
  // =========================================================================
  for (const calId of config.calendarIds) {
    let syncToken: string | undefined = state.calendarTokens[calId];
    let pageToken: string | undefined = undefined;

    do {
      try {
        const response: any = await calendar.events.list({
          calendarId: calId,
          syncToken: syncToken,
          pageToken: pageToken,
          singleEvents: true,
          // First run: only fetch events from the last 7 days to avoid history dump.
          ...( !syncToken ? { timeMin: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString() } : {} )
        });

        const events = response.data.items || [];

        for (const event of events) {
          if (!event.id) continue;

          const existingFile = await findFileByGoogleId(config.vaultResolved, '{Calendar}', event.id);

          let frontmatter: Record<string, any> = {
            type: 'event',
            google_id: event.id,
            calendar_id: calId,
            source: 'google',
          };
          let body = ''; // Markdown body belongs to Obsidian — never overwritten by Google data.

          if (existingFile) {
            const fullPath = resolveVaultPath(config.vaultResolved, existingFile);
            const stat = await fs.stat(fullPath);
            const content = await fs.readFile(fullPath, 'utf-8');
            const parsed = parseNote(content);
            frontmatter = { ...parsed.frontmatter, ...frontmatter };
            body = parsed.body; // preserve private Obsidian notes

            // -----------------------------------------------------------------
            // Hash-based Modification Check (Immunized against LiveSync)
            // -----------------------------------------------------------------
            const currentHash = computeSyncHash(frontmatter);
            const locallyModified = frontmatter.sync_hash
              ? frontmatter.sync_hash !== currentHash
              : (frontmatter.synced_at ? stat.mtimeMs > new Date(frontmatter.synced_at).getTime() + 2000 : false);

            const googleUpdatedMs = event.updated ? new Date(event.updated).getTime() : 0;

            if (locallyModified && stat.mtimeMs >= googleUpdatedMs) {
              // Obsidian is the newer interface — skip Google's data.
              // push.ts (which runs right after) will push the local version up.
              console.log(`[Ingest][LWW] Obsidian newer for ${existingFile} — deferring to push`);
              addToManifest(state.knownEventIds, calId, event.id);
              continue;
            }

            // Google is newer (or file wasn't locally modified) → apply Google data.
            if (locallyModified) {
              // Genuine LWW conflict: Google won. Log it.
              const { logConflict } = await import('./conflicts.js');
              await logConflict(
                config.vaultResolved,
                existingFile,
                { title: frontmatter.title, mtime: new Date(stat.mtimeMs).toISOString() },
                { title: event.summary, updated: event.updated },
                'Google is newer (Last-Write-Wins)'
              );
            }
          }

          // Apply Google's authoritative data to frontmatter.
          if (event.status === 'cancelled') {
            frontmatter.status = 'cancelled';
          } else {
            frontmatter.status = event.status || 'confirmed';
            frontmatter.start  = event.start?.dateTime || event.start?.date || '';
            frontmatter.end    = event.end?.dateTime   || event.end?.date   || '';
          }

          frontmatter.title   = event.summary || 'Untitled Event';
          // Google's description → frontmatter.description (not body).
          // The Markdown body below --- is Obsidian-only and never touched here.
          if (event.description != null) frontmatter.description = event.description;

          if (event.reminders) {
            if (event.reminders.useDefault) {
              frontmatter.reminders = ['default'];
            } else if (event.reminders.overrides) {
              frontmatter.reminders = event.reminders.overrides.map((r: any) => {
                const m = r.minutes || 0;
                if (m > 0 && m % 1440 === 0) return `${m / 1440}d`;
                if (m > 0 && m % 60 === 0) return `${m / 60}h`;
                return `${m}m`;
              });
            } else {
              delete frontmatter.reminders;
            }
          }

          frontmatter.updated   = event.updated || new Date().toISOString();
          frontmatter.synced_at = new Date().toISOString();
          frontmatter.sync_hash = computeSyncHash(frontmatter);

          const safeTitle = sanitizeTitle(event.summary || 'Untitled Event');
          const shortId   = event.id.substring(0, 8);

          // Build the canonical (ideal) path for this event:
          //   {Calendar}/YYYY/MM/YYYY-MM-DD-HHMM-title-shortId.md
          //
          // Date + time come from Google (authoritative). HHMM = "0000" for
          // all-day events that have no dateTime. This gives correct
          // chronological sort both inside a month folder and across months.
          //
          // If the event's month has fully passed, the canonical path moves
          // under 04-Archive/{Calendar}/... instead — same YYYY/MM/filename,
          // just relocated, so the active {Calendar} folder only ever lists
          // the current and future months. Reversible: if the date is ever
          // corrected back into the current/future, isPastMonth() flips back
          // to false and the existing relocate-on-mismatch logic below moves
          // it back out of the archive automatically.
          const startRaw    = event.start?.dateTime || event.start?.date || '';
          const datePart    = startRaw.slice(0, 10) || new Date().toISOString().slice(0, 10);
          const timePart    = event.start?.dateTime
            ? event.start.dateTime.slice(11, 16).replace(':', '') // "HH:MM" → "HHMM"
            : '0000';
          const yearStr     = datePart.slice(0, 4);
          const monthStr    = datePart.slice(5, 7);
          const activeIdealRelative = `{Calendar}/${yearStr}-${monthStr}/${datePart}-${timePart}-${safeTitle}-${shortId}.md`;
          const idealRelative = isPastMonth(datePart)
            ? `${ARCHIVE_PREFIX}/${activeIdealRelative}`
            : activeIdealRelative;

          // For a new file: write directly to its ideal location.
          // For an existing file: write in place first (crash-safe), then
          // call renameAndRefactorLinks to relocate + rewrite wikilinks if
          // the ideal path differs (e.g. the event was rescheduled, or its
          // month just became past/current).
          const writeRelative = existingFile ?? idealRelative;
          const fullPath = resolveVaultPath(config.vaultResolved, writeRelative);
          await fs.mkdir(path.dirname(fullPath), { recursive: true });
          await fs.writeFile(fullPath, serializeNote(frontmatter, body), 'utf-8');

          if (existingFile && existingFile !== idealRelative) {
            const wasArchived = existingFile.startsWith(`${ARCHIVE_PREFIX}/`);
            const nowArchived = idealRelative.startsWith(`${ARCHIVE_PREFIX}/`);
            const verb = !wasArchived && nowArchived ? 'Archived' : wasArchived && !nowArchived ? 'Unarchived' : 'Relocated';
            const { renameAndRefactorLinks } = await import('./refactor.js');
            await renameAndRefactorLinks(config.vaultResolved, existingFile, idealRelative);
            console.log(`[Ingest] ${verb} event: ${existingFile} → ${idealRelative}`);
          }

          addToManifest(state.knownEventIds, calId, event.id);
        }

        syncToken = response.data.nextSyncToken || syncToken;
        pageToken = response.data.nextPageToken  || undefined;
      } catch (err: any) {
        if (err.code === 410 || err.status === 410) {
          console.warn(`[Ingest] Sync token expired for calendar ${calId}. Full re-sync on next run.`);
          syncToken = undefined;
        } else {
          console.error(`[Ingest] Error pulling calendar ${calId}:`, err.message);
          break;
        }
      }
    } while (pageToken);

    if (syncToken) state.calendarTokens[calId] = syncToken;
  }

  // =========================================================================
  // 2. INGEST TASKS
  // =========================================================================
  for (const tasklistId of config.tasklistIds) {
    const lastSync = state.tasksTokens[tasklistId];
    let pageToken: string | undefined = undefined;
    let maxUpdated: string | undefined = lastSync;

    do {
      try {
        const response: any = await tasks.tasks.list({
          tasklist:    tasklistId,
          showDeleted: true,
          showHidden:  true,
          updatedMin:  lastSync || undefined,
          pageToken:   pageToken,
        });

        const items = response.data.items || [];

        for (const task of items) {
          if (!task.id) continue;

          // Track the highest updated timestamp seen this page.
          if (!maxUpdated || (task.updated && task.updated > maxUpdated)) {
            maxUpdated = task.updated ?? maxUpdated;
          }

          const existingFile = await findFileByGoogleId(config.vaultResolved, '{Tasks}', task.id);

          let frontmatter: Record<string, any> = {
            type: 'task',
            google_id: task.id,
            tasklist_id: tasklistId,
            source: 'google',
          };
          let body = ''; // private Obsidian area

          if (existingFile) {
            const fullPath = resolveVaultPath(config.vaultResolved, existingFile);
            const stat     = await fs.stat(fullPath);
            const content  = await fs.readFile(fullPath, 'utf-8');
            const parsed   = parseNote(content);
            frontmatter = { ...parsed.frontmatter, ...frontmatter };
            body = parsed.body;

            // -----------------------------------------------------------------
            // Hash-based Modification Check (Immunized against LiveSync)
            // -----------------------------------------------------------------
            const currentHash = computeSyncHash(frontmatter);
            const locallyModified = frontmatter.sync_hash
              ? frontmatter.sync_hash !== currentHash
              : (frontmatter.synced_at ? stat.mtimeMs > new Date(frontmatter.synced_at).getTime() + 2000 : false);

            const googleUpdatedMs = task.updated ? new Date(task.updated).getTime() : 0;

            if (locallyModified && stat.mtimeMs >= googleUpdatedMs) {
              console.log(`[Ingest][LWW] Obsidian newer for ${existingFile} — deferring to push`);
              addToManifest(state.knownTaskIds, tasklistId, task.id);
              continue;
            }

            if (locallyModified) {
              const { logConflict } = await import('./conflicts.js');
              await logConflict(
                config.vaultResolved,
                existingFile,
                { title: frontmatter.title, mtime: new Date(stat.mtimeMs).toISOString() },
                { title: task.title, updated: task.updated },
                'Google is newer (Last-Write-Wins)'
              );
            }
          }

          // Apply Google's authoritative data.
          if (task.deleted) {
            frontmatter.status = 'cancelled';
          } else {
            frontmatter.status = task.status || 'needsAction';
            if (task.due) frontmatter.due = task.due.substring(0, 10); // YYYY-MM-DD
          }

          frontmatter.title = task.title || 'Untitled Task';
          // Google notes → frontmatter.description (not body).
          if (task.notes != null) frontmatter.description = task.notes;

          frontmatter.updated   = task.updated || new Date().toISOString();
          frontmatter.synced_at = new Date().toISOString();
          frontmatter.sync_hash = computeSyncHash(frontmatter);

          const safeTitle = sanitizeTitle(task.title || 'Untitled Task');
          const shortId   = task.id.substring(0, 8);

          // ----------------------------------------------------------------
          // Bidirectional archive management.
          //
          // File location always reflects task status:
          //   needsAction → {Tasks}/
          //   completed / cancelled → 04-Archive/{Tasks}/
          //
          // Both directions are supported so a task un-completed in Google
          // is automatically moved back to the active folder.
          // ----------------------------------------------------------------
          const isArchived        = frontmatter.status === 'completed' || frontmatter.status === 'cancelled';
          const currentlyArchived = existingFile?.startsWith(`${ARCHIVE_PREFIX}/`) ?? false;

          let targetRelative: string;
          if (existingFile) {
            if (isArchived && !currentlyArchived) {
              // Active → archive: preserve filename, change folder.
              targetRelative = `${ARCHIVE_PREFIX}/${existingFile}`;
            } else if (!isArchived && currentlyArchived) {
              // Archive → active (task un-completed in Google).
              targetRelative = existingFile.slice(`${ARCHIVE_PREFIX}/`.length);
            } else {
              // No location change needed — update in place.
              targetRelative = existingFile;
            }
          } else {
            // New task: write directly to the correct folder.
            // Stable creation-date prefix — set once, never changes, enables
            // chronological sort in the file explorer without encoding mutable state.
            const createdPrefix = new Date().toISOString().slice(0, 10);
            targetRelative = isArchived
              ? `${ARCHIVE_PREFIX}/{Tasks}/${createdPrefix}-${safeTitle}-${shortId}.md`
              : `{Tasks}/${createdPrefix}-${safeTitle}-${shortId}.md`;
          }

          // Write to the target first. If we crash before the unlink below,
          // the next cycle will find the new file (active folder has priority
          // in findFileByGoogleId) and cleanly remove the stale copy then.
          const targetPath = resolveVaultPath(config.vaultResolved, targetRelative);
          await fs.mkdir(path.dirname(targetPath), { recursive: true });
          await fs.writeFile(targetPath, serializeNote(frontmatter, body), 'utf-8');

          if (existingFile && targetRelative !== existingFile) {
            const oldPath = resolveVaultPath(config.vaultResolved, existingFile);
            try {
              await fs.unlink(oldPath);
              console.log(`[Ingest] ${isArchived ? 'Archived' : 'Unarchived'} task: ${existingFile} → ${targetRelative}`);
            } catch (err: any) {
              // ENOENT: already gone (double-cycle race) — new file is written
              // correctly, so this is safe to ignore. Any other code is unexpected.
              if (err.code !== 'ENOENT') {
                console.error(`[Ingest] Could not remove old task file (${existingFile}):`, err.message);
              }
            }
          }

          addToManifest(state.knownTaskIds, tasklistId, task.id);
        }

        pageToken = response.data.nextPageToken || undefined;
      } catch (err: any) {
        console.error(`[Ingest] Error pulling tasklist ${tasklistId}:`, err.message);
        break;
      }
    } while (pageToken);

    // +1 ms because Google updatedMin is inclusive (>=).
    // Without this, the most-recently-updated task is re-fetched every cycle.
    if (maxUpdated) {
      state.tasksTokens[tasklistId] = new Date(new Date(maxUpdated).getTime() + 1).toISOString();
    }
  }
}
