import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Config } from '../config.js';
import { registerGetPath } from './getPath.js';
import { registerVaultTree } from './vaultTree.js';
import { registerWriteNote } from './writeNote.js';
import { registerEditNote } from './editNote.js';
import { registerSearchNotes } from './searchNotes.js';
import { registerMoveNote } from './moveNote.js';
import { registerDeleteNote } from './deleteNote.js';

/** Registers every tool this server exposes onto a fresh McpServer instance. */
export function registerAllTools(server: McpServer, config: Config): void {
  const ctx = { config };
  registerGetPath(server, ctx);
  registerVaultTree(server, ctx);
  registerWriteNote(server, ctx);
  registerEditNote(server, ctx);
  registerSearchNotes(server, ctx);
  registerMoveNote(server, ctx);
  registerDeleteNote(server, ctx);
}
