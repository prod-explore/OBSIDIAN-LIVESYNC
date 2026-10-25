import { google } from 'googleapis';
import { Config } from '../config.js';

/**
 * The Calendar and Tasks clients, authorised with the stored refresh token. The OAuth client exchanges it for a
 * short-lived access token on its own whenever one is needed.
 */
export function createGoogleClient(config: Config) {
  const oauth2Client = new google.auth.OAuth2(config.clientId, config.clientSecret);

  oauth2Client.setCredentials({
    refresh_token: config.refreshToken,
  });

  const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
  const tasks = google.tasks({ version: 'v1', auth: oauth2Client });

  return { calendar, tasks, oauth2Client };
}
