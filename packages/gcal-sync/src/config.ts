import * as path from 'path';
import { resolveTrashDir } from 'obsidian-livesync-shared';

/** The service's settings, read once from the environment at start-up. */
export interface Config {
  /** VAULT_PATH as given. */
  vaultPath: string;
  /** VAULT_PATH as an absolute path: every note path is resolved and checked against it. */
  vaultResolved: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  calendarIds: string[];
  pollIntervalMinutes: number;
  /** Lets push delete most of a list on Google in one cycle (see sync/safety.ts). Off unless ALLOW_MASS_DELETE=true. */
  allowMassDelete: boolean;
  /**
   * How long a cancelled note with an empty body is kept before the sync removes it (see sync/retention.ts).
   * 0 keeps them for ever.
   */
  cancelledRetentionDays: number;
  /** TRASH_DIR, the vault's trash folder, read as the MCP server reads it: where a deleted task list's folder goes. */
  trashDir: string;
}

/** Folders the sync reads notes from; a trash inside one would have its contents synced back. */
const SYNCED_ROOTS = ['{Tasks}', '{Calendar}', '04-Archive'];

/** Reads and checks the configuration. Throws, naming the variable, when one is missing or out of range. */
export function loadConfig(): Config {
  const vaultPath = process.env.VAULT_PATH;
  if (!vaultPath) throw new Error('VAULT_PATH environment variable is required');

  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) throw new Error('GOOGLE_CLIENT_ID environment variable is required');

  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientSecret) throw new Error('GOOGLE_CLIENT_SECRET environment variable is required');

  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;
  if (!refreshToken) throw new Error('GOOGLE_REFRESH_TOKEN environment variable is required');

  const calendarIdsRaw = process.env.CALENDAR_IDS || 'primary';

  const calendarIds = calendarIdsRaw
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);

  // The schedule is a cron expression (*/n * * * *), which only allows 1-59.
  const pollIntervalMinutes = Number(process.env.POLL_INTERVAL_MINUTES || '5');
  if (!Number.isInteger(pollIntervalMinutes) || pollIntervalMinutes < 1 || pollIntervalMinutes > 59) {
    throw new Error('POLL_INTERVAL_MINUTES must be a whole number from 1 to 59');
  }

  const retentionRaw = process.env.CANCELLED_RETENTION_DAYS || '30';
  const cancelledRetentionDays = Number(retentionRaw);
  if (!Number.isInteger(cancelledRetentionDays) || cancelledRetentionDays < 0 || cancelledRetentionDays > 3650) {
    throw new Error('CANCELLED_RETENTION_DAYS must be a whole number of days from 0 (keep for ever) to 3650');
  }

  const trashDir = resolveTrashDir(process.env.TRASH_DIR);
  if (SYNCED_ROOTS.some((root) => trashDir === root || trashDir.startsWith(`${root}/`))) {
    throw new Error(
      `TRASH_DIR must not be inside a folder the sync reads (${SYNCED_ROOTS.join(', ')}); got "${trashDir}"`,
    );
  }

  return {
    vaultPath,
    vaultResolved: path.resolve(vaultPath),
    clientId,
    clientSecret,
    refreshToken,
    calendarIds,
    pollIntervalMinutes,
    allowMassDelete: process.env.ALLOW_MASS_DELETE === 'true',
    cancelledRetentionDays,
    trashDir,
  };
}
