import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import { resolveVaultPath } from '../security.js';
import { ok, fail, ToolContext } from './types.js';

/**
 * Returns a recursive snapshot of paths rooted at the vault (or a subfolder).
 * Skips dotfiles/dotdirs (.trash, .obsidian, etc.). No content is read.
 *
 * ── Recommended calling convention ──
 * 1. On first vault contact per session — full tree for orientation.
 * 2. After > 5 min idle — files may have moved outside this session.
 * 3. Scoped to a subfolder when exploring a project or area in detail.
 */
export function registerVaultTree(server: McpServer, { config }: ToolContext): void {
  server.tool(
    'get_vault_tree',
    'Returns a recursive listing of paths (no content). ' +
      'Leave path empty for the full vault tree. ' +
      'Pass a folder path (e.g. "01-Projects/HYPNAGOGIA Instrumentals") to scope to a subtree. ' +
      'IMPORTANT: call with no path on first vault contact per session and after >5 min idle.',
    {
      path: z
        .string()
        .default('')
        .describe('Folder path relative to vault root. Empty = full vault tree.'),
    },
    async ({ path: inputPath }) => {
      try {
        const rootPath = resolveVaultPath(config.vaultResolved, inputPath);
        const stat = await fs.stat(rootPath);
        if (!stat.isDirectory()) {
          return fail(`Path is not a directory: ${inputPath}`);
        }
        const lines: string[] = [];
        await walk(config.vaultResolved, rootPath, lines);
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
 * Skips:
 *   - any entry whose name starts with '.'  (dotfiles / .trash / .obsidian)
 *   - symlinks (fs.readdir withFileTypes reports them; we skip to avoid loops)
 */
async function walk(vaultRoot: string, dirPath: string, lines: string[]): Promise<void> {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;

    const absPath = path.join(dirPath, entry.name);
    const relPath = path.relative(vaultRoot, absPath).replace(/\\/g, '/');

    if (entry.isDirectory()) {
      lines.push(`📁 ${relPath}/`);
      await walk(vaultRoot, absPath, lines);
    } else if (entry.isFile()) {
      lines.push(`📄 ${relPath}`);
    }
    // skip symlinks silently
  }
}
