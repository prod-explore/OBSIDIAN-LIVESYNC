import * as fs from 'fs/promises';
import * as path from 'path';
import { resolveVaultPath } from '../markdown/paths.js';
import type { NoteFields } from '../markdown/notes.js';
import { isPastMonth } from './archive.js';
import { logConflict } from './conflicts.js';
import type { SyncContext } from './context.js';
import { isArchivedPath } from './folders.js';
import { isLocallyModified } from './hash.js';
import type { ScannedNote } from './scan.js';

/** Where the copy that lost is kept. Nothing in here is read by the sync. */
export const DUPLICATES_FOLDER = '_Systems/duplicates';

type Kind = 'task' | 'event';

/**
 * When did the note last change, as far as we can tell? Google's `updated`, unless the note was edited here after
 * the last sync, in which case the edit is newer than anything Google knows.
 */
function lastChange(entry: ScannedNote<NoteFields>): number {
  const updated = entry.note.updated ? Date.parse(entry.note.updated) : NaN;
  const known = Number.isNaN(updated) ? 0 : updated;
  return isLocallyModified(entry.note, entry.mtimeMs) ? Math.max(known, entry.mtimeMs) : known;
}

/** Does the note sit where its state says it should (open tasks active, finished ones archived, past-month events archived)? */
function inRightPlace(kind: Kind, entry: ScannedNote<NoteFields>): boolean {
  const archived = isArchivedPath(entry.relative);
  if (kind === 'task') {
    const status = entry.note.status;
    return archived === (status === 'completed' || status === 'cancelled');
  }
  const start = typeof entry.note.start === 'string' ? entry.note.start : '';
  return start ? archived === isPastMonth(start.slice(0, 10)) : true;
}

/**
 * Which of several notes with the same google_id is the real one: the one changed last; then the one in the place
 * its state calls for; then the one outside the archive; then the one touched last; then the first by path, so
 * the answer never depends on directory order.
 */
export function compareCandidates(kind: Kind) {
  return (a: ScannedNote<NoteFields>, b: ScannedNote<NoteFields>): number =>
    lastChange(b) - lastChange(a) ||
    Number(inRightPlace(kind, b)) - Number(inRightPlace(kind, a)) ||
    Number(isArchivedPath(a.relative)) - Number(isArchivedPath(b.relative)) ||
    b.mtimeMs - a.mtimeMs ||
    (a.relative < b.relative ? -1 : a.relative > b.relative ? 1 : 0);
}

/** The notes grouped by google_id; notes without one are not part of any group. */
export function groupById<N extends NoteFields>(notes: ScannedNote<N>[]): Map<string, ScannedNote<N>[]> {
  const groups = new Map<string, ScannedNote<N>[]>();
  for (const entry of notes) {
    const id = entry.note.google_id;
    if (!id) continue;
    const group = groups.get(id);
    if (group) group.push(entry);
    else groups.set(id, [entry]);
  }
  return groups;
}

/** google_id → the path of the note that stands for it (the winner where there are several). */
export function indexWinners(kind: Kind, notes: ScannedNote<NoteFields>[]): Map<string, string> {
  const index = new Map<string, string>();
  for (const [id, group] of groupById(notes)) {
    index.set(id, [...group].sort(compareCandidates(kind))[0].relative);
  }
  return index;
}

function stamp(now: Date): string {
  return now.toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');
}

/**
 * One google_id, one file. Where several notes carry the same id (an interrupted move, a note copied in
 * Obsidian, a LiveSync conflict copy), the winner stays and each other copy is moved to `_Systems/duplicates/`
 * and written to the conflict log. The copy is moved, not deleted: its body may hold text that exists nowhere else.
 * Returns the notes that remain.
 */
export async function setDuplicatesAside<N extends NoteFields>(
  ctx: SyncContext,
  kind: Kind,
  notes: ScannedNote<N>[],
): Promise<ScannedNote<N>[]> {
  const losers = new Set<ScannedNote<N>>();

  for (const [id, group] of groupById(notes)) {
    if (group.length < 2) continue;
    const [winner, ...rest] = [...group].sort(compareCandidates(kind));

    for (const loser of rest) {
      losers.add(loser);
      const target = `${DUPLICATES_FOLDER}/${stamp(ctx.now())}-${loser.relative.replace(/\//g, ' - ')}`;
      try {
        const targetPath = resolveVaultPath(ctx.config.vaultResolved, target);
        await fs.mkdir(path.dirname(targetPath), { recursive: true });
        await fs.rename(loser.fullPath, targetPath);
        ctx.log.warn(`Two notes for one ${kind}: kept ${winner.relative}, moved ${loser.relative} to ${target}`, {
          googleId: id,
        });
        await logConflict(
          ctx,
          loser.relative,
          { ...loser.note, mtime: new Date(loser.mtimeMs).toISOString() },
          { keptInstead: winner.relative },
          `Same google_id as ${winner.relative}; the other copy was moved to ${target}`,
        );
      } catch (err) {
        ctx.fail(`Could not move the duplicate ${loser.relative} aside`, err, { googleId: id });
      }
    }
  }

  return losers.size === 0 ? notes : notes.filter((entry) => !losers.has(entry));
}
