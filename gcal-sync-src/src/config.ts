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

  const pollIntervalMinutes = parseInt(process.env.POLL_INTERVAL_MINUTES || '5', 10);
  if (isNaN(pollIntervalMinutes) || pollIntervalMinutes < 1) {
    throw new Error('POLL_INTERVAL_MINUTES must be a positive integer');
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
  };
}
