import * as fs from 'fs/promises';
import * as path from 'path';

export interface SyncState {
  calendarTokens: Record<string, string>;
  tasksTokens: Record<string, string>;
}

export class StateManager {
  private stateFile: string;

  constructor() {
    // If running in docker, it maps to /data. If local, gcal-sync-state in current dir
    const dataDir = process.env.DATA_PATH || path.resolve(process.cwd(), 'gcal-sync-state');
    this.stateFile = path.join(dataDir, 'sync-state.json');
  }

  async load(): Promise<SyncState> {
    try {
      const content = await fs.readFile(this.stateFile, 'utf-8');
      return JSON.parse(content);
    } catch {
      return { calendarTokens: {}, tasksTokens: {} };
    }
  }

  async save(state: SyncState): Promise<void> {
    try {
      await fs.mkdir(path.dirname(this.stateFile), { recursive: true });
      await fs.writeFile(this.stateFile, JSON.stringify(state, null, 2), 'utf-8');
    } catch (err: any) {
      console.error(`Error saving sync state: ${err.message}`);
    }
  }
}
