import * as fs from 'fs/promises';
import type { NoteFields } from '../markdown/notes.js';
import type { SyncContext } from './context.js';
import { isLocallyModified } from './hash.js';
import { scanEvents, scanTasks, type ScannedNote } from './scan.js';
import type { SyncState } from './state.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * When Google deletes a task or cancels an event we have a note for, the note stays as a record: status
 * `cancelled`, moved into the archive. Left alone these pile up for ever. A cancelled note that holds nothing but
 * synced fields (no text in the body), has not been touched by anyone for `cancelledRetentionDays` days and has
 * no edit waiting to be pushed is removed. A note with anything written in its body is never removed.
 */
function isExpired(entry: ScannedNote<NoteFields>, now: number, days: number): boolean {
  if (entry.note.status !== 'cancelled') return false;
  if (entry.problems.length > 0 || entry.note.push_pending) return false;
  if (entry.body.trim() !== '') return false;
  if (isLocallyModified(entry.note, entry.mtimeMs)) return false;

  // Dated by Google's `updated` (the day it was cancelled there), not by the file time: LiveSync touches files
  // it merely re-downloaded. A note with no date at all is left alone rather than guessed at.
  const stamp = Date.parse(entry.note.updated ?? entry.note.synced_at ?? '');
  return !Number.isNaN(stamp) && now - stamp > days * DAY_MS;
}

function forget(manifest: SyncState['knownTaskIds'], id: string): void {
  for (const [list, ids] of Object.entries(manifest)) {
    if (ids.includes(id)) manifest[list] = ids.filter((known) => known !== id);
  }
}

/** Removes the expired notes; returns how many it removed. */
export async function sweepCancelled(ctx: SyncContext): Promise<number> {
  const days = ctx.config.cancelledRetentionDays;
  if (days === 0) return 0;

  const now = ctx.now().getTime();
  let removed = 0;

  const candidates: Array<{
    entry: ScannedNote<NoteFields>;
    manifest: SyncState['knownTaskIds'];
    noun: 'task' | 'event';
  }> = [];
  for (const entry of (await scanTasks(ctx)).notes)
    candidates.push({ entry, manifest: ctx.state.knownTaskIds, noun: 'task' });
  for (const entry of (await scanEvents(ctx)).notes)
    candidates.push({ entry, manifest: ctx.state.knownEventIds, noun: 'event' });

  for (const { entry, manifest, noun } of candidates) {
    if (!isExpired(entry, now, days)) continue;
    try {
      await fs.unlink(entry.fullPath);
    } catch (err) {
      ctx.fail(`Could not remove the cancelled ${noun} note ${entry.relative}`, err);
      continue;
    }
    // Out of the manifest too: otherwise push would see an id without a file and delete the record on Google.
    if (entry.note.google_id) forget(manifest, entry.note.google_id);
    removed++;
    ctx.log.info(`Removed a cancelled ${noun} note after ${days} days`, { path: entry.relative });
  }

  return removed;
}
