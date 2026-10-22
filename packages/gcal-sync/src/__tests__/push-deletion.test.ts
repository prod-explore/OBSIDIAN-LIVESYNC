import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type { calendar_v3, tasks_v1 } from 'googleapis';
import type { Config } from '../config.js';
import type { SyncState } from '../sync/state.js';
import { push } from './fakes.js';

function setup(taskIds: string[], overrides: Partial<Config> = {}) {
  const deleted: string[] = [];
  const tasks = {
    tasks: {
      delete: async ({ task }: { task: string }) => {
        deleted.push(task);
      },
    },
  } as unknown as tasks_v1.Tasks;
  const calendar = {
    events: {
      delete: async () => {
        throw new Error('no calendar deletions expected');
      },
    },
  } as unknown as calendar_v3.Calendar;
  const state: SyncState = {
    calendarTokens: {},
    tasksTokens: {},
    knownTaskIds: { '@default': [...taskIds] },
    knownEventIds: {},
  };
  return { deleted, tasks, calendar, state, overrides };
}

async function emptyVault(): Promise<Config> {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), 'gcal-push-'));
  return {
    vaultPath: vault,
    vaultResolved: vault,
    clientId: 'x',
    clientSecret: 'x',
    refreshToken: 'x',
    calendarIds: ['primary'],
    tasklistIds: ['@default'],
    pollIntervalMinutes: 5,
    allowMassDelete: false,
    cancelledRetentionDays: 30,
  };
}

const ids = (n: number) => Array.from({ length: n }, (_, i) => `task-${i}`);

test('an unavailable vault does not wipe the task list on Google', async () => {
  const config = await emptyVault();
  const { deleted, tasks, calendar, state } = setup(ids(30));
  await push(config, state, calendar, tasks);
  assert.deepEqual(deleted, []);
  assert.equal(state.knownTaskIds['@default'].length, 30, 'the manifest must keep the ids so nothing is forgotten');
});

test('a small, genuine deletion still goes through and leaves the manifest', async () => {
  const config = await emptyVault();
  const { deleted, tasks, calendar, state } = setup(ids(3));
  await push(config, state, calendar, tasks);
  assert.deepEqual(deleted.sort(), ids(3));
  assert.deepEqual(state.knownTaskIds['@default'], []);
});

test('ALLOW_MASS_DELETE=true lets a deliberate bulk deletion through', async () => {
  const config = { ...(await emptyVault()), allowMassDelete: true };
  const { deleted, tasks, calendar, state } = setup(ids(30));
  await push(config, state, calendar, tasks);
  assert.equal(deleted.length, 30);
});
