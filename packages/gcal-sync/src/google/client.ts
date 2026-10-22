import { google } from 'googleapis';
import { Config } from '../config.js';

export function createGoogleClient(config: Config) {
  const oauth2Client = new google.auth.OAuth2(
    config.clientId,
    config.clientSecret
  );

  oauth2Client.setCredentials({
    refresh_token: config.refreshToken
  });

  const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
  const tasks = google.tasks({ version: 'v1', auth: oauth2Client });

  return { calendar, tasks, oauth2Client };
}
