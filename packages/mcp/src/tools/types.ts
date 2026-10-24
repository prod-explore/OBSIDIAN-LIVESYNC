import { Config } from '../config.js';
import type { WriteLimiter } from '../rateLimit.js';

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

/** Context every tool needs: where the vault lives, how it's configured, and the limit on writes. */
export interface ToolContext {
  config: Config;
  limiter: WriteLimiter;
}

/** For the tools that change the vault: the error to return when the client is writing too fast, or null. */
export function tooManyWrites({ limiter }: ToolContext): ToolTextResult | null {
  const wait = limiter.take();
  return wait === null ? null : fail(`Too many changes to the vault in a short time. Try again in ${wait}s.`);
}
