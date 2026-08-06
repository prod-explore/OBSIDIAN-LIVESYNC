import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import { resolveVaultPath } from '../security.js';
import { ok, fail, ToolContext } from './types.js';

/**
 * Moves/renames a note within the vault.
 *
 * Safety choices, deliberately conservative for an agent-facing tool:
 * - Both `from` and `to` go through the same path-traversal guard as every other tool.
 * - Refuses to clobber an existing file at `to` unless `overwrite: true` is passed
 *   explicitly — an agent should have to state its intent to destroy something,
 *   not do it as a side effect of a typo'd destination path.
 * - Uses fs.rename (atomic on the same filesystem/volume), not copy+delete, so a
 *   crash mid-operation can't leave two copies or zero copies of the note.
 */
export function registerMoveNote(server: McpServer, { config }: ToolContext): void {
  server.tool(
    'move_note',
    'Moves or renames a note within the vault. Fails if the destination already exists unless overwrite is set.',
    {
      from: z.string().describe('Current path of the note, relative to the vault root'),
      to: z.string().describe('Destination path, relative to the vault root'),
      overwrite: z.boolean().default(false).describe('If true, allow replacing an existing file at the destination'),
    },
    async ({ from, to, overwrite }) => {
      try {
        const fromPath = resolveVaultPath(config.vaultResolved, from);
        const toPath = resolveVaultPath(config.vaultResolved, to);

        await fs.access(fromPath).catch(() => {
          throw new Error(`Source note does not exist: ${from}`);
        });

        if (!overwrite) {
          const destExists = await fs
            .access(toPath)
            .then(() => true)
            .catch(() => false);
          if (destExists) {
            throw new Error(`Destination already exists: ${to} (pass overwrite: true to replace it)`);
          }
        }

        await fs.mkdir(path.dirname(toPath), { recursive: true });
        await fs.rename(fromPath, toPath);
        return ok(`Moved ${from} → ${to}`);
      } catch (err: any) {
        return fail(`Error moving note: ${err.message}`);
      }
    }
  );
}
