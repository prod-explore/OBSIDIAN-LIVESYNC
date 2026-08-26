import { calendar_v3, tasks_v1 } from 'googleapis';
import * as fs from 'fs/promises';
import * as path from 'path';
import { Config } from '../config.js';
import { parseNote, serializeNote } from '../markdown/frontmatter.js';
import { resolveVaultPath, sanitizeTitle } from '../markdown/paths.js';

export async function pushVaultData(
  config: Config,
  calendar: calendar_v3.Calendar,
  tasks: tasks_v1.Tasks
) {
  const folders = ['_Calendar', '_Tasks'];
  
  for (const folder of folders) {
    let folderPath: string;
    try {
      folderPath = resolveVaultPath(config.vaultResolved, folder);
    } catch {
      continue; // Folder not resolvable
    }

    let files: string[] = [];
    try {
      files = await fs.readdir(folderPath);
    } catch {
      continue; // Folder might not exist yet
    }

    for (const file of files) {
      if (!file.endsWith('.md')) continue;
      let fullPath: string;
      try {
        fullPath = resolveVaultPath(config.vaultResolved, `${folder}/${file}`);
      } catch {
        continue; // Defensive: skip any file whose path doesn't resolve cleanly
      }
      
      const stat = await fs.stat(fullPath);
      const content = await fs.readFile(fullPath, 'utf-8');
      const { frontmatter, body } = parseNote(content);

      if (!frontmatter.google_id || !frontmatter.synced_at) continue;

      const syncedTime = new Date(frontmatter.synced_at).getTime();
      
      // If the file was modified locally after our last sync
      // and survived ingest (meaning no Google-side change collided with it)
      if (stat.mtimeMs > syncedTime + 2000) {
        try {
          if (folder === '_Calendar' && frontmatter.calendar_id) {
             const payload: calendar_v3.Schema$Event = {};
             if (frontmatter.status) payload.status = frontmatter.status;
             
             // Convert string dates into Google's expected objects
             if (frontmatter.start) {
               payload.start = frontmatter.start.includes('T') ? { dateTime: frontmatter.start } : { date: frontmatter.start };
             }
             if (frontmatter.end) {
               payload.end = frontmatter.end.includes('T') ? { dateTime: frontmatter.end } : { date: frontmatter.end };
             }
             
             const res = await calendar.events.patch({
               calendarId: frontmatter.calendar_id,
               eventId: frontmatter.google_id,
               requestBody: payload
             });
             
             frontmatter.updated = res.data.updated || new Date().toISOString();
             
          } else if (folder === '_Tasks' && frontmatter.tasklist_id) {
             const payload: tasks_v1.Schema$Task = { id: frontmatter.google_id };
             if (frontmatter.status) payload.status = frontmatter.status;
             if (frontmatter.due) payload.due = new Date(frontmatter.due).toISOString();
             
             const res = await tasks.tasks.patch({
               tasklist: frontmatter.tasklist_id,
               task: frontmatter.google_id,
               requestBody: payload
             });
             
             frontmatter.updated = res.data.updated || new Date().toISOString();
          }

          // Mark as successfully synced to prevent infinite loop
          frontmatter.synced_at = new Date().toISOString();
          await fs.writeFile(fullPath, serializeNote(frontmatter, body), 'utf-8');
          console.log(`[Push] Successfully pushed local changes for ${file}`);
          
        } catch (err: any) {
          console.error(`[Push] Failed to push ${file}:`, err.message);
        }
      }
    }
  }
}
