import * as fs from 'fs/promises';
import * as path from 'path';
import { isFileMissing } from '../errors.js';
import { logger as defaultLogger, type Logger } from '../logger.js';

export interface SyncState {
  calendarTokens: Record<string, string>;
  tasksTokens: Record<string, string>;
  // Manifest of google_ids known to exist per tasklist/calendar.
  // Used by push to detect file deletions (ids that vanished from the vault).
  knownTaskIds: Record<string, string[]>; // tasklistId → [googleId, ...]
  knownEventIds: Record<string, string[]>; // calendarId → [googleId, ...]
}

export function emptyState(): SyncState {
  return { calendarTokens: {}, tasksTokens: {}, knownTaskIds: {}, knownEventIds: {} };
}

/** Where the sync keeps what it must remember between runs (sync-state.json, status.json). */
export function dataDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.DATA_PATH || path.resolve(process.cwd(), 'gcal-sync-state');
}

export class StateManager {
  private stateFile: string;

  constructor(
    private readonly log: Logger = defaultLogger,
    dir: string = dataDir(),
  ) {
    this.stateFile = path.join(dir, 'sync-state.json');
  }

  /**
   * A missing file is a first run. A file that cannot be read stops the cycle (throws) instead of
   * silently starting from nothing, and a file that is not valid JSON is moved aside, not overwritten,
   * so there is something to look at afterwards.
   */
  async load(): Promise<SyncState> {
    let content: string;
    try {
      content = await fs.readFile(this.stateFile, 'utf-8');
    } catch (err) {
      if (isFileMissing(err)) return emptyState();
      throw err;
    }

    let raw: Partial<SyncState>;
    try {
      raw = JSON.parse(content) as Partial<SyncState>;
    } catch {
      const aside = `${this.stateFile}.corrupt-${Date.now()}`;
      await fs.rename(this.stateFile, aside).catch(() => {});
      this.log.error('State file is not valid JSON; moved aside and starting from an empty state (full re-sync)', {
        file: this.stateFile,
        movedTo: aside,
      });
      return emptyState();
    }

    // Zero-fill new fields — existing sync-state.json files won't break.
    return {
      calendarTokens: raw.calendarTokens ?? {},
      tasksTokens: raw.tasksTokens ?? {},
      knownTaskIds: raw.knownTaskIds ?? {},
      knownEventIds: raw.knownEventIds ?? {},
    };
  }

  /**
   * Writes to a temporary file and renames it over the real one, so a crash mid-write cannot leave half a file.
   * Throws when it cannot write: a cycle whose progress was not saved is not a success.
   */
  async save(state: SyncState): Promise<void> {
    const tmp = `${this.stateFile}.tmp`;
    try {
      await fs.mkdir(path.dirname(this.stateFile), { recursive: true });
      await fs.writeFile(tmp, JSON.stringify(state, null, 2), 'utf-8');
      await fs.rename(tmp, this.stateFile);
    } catch (err) {
      await fs.rm(tmp, { force: true }).catch(() => {});
      throw err;
    }
  }
}
