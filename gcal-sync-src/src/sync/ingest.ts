import { calendar_v3, tasks_v1 } from 'googleapis';
import * as fs from 'fs/promises';
import * as path from 'path';
import { Config } from '../config.js';
import { SyncState } from './state.js';
import { parseNote, serializeNote } from '../markdown/frontmatter.js';
import { sanitizeTitle, resolveVaultPath } from '../markdown/paths.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function addToManifest(manifest: Record<string, string[]>, key: string, id: string) {
  if (!manifest[key]) manifest[key] = [];
  if (!manifest[key].includes(id)) manifest[key].push(id);
}

async function findFileByGoogleId(
  vaultRoot: string,
  folderRelative: string,
  googleId: string
): Promise<string | null> {
  const folderPath = resolveVaultPath(vaultRoot, folderRelative);
  try {
    const files = await fs.readdir(folderPath);
    for (const file of files) {
      if (!file.endsWith('.md')) continue;
      const fullPath = path.join(folderPath, file);
      const content = await fs.readFile(fullPath, 'utf-8');
      const { frontmatter } = parseNote(content);
      if (frontmatter.google_id === googleId) {
        return path.join(folderRelative, file).replace(/\\/g, '/');
      }
    }
  } catch (err: any) {
    if (err.code !== 'ENOENT') console.error(`[Ingest] Error searching ${folderRelative}:`, err.message);
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
            // Last-Write-Wins: compare file mtime vs Google's updated timestamp.
            // -----------------------------------------------------------------
            const googleUpdatedMs = event.updated ? new Date(event.updated).getTime() : 0;
            const locallyModified = frontmatter.synced_at
              ? stat.mtimeMs > new Date(frontmatter.synced_at).getTime() + 2000
              : false;

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

          frontmatter.updated   = event.updated || new Date().toISOString();
          frontmatter.synced_at = new Date().toISOString();

          const safeTitle     = sanitizeTitle(event.summary || 'Untitled Event');
          const shortId       = event.id.substring(0, 8);
          const targetRelative = existingFile || `{Calendar}/${safeTitle}-${shortId}.md`;

          const fullPath = resolveVaultPath(config.vaultResolved, targetRelative);
          await fs.mkdir(path.dirname(fullPath), { recursive: true });
          await fs.writeFile(fullPath, serializeNote(frontmatter, body), 'utf-8');

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
            // Last-Write-Wins
            // -----------------------------------------------------------------
            const googleUpdatedMs = task.updated ? new Date(task.updated).getTime() : 0;
            const locallyModified = frontmatter.synced_at
              ? stat.mtimeMs > new Date(frontmatter.synced_at).getTime() + 2000
              : false;

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

          const safeTitle      = sanitizeTitle(task.title || 'Untitled Task');
          const shortId        = task.id.substring(0, 8);
          const targetRelative = existingFile || `{Tasks}/${safeTitle}-${shortId}.md`;

          const fullPath = resolveVaultPath(config.vaultResolved, targetRelative);
          await fs.mkdir(path.dirname(fullPath), { recursive: true });
          await fs.writeFile(fullPath, serializeNote(frontmatter, body), 'utf-8');

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
