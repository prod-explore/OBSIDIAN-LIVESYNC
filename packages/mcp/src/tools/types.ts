import { Config } from '../config.js';

/**
 * Standard MCP tool result shape returned by every tool handler in this project.
 * The index signature matches the SDK's own (wider) CallToolResult type, which
 * allows arbitrary extra fields — without it, TS rejects this as too narrow.
 */
export interface ToolTextResult {
  [key: string]: unknown;
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

export function ok(text: string): ToolTextResult {
  return { content: [{ type: 'text', text }] };
}

export function fail(text: string): ToolTextResult {
  return { content: [{ type: 'text', text }], isError: true };
}

/** Context every tool needs: where the vault lives and how it's configured. */
export interface ToolContext {
  config: Config;
}
