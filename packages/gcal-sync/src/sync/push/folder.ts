import { isAlreadyGone } from '../../errors.js';
import type { NoteFields } from '../../markdown/notes.js';
import type { SyncContext } from '../context.js';
import { setDuplicatesAside } from '../duplicates.js';
import { isLocallyModified } from '../hash.js';
import { isMassDeletion } from '../safety.js';
import type { Scan, ScannedNote } from '../scan.js';
import type { SyncState } from '../state.js';
import { saveNote, type PushOutcome } from './shared.js';

/** What differs between pushing tasks and pushing events; the walk through the vault is the same. */
export interface NoteKind<N extends NoteFields> {
  noun: 'task' | 'event';
  scan(ctx: SyncContext): Promise<Scan<N>>;
  /** The Google task list or calendar a note belongs to. */
  containerOf(ctx: SyncContext, note: N): string;
  /** The ids known per list or calendar, for noticing which notes were deleted. */
  manifest(state: SyncState): Record<string, string[]>;
  /** An existing item whose note was moved to another list in the vault. */
  hasMoved?(ctx: SyncContext, entry: ScannedNote<N>): Promise<boolean>;
  /** Creates or updates the item on Google and brings the note up to date. Returns undefined when it left the note alone. */
  push(ctx: SyncContext, entry: ScannedNote<N>, isNew: boolean): Promise<PushOutcome | undefined>;
  deleteRemote(ctx: SyncContext, containerId: string, id: string): Promise<void>;
}

/** Sends the changes made in the vault to Google, one kind of note at a time. */
export async function pushKind<N extends NoteFields>(ctx: SyncContext, kind: NoteKind<N>): Promise<void> {
  const scan = await kind.scan(ctx);
  const notes = await setDuplicatesAside(ctx, kind.noun, scan.notes);

  // container → the ids that have a note right now. Built as the walk goes, so a deletion is judged against what
  // was in the vault before this pass changed anything.
  const present = new Map<string, Set<string>>();
  const markPresent = (containerId: string, id: string) => {
    let ids = present.get(containerId);
    if (!ids) present.set(containerId, (ids = new Set()));
    ids.add(id);
  };

  for (const entry of notes) {
    const { note } = entry;
    if (note.google_id) markPresent(kind.containerOf(ctx, note), note.google_id);

    if (entry.problems.length > 0) {
      ctx.flag(entry.relative, entry.problems.join('; '));
      continue;
    }

    // Crash recovery: the marker was written, the insert may or may not have happened, and no id was saved.
    // Insert again. Worst case this leaves one extra item in Google, which needs a crash in a sub-second window.
    if (note.push_pending === true && !note.google_id) {
      const outcome = await attempt(ctx, kind, entry, true);
      if (outcome) markPresent(outcome.containerId, outcome.googleId);
      continue;
    }

    // Crash recovery: the insert succeeded and the id was written, but the marker was never cleared.
    if (note.push_pending === true && note.google_id) {
      try {
        const settled: N = { ...note, synced_at: ctx.now().toISOString() };
        delete settled.push_pending;
        await saveNote(entry.fullPath, settled, entry.body);
      } catch (err) {
        ctx.fail(`Could not clear the pending marker of ${entry.relative}`, err);
      }
      continue;
    }

    const isNew = !note.google_id;

    // A note that came from Google and never got an id here is a record of something that is gone, not a new item
    // — unless it has been reset by hand (source google, no synced_at), which re-pushes it as new.
    if (isNew && note.source === 'google' && note.synced_at) continue;

    const moved = !isNew && kind.hasMoved ? await kind.hasMoved(ctx, entry) : false;
    if (!isNew && !moved && !isLocallyModified(note, entry.mtimeMs)) continue;

    const outcome = await attempt(ctx, kind, entry, isNew);
    if (outcome) markPresent(outcome.containerId, outcome.googleId);
  }

  if (!scan.complete) {
    // Some of the vault could not be read, so a missing note may just be one that was not looked at.
    ctx.log.warn(`Skipping deletions of ${kind.noun}s on Google: the vault was not fully readable this cycle`);
    return;
  }
  await deleteVanished(ctx, kind, present);
}

async function attempt<N extends NoteFields>(
  ctx: SyncContext,
  kind: NoteKind<N>,
  entry: ScannedNote<N>,
  isNew: boolean,
): Promise<PushOutcome | undefined> {
  try {
    return await kind.push(ctx, entry, isNew);
  } catch (err) {
    ctx.fail(`Could not push ${entry.relative}`, err);
    return undefined;
  }
}

/** Ids in the manifest that no longer have a note were deleted in the vault: delete them on Google too. */
async function deleteVanished<N extends NoteFields>(
  ctx: SyncContext,
  kind: NoteKind<N>,
  present: Map<string, Set<string>>,
): Promise<void> {
  const manifest = kind.manifest(ctx.state);

  for (const [containerId, knownIds] of Object.entries(manifest)) {
    const here = present.get(containerId) ?? new Set<string>();
    const missing = knownIds.filter((id) => !here.has(id));

    if (!ctx.config.allowMassDelete && isMassDeletion(missing.length, knownIds.length)) {
      ctx.fail(
        `Refusing to delete ${missing.length} of ${knownIds.length} known ${kind.noun}s in ${containerId}: their notes vanished from the vault at once, ` +
          'which looks like a missing mount or an unfinished sync rather than a decision. Nothing was deleted on Google. ' +
          'If the deletion is intended, run once with ALLOW_MASS_DELETE=true.',
      );
      continue;
    }

    const forgotten = new Set<string>();
    for (const id of missing) {
      try {
        await kind.deleteRemote(ctx, containerId, id);
        ctx.log.info(`Deleted a ${kind.noun} on Google (its note was removed from the vault)`, { googleId: id });
      } catch (err) {
        // 404 / 410: already gone on Google, which is what was wanted. Anything else stays in the manifest and is retried.
        if (!isAlreadyGone(err)) {
          ctx.fail(`Could not delete ${kind.noun} ${id}`, err);
          continue;
        }
      }
      forgotten.add(id);
    }

    // Drop every id that is gone from Google from the manifest in one go. (Filtering the original
    // list once per id would resurrect all but the last one.)
    if (forgotten.size > 0) manifest[containerId] = knownIds.filter((id) => !forgotten.has(id));
  }
}
