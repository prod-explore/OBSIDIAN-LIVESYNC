import * as fs from 'fs/promises';
import { isFileMissing } from '../errors.js';
import { resolveVaultPath } from '../markdown/paths.js';
import { ARCHIVE_PREFIX, isPastMonth } from './archive.js';
import type { SyncContext } from './context.js';
import { CALENDAR_FOLDER } from './folders.js';
import { renameAndRefactorLinks } from './refactor.js';

/**
 * Moves the notes of every month that is over from {Calendar}/YYYY-MM/ to 04-Archive/{Calendar}/YYYY-MM/.
 *
 * Ingest and push only decide where an event's note belongs when they touch the event: ingest sees an event again
 * only when Google reports a change through the sync token, and push only handles notes that are new or edited.
 * Most past events are touched by neither, so the archiving that time alone calls for happens here, by walking
 * the folders on disk.
 *
 * The file name does not change, only the folder, so no link has to be rewritten: Obsidian resolves a link by
 * name wherever the note lives. With nothing to archive this is a few `readdir` calls and no Google traffic, so
 * it runs every cycle.
 */
export async function sweepCalendarArchive(ctx: SyncContext): Promise<void> {
  const activeRoot = CALENDAR_FOLDER;

  const monthDirs = await listEntries(ctx, activeRoot, (e) => e.isDirectory() && /^\d{4}-\d{2}$/.test(e.name));
  if (monthDirs === null) return; // no {Calendar} folder yet, or it could not be read (already reported)

  for (const yyyymm of monthDirs) {
    if (!isPastMonth(`${yyyymm}-01`, ctx.now())) continue;

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
        // Gone since the folder was listed: nothing left to archive.
        if (!isFileMissing(err)) ctx.fail(`Could not archive ${currentRelative}`, err);
      }
    }

    // The emptied YYYY-MM folder is left in place: removing it is cosmetic, and could race an ingest that is
    // writing a note into it.
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
