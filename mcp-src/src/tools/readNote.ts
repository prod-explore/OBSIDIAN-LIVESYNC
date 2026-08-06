import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as fs from 'fs/promises';
import { resolveVaultPath } from '../security.js';
import { ok, fail, ToolContext } from './types.js';

export function registerReadNote(server: McpServer, { config }: ToolContext): void {
  server.tool(
    'read_note',
    'Reads the content of a markdown note from the Obsidian vault.',
    {
      path: z.string().describe('Path to the note relative to the vault root (e.g., "Folder/My Note.md")'),
    },
    async ({ path: notePath }) => {
      try {
        const fullPath = resolveVaultPath(config.vaultResolved, notePath);
        const content = await fs.readFile(fullPath, 'utf-8');
        return ok(content);
      } catch (err: any) {
        return fail(`Error reading note: ${err.message}`);
      }
    }
  );
}
