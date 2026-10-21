import * as fs from 'fs/promises';
import * as path from 'path';

export interface SyncState {
  calendarTokens: Record<string, string>;
  tasksTokens:    Record<string, string>;
  // Manifest of google_ids known to exist per tasklist/calendar.
  // Used by push.ts to detect file deletions (ids that vanished from the vault).
  knownTaskIds:   Record<string, string[]>; // tasklistId → [googleId, ...]
  knownEventIds:  Record<string, string[]>; // calendarId → [googleId, ...]
}

function emptyState(): SyncState {
  return { calendarTokens: {}, tasksTokens: {}, knownTaskIds: {}, knownEventIds: {} };
}

export class StateManager {
  private stateFile: string;

  constructor() {
    const dataDir = process.env.DATA_PATH || path.resolve(process.cwd(), 'gcal-sync-state');
    this.stateFile = path.join(dataDir, 'sync-state.json');
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
    } catch (err: any) {
      if (err.code === 'ENOENT') return emptyState();
      throw err;
    }

    let raw: Partial<SyncState>;
    try {
      raw = JSON.parse(content);
    } catch {
      const aside = `${this.stateFile}.corrupt-${Date.now()}`;
      await fs.rename(this.stateFile, aside).catch(() => {});
      console.error(`[State] ${this.stateFile} is not valid JSON. Moved to ${aside}; starting from an empty state (full re-sync).`);
      return emptyState();
    }

    // Zero-fill new fields — existing sync-state.json files won't break.
    return {
      calendarTokens: raw.calendarTokens ?? {},
      tasksTokens:    raw.tasksTokens    ?? {},
      knownTaskIds:   raw.knownTaskIds   ?? {},
      knownEventIds:  raw.knownEventIds  ?? {},
    };
  }

  /** Writes to a temporary file and renames it over the real one, so a crash mid-write cannot leave half a file. */
  async save(state: SyncState): Promise<void> {
    const tmp = `${this.stateFile}.tmp`;
    try {
      await fs.mkdir(path.dirname(this.stateFile), { recursive: true });
      await fs.writeFile(tmp, JSON.stringify(state, null, 2), 'utf-8');
      await fs.rename(tmp, this.stateFile);
    } catch (err: any) {
      console.error(`Error saving sync state: ${err.message}`);
      await fs.rm(tmp, { force: true }).catch(() => {});
    }
  }
}
