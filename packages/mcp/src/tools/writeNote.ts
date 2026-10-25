import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import { resolveVaultPath } from '../security.js';
import { moveToTrash } from '../trash.js';
import { errorMessage } from '../errors.js';
import { ok, fail, tooManyWrites, ToolContext } from './types.js';

/**
 * `write_note`: creates a note, and the folders above it. An existing note is replaced only with `overwrite: true`,
 * and then the previous version goes to the trash first.
 */
export function registerWriteNote(server: McpServer, ctx: ToolContext): void {
  const { config } = ctx;
  server.tool(
    'write_note',
    'Writes a new markdown note. Fails if the file already exists unless overwrite is true (old file goes to trash).',
    {
      path: z.string().describe('Path to the note relative to the vault root (e.g., "Folder/My Note.md")'),
      content: z.string().describe('The markdown content to write to the note'),
      overwrite: z.boolean().default(false).describe('If true, allow replacing an existing note (backed up to trash)'),
    },
    async ({ path: notePath, content, overwrite }) => {
      const limited = tooManyWrites(ctx);
      if (limited) return limited;
      try {
        const fullPath = resolveVaultPath(config.vaultResolved, notePath);

        const existing = await fs.stat(fullPath).catch(() => undefined);
        let trashedPath: string | undefined;

        if (existing) {
          // Replacing a folder would send everything in it to the trash.
          if (!existing.isFile()) return fail(`Not a note: ${notePath} is a folder`);
          if (!overwrite) {
            return fail(`Note already exists: ${notePath} (pass overwrite: true to replace it)`);
          }
          trashedPath = await moveToTrash(config.vaultResolved, config.trashDir, notePath);
        }

        await fs.mkdir(path.dirname(fullPath), { recursive: true });
        await fs.writeFile(fullPath, content, 'utf-8');

        if (trashedPath) {
          return ok(`Overwrote ${notePath} (previous version backed up to ${trashedPath})`);
        }
        return ok(`Successfully wrote note to ${notePath}`);
      } catch (err) {
        return fail(`Error writing note: ${errorMessage(err)}`);
      }
    },
  );
}
