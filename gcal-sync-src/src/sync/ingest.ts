import { calendar_v3, tasks_v1 } from 'googleapis';
import * as fs from 'fs/promises';
import * as path from 'path';
import { Config } from '../config.js';
import { SyncState } from './state.js';
import { parseNote, serializeNote } from '../markdown/frontmatter.js';
import { sanitizeTitle, resolveVaultPath } from '../markdown/paths.js';

async function findFileByGoogleId(vaultRoot: string, folderRelative: string, googleId: string): Promise<string | null> {
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

export async function ingestGoogleData(
  config: Config, 
  state: SyncState, 
  calendar: calendar_v3.Calendar, 
  tasks: tasks_v1.Tasks
) {
  const now = new Date().toISOString();

  // 1. INGEST CALENDARS
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
          // If first run, limit to future events so we don't dump 10 years of history
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
            source: 'google'
          };
          let body = '';
          let localModified = false;

          if (existingFile) {
            const fullPath = resolveVaultPath(config.vaultResolved, existingFile);
            const stat = await fs.stat(fullPath);
            const content = await fs.readFile(fullPath, 'utf-8');
            const parsed = parseNote(content);
            frontmatter = { ...parsed.frontmatter, ...frontmatter };
            body = parsed.body;

            // Detect if local file has pending unsynced changes
            if (frontmatter.synced_at) {
               const syncedTime = new Date(frontmatter.synced_at).getTime();
               if (stat.mtimeMs > syncedTime + 2000) { // 2s buffer for fs resolution
                 localModified = true;
               }
            }
          }

          // Conflict resolution: Google always wins on conflict, but we must save local changes to conflicts.md
          if (localModified) {
             const { logConflict } = await import('./conflicts.js');
             await logConflict(
               config.vaultResolved,
               existingFile || event.id,
               frontmatter,
               event,
               'Simultaneous update (Google won)'
             );
          }

          if (event.status === 'cancelled') {
            frontmatter.status = 'cancelled';
          } else {
            frontmatter.status = event.status || 'confirmed';
            frontmatter.start = event.start?.dateTime || event.start?.date || '';
            frontmatter.end = event.end?.dateTime || event.end?.date || '';
          }
          
          frontmatter.updated = event.updated || new Date().toISOString();
          frontmatter.synced_at = new Date().toISOString();

          const title = sanitizeTitle(event.summary || 'Untitled Event');
          frontmatter.title = event.summary || 'Untitled Event'; // preserve original casing for push
          const shortId = event.id.substring(0, 8);
          const targetRelative = existingFile || `{Calendar}/${title}-${shortId}.md`;
          
          const fullPath = resolveVaultPath(config.vaultResolved, targetRelative);
          await fs.mkdir(path.dirname(fullPath), { recursive: true });
          await fs.writeFile(fullPath, serializeNote(frontmatter, body), 'utf-8');
        }

        syncToken = response.data.nextSyncToken || syncToken;
        pageToken = response.data.nextPageToken || undefined;
      } catch (err: any) {
        if (err.code === 410 || err.status === 410) {
          console.warn(`[Ingest] Sync token expired for calendar ${calId}. Full sync required on next run.`);
          syncToken = undefined;
        } else {
          console.error(`[Ingest] Error pulling calendar ${calId}:`, err.message);
          break;
        }
      }
    } while (pageToken);

    if (syncToken) state.calendarTokens[calId] = syncToken;
  }

  // 2. INGEST TASKS
  for (const tasklistId of config.tasklistIds) {
    const lastSync = state.tasksTokens[tasklistId];
    let pageToken: string | undefined = undefined;
    let maxUpdated: string | undefined = lastSync;

    do {
      try {
        const response: any = await tasks.tasks.list({
          tasklist: tasklistId,
          showDeleted: true,
          showHidden: true,
          updatedMin: lastSync || undefined,
          pageToken: pageToken
        });

        const items = response.data.items || [];
        for (const task of items) {
          if (!task.id) continue;
          
          // Track highest updated timestamp for the next run
          if (!maxUpdated || (task.updated && task.updated > maxUpdated)) {
            maxUpdated = task.updated || maxUpdated;
          }

          const existingFile = await findFileByGoogleId(config.vaultResolved, '{Tasks}', task.id);
          
          let frontmatter: Record<string, any> = {
            type: 'task',
            google_id: task.id,
            tasklist_id: tasklistId,
            source: 'google'
          };
          let body = '';
          let localModified = false;

          if (existingFile) {
            const fullPath = resolveVaultPath(config.vaultResolved, existingFile);
            const stat = await fs.stat(fullPath);
            const content = await fs.readFile(fullPath, 'utf-8');
            const parsed = parseNote(content);
            frontmatter = { ...parsed.frontmatter, ...frontmatter };
            body = parsed.body;
            
            if (frontmatter.synced_at) {
               const syncedTime = new Date(frontmatter.synced_at).getTime();
               if (stat.mtimeMs > syncedTime + 2000) localModified = true;
            }
          }
          
          if (localModified) {
             const { logConflict } = await import('./conflicts.js');
             await logConflict(
               config.vaultResolved,
               existingFile || task.id,
               frontmatter,
               task,
               'Simultaneous update (Google won)'
             );
          }

          if (task.deleted) {
            frontmatter.status = 'cancelled';
          } else {
            frontmatter.status = task.status || 'needsAction';
            if (task.due) frontmatter.due = task.due.substring(0, 10); // YYYY-MM-DD
          }
          
          frontmatter.updated = task.updated || new Date().toISOString();
          frontmatter.synced_at = new Date().toISOString();

          const title = sanitizeTitle(task.title || 'Untitled Task');
          frontmatter.title = task.title || 'Untitled Task'; // preserve original casing for push
          const shortId = task.id.substring(0, 8);
          const targetRelative = existingFile || `{Tasks}/${title}-${shortId}.md`;
          
          const fullPath = resolveVaultPath(config.vaultResolved, targetRelative);
          await fs.mkdir(path.dirname(fullPath), { recursive: true });
          await fs.writeFile(fullPath, serializeNote(frontmatter, body), 'utf-8');
        }

        pageToken = response.data.nextPageToken || undefined;
      } catch (err: any) {
        console.error(`[Ingest] Error pulling tasklist ${tasklistId}:`, err.message);
        break;
      }
    } while (pageToken);

    // Save the latest update time we saw + 1 ms as our next sync threshold.
    // Google Tasks updatedMin is inclusive (>=), so without this offset the task
    // with the highest `updated` timestamp is re-fetched (and rewritten) on every
    // poll cycle even when nothing has changed — causing the recurring conflict on
    // "adas 100" (or whichever task happens to be the newest).
    if (maxUpdated) {
      const nextThreshold = new Date(new Date(maxUpdated).getTime() + 1).toISOString();
      state.tasksTokens[tasklistId] = nextThreshold;
    }
  }
}
