import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import { resolveVaultPath } from '../security.js';
import { copyToTrash, moveToTrash } from '../trash.js';
import { errorMessage } from '../errors.js';
import { logger } from '../logger.js';
import { ok, fail, tooManyWrites, ToolContext } from './types.js';
import { updateBacklinks, type BacklinkUpdate } from './refactorLinks.js';

/**
 * `move_note`: moves or renames a note and rewrites the links to it.
 *
 * - Only a note moves, never a folder, and nothing is moved onto a folder.
 * - An existing note at `to` is replaced only with `overwrite: true`, so a client has to state that it means to
 *   replace something rather than do it through a mistyped destination. The replaced note goes to the trash.
 * - fs.rename, not copy and delete: on one file system it is atomic, so a crash cannot leave two copies or none.
 * - Links are rewritten after the move (see updateBacklinks), each changed note copied to the trash first. The move
 *   stands whatever happens to them, and the result names every note whose links could not be rewritten, so the
 *   client can fix those by hand.
 */
export function registerMoveNote(server: McpServer, ctx: ToolContext): void {
  const { config } = ctx;
  server.tool(
    'move_note',
    'Moves or renames a note within the vault. Fails if destination exists unless overwrite is set (clobbered file goes to trash). Automatically updates backlinks; each note it rewrites is copied to the trash first.',
    {
      from: z.string().describe('Current path of the note, relative to the vault root'),
      to: z.string().describe('Destination path, relative to the vault root'),
      overwrite: z.boolean().default(false).describe('If true, allow replacing an existing file (backed up to trash)'),
    },
    async ({ from, to, overwrite }) => {
      const limited = tooManyWrites(ctx);
      if (limited) return limited;
      try {
        const fromPath = resolveVaultPath(config.vaultResolved, from, { trashDir: config.trashDir });
        const toPath = resolveVaultPath(config.vaultResolved, to, { trashDir: config.trashDir });

        if (fromPath === toPath) {
          return ok(`Source and destination are identical: ${from}. Nothing to do.`);
        }

        const source = await fs.stat(fromPath).catch(() => {
          throw new Error(`Source note does not exist: ${from}`);
        });
        // One note at a time: renaming a folder would move everything in it, and its links would not be rewritten.
        if (!source.isFile()) return fail(`Not a note: ${from} is a folder; move the notes in it one by one`);

        const dest = await fs.stat(toPath).catch(() => undefined);
        let trashedPath: string | undefined;

        if (dest) {
          if (!dest.isFile()) return fail(`Destination is a folder: ${to}; give the full path of the note`);
          if (!overwrite) {
            throw new Error(`Destination already exists: ${to} (pass overwrite: true to replace it)`);
          }
          trashedPath = await moveToTrash(config.vaultResolved, config.trashDir, to);
        }

        await fs.mkdir(path.dirname(toPath), { recursive: true });
        await fs.rename(fromPath, toPath);

        let links: string;
        try {
          // Every note whose links change is copied to the trash first, as edit_note does before it changes a note.
          const backup = (rel: string) => copyToTrash(config.vaultResolved, config.trashDir, rel);
          links = describeLinkUpdate(
            await updateBacklinks(config.vaultResolved, from, to, { backup, trashDir: config.trashDir }),
            from,
          );
        } catch (err) {
          // The note has already moved, so this is not a failed call; the client still has to hear about it.
          logger.warn('Moved a note but could not update the links to it', { from, to, error: errorMessage(err) });
          links = `WARNING: links to ${from} were not updated: ${errorMessage(err)}`;
        }

        const backup = trashedPath ? ` (overwritten file backed up to ${trashedPath})` : '';
        return ok(`Moved ${from} → ${to}${backup}. ${links}`);
      } catch (err) {
        return fail(`Error moving note: ${errorMessage(err)}`);
      }
    },
  );
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** The link part of move_note's answer: what was rewritten, then every note that could not be. */
function describeLinkUpdate(update: BacklinkUpdate, from: string): string {
  const backedUp = update.files.length > 0 ? ' (previous versions copied to the trash)' : '';
  const done = `Updated ${plural(update.links, 'link')} in ${plural(update.files.length, 'note')}${backedUp}.`;
  if (update.failed.length === 0) return done;
  logger.warn('Moved a note but could not update the links in some notes', { from, failed: update.failed });
  const list = update.failed.map((f) => `${f.file} (${f.error})`).join('; ');
  return `${done} WARNING: could not update ${plural(update.failed.length, 'note')}, which may still link to ${from}: ${list}`;
}
