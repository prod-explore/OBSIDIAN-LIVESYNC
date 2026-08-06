import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Config } from '../config.js';
import { registerReadNote } from './readNote.js';
import { registerWriteNote } from './writeNote.js';
import { registerSearchNotes } from './searchNotes.js';
import { registerListFolder } from './listFolder.js';
import { registerMoveNote } from './moveNote.js';
import { registerDeleteNote } from './deleteNote.js';

/** Registers every tool this server exposes onto a fresh McpServer instance. */
export function registerAllTools(server: McpServer, config: Config): void {
  const ctx = { config };
  registerReadNote(server, ctx);
  registerWriteNote(server, ctx);
  registerSearchNotes(server, ctx);
  registerListFolder(server, ctx);
  registerMoveNote(server, ctx);
  registerDeleteNote(server, ctx);
}
