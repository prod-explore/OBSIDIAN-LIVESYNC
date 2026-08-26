import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import { ok, fail, ToolContext } from './types.js';

/**
 * Returns a full recursive snapshot of all paths in the vault (directories +
 * files), skipping .trash/ and any dotfile/dotdir.
 *
 * Cost scales with file count, not file size — no content is read.
 *
 * ── Recommended calling convention (document for the agent, not enforced here) ──
 * Call get_vault_tree:
 *   1. On first vault contact per session (before any read/write operation).
 *   2. Again after the session has been idle for > 5 minutes.
 * Rationale: files may have been moved or renamed outside this session
 * (e.g. via Obsidian on a phone, or by another tool).  Operating on a stale
 * path cache silently creates orphan files.  This tool is cheap; use it freely.
 */
export function registerVaultTree(server: McpServer, { config }: ToolContext): void {
  server.tool(
    'get_vault_tree',
    'Returns a full recursive listing of every path in the vault (directories and file names only — no content). ' +
      'IMPORTANT: call this on first vault contact per session, and again after > 5 minutes of inactivity, ' +
      'to ensure you are not operating on stale paths.',
    {},
    async () => {
      try {
        const lines: string[] = [];
        await walk(config.vaultResolved, config.vaultResolved, lines);
        if (lines.length === 0) {
          return ok('(vault is empty)');
        }
        return ok(lines.join('\n'));
      } catch (err: any) {
        return fail(`Error building vault tree: ${err.message}`);
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
