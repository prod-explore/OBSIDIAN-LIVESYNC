import * as fs from 'fs/promises';
import { Config } from '../config.js';
import { resolveVaultPath } from '../markdown/paths.js';
import { ARCHIVE_PREFIX, isPastMonth } from './archive.js';
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
 * This sweep is independent of both: it walks the active {Calendar}/YYYY/MM/
 * tree directly on disk and moves anything whose month has fully passed into
 * 04-Archive/{Calendar}/YYYY/MM/ — the same relocation mechanism
 * (renameAndRefactorLinks) ingest.ts/push.ts already use reactively, just
 * triggered by "time has passed" instead of "something changed." Filenames
 * are unchanged by the move (only the folder differs), so this never
 * triggers a wikilink rewrite — Obsidian resolves links by basename
 * regardless of which folder a note lives in.
 *
 * Safe to call every sync cycle: with nothing to archive it's a handful of
 * cheap `readdir` calls, no Google API traffic.
 */
export async function sweepCalendarArchive(config: Config): Promise<void> {
  const activeRoot = '{Calendar}';

  // Scan flat YYYY-MM subdirectories directly under {Calendar}/
  const monthDirs = await listSubdirs(config, activeRoot, /^\d{4}-\d{2}$/);
  if (monthDirs === null) return; // nothing synced yet — {Calendar} doesn't exist

  for (const yyyymm of monthDirs) {
    if (!isPastMonth(`${yyyymm}-01`)) continue; // current/future month — leave alone

    const monthRelative = `${activeRoot}/${yyyymm}`;
    const files = await listFiles(config, monthRelative);
    if (files === null) continue;

    for (const file of files) {
      const currentRelative = `${monthRelative}/${file}`;
      const targetRelative = `${ARCHIVE_PREFIX}/${currentRelative}`;
      try {
        await renameAndRefactorLinks(config.vaultResolved, currentRelative, targetRelative);
        console.log(`[Archive Sweep] Archived event: ${currentRelative} → ${targetRelative}`);
      } catch (err: any) {
        if (err.code !== 'ENOENT') {
          // ENOENT = ingest/push already moved or deleted it this same cycle — nothing to do.
          console.error(`[Archive Sweep] Could not archive ${currentRelative}:`, err.message);
        }
      }
    }

    // YYYY-MM folder may now be empty. Left in place deliberately —
    // removing it is cosmetic only and risks racing a fresh ingest write.
  }
}


async function listSubdirs(config: Config, relPath: string, namePattern: RegExp): Promise<string[] | null> {
  try {
    const fullPath = resolveVaultPath(config.vaultResolved, relPath);
    const entries = await fs.readdir(fullPath, { withFileTypes: true });
    return entries.filter(e => e.isDirectory() && namePattern.test(e.name)).map(e => e.name);
  } catch (err: any) {
    if (err.code === 'ENOENT') return null;
    console.error(`[Archive Sweep] Could not read ${relPath}:`, err.message);
    return null;
  }
}

async function listFiles(config: Config, relPath: string): Promise<string[] | null> {
  try {
    const fullPath = resolveVaultPath(config.vaultResolved, relPath);
    const entries = await fs.readdir(fullPath, { withFileTypes: true });
    return entries.filter(e => e.isFile() && e.name.endsWith('.md')).map(e => e.name);
  } catch (err: any) {
    if (err.code === 'ENOENT') return null;
    console.error(`[Archive Sweep] Could not read ${relPath}:`, err.message);
    return null;
  }
}
