import { Config } from '../config.js';
import type { WriteLimiter } from '../rateLimit.js';

/**
 * The result every tool handler returns: one text block, flagged as an error when the call failed.
 * The index signature matches the SDK's CallToolResult, which allows extra fields; without it the compiler rejects
 * this type as too narrow for a handler's return value.
 */
export interface ToolTextResult {
  [key: string]: unknown;
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

/** A successful tool result. */
export function ok(text: string): ToolTextResult {
  return { content: [{ type: 'text', text }] };
}

/** A failed tool result: the client sees `text` as a tool error, not as a protocol error. */
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
