import * as fs from 'fs/promises';
import * as path from 'path';
import { isFileMissing } from './errors.js';

/**
 * What the sync tells the outside world about itself: a small JSON file next to the sync state, rewritten after
 * every cycle. `docker inspect` shows the health check's verdict; this file is where the verdict comes from and
 * what to read for the reasons (`cat status.json`).
 */
export interface SyncStatus {
  version: 1;
  /** When the latest cycle started (ISO 8601). */
  lastAttemptAt: string;
  /** When the latest cycle that finished without an error ended. Absent until there has been one. */
  lastSuccessAt?: string;
  lastDurationMs: number;
  /** Errors in the latest cycle. 0 means it went through cleanly. */
  errors: number;
  /** What stopped or failed the latest cycle, when it did not succeed. */
  lastError?: string;
  /** Notes the sync leaves alone until someone fixes them: vault path → why. These do not make the cycle fail. */
  problems: Record<string, string>;
  /** Cancelled notes removed by the latest cycle. */
  removedCancelled: number;
  /** Copied from the config so the health check needs no environment of its own. */
  pollIntervalMinutes: number;
}

export const statusFilePath = (dir: string): string => path.join(dir, 'status.json');

/** The last status written; undefined when the file is missing, is not JSON, or is not a version-1 status. */
export async function readStatus(file: string): Promise<SyncStatus | undefined> {
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf-8')) as Partial<SyncStatus>;
    return parsed.version === 1 && typeof parsed.lastAttemptAt === 'string' ? (parsed as SyncStatus) : undefined;
  } catch (err) {
    if (isFileMissing(err) || err instanceof SyntaxError) return undefined;
    throw err;
  }
}

/** Written to a temporary file and renamed, so a health check never reads half a file. */
export async function writeStatus(file: string, status: SyncStatus): Promise<void> {
  const tmp = `${file}.tmp`;
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(tmp, JSON.stringify(status, null, 2), 'utf-8');
  await fs.rename(tmp, file);
}

export interface Health {
  healthy: boolean;
  /** One line, for `docker inspect` and for people. */
  reason: string;
}

const MINUTE_MS = 60_000;

/** How old the last success may be before the sync counts as stuck: three missed polls and a margin for a long first sync. */
export const staleAfterMinutes = (pollIntervalMinutes: number): number => pollIntervalMinutes * 3 + 5;

/** The health check's verdict: healthy while the last successful cycle is recent enough. */
export function evaluateHealth(status: SyncStatus | undefined, now: Date): Health {
  if (!status) return { healthy: false, reason: 'no sync cycle has finished yet' };

  const detail = status.lastError
    ? ` Last error: ${status.lastError}`
    : status.errors > 0
      ? ` The last cycle had ${status.errors} error(s); see the logs.`
      : '';
  if (!status.lastSuccessAt) return { healthy: false, reason: `no sync cycle has succeeded yet.${detail}` };

  const ageMinutes = Math.floor((now.getTime() - new Date(status.lastSuccessAt).getTime()) / MINUTE_MS);
  const limit = staleAfterMinutes(status.pollIntervalMinutes);
  if (ageMinutes > limit) {
    return { healthy: false, reason: `last successful sync was ${ageMinutes} minutes ago (limit ${limit}).${detail}` };
  }

  const problems = Object.keys(status.problems).length;
  return {
    healthy: true,
    reason: `last successful sync ${ageMinutes} minute(s) ago${problems > 0 ? `; ${problems} note(s) need attention, see status.json` : ''}`,
  };
}
