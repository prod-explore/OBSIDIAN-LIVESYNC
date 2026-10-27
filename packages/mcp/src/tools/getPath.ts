import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import { isTrashPath, resolveVaultPath } from '../security.js';
import { errorMessage, isFileMissing } from '../errors.js';
import { ok, fail, ToolContext } from './types.js';

/**
 * `get_path`: reads a note or lists a folder, whichever the path turns out to be. One tool instead of a read tool
 * and a list tool costs less of every client's context, and a client that guesses wrong about what a path is still
 * gets a useful answer.
 *
 *   - a file   → its contents (UTF-8)
 *   - a folder → its immediate children, sorted, marked 📁/📄, hidden entries and the trash folder left out
 */
export function registerGetPath(server: McpServer, { config }: Pick<ToolContext, 'config'>): void {
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
            'e.g. "Folder/My Note.md" to read a note, "Folder" to list a directory.',
        ),
    },
    async ({ path: inputPath }) => {
      try {
        const fullPath = resolveVaultPath(config.vaultResolved, inputPath, { trashDir: config.trashDir });
        const stat = await fs.stat(fullPath);

        if (stat.isDirectory()) {
          const entries = await fs.readdir(fullPath, { withFileTypes: true });
          const visible = entries.filter(
            (e) =>
              !e.name.startsWith('.') &&
              !isTrashPath(config.vaultResolved, path.join(fullPath, e.name), config.trashDir),
          );

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

        // A file, or a link to one that resolveVaultPath has checked stays inside the vault.
        if (stat.isFile()) {
          const content = await fs.readFile(fullPath, 'utf-8');
          return ok(content);
        }

        return fail(`Path exists but is neither a file nor a directory: ${inputPath}`);
      } catch (err) {
        if (isFileMissing(err)) {
          return fail(`Path not found: ${inputPath}`);
        }
        // A refused path (PathTraversalError, HiddenPathError, TrashPathError) and anything unexpected reach the client as a
        // tool error with its message, not as a silent empty result.
        return fail(`Error accessing path: ${errorMessage(err)}`);
      }
    },
  );
}
