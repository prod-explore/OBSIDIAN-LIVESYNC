import type { calendar_v3, tasks_v1 } from 'googleapis';
import type { Config } from './config.js';
import { errorMessage } from './errors.js';
import { createGoogleClient } from './google/client.js';
import type { Logger } from './logger.js';
import { readStatus, writeStatus, type SyncStatus } from './status.js';
import { sweepCalendarArchive } from './sync/archive-sweep.js';
import { createContext, type SyncContext } from './sync/context.js';
import { ingestGoogleData } from './sync/ingest.js';
import { pushVaultData } from './sync/push/index.js';
import { sweepCancelled } from './sync/retention.js';
import type { StateManager } from './sync/state.js';

export interface CycleDeps {
  config: Config;
  stateManager: StateManager;
  /** Where status.json is written. */
  statusFile: string;
  log: Logger;
  /** The Google clients. Created from the config's credentials unless given (the tests give fakes). */
  clients?: { calendar: calendar_v3.Calendar; tasks: tasks_v1.Tasks };
  now?: () => Date;
}

export interface CycleResult {
  /** True when the cycle ran to the end and nothing in it failed. */
  ok: boolean;
  errors: number;
  durationMs: number;
}

/**
 * One full sync: pull from Google, push the vault's changes, tidy up, save the state, then report in status.json.
 * Never throws: a failure is logged, counted and written to the status file, so the schedule goes on and the health
 * check can say what happened.
 */
export async function runCycle(deps: CycleDeps): Promise<CycleResult> {
  const now = deps.now ?? (() => new Date());
  const log = deps.log;
  const started = now();
  const previous = await readStatus(deps.statusFile).catch(() => undefined);

  let ctx: SyncContext | undefined;
  let fatal: string | undefined;
  let removedCancelled = 0;

  log.info('Sync cycle started');
  try {
    const { calendar, tasks } = deps.clients ?? createGoogleClient(deps.config);
    const state = await deps.stateManager.load();
    ctx = createContext({ config: deps.config, state, calendar, tasks, log, now });

    await ingestGoogleData(ctx);
    await pushVaultData(ctx);
    removedCancelled = await sweepCancelled(ctx);
    await sweepCalendarArchive(ctx);
    await deps.stateManager.save(state);
  } catch (err) {
    fatal = errorMessage(err);
    log.error('Sync cycle failed', { error: fatal });
  }

  const finished = now();
  const errors = (ctx?.report.errors ?? 0) + (fatal ? 1 : 0);
  const ok = errors === 0;
  const durationMs = finished.getTime() - started.getTime();

  const status: SyncStatus = {
    version: 1,
    lastAttemptAt: started.toISOString(),
    lastSuccessAt: ok ? finished.toISOString() : previous?.lastSuccessAt,
    lastDurationMs: durationMs,
    errors,
    lastError: fatal,
    problems: Object.fromEntries(ctx?.report.problems ?? []),
    removedCancelled,
    pollIntervalMinutes: deps.config.pollIntervalMinutes,
  };
  try {
    await writeStatus(deps.statusFile, status);
  } catch (err) {
    log.error('Could not write the status file', { file: deps.statusFile, error: errorMessage(err) });
  }

  const fields = { errors, durationMs, problems: Object.keys(status.problems).length, removedCancelled };
  if (ok) log.info('Sync cycle finished', fields);
  else log.warn('Sync cycle finished with errors', fields);

  return { ok, errors, durationMs };
}
