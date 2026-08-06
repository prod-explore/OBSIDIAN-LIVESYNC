import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as fs from 'fs/promises';
import { resolveVaultPath } from '../security.js';
import { ok, fail, ToolContext } from './types.js';

/**
 * Lists the immediate children of a folder — read-only, no recursion.
 *
 * This exists because `search_notes` is a content/name grep, not a directory
 * listing: an agent restructuring notes has no way to just ask "what's actually
 * in this folder right now" without it. Read-only, so it carries none of the
 * risk of the mutating tools below.
 */
export function registerListFolder(server: McpServer, { config }: ToolContext): void {
  server.tool(
    'list_folder',
    'Lists the immediate files and subfolders inside a vault folder (non-recursive).',
    {
      path: z
        .string()
        .default('')
        .describe('Folder path relative to the vault root. Empty string lists the vault root.'),
    },
    async ({ path: folderPath }) => {
      try {
        const fullPath = resolveVaultPath(config.vaultResolved, folderPath);
        const entries = await fs.readdir(fullPath, { withFileTypes: true });

        const visible = entries.filter((e) => !e.name.startsWith('.'));
        if (visible.length === 0) {
          return ok(`(empty) ${folderPath || '/'}`);
        }

        const lines = visible
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((e) => `${e.isDirectory() ? '📁' : '📄'} ${e.name}`);

        return ok(lines.join('\n'));
      } catch (err: any) {
        return fail(`Error listing folder: ${err.message}`);
      }
    }
  );
}
