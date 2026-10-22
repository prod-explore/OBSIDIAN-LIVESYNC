import type { calendar_v3 } from 'googleapis';
import * as fs from 'fs/promises';
import { errorMessage, isFileMissing } from '../../errors.js';
import type { EventNote } from '../../markdown/notes.js';
import { sanitizeTitle } from '../../markdown/paths.js';
import { eventNotePath } from '../archive.js';
import type { SyncContext } from '../context.js';
import { isArchivedPath } from '../folders.js';
import { computeSyncHash } from '../hash.js';
import { renameAndRefactorLinks } from '../refactor.js';
import { scanEvents, type ScannedNote } from '../scan.js';
import type { NoteKind } from './folder.js';
import { fallbackTitle, insertWithMarker, saveNote, type PushOutcome } from './shared.js';

export const eventKind: NoteKind<EventNote> = {
  noun: 'event',
  scan: scanEvents,
  containerOf: (ctx, note) => note.calendar_id || ctx.config.calendarIds[0],
  manifest: (state) => state.knownEventIds,
  push: pushEventNote,
  async deleteRemote(ctx, calendarId, id) {
    await ctx.calendar.events.delete({ calendarId, eventId: id });
  },
};

/**
 * The `reminders` property as Google wants it. Accepted: `default` (or `[default]`, or true) for the calendar's
 * own reminders; a list like `[10m, 1h, 1d]` for popups before the event; null, false or `[]` for none.
 * Anything else is left out, which leaves Google's reminders as they are.
 */
export function remindersPayload(value: unknown): calendar_v3.Schema$Event['reminders'] | undefined {
  if (value === undefined) return undefined;

  if (Array.isArray(value)) {
    if (value.length === 1 && value[0] === 'default') return { useDefault: true };
    const overrides = value.map((item: unknown) => {
      const text = typeof item === 'string' || typeof item === 'number' ? String(item).trim().toLowerCase() : '';
      const amount = parseInt(text, 10) || 0;
      const minutes = text.endsWith('h') ? amount * 60 : text.endsWith('d') ? amount * 1440 : amount;
      return { method: 'popup', minutes };
    });
    return { useDefault: false, overrides };
  }

  if (value === 'default' || value === true) return { useDefault: true };
  if (value === null || value === false) return { useDefault: false, overrides: [] };
  return undefined;
}

/** Creates or updates the event on Google, then moves the note to the path its date and title call for. */
async function pushEventNote(ctx: SyncContext, entry: ScannedNote<EventNote>, isNew: boolean): Promise<PushOutcome | undefined> {
  const { calendar, config, state } = ctx;
  const note: EventNote = { ...entry.note };

  if (isNew && !note.start && note.status !== 'cancelled') {
    ctx.flag(entry.relative, 'start is missing: add start: YYYY-MM-DD (or a date-time) so the event can be created');
    return undefined;
  }

  const calendarId = note.calendar_id || config.calendarIds[0];
  const summary = note.title || fallbackTitle(entry.file, sanitizeTitle);

  const payload: calendar_v3.Schema$Event = { summary };
  if (note.status) payload.status = note.status;
  // The description syncs to Google's description. The Markdown body stays private.
  if (note.description != null) payload.description = note.description;

  const reminders = remindersPayload(note.reminders);
  if (reminders) payload.reminders = reminders;

  for (const key of ['start', 'end'] as const) {
    const value = note[key];
    if (value) payload[key] = value.includes('T') ? { dateTime: value } : { date: value };
  }

  let res: { data: calendar_v3.Schema$Event };
  let googleId: string;
  if (isNew) {
    note.calendar_id = calendarId;
    note.type = 'event';
    res = await insertWithMarker(entry, note, () => calendar.events.insert({ calendarId, requestBody: payload }));

    if (!res.data.id) throw new Error('Google did not return an id for the new event');
    googleId = res.data.id;
    note.google_id = googleId;
    delete note.push_pending;
    note.source = 'obsidian';
    ctx.log.info('Created event', { googleId, path: entry.relative });
  } else {
    if (!note.google_id) throw new Error('an existing event has no google_id'); // cannot happen: isNew is true without one
    googleId = note.google_id;
    res = await calendar.events.patch({ calendarId, eventId: googleId, requestBody: payload });
    ctx.log.info('Updated event', { googleId, path: entry.relative });
  }

  note.updated = res.data.updated || ctx.now().toISOString();
  note.synced_at = ctx.now().toISOString();
  note.sync_hash = computeSyncHash(note);
  await saveNote(entry.fullPath, note, entry.body);

  // After writing, check if this file should live at a different (canonical) path:
  // {Calendar}/YYYY-MM/YYYY-MM-DD-HHMM-title-shortId.md, or under 04-Archive/{Calendar}/... once its month has
  // fully passed. This fires when the user edits the title or start time in Obsidian, or when the calendar rolls
  // over into a new month, and the change has just been pushed to (or already matches) Google.
  if (note.start) {
    const idealRelative = eventNotePath(note.start, summary, googleId, ctx.now());
    const currentRelative = entry.relative;

    if (currentRelative !== idealRelative) {
      // Guard: ingest may already have moved this file to idealRelative in the same cycle (Google returned a
      // reschedule that ingest processed first). If the file is gone, the move is a no-op.
      try {
        await fs.access(entry.fullPath);
        const verb = !isArchivedPath(currentRelative) && isArchivedPath(idealRelative) ? 'Archived' : isArchivedPath(currentRelative) && !isArchivedPath(idealRelative) ? 'Unarchived' : 'Relocated';
        await renameAndRefactorLinks(ctx, currentRelative, idealRelative);
        ctx.log.info(`${verb} event`, { from: currentRelative, to: idealRelative });
      } catch (err) {
        // ENOENT = ingest already moved it — nothing to do.
        if (!isFileMissing(err)) ctx.log.warn(`Could not relocate ${entry.file}`, { error: errorMessage(err) });
      }
    }
  }

  // Keep the manifest in sync.
  const known = (state.knownEventIds[calendarId] ??= []);
  if (!known.includes(googleId)) known.push(googleId);

  return { googleId, containerId: calendarId };
}
