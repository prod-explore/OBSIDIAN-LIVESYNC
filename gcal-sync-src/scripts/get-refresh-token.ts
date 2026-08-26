import { google } from 'googleapis';
import * as http from 'http';
import * as url from 'url';
import * as dotenv from 'dotenv';

// Load variables from .env if present
dotenv.config({ path: '../.env' });

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID || 'MISSING_CLIENT_ID';
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || 'MISSING_CLIENT_SECRET';
const REDIRECT_URI = 'http://localhost:3000/oauth2callback';

if (CLIENT_ID === 'MISSING_CLIENT_ID') {
  console.error("Please add GOOGLE_CLIENT_ID to your .env file before running this script.");
  process.exit(1);
}

const SCOPES = [
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/tasks'
];

const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

console.log('Generating auth URL...\n');
const authUrl = oauth2Client.generateAuthUrl({
  access_type: 'offline',
  scope: SCOPES,
  prompt: 'consent', // Force consent prompt to ensure refresh token is returned
});

console.log('====================================================');
console.log('1. Click this link and sign in with Google:');
console.log(authUrl);
console.log('====================================================\n');

const server = http.createServer(async (req, res) => {
  try {
    if (req.url && req.url.startsWith('/oauth2callback')) {
      const q = url.parse(req.url, true).query;
      if (q.error) {
        console.error('Error returned from Google:', q.error);
        res.end('Error! Check terminal.');
        process.exit(1);
      }
      
      if (q.code) {
        console.log('Authorization code received, exchanging for tokens...');
        const { tokens } = await oauth2Client.getToken(q.code as string);
        
        console.log('\n=== SUCCESS! Copy the token below to your .env ===\n');
        console.log(`GOOGLE_REFRESH_TOKEN=${tokens.refresh_token}`);
        console.log('\n==================================================');
        
        res.end('Authentication successful! Refresh token printed in your terminal. You can close this tab.');
        
        // Wait a bit to ensure response is sent before killing server
        setTimeout(() => {
          server.close();
          process.exit(0);
        }, 1000);
      }
    }
  } catch (err: any) {
    console.error('Error exchanging token:', err.message);
    res.end('Error! Check terminal.');
    process.exit(1);
  }
});

server.listen(3000, () => {
  console.log('Listening on http://localhost:3000/oauth2callback for the redirect...');
});
