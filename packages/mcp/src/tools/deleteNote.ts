import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as fs from 'fs/promises';
import { resolveVaultPath } from '../security.js';
import { moveToTrash } from '../trash.js';
import { ok, fail, ToolContext } from './types.js';

/**
 * "Deletes" a note by moving it into a vault-local trash folder — this tool
 * never calls fs.unlink. An agent (or a misfired batch operation) permanently
 * destroying notes with no recovery path is exactly the kind of risk this
 * project should not hand an AI client. Moving to `.trash/` keeps the operation
 * useful while making it reversible: worst case, you go dig the file back out.
 *
 * Collisions (deleting the same relative path twice) are handled by suffixing
 * a timestamp — the second delete never overwrites the first one sitting in trash.
 */
export function registerDeleteNote(server: McpServer, { config }: ToolContext): void {
  server.tool(
    'delete_note',
    'Moves a note to the vault trash folder (soft delete — does not permanently remove it).',
    {
      path: z.string().describe('Path to the note relative to the vault root'),
    },
    async ({ path: notePath }) => {
      try {
        const fullPath = resolveVaultPath(config.vaultResolved, notePath);

        await fs.access(fullPath).catch(() => {
          throw new Error(`Note does not exist: ${notePath}`);
        });

        const trashedPath = await moveToTrash(config.vaultResolved, config.trashDir, notePath);
        return ok(`Moved to trash: ${notePath} → ${trashedPath}`);
      } catch (err: any) {
        return fail(`Error deleting note: ${err.message}`);
      }
    }
  );
}
