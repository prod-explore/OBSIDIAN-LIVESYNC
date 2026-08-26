import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import { resolveVaultPath } from '../security.js';
import { ok, fail, ToolContext } from './types.js';

/**
 * Unified path accessor — replaces read_note + list_folder with one tool.
 *
 * Design rationale: one tool definition is cheaper in the system-prompt token
 * budget than two.  If the AI guesses the wrong type (file vs. directory) it
 * still receives the correct content in the response — an acceptable tradeoff.
 *
 * Behaviour:
 *   - path resolves to a file   → returns file contents (utf-8)
 *   - path resolves to a folder → returns immediate children (non-recursive),
 *                                  sorted, with 📁/📄 prefix
 */
export function registerGetPath(server: McpServer, { config }: ToolContext): void {
  server.tool(
    'get_path',
    'Reads a note OR lists a folder — auto-detected from the path. ' +
      'Pass a .md file path to read its contents, or a folder path (including empty string for vault root) to list its immediate children.',
    {
      path: z
        .string()
        .default('')
        .describe(
          'Path relative to the vault root. ' +
            'Empty string = vault root. ' +
            'e.g. "Folder/My Note.md" to read a note, "Folder" to list a directory.'
        ),
    },
    async ({ path: inputPath }) => {
      try {
        const fullPath = resolveVaultPath(config.vaultResolved, inputPath);
        const stat = await fs.stat(fullPath);

        if (stat.isDirectory()) {
          const entries = await fs.readdir(fullPath, { withFileTypes: true });
          const visible = entries.filter((e) => !e.name.startsWith('.'));

          if (visible.length === 0) {
            return ok(`(empty) ${inputPath || '/'}`);
          }

          const lines = visible
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((e) => {
              const icon = e.isDirectory() ? '📁' : '📄';
              const childRelative = inputPath ? `${inputPath}/${e.name}` : e.name;
              return `${icon} ${e.name}  →  ${childRelative}`;
            });

          return ok(lines.join('\n'));
        }

        // File (or symlink to file — resolveVaultPath already guards traversal)
        if (stat.isFile()) {
          const content = await fs.readFile(fullPath, 'utf-8');
          return ok(content);
        }

        return fail(`Path exists but is neither a file nor a directory: ${inputPath}`);
      } catch (err: any) {
        if (err.code === 'ENOENT') {
          return fail(`Path not found: ${inputPath}`);
        }
        // Re-throw PathTraversalError and other unexpected errors so they're
        // surfaced as tool errors rather than silently swallowed.
        return fail(`Error accessing path: ${err.message}`);
      }
    }
  );
}
