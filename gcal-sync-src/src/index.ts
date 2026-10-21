import cron from 'node-cron';
import { loadConfig } from './config.js';
import { createGoogleClient } from './google/client.js';
import { StateManager } from './sync/state.js';
import { ingestGoogleData } from './sync/ingest.js';
import { pushVaultData } from './sync/push.js';
import { sweepCalendarArchive } from './sync/archive-sweep.js';

let isSyncing = false;
let shuttingDown = false;
let currentCycle: Promise<void> | null = null;

/** How long a stop signal waits for a running cycle before giving up (compose gives the container 20s). */
const SHUTDOWN_WAIT_MS = 15_000;

function runSyncCycle(): Promise<void> {
  if (isSyncing || shuttingDown) {
    console.log(shuttingDown ? '[Skip] Shutting down.' : '[Skip] Previous sync cycle still running.');
    return Promise.resolve();
  }
  currentCycle = syncOnce().finally(() => { currentCycle = null; });
  return currentCycle;
}

async function syncOnce() {
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
    await pushVaultData(config, state, calendar, tasks);

    console.log('[Archive Sweep] Checking for past-month events to archive...');
    await sweepCalendarArchive(config);

    await stateManager.save(state);
    console.log(`--- Sync Cycle Completed Successfully ---\n`);
  } catch (err: any) {
    console.error('Fatal error during sync cycle:', err.message);
  } finally {
    isSyncing = false;
  }
}

let cronTask: ReturnType<typeof cron.schedule> | null = null;

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
    cronTask = cron.schedule(`*/${config.pollIntervalMinutes} * * * *`, () => {
      void runSyncCycle();
    });

  } catch (err: any) {
    console.error('Failed to boot sync service:', err.message);
    process.exit(1);
  }
}

bootstrap();

/**
 * Stops scheduling and lets a cycle that is already running finish: it may be halfway through
 * rewriting a note or the state file, and killing it there is how files end up truncated.
 */
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received. Shutting down...`);
  cronTask?.stop();
  if (currentCycle) {
    console.log('Waiting for the running sync cycle to finish...');
    await Promise.race([currentCycle, new Promise((resolve) => setTimeout(resolve, SHUTDOWN_WAIT_MS))]);
  }
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
