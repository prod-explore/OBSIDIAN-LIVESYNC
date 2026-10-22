import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { createLogger } from '../logger.js';
import { StateManager } from '../sync/state.js';

const quiet = createLogger({ level: 'silent' });

async function withDataDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gcal-state-'));
  const previous = process.env.DATA_PATH;
  process.env.DATA_PATH = dir;
  try {
    return await fn(dir);
  } finally {
    if (previous === undefined) delete process.env.DATA_PATH;
    else process.env.DATA_PATH = previous;
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test('a first run starts from an empty state', async () => {
  await withDataDir(async () => {
    const state = await new StateManager().load();
    assert.deepEqual(state, { calendarTokens: {}, tasksTokens: {}, knownTaskIds: {}, knownEventIds: {} });
  });
});

test('saved state loads back unchanged and leaves no temporary file', async () => {
  await withDataDir(async (dir) => {
    const manager = new StateManager();
    const state = {
      calendarTokens: { primary: 'tok' },
      tasksTokens: { '@default': '2026-09-01T00:00:00.000Z' },
      knownTaskIds: { '@default': ['a', 'b'] },
      knownEventIds: { primary: ['e1'] },
    };
    await manager.save(state);
    assert.deepEqual(await manager.load(), state);
    assert.deepEqual(await fs.readdir(dir), ['sync-state.json']);
  });
});

test('a state file from an older version is zero-filled', async () => {
  await withDataDir(async (dir) => {
    await fs.writeFile(path.join(dir, 'sync-state.json'), JSON.stringify({ calendarTokens: { primary: 'x' } }));
    const state = await new StateManager().load();
    assert.deepEqual(state.calendarTokens, { primary: 'x' });
    assert.deepEqual(state.knownTaskIds, {});
    assert.deepEqual(state.knownEventIds, {});
  });
});

test('a corrupt state file is moved aside, not silently overwritten', async () => {
  await withDataDir(async (dir) => {
    await fs.writeFile(path.join(dir, 'sync-state.json'), '{"calendarTokens": {');
    const state = await new StateManager(quiet).load();
    assert.deepEqual(state.calendarTokens, {});
    const files = await fs.readdir(dir);
    const aside = files.find((f) => f.startsWith('sync-state.json.corrupt-'));
    assert.ok(aside, 'the broken file should be kept for inspection');
    assert.equal(await fs.readFile(path.join(dir, aside!), 'utf-8'), '{"calendarTokens": {');
    assert.equal(files.includes('sync-state.json'), false);
  });
});

test('a state file that cannot be read stops the cycle instead of pretending there is no state', async () => {
  await withDataDir(async (dir) => {
    // A directory where the file should be: readFile fails with EISDIR, not ENOENT.
    await fs.mkdir(path.join(dir, 'sync-state.json'));
    await assert.rejects(
      () => new StateManager().load(),
      (err: NodeJS.ErrnoException) => err.code === 'EISDIR',
    );
  });
});

test('a state that cannot be saved is an error, not a silent loss of progress', async () => {
  await withDataDir(async (dir) => {
    await fs.writeFile(path.join(dir, 'blocker'), 'a file where a folder is needed');
    const manager = new StateManager(quiet, path.join(dir, 'blocker', 'inside'));
    await assert.rejects(() =>
      manager.save({ calendarTokens: {}, tasksTokens: {}, knownTaskIds: {}, knownEventIds: {} }),
    );
  });
});
