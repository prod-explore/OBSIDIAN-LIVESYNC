import cron from 'node-cron';
import { loadConfig } from './config.js';
import { createGoogleClient } from './google/client.js';
import { StateManager } from './sync/state.js';
import { ingestGoogleData } from './sync/ingest.js';
import { pushVaultData } from './sync/push.js';

let isSyncing = false;

async function runSyncCycle() {
  if (isSyncing) {
    console.log('[Skip] Previous sync cycle still running.');
    return;
  }
  isSyncing = true;
  console.log(`\n--- Starting Sync Cycle at ${new Date().toISOString()} ---`);
  try {
    const config = loadConfig();
    const { calendar, tasks } = createGoogleClient(config);
    const stateManager = new StateManager();
    const state = await stateManager.load();

    console.log('[Ingest] Pulling updates from Google...');
    await ingestGoogleData(config, state, calendar, tasks);
    
    console.log('[Push] Pushing local changes to Google...');
    await pushVaultData(config, calendar, tasks);

    await stateManager.save(state);
    console.log(`--- Sync Cycle Completed Successfully ---\n`);
  } catch (err: any) {
    console.error('Fatal error during sync cycle:', err.message);
  } finally {
    isSyncing = false;
  }
}

async function bootstrap() {
  console.log('Obsidian Google Calendar & Tasks Sync started.');
  try {
    const config = loadConfig();
    console.log(`Vault Path: ${config.vaultResolved}`);
    console.log(`Calendars: ${config.calendarIds.join(', ')}`);
    console.log(`Tasklists: ${config.tasklistIds.join(', ')}`);
    console.log(`Poll Interval: ${config.pollIntervalMinutes} minutes`);
    
    // Run immediately on boot
    await runSyncCycle();

    // Schedule cron
    cron.schedule(`*/${config.pollIntervalMinutes} * * * *`, () => {
      runSyncCycle();
    });

  } catch (err: any) {
    console.error('Failed to boot sync service:', err.message);
    process.exit(1);
  }
}

bootstrap();

process.on('SIGTERM', () => {
  console.log('SIGTERM received. Shutting down...');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('SIGINT received. Shutting down...');
  process.exit(0);
});
