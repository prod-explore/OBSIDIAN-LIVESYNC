import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import { resolveVaultPath } from '../security.js';
import { ok, fail, ToolContext } from './types.js';

export function registerWriteNote(server: McpServer, { config }: ToolContext): void {
  server.tool(
    'write_note',
    'Writes or overwrites a markdown note in the Obsidian vault.',
    {
      path: z.string().describe('Path to the note relative to the vault root (e.g., "Folder/My Note.md")'),
      content: z.string().describe('The markdown content to write to the note'),
    },
    async ({ path: notePath, content }) => {
      try {
        const fullPath = resolveVaultPath(config.vaultResolved, notePath);
        await fs.mkdir(path.dirname(fullPath), { recursive: true });
        await fs.writeFile(fullPath, content, 'utf-8');
        return ok(`Successfully wrote note to ${notePath}`);
      } catch (err: any) {
        return fail(`Error writing note: ${err.message}`);
      }
    }
  );
}
