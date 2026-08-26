import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import { resolveVaultPath } from '../security.js';
import { ok, fail, ToolContext } from './types.js';

/**
 * Returns a depth-limited path snapshot rooted at the vault (or a subfolder).
 * Skips dotfiles/dotdirs (.trash, .obsidian, etc.). No content is read.
 *
 * depth=1 (default): top-level folders + their immediate children.
 *   Good for orientation — shows projects, areas, resource folders and their
 *   hubs/READMEs without flooding the context with leaf notes.
 * depth=-1: unlimited recursion.
 *   Use when scoped to a specific project/area subfolder.
 *
 * ── Recommended calling convention ──
 * 1. First vault contact per session: get_vault_tree() — depth=1 for orientation.
 * 2. After >5 min idle: same, to catch moves/renames that happened outside session.
 * 3. Exploring a specific area: get_vault_tree("02-Areas/The Protocol", depth=-1).
 */
export function registerVaultTree(server: McpServer, { config }: ToolContext): void {
  server.tool(
    'get_vault_tree',
    'Returns a path listing of the vault (no file content). ' +
      'Default depth=1 shows top-level folders + their immediate children — enough for orientation. ' +
      'Use depth=-1 for a full recursive listing (best combined with a scoped path). ' +
      'IMPORTANT: call on first vault contact per session and after >5 min idle to avoid stale paths.',
    {
      path: z
        .string()
        .default('')
        .describe('Folder path relative to vault root. Empty = vault root.'),
      depth: z
        .number()
        .int()
        .default(1)
        .describe(
          'How many levels to recurse. ' +
            '1 (default) = top folders + their immediate children. ' +
            '2 = one level deeper. ' +
            '-1 = unlimited (use with a scoped path to avoid large output).'
        ),
    },
    async ({ path: inputPath, depth }) => {
      try {
        const rootPath = resolveVaultPath(config.vaultResolved, inputPath);
        const stat = await fs.stat(rootPath);
        if (!stat.isDirectory()) {
          return fail(`Path is not a directory: ${inputPath}`);
        }
        const lines: string[] = [];
        await walk(config.vaultResolved, rootPath, lines, depth, 0);
        if (lines.length === 0) {
          return ok(`(empty) ${inputPath || '/'}`);
        }
        return ok(lines.join('\n'));
      } catch (err: any) {
        if (err.code === 'ENOENT') return fail(`Path not found: ${inputPath}`);
        return fail(`Error building tree: ${err.message}`);
      }
    }
  );
}

/**
 * Recursively walks `dirPath`, appending relative paths to `lines`.
 * Skips dotfiles/dotdirs and symlinks.
 *
 * @param maxDepth  -1 = unlimited; 0 = this directory's children only (no recursion);
 *                  N = recurse N levels deep.
 * @param curDepth  current recursion depth (starts at 0).
 */
async function walk(
  vaultRoot: string,
  dirPath: string,
  lines: string[],
  maxDepth: number,
  curDepth: number
): Promise<void> {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;

    const absPath = path.join(dirPath, entry.name);
    const relPath = path.relative(vaultRoot, absPath).replace(/\\/g, '/');

    if (entry.isDirectory()) {
      lines.push(`📁 ${relPath}/`);
      // Recurse if unlimited (-1) or we haven't hit the depth cap yet.
      if (maxDepth === -1 || curDepth < maxDepth) {
        await walk(vaultRoot, absPath, lines, maxDepth, curDepth + 1);
      }
    } else if (entry.isFile()) {
      lines.push(`📄 ${relPath}`);
    }
    // skip symlinks silently
  }
}
