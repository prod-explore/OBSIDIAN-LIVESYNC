import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import { ok, fail, ToolContext } from './types.js';

/**
 * Recursively walks the vault looking for .md files whose name or content
 * contains `query` (case-insensitive). This always reflects the live filesystem —
 * there is no cache here, so results can only be stale if the vault sync itself
 * (e.g. LiveSync replication from a client to this container) hasn't caught up yet.
 */
async function walkAndSearch(dir: string, vaultRoot: string, query: string, results: string[]): Promise<void> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue; // skip dotfiles/dirs, incl. the trash folder
    const full = path.resolve(dir, entry.name);
    if (entry.isDirectory()) {
      await walkAndSearch(full, vaultRoot, query, results);
    } else if (entry.name.endsWith('.md')) {
      try {
        const content = await fs.readFile(full, 'utf-8');
        if (content.toLowerCase().includes(query) || entry.name.toLowerCase().includes(query)) {
          results.push(path.relative(vaultRoot, full));
        }
      } catch {
        // Unreadable file (permissions, race with a concurrent delete, etc.) — skip it.
      }
    }
  }
}

export function registerSearchNotes(server: McpServer, { config }: ToolContext): void {
  server.tool(
    'search_notes',
    'Searches for notes containing a specific keyword or phrase.',
    {
      query: z.string().describe('The keyword or phrase to search for'),
    },
    async ({ query }) => {
      try {
        const results: string[] = [];
        await walkAndSearch(config.vaultResolved, config.vaultResolved, query.toLowerCase(), results);
        return ok(
          results.length > 0
            ? `Found ${results.length} notes matching "${query}":\n\n${results.join('\n')}`
            : `No notes found matching "${query}".`
        );
      } catch (err: any) {
        return fail(`Error searching notes: ${err.message}`);
      }
    }
  );
}
