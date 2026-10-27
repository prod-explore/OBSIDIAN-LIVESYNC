import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as fs from 'fs/promises';
import { resolveVaultPath } from '../security.js';
import { copyToTrash } from '../trash.js';
import { errorMessage } from '../errors.js';
import { ok, fail, tooManyWrites, ToolContext } from './types.js';

/**
 * `edit_note`: replaces a range of lines in an existing note, so a client can change a few lines without sending
 * the whole note back.
 *
 * - The note must exist; creating one is write_note's job.
 * - `end_line === start_line - 1` is a pure insert: no line is removed.
 * - The version before the edit is copied to the trash first, as write_note does for an overwrite.
 * - A range outside the note is refused with the line count rather than clamped, so a client that miscounted
 *   finds out instead of editing the wrong lines.
 */
export function registerEditNote(server: McpServer, ctx: ToolContext): void {
  const { config } = ctx;
  server.tool(
    'edit_note',
    'Replaces a range of lines in an existing note. Read the note first to determine line numbers. ' +
      'Setting end_line to start_line - 1 inserts new_content without removing any lines.',
    {
      path: z.string().describe('Path to the note relative to the vault root (e.g., "Folder/My Note.md")'),
      start_line: z.number().int().min(1).describe('First line to replace (1-indexed)'),
      end_line: z
        .number()
        .int()
        .describe(
          'Last line to replace (1-indexed, inclusive). ' +
            'Use start_line - 1 to insert new_content without removing any lines.',
        ),
      new_content: z
        .string()
        .describe('Content that replaces the specified line range (may be empty string to delete lines)'),
    },
    async ({ path: notePath, start_line, end_line, new_content }) => {
      const limited = tooManyWrites(ctx);
      if (limited) return limited;
      try {
        const fullPath = resolveVaultPath(config.vaultResolved, notePath, { trashDir: config.trashDir });

        let original: string;
        try {
          original = await fs.readFile(fullPath, 'utf-8');
        } catch {
          return fail(`Note does not exist: ${notePath}`);
        }

        const lines = original.split('\n');
        const lineCount = lines.length;

        if (end_line < start_line - 1) {
          return fail(`end_line (${end_line}) must be >= start_line - 1 (${start_line - 1})`);
        }

        if (start_line > lineCount + 1) {
          return fail(
            `start_line (${start_line}) is out of range — note has ${lineCount} line${lineCount === 1 ? '' : 's'}`,
          );
        }

        if (end_line > lineCount) {
          return fail(
            `end_line (${end_line}) is out of range — note has ${lineCount} line${lineCount === 1 ? '' : 's'}`,
          );
        }

        const removedCount = end_line - start_line + 1; // 0 when inserting
        const insertLines = new_content === '' ? [] : new_content.split('\n');

        lines.splice(start_line - 1, Math.max(0, removedCount), ...insertLines);

        const backup = await copyToTrash(config.vaultResolved, config.trashDir, notePath);
        await fs.writeFile(fullPath, lines.join('\n'), 'utf-8');

        const action =
          removedCount <= 0
            ? `Inserted ${insertLines.length} line${insertLines.length === 1 ? '' : 's'} before line ${start_line} in ${notePath}`
            : `Replaced lines ${start_line}–${end_line} in ${notePath} (${removedCount} → ${insertLines.length} line${insertLines.length === 1 ? '' : 's'})`;

        return ok(`${action}; previous version backed up to ${backup}`);
      } catch (err) {
        return fail(`Error editing note: ${errorMessage(err)}`);
      }
    },
  );
}
