import cron from 'node-cron';
import * as path from 'path';
import { loadConfig } from './config.js';
import { runCycle } from './cycle.js';
import { errorMessage } from './errors.js';
import { logger } from './logger.js';
import { statusFilePath } from './status.js';
import { dataDir, StateManager } from './sync/state.js';

const log = logger.child({ scope: 'sync' });

/** How long a stop signal waits for a running cycle before giving up (compose gives the container 20s). */
const SHUTDOWN_WAIT_MS = 15_000;

let isSyncing = false;
let shuttingDown = false;
let currentCycle: Promise<unknown> | null = null;
let cronTask: ReturnType<typeof cron.schedule> | null = null;

function bootstrap(): void {
  log.info('Obsidian Google Calendar & Tasks sync starting');
  let config: ReturnType<typeof loadConfig>;
  try {
    config = loadConfig();
  } catch (err) {
    log.error('Cannot start', { error: errorMessage(err) });
    process.exit(1);
  }

  log.info('Configuration', {
    vault: config.vaultResolved,
    calendars: config.calendarIds,
    tasklists: config.tasklistIds,
    pollIntervalMinutes: config.pollIntervalMinutes,
    cancelledRetentionDays: config.cancelledRetentionDays,
  });

  const dir = dataDir();
  const stateManager = new StateManager(log, dir);
  const statusFile = statusFilePath(path.resolve(dir));

  const runSyncCycle = (): Promise<unknown> => {
    if (isSyncing || shuttingDown) {
      log.info(
        shuttingDown ? 'Skipping a cycle: shutting down' : 'Skipping a cycle: the previous one is still running',
      );
      return Promise.resolve();
    }
    isSyncing = true;
    currentCycle = runCycle({ config, stateManager, statusFile, log }).finally(() => {
      isSyncing = false;
      currentCycle = null;
    });
    return currentCycle;
  };

  // Run immediately on boot, then on schedule.
  void runSyncCycle().then(() => {
    if (shuttingDown) return;
    cronTask = cron.schedule(`*/${config.pollIntervalMinutes} * * * *`, () => void runSyncCycle());
  });
}

/**
 * Stops scheduling and lets a cycle that is already running finish: it may be halfway through
 * rewriting a note or the state file, and killing it there is how files end up truncated.
 */
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info('Shutting down', { signal });
  cronTask?.stop();
  if (currentCycle) {
    log.info('Waiting for the running sync cycle to finish');
    await Promise.race([currentCycle, new Promise((resolve) => setTimeout(resolve, SHUTDOWN_WAIT_MS))]);
  }
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

bootstrap();
