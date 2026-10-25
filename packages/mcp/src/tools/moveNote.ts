import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import { resolveVaultPath } from '../security.js';
import { moveToTrash } from '../trash.js';
import { errorMessage } from '../errors.js';
import { logger } from '../logger.js';
import { ok, fail, tooManyWrites, ToolContext } from './types.js';

import { updateBacklinks } from './refactorLinks.js';

/**
 * `move_note`: moves or renames a note and rewrites the links to it.
 *
 * - Only a note moves, never a folder, and nothing is moved onto a folder.
 * - An existing note at `to` is replaced only with `overwrite: true`, so a client has to state that it means to
 *   replace something rather than do it through a mistyped destination. The replaced note goes to the trash.
 * - fs.rename, not copy and delete: on one file system it is atomic, so a crash cannot leave two copies or none.
 * - Links are rewritten after the move (see updateBacklinks); if that fails, the move still stands.
 */
export function registerMoveNote(server: McpServer, ctx: ToolContext): void {
  const { config } = ctx;
  server.tool(
    'move_note',
    'Moves or renames a note within the vault. Fails if destination exists unless overwrite is set (clobbered file goes to trash). Automatically updates backlinks.',
    {
      from: z.string().describe('Current path of the note, relative to the vault root'),
      to: z.string().describe('Destination path, relative to the vault root'),
      overwrite: z.boolean().default(false).describe('If true, allow replacing an existing file (backed up to trash)'),
    },
    async ({ from, to, overwrite }) => {
      const limited = tooManyWrites(ctx);
      if (limited) return limited;
      try {
        const fromPath = resolveVaultPath(config.vaultResolved, from);
        const toPath = resolveVaultPath(config.vaultResolved, to);

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

        let updatedCount = 0;
        try {
          updatedCount = await updateBacklinks(config.vaultResolved, from, to);
        } catch (err) {
          // The note has already moved; a failed rewrite is logged, not turned into a failed call.
          logger.warn('Moved a note but could not update the links to it', { from, to, error: errorMessage(err) });
        }

        if (trashedPath) {
          return ok(
            `Moved ${from} → ${to} (overwritten file backed up to ${trashedPath}). Updated ${updatedCount} backlink(s).`,
          );
        }
        return ok(`Moved ${from} → ${to}. Updated ${updatedCount} backlink(s).`);
      } catch (err) {
        return fail(`Error moving note: ${errorMessage(err)}`);
      }
    },
  );
}
