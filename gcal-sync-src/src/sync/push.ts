import { calendar_v3, tasks_v1 } from 'googleapis';
import * as fs from 'fs/promises';
import { Config } from '../config.js';
import { parseNote, serializeNote } from '../markdown/frontmatter.js';
import { resolveVaultPath, sanitizeTitle } from '../markdown/paths.js';

export async function pushVaultData(
  config: Config,
  calendar: calendar_v3.Calendar,
  tasks: tasks_v1.Tasks
) {
  const folders = ['{Calendar}', '{Tasks}'] as const;

  for (const folder of folders) {
    let folderPath: string;
    try {
      folderPath = resolveVaultPath(config.vaultResolved, folder);
    } catch {
      continue;
    }

    let files: string[] = [];
    try {
      files = await fs.readdir(folderPath);
    } catch {
      continue;
    }

    for (const file of files) {
      if (!file.endsWith('.md') || file.startsWith('README')) continue;

      let fullPath: string;
      try {
        fullPath = resolveVaultPath(config.vaultResolved, `${folder}/${file}`);
      } catch {
        continue;
      }

      const stat = await fs.stat(fullPath);
      const content = await fs.readFile(fullPath, 'utf-8');
      const { frontmatter, body } = parseNote(content);

      const isNew = !frontmatter.google_id;
      const syncedTime = frontmatter.synced_at
        ? new Date(frontmatter.synced_at).getTime()
        : 0;
      const locallyModified = stat.mtimeMs > syncedTime + 2000;

      // Skip unmodified already-linked notes
      if (!isNew && !locallyModified) continue;

      // Skip unlinked notes that explicitly came from Google (shouldn't push back as new)
      if (isNew && frontmatter.source === 'google') continue;

      try {
        if (folder === '{Calendar}') {
          await pushCalendarNote(
            calendar, config, fullPath, file, frontmatter, body, isNew
          );
        } else {
          await pushTaskNote(
            tasks, config, fullPath, file, frontmatter, body, isNew
          );
        }
      } catch (err: any) {
        console.error(`[Push] Failed to push ${file}:`, err.message);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Calendar helpers
// ---------------------------------------------------------------------------

async function pushCalendarNote(
  calendar: calendar_v3.Calendar,
  config: Config,
  fullPath: string,
  file: string,
  frontmatter: Record<string, any>,
  body: string,
  isNew: boolean
) {
  const calendarId: string = frontmatter.calendar_id || config.calendarIds[0];

  // Build a title from the filename if frontmatter doesn't have one
  const summary: string =
    frontmatter.title ||
    sanitizeTitle(file.replace(/\.md$/, '').replace(/-[a-z0-9]{8}$/i, ''));

  const payload: calendar_v3.Schema$Event = {
    summary,
    description: body.trim() || undefined,
  };

  if (frontmatter.status) payload.status = frontmatter.status as calendar_v3.Schema$Event['status'];

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
    res = await calendar.events.insert({ calendarId, requestBody: payload });
    frontmatter.google_id = res.data.id!;
    frontmatter.calendar_id = calendarId;
    frontmatter.type = 'event';
    frontmatter.source = 'obsidian';
    console.log(`[Push] Created new calendar event for ${file} → ${res.data.id}`);
  } else {
    res = await calendar.events.patch({
      calendarId: frontmatter.calendar_id || calendarId,
      eventId: frontmatter.google_id,
      requestBody: payload,
    });
    console.log(`[Push] Updated calendar event for ${file}`);
  }

  frontmatter.updated = res.data.updated || new Date().toISOString();
  frontmatter.synced_at = new Date().toISOString();
  await fs.writeFile(fullPath, serializeNote(frontmatter, body), 'utf-8');
}

// ---------------------------------------------------------------------------
// Tasks helpers
// ---------------------------------------------------------------------------

async function pushTaskNote(
  tasks: tasks_v1.Tasks,
  config: Config,
  fullPath: string,
  file: string,
  frontmatter: Record<string, any>,
  body: string,
  isNew: boolean
) {
  const tasklistId: string = frontmatter.tasklist_id || config.tasklistIds[0];

  // Build a title from the filename if frontmatter doesn't have one
  const title: string =
    frontmatter.title ||
    sanitizeTitle(file.replace(/\.md$/, '').replace(/-[a-z0-9]{8}$/i, ''));

  const payload: tasks_v1.Schema$Task = {
    title,
    notes: body.trim() || undefined,
  };

  if (frontmatter.status) payload.status = frontmatter.status;
  if (frontmatter.due) payload.due = new Date(frontmatter.due).toISOString();

  let res: { data: tasks_v1.Schema$Task };

  if (isNew) {
    res = await tasks.tasks.insert({ tasklist: tasklistId, requestBody: payload });
    frontmatter.google_id = res.data.id!;
    frontmatter.tasklist_id = tasklistId;
    frontmatter.type = 'task';
    frontmatter.source = 'obsidian';
    console.log(`[Push] Created new task for ${file} → ${res.data.id}`);
  } else {
    payload.id = frontmatter.google_id;
    res = await tasks.tasks.patch({
      tasklist: frontmatter.tasklist_id || tasklistId,
      task: frontmatter.google_id,
      requestBody: payload,
    });
    console.log(`[Push] Updated task for ${file}`);
  }

  frontmatter.updated = res.data.updated || new Date().toISOString();
  frontmatter.synced_at = new Date().toISOString();
  await fs.writeFile(fullPath, serializeNote(frontmatter, body), 'utf-8');
}
