// runCycle: the cycle as the service runs it, ending in status.json and the verdict of the health check.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { runCycle } from '../cycle.js';
import { createLogger } from '../logger.js';
import { evaluateHealth, readStatus } from '../status.js';
import { computeSyncHash } from '../sync/hash.js';
import { StateManager } from '../sync/state.js';
import { apiError, fakeCalendar, fakeTasks, exists, makeVault, removeVaults, writeNote } from './fakes.js';

after(removeVaults);

const dirs: string[] = [];
after(() => Promise.all(dirs.map((d) => fs.rm(d, { recursive: true, force: true }))));

async function setup(over: Parameters<typeof makeVault>[0] = {}) {
  const config = await makeVault(over);
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'gcal-data-'));
  dirs.push(data);
  const lines: string[] = [];
  const log = createLogger({ level: 'debug', write: (line) => lines.push(line) });
  const statusFile = path.join(data, 'status.json');
  const stateManager = new StateManager(log, data);
  return { config, data, lines, log, statusFile, stateManager };
}

test('a clean cycle saves the state and reports success', async () => {
  const { config, log, statusFile, stateManager, data } = await setup();
  await writeNote(config, '{Tasks}/Buy milk.md', { title: 'Buy milk', status: 'needsAction' });
  const tasks = fakeTasks();
  const now = () => new Date('2026-06-01T12:00:00.000Z');

  const result = await runCycle({ config, stateManager, statusFile, log, clients: { calendar: fakeCalendar().client, tasks: tasks.client }, now });

  assert.equal(result.ok, true);
  assert.equal(tasks.calls.tasks.insert.length, 1);
  const status = await readStatus(statusFile);
  assert.equal(status?.errors, 0);
  assert.equal(status?.lastSuccessAt, '2026-06-01T12:00:00.000Z');
  assert.equal(status?.pollIntervalMinutes, 5);
  assert.deepEqual(status?.problems, {});
  assert.equal(await exists({ ...config, vaultResolved: data }, 'sync-state.json'), true);
  assert.equal(evaluateHealth(status, now()).healthy, true);
});

test('a Google error is counted, the cycle is not a success, and the last success is remembered', async () => {
  const { config, log, statusFile, stateManager } = await setup();
  const earlier = new Date('2026-06-01T12:00:00.000Z');
  await runCycle({ config, stateManager, statusFile, log, clients: { calendar: fakeCalendar().client, tasks: fakeTasks().client }, now: () => earlier });

  const failing = fakeTasks({}, { list: () => { throw apiError(500, 'backend error'); } });
  const result = await runCycle({
    config, stateManager, statusFile, log,
    clients: { calendar: fakeCalendar().client, tasks: failing.client },
    now: () => new Date('2026-06-01T12:05:00.000Z'),
  });

  assert.equal(result.ok, false);
  const status = await readStatus(statusFile);
  assert.equal(status?.errors, 1);
  assert.equal(status?.lastSuccessAt, earlier.toISOString(), 'the last success is still the earlier one');
  assert.equal(status?.lastAttemptAt, '2026-06-01T12:05:00.000Z');
});

test('a failure that stops the cycle is written down and logged, and does not throw', async () => {
  const { config, log, lines, statusFile, stateManager } = await setup();
  const broken = Object.assign(Object.create(stateManager), { save: () => Promise.reject(new Error('disk full')) }) as StateManager;

  const result = await runCycle({ config, stateManager: broken, statusFile, log, clients: { calendar: fakeCalendar().client, tasks: fakeTasks().client } });

  assert.equal(result.ok, false);
  const status = await readStatus(statusFile);
  assert.equal(status?.lastError, 'disk full');
  assert.equal(status?.lastSuccessAt, undefined);
  assert.ok(lines.some((l) => l.includes('Sync cycle failed') && l.includes('disk full')));
});

test('a note that needs fixing is listed in the status, and the cycle still counts as a success', async () => {
  const { config, log, statusFile, stateManager } = await setup();
  await writeNote(config, '{Tasks}/Bad.md', { title: 'Bad', status: 'needsAction', due: 'someday' });

  const result = await runCycle({ config, stateManager, statusFile, log, clients: { calendar: fakeCalendar().client, tasks: fakeTasks().client } });

  assert.equal(result.ok, true);
  const status = await readStatus(statusFile);
  assert.match(status?.problems['{Tasks}/Bad.md'] ?? '', /due "someday" is not a date/);
});

test('cancelled notes past their retention are removed as part of the cycle', async () => {
  const { config, log, statusFile, stateManager } = await setup();
  const fm = { type: 'task', google_id: 'g1', tasklist_id: 'L1', title: 'Gone', status: 'cancelled', updated: '2026-01-01T00:00:00.000Z', source: 'google' };
  await writeNote(config, '04-Archive/{Tasks}/Gone.md', { ...fm, sync_hash: computeSyncHash(fm), synced_at: '2026-01-01T00:00:00.000Z' });
  const now = () => new Date('2026-06-01T12:00:00.000Z');

  await runCycle({ config, stateManager, statusFile, log, clients: { calendar: fakeCalendar().client, tasks: fakeTasks().client }, now });

  assert.equal(await exists(config, '04-Archive/{Tasks}/Gone.md'), false);
  assert.equal((await readStatus(statusFile))?.removedCancelled, 1);
});

test('the log says how the cycle went', async () => {
  const { config, log, lines, statusFile, stateManager } = await setup();
  await runCycle({ config, stateManager, statusFile, log, clients: { calendar: fakeCalendar().client, tasks: fakeTasks().client } });
  const finished = lines.map((l) => JSON.parse(l)).find((e) => e.msg === 'Sync cycle finished');
  assert.equal(finished.level, 'info');
  assert.equal(finished.errors, 0);
  assert.equal(typeof finished.durationMs, 'number');
});
