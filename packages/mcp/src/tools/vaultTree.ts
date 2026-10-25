import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import { resolveVaultPath } from '../security.js';
import { errorMessage, isFileMissing } from '../errors.js';
import { ok, fail, ToolContext } from './types.js';

/**
 * `get_vault_tree`: a depth-limited listing of the vault or of one folder in it. Names only, no content; hidden
 * entries are left out.
 *
 * The default depth of 1 shows the top-level folders and what is directly inside them: enough for a client to
 * find its way without filling its context with every note. -1 lists everything, which is meant for one folder,
 * not the whole vault.
 */
export function registerVaultTree(server: McpServer, { config }: Pick<ToolContext, 'config'>): void {
  server.tool(
    'get_vault_tree',
    'Returns a path listing of the vault (no file content). ' +
      'Default depth=1 shows top-level folders + their immediate children — enough for orientation. ' +
      'Use depth=-1 for a full recursive listing (best combined with a scoped path). ' +
      'IMPORTANT: call on first vault contact per session and after >5 min idle to avoid stale paths.',
    {
      path: z.string().default('').describe('Folder path relative to vault root. Empty = vault root.'),
      depth: z
        .number()
        .int()
        .default(1)
        .describe(
          'How many levels to recurse. ' +
            '1 (default) = top folders + their immediate children. ' +
            '2 = one level deeper. ' +
            '-1 = unlimited (use with a scoped path to avoid large output).',
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
      } catch (err) {
        if (isFileMissing(err)) return fail(`Path not found: ${inputPath}`);
        return fail(`Error building tree: ${errorMessage(err)}`);
      }
    },
  );
}

/**
 * Recursively walks `dirPath`, appending classic tree-style lines to `lines`.
 *
 *   01-Projects/
 *   ├── Project A/
 *   │   ├── Notes.md
 *   │   └── Plan.md
 *   ├── Project B/
 *   └── README.md
 *
 * Hidden entries and symbolic links are left out. Within each level folders come before files.
 *
 * @param maxDepth  -1 = unlimited; 0 = direct children only; N = N levels below them.
 * @param curDepth  current recursion depth (starts at 0).
 * @param prefix    the indentation built up through the recursion.
 */
async function walk(
  dirPath: string,
  lines: string[],
  maxDepth: number,
  curDepth: number,
  prefix: string,
): Promise<void> {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });

  const visible = entries
    .filter((e) => !e.name.startsWith('.') && (e.isDirectory() || e.isFile()))
    .sort((a, b) => {
      const aDir = a.isDirectory() ? 0 : 1;
      const bDir = b.isDirectory() ? 0 : 1;
      if (aDir !== bDir) return aDir - bDir;
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });

  for (let i = 0; i < visible.length; i++) {
    const entry = visible[i];
    const isLast = i === visible.length - 1;
    const branch = isLast ? '└── ' : '├── ';
    const childPfx = isLast ? '    ' : '│   ';

    if (entry.isDirectory()) {
      lines.push(`${prefix}${branch}${entry.name}/`);
      if (maxDepth === -1 || curDepth < maxDepth) {
        await walk(path.join(dirPath, entry.name), lines, maxDepth, curDepth + 1, prefix + childPfx);
      }
    } else {
      lines.push(`${prefix}${branch}${entry.name}`);
    }
  }
}
