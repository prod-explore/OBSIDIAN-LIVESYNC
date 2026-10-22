import * as fs from 'fs/promises';
import { isFileMissing } from '../errors.js';
import { resolveVaultPath } from '../markdown/paths.js';
import { ARCHIVE_PREFIX, isPastMonth } from './archive.js';
import type { SyncContext } from './context.js';
import { CALENDAR_FOLDER } from './folders.js';
import { renameAndRefactorLinks } from './refactor.js';

/**
 * Ingest and push only re-evaluate an event's ideal path (and therefore only
 * ever archive it) when something actually touches it — ingest relies on
 * Calendar's incremental `syncToken`, so an event nobody edits is never
 * returned by Google again on later cycles, and push skips any file that
 * isn't new and isn't locally modified. An event that just sits there,
 * untouched, would never get re-evaluated by either — which is the common
 * case, and exactly what "shorten the active Calendar folder" needs to
 * handle for events from a month that has simply ended.
 *
 * This sweep is independent of both: it walks the active {Calendar}/YYYY-MM/
 * tree directly on disk and moves anything whose month has fully passed into
 * 04-Archive/{Calendar}/YYYY-MM/ — the same relocation mechanism
 * (renameAndRefactorLinks) ingest and push already use reactively, just
 * triggered by "time has passed" instead of "something changed." Filenames
 * are unchanged by the move (only the folder differs), so this never
 * triggers a wikilink rewrite — Obsidian resolves links by basename
 * regardless of which folder a note lives in.
 *
 * Safe to call every sync cycle: with nothing to archive it's a handful of
 * cheap `readdir` calls, no Google API traffic.
 */
export async function sweepCalendarArchive(ctx: SyncContext): Promise<void> {
  const activeRoot = CALENDAR_FOLDER;

  // Scan flat YYYY-MM subdirectories directly under {Calendar}/
  const monthDirs = await listEntries(ctx, activeRoot, (e) => e.isDirectory() && /^\d{4}-\d{2}$/.test(e.name));
  if (monthDirs === null) return; // nothing synced yet — {Calendar} doesn't exist

  for (const yyyymm of monthDirs) {
    if (!isPastMonth(`${yyyymm}-01`, ctx.now())) continue; // current/future month — leave alone

    const monthRelative = `${activeRoot}/${yyyymm}`;
    const files = await listEntries(ctx, monthRelative, (e) => e.isFile() && e.name.endsWith('.md'));
    if (files === null) continue;

    for (const file of files) {
      const currentRelative = `${monthRelative}/${file}`;
      const targetRelative = `${ARCHIVE_PREFIX}/${currentRelative}`;
      try {
        await renameAndRefactorLinks(ctx, currentRelative, targetRelative);
        ctx.log.info('Archived event', { from: currentRelative, to: targetRelative });
      } catch (err) {
        // ENOENT = ingest/push already moved or deleted it this same cycle — nothing to do.
        if (!isFileMissing(err)) ctx.fail(`Could not archive ${currentRelative}`, err);
      }
    }

    // YYYY-MM folder may now be empty. Left in place deliberately —
    // removing it is cosmetic only and risks racing a fresh ingest write.
  }
}

/** The names in a folder that pass `keep`, or null when the folder is missing or cannot be read. */
async function listEntries(
  ctx: SyncContext,
  relPath: string,
  keep: (entry: import('fs').Dirent) => boolean,
): Promise<string[] | null> {
  try {
    const entries = await fs.readdir(resolveVaultPath(ctx.config.vaultResolved, relPath), { withFileTypes: true });
    return entries.filter(keep).map((e) => e.name);
  } catch (err) {
    if (!isFileMissing(err)) ctx.fail(`Could not read ${relPath}`, err);
    return null;
  }
}
