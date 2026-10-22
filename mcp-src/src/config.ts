import * as path from 'path';

export interface Config {
  port: number;
  vaultPath: string;
  vaultResolved: string;
  apiKey: string;
  /** Folder (relative to vault root) that soft-deleted notes are moved into instead of being unlinked. */
  trashDir: string;
  /** SSE sessions older than this (ms) get force-closed by the sweep, in case the client never fired 'close'. */
  sseSessionMaxAgeMs: number;
  /** How often (ms) the sweep checks for stale SSE sessions. */
  sseSweepIntervalMs: number;
  /** Sent to every client on connect (MCP `instructions`); undefined = send none. From MCP_INSTRUCTIONS. */
  instructions: string | undefined;
}

/**
 * What clients are told on connect (the MCP `instructions` field): the text in MCP_INSTRUCTIONS, or nothing.
 * There is deliberately no built-in default; a vault that has its own rules file says so here.
 * Unset and empty both mean "nothing", so a compose file can pass the variable through safely.
 */
export function resolveInstructions(env: NodeJS.ProcessEnv): string | undefined {
  return env.MCP_INSTRUCTIONS?.trim() || undefined;
}

/**
 * Reads and validates environment configuration. Exits the process if a required
 * secret is missing — this server should never boot into an unauthenticated state.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const apiKey = env.MCP_API_KEY;
  if (!apiKey) {
    console.error('FATAL: MCP_API_KEY environment variable is not set. Refusing to start.');
    process.exit(1);
  }

  const vaultPath = env.VAULT_PATH || '/vault';

  return {
    port: Number(env.PORT) || 3000,
    vaultPath,
    vaultResolved: path.resolve(vaultPath),
    apiKey,
    trashDir: env.TRASH_DIR || '.trash',
    sseSessionMaxAgeMs: Number(env.SSE_SESSION_MAX_AGE_MS) || 60 * 60 * 1000, // 1h
    sseSweepIntervalMs: Number(env.SSE_SWEEP_INTERVAL_MS) || 5 * 60 * 1000, // 5m
    instructions: resolveInstructions(env),
  };
}
