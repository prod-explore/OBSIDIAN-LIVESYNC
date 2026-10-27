import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as fs from 'fs/promises';
import { resolveVaultPath } from '../security.js';
import { moveToTrash } from '../trash.js';
import { errorMessage } from '../errors.js';
import { ok, fail, tooManyWrites, ToolContext } from './types.js';

/**
 * `delete_note`: moves a note into the vault's trash folder instead of unlinking it. An AI client, or a batch of
 * calls that goes wrong, must not be able to destroy notes beyond recovery; a trashed note can be moved back.
 *
 * Trashed names carry a timestamp, so deleting the same path twice keeps both copies. Folders are refused: one
 * call never removes more than one file.
 */
export function registerDeleteNote(server: McpServer, ctx: ToolContext): void {
  const { config } = ctx;
  server.tool(
    'delete_note',
    'Moves a note to the vault trash folder (soft delete — does not permanently remove it).',
    {
      path: z.string().describe('Path to the note relative to the vault root'),
    },
    async ({ path: notePath }) => {
      const limited = tooManyWrites(ctx);
      if (limited) return limited;
      try {
        const fullPath = resolveVaultPath(config.vaultResolved, notePath, { trashDir: config.trashDir });

        const stat = await fs.stat(fullPath).catch(() => {
          throw new Error(`Note does not exist: ${notePath}`);
        });
        // One note at a time: a folder would take everything in it along.
        if (!stat.isFile()) return fail(`Not a note: ${notePath} is a folder; delete the notes in it one by one`);

        const trashedPath = await moveToTrash(config.vaultResolved, config.trashDir, notePath);
        return ok(`Moved to trash: ${notePath} → ${trashedPath}`);
      } catch (err) {
        return fail(`Error deleting note: ${errorMessage(err)}`);
      }
    },
  );
}
