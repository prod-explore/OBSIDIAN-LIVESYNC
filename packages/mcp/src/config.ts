import * as path from 'path';
import { resolveTrashDir } from 'obsidian-livesync-shared';

/** The server's settings, read once from the environment at start-up. */
export interface Config {
  port: number;
  /** VAULT_PATH as given. */
  vaultPath: string;
  /** VAULT_PATH as an absolute path: the root every client path is resolved and checked against. */
  vaultResolved: string;
  apiKey: string;
  /** TRASH_DIR: the folder (relative to the vault root) deleted and replaced notes go to; shared with the sync. */
  trashDir: string;
  /** SSE sessions older than this (ms) get force-closed by the sweep, in case the client never fired 'close'. */
  sseSessionMaxAgeMs: number;
  /** How often (ms) the sweep checks for stale SSE sessions. */
  sseSweepIntervalMs: number;
  /** Largest JSON request body the server accepts (express `limit` syntax, e.g. "5mb"); a bigger note is refused with 413. */
  bodyLimit: string;
  /** Mutating tool calls (write, edit, move, delete) allowed per window; 0 turns the limit off. */
  writeLimit: { max: number; windowMs: number };
  /** Sent to every client on connect (MCP `instructions`); undefined = send none. See resolveInstructions(). */
  instructions: string | undefined;
}

/**
 * The pointer every client gets on connect (the MCP `instructions` field), next to the tool list. It only says
 * where the vault owner keeps their own rules; the server never creates or fills that file, and what is in it
 * (structure, conventions, how to work in the vault) is entirely the owner's.
 */
export const DEFAULT_INSTRUCTIONS =
  "Before any vault operation, read `_Systems/AGENTS.md` if the vault has one: it holds the owner's rules for the vault's structure and for working in it.";

/**
 * MCP_INSTRUCTIONS replaces the default text; the value `none` sends no instructions at all.
 * Unset and empty both mean "the default", so a compose file can pass the variable through safely.
 */
export function resolveInstructions(env: NodeJS.ProcessEnv): string | undefined {
  const value = env.MCP_INSTRUCTIONS?.trim();
  if (!value) return DEFAULT_INSTRUCTIONS;
  return value.toLowerCase() === 'none' ? undefined : value;
}

/** A whole number of at least 0 from the environment; anything else falls back to the default. */
function nonNegative(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

/**
 * Reads the configuration from the environment. Throws when MCP_API_KEY is missing (the server never runs without
 * authentication) or TRASH_DIR is not a folder inside the vault. Every other setting has a default.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const apiKey = env.MCP_API_KEY;
  if (!apiKey) {
    throw new Error('MCP_API_KEY environment variable is not set. Refusing to start without authentication.');
  }

  const vaultPath = env.VAULT_PATH || '/vault';

  return {
    port: Number(env.PORT) || 3000,
    vaultPath,
    vaultResolved: path.resolve(vaultPath),
    apiKey,
    trashDir: resolveTrashDir(env.TRASH_DIR),
    sseSessionMaxAgeMs: Number(env.SSE_SESSION_MAX_AGE_MS) || 60 * 60 * 1000,
    sseSweepIntervalMs: Number(env.SSE_SWEEP_INTERVAL_MS) || 5 * 60 * 1000,
    bodyLimit: env.MCP_BODY_LIMIT?.trim() || '5mb',
    writeLimit: { max: nonNegative(env.MCP_WRITE_LIMIT_PER_MINUTE, 120), windowMs: 60_000 },
    instructions: resolveInstructions(env),
  };
}
