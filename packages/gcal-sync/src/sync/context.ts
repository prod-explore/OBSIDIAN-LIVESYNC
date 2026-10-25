import type { calendar_v3, tasks_v1 } from 'googleapis';
import type { Config } from '../config.js';
import { errorMessage } from '../errors.js';
import { logger, type Fields, type Logger } from '../logger.js';
import type { SyncState } from './state.js';

/** What went wrong in one cycle, for the status file and the health check. */
export interface CycleReport {
  /** Failures that were logged and skipped. A cycle with any of them is not counted as a success. */
  errors: number;
  /** The first of them, in words, for the status file: the health check can then say what is wrong without the logs. */
  firstError?: string;
  /** Notes that cannot be synced as they are (a date that is not a date, say), by vault path, with the reason. */
  problems: Map<string, string>;
}

/** Everything one sync cycle works with, so a function takes one argument instead of a long list. */
export interface SyncContext {
  readonly config: Config;
  readonly state: SyncState;
  readonly calendar: calendar_v3.Calendar;
  readonly tasks: tasks_v1.Tasks;
  readonly log: Logger;
  readonly report: CycleReport;
  now(): Date;
  /** Logs a failure that is skipped rather than thrown, and counts it against the cycle. */
  fail(message: string, err?: unknown, fields?: Fields): void;
  /** Records a note that is left alone because it cannot be synced; logged once, listed in the status file every cycle. */
  flag(path: string, reason: string): void;
}

export interface ContextParts {
  config: Config;
  state: SyncState;
  calendar: calendar_v3.Calendar;
  tasks: tasks_v1.Tasks;
  log?: Logger;
  now?: () => Date;
}

/** A fresh context for one cycle, with an empty report. */
export function createContext(parts: ContextParts): SyncContext {
  const log = parts.log ?? logger;
  const report: CycleReport = { errors: 0, problems: new Map() };
  return {
    config: parts.config,
    state: parts.state,
    calendar: parts.calendar,
    tasks: parts.tasks,
    log,
    report,
    now: parts.now ?? (() => new Date()),
    fail(message, err, fields) {
      report.errors++;
      report.firstError ??= err === undefined ? message : `${message}: ${errorMessage(err)}`;
      log.error(message, { ...(err === undefined ? {} : { error: errorMessage(err) }), ...fields });
    },
    flag(path, reason) {
      report.problems.set(path, reason);
      log.warnOnce(`${path}: ${reason}`, `Skipping ${path}: ${reason}`);
    },
  };
}
