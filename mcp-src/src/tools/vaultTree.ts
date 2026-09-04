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
        const lines: string[] = [inputPath ? `${inputPath}/` : '(vault root)'];
        await walk(rootPath, lines, depth, 0, '');
        return ok(lines.join('\n'));
      } catch (err: any) {
        if (err.code === 'ENOENT') return fail(`Path not found: ${inputPath}`);
        return fail(`Error building tree: ${err.message}`);
      }
    }
  );
}

/**
 * Recursively walks `dirPath`, appending classic tree-style lines to `lines`.
 *
 *   01-Projects/
 *   ├── README.md
 *   ├── Projekt A/
 *   │   ├── Notatka.md
 *   │   └── Plik.md
 *   └── Projekt B/
 *
 * Skips dotfiles/dotdirs and symlinks. Directories are listed before files
 * within each level for consistent visual grouping.
 *
 * @param maxDepth  -1 = unlimited; 0 = direct children only; N = N levels deep.
 * @param curDepth  current recursion depth (starts at 0).
 * @param prefix    the indentation string built up through recursion.
 */
async function walk(
  dirPath: string,
  lines: string[],
  maxDepth: number,
  curDepth: number,
  prefix: string
): Promise<void> {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });

  // Skip dotfiles/dotdirs; sort directories before files, then alphabetically.
  const visible = entries
    .filter(e => !e.name.startsWith('.') && (e.isDirectory() || e.isFile()))
    .sort((a, b) => {
      const aDir = a.isDirectory() ? 0 : 1;
      const bDir = b.isDirectory() ? 0 : 1;
      if (aDir !== bDir) return aDir - bDir;
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });

  for (let i = 0; i < visible.length; i++) {
    const entry    = visible[i];
    const isLast   = i === visible.length - 1;
    const branch   = isLast ? '└── ' : '├── ';
    const childPfx = isLast ? '    ' : '│   ';

    if (entry.isDirectory()) {
      lines.push(`${prefix}${branch}${entry.name}/`);
      if (maxDepth === -1 || curDepth < maxDepth) {
        await walk(
          path.join(dirPath, entry.name),
          lines,
          maxDepth,
          curDepth + 1,
          prefix + childPfx
        );
      }
    } else {
      lines.push(`${prefix}${branch}${entry.name}`);
    }
  }
}
