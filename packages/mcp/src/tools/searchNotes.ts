import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import { errorMessage } from '../errors.js';
import { ok, fail, ToolContext } from './types.js';

/**
 * Walks the vault for .md files whose name or content contains `query` (already lower-cased), stopping at `limit`.
 * There is no index: every search reads the files as they are on disk now, so a result is only as stale as
 * LiveSync's replication into this vault.
 */
async function walkAndSearch(
  dir: string,
  vaultRoot: string,
  query: string,
  results: string[],
  limit: number,
): Promise<void> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (results.length >= limit) return;
    if (entry.name.startsWith('.')) continue; // hidden files and folders, the trash included
    if (entry.isSymbolicLink()) continue; // never follow links: they may lead out of the vault
    const full = path.resolve(dir, entry.name);
    if (entry.isDirectory()) {
      await walkAndSearch(full, vaultRoot, query, results, limit);
    } else if (entry.name.endsWith('.md')) {
      try {
        const content = await fs.readFile(full, 'utf-8');
        if (content.toLowerCase().includes(query) || entry.name.toLowerCase().includes(query)) {
          results.push(path.relative(vaultRoot, full));
        }
      } catch {
        // Unreadable (permissions, or deleted since the folder was listed): one file does not fail the search.
      }
    }
  }
}

/** Most paths one search returns; a vault-wide hit list beyond this is noise for the client. */
export const MAX_SEARCH_RESULTS = 100;

/** `search_notes`: a case-insensitive substring search over note names and contents. */
export function registerSearchNotes(server: McpServer, { config }: Pick<ToolContext, 'config'>): void {
  server.tool(
    'search_notes',
    'Searches for notes containing a specific keyword or phrase.',
    {
      query: z.string().describe('The keyword or phrase to search for'),
    },
    async ({ query }) => {
      try {
        const results: string[] = [];
        await walkAndSearch(
          config.vaultResolved,
          config.vaultResolved,
          query.toLowerCase(),
          results,
          MAX_SEARCH_RESULTS,
        );
        if (results.length === 0) return ok(`No notes found matching "${query}".`);
        const capped =
          results.length >= MAX_SEARCH_RESULTS
            ? `\n\n(Stopped at ${MAX_SEARCH_RESULTS} results — narrow the query to see the rest.)`
            : '';
        return ok(`Found ${results.length} notes matching "${query}":\n\n${results.join('\n')}${capped}`);
      } catch (err) {
        return fail(`Error searching notes: ${errorMessage(err)}`);
      }
    },
  );
}
