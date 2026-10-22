import * as path from 'path';

export interface Config {
  vaultPath: string;
  vaultResolved: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  calendarIds: string[];
  tasklistIds: string[];
  pollIntervalMinutes: number;
  /** Lets push delete most of a list on Google in one cycle (see sync/safety.ts). Off unless ALLOW_MASS_DELETE=true. */
  allowMassDelete: boolean;
  /**
   * How long a cancelled note with an empty body is kept before the sync removes it (see sync/retention.ts).
   * 0 keeps them for ever.
   */
  cancelledRetentionDays: number;
}

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
  const tasklistIdsRaw = process.env.TASKLIST_IDS || '@default';
  
  const calendarIds = calendarIdsRaw.split(',').map((id) => id.trim()).filter(Boolean);
  const tasklistIds = tasklistIdsRaw.split(',').map((id) => id.trim()).filter(Boolean);

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

  return {
    vaultPath,
    vaultResolved: path.resolve(vaultPath),
    clientId,
    clientSecret,
    refreshToken,
    calendarIds,
    tasklistIds,
    pollIntervalMinutes,
    allowMassDelete: process.env.ALLOW_MASS_DELETE === 'true',
    cancelledRetentionDays,
  };
}
