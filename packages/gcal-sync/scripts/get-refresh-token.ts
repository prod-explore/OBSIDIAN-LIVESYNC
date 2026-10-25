/**
 * One-off helper that prints GOOGLE_REFRESH_TOKEN: it opens Google's consent page for the Calendar and Tasks scopes,
 * catches the redirect on localhost:3000 and exchanges the code for tokens.
 * Run it on a machine with a browser: `npm run get-token --workspace packages/gcal-sync`.
 */
import { google } from 'googleapis';
import * as http from 'http';
import { fileURLToPath } from 'url';
import * as dotenv from 'dotenv';

// The repository root's .env, the same file docker compose reads.
dotenv.config({ path: fileURLToPath(new URL('../../../.env', import.meta.url)), quiet: true });

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID || 'MISSING_CLIENT_ID';
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || 'MISSING_CLIENT_SECRET';
const REDIRECT_URI = 'http://localhost:3000/oauth2callback';

if (CLIENT_ID === 'MISSING_CLIENT_ID') {
  console.error('Please add GOOGLE_CLIENT_ID to your .env file before running this script.');
  process.exit(1);
}

const SCOPES = ['https://www.googleapis.com/auth/calendar', 'https://www.googleapis.com/auth/tasks'];

const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

console.log('Generating auth URL...\n');
const authUrl = oauth2Client.generateAuthUrl({
  access_type: 'offline',
  scope: SCOPES,
  // Google returns a refresh token only on consent: without the prompt, an account that has authorised the app
  // before gets an access token alone.
  prompt: 'consent',
});

console.log('====================================================');
console.log('1. Click this link and sign in with Google:');
console.log(authUrl);
console.log('====================================================\n');

// eslint-disable-next-line @typescript-eslint/no-misused-promises -- the handler catches its own errors
const server = http.createServer(async (req, res) => {
  try {
    if (req.url && req.url.startsWith('/oauth2callback')) {
      const q = new URL(req.url, REDIRECT_URI).searchParams;
      const error = q.get('error');
      if (error) {
        console.error('Error returned from Google:', error);
        res.end('Error! Check terminal.');
        process.exit(1);
      }

      const code = q.get('code');
      if (code) {
        console.log('Authorization code received, exchanging for tokens...');
        const { tokens } = await oauth2Client.getToken(code);

        console.log('\n=== SUCCESS! Copy the token below to your .env ===\n');
        console.log(`GOOGLE_REFRESH_TOKEN=${tokens.refresh_token}`);
        console.log('\n==================================================');

        res.end('Authentication successful! Refresh token printed in your terminal. You can close this tab.');

        // Give the browser a moment to receive the page before the process exits.
        setTimeout(() => {
          server.close();
          process.exit(0);
        }, 1000);
      }
    }
  } catch (err) {
    console.error('Error exchanging token:', err instanceof Error ? err.message : String(err));
    res.end('Error! Check terminal.');
    process.exit(1);
  }
});

// Loopback only: the redirect comes from this machine's browser, and nobody else on the network needs to reach it.
server.listen(3000, 'localhost', () => {
  console.log('Listening on http://localhost:3000/oauth2callback for the redirect...');
});
