import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import { resolveVaultPath } from '../security.js';
import { moveToTrash } from '../trash.js';
import { ok, fail, ToolContext } from './types.js';

export function registerWriteNote(server: McpServer, { config }: ToolContext): void {
  server.tool(
    'write_note',
    'Writes a new markdown note. Fails if the file already exists unless overwrite is true (old file goes to trash).',
    {
      path: z.string().describe('Path to the note relative to the vault root (e.g., "Folder/My Note.md")'),
      content: z.string().describe('The markdown content to write to the note'),
      overwrite: z.boolean().default(false).describe('If true, allow replacing an existing note (backed up to trash)'),
    },
    async ({ path: notePath, content, overwrite }) => {
      try {
        const fullPath = resolveVaultPath(config.vaultResolved, notePath);
        
        const exists = await fs.access(fullPath).then(() => true).catch(() => false);
        let trashedPath: string | undefined;

        if (exists) {
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
      } catch (err: any) {
        return fail(`Error writing note: ${err.message}`);
      }
    }
  );
}
