// Task lists <-> subfolders of {Tasks}/: created, renamed and kept in both directions, never deleted.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs/promises';
import * as path from 'path';
import type { Config } from '../config.js';
import { computeSyncHash } from '../sync/hash.js';
import type { SyncState } from '../sync/state.js';
import {
  emptyState,
  exists,
  fakeCalendar,
  fakeTasks,
  ingest,
  makeVault,
  push,
  removeVaults,
  writeNote,
  type TaskListSpec,
} from './fakes.js';

after(removeVaults);

/** One cycle's worth of Google: a fresh client (the list lookup is cached per client) over lists that persist. */
function google(lists: TaskListSpec[]) {
  return fakeTasks({ lists, defaultId: 'L1' });
}

async function cycle(config: Config, state: SyncState, lists: TaskListSpec[]) {
  const tasks = google(lists);
  await ingest(config, state, fakeCalendar().client, tasks.client);
  await push(config, state, fakeCalendar().client, tasks.client);
  return tasks;
}

const mkdir = (config: Config, rel: string) => fs.mkdir(path.join(config.vaultResolved, rel), { recursive: true });

function taskNote(title: string, google_id: string, tasklist_id: string | undefined) {
  const fm = { type: 'task', title, status: 'needsAction', google_id, source: 'google' };
  return {
    ...fm,
    ...(tasklist_id ? { tasklist_id } : {}),
    synced_at: new Date().toISOString(),
    sync_hash: computeSyncHash(fm),
  };
}

test('every list but the default one gets a folder, even an empty one', async () => {
  const config = await makeVault();
  const state = emptyState();
  const lists = [
    { id: 'L1', title: 'My Tasks' },
    { id: 'L2', title: 'Shopping' },
    { id: 'L3', title: 'Work: Q4' },
  ];
  const tasks = await cycle(config, state, lists);

  assert.equal(await exists(config, '{Tasks}/Shopping'), true);
  assert.equal(await exists(config, '{Tasks}/Work- Q4'), true, 'named after the title, cleaned for a file name');
  assert.equal(await exists(config, '{Tasks}/My Tasks'), false, 'the default list lives in {Tasks}/ itself');
  assert.deepEqual(state.tasklistFolders, { L2: 'Shopping', L3: 'Work- Q4' });
  assert.equal(tasks.calls.lists.insert.length, 0, 'the folders it made do not come back as new lists');
});

test('a new folder in the vault, even an empty one, becomes a list once', async () => {
  const config = await makeVault();
  const state = emptyState();
  const lists = [{ id: 'L1', title: 'My Tasks' }];
  await mkdir(config, '{Tasks}/Garden');
  await mkdir(config, '{Tasks}/.hidden');

  const first = await cycle(config, state, lists);
  assert.deepEqual(
    first.calls.lists.insert.map((c) => c.requestBody?.title),
    ['Garden'],
  );
  const second = await cycle(config, state, lists);
  assert.equal(second.calls.lists.insert.length, 0);
  assert.equal(lists.length, 2);
});

test('a list renamed in Google renames its folder and archive folder; the tasks stay where they are', async () => {
  const config = await makeVault();
  const state = emptyState();
  const lists = [
    { id: 'L1', title: 'My Tasks' },
    { id: 'L2', title: 'Shopping' },
  ];
  await cycle(config, state, lists);
  await writeNote(config, '{Tasks}/Shopping/Milk.md', taskNote('Milk', 'g1', 'L2'));
  await writeNote(config, '04-Archive/{Tasks}/Shopping/Bread.md', {
    ...taskNote('Bread', 'g2', 'L2'),
    status: 'completed',
  });
  state.knownTaskIds.L2 = ['g1', 'g2'];

  lists[1].title = 'Groceries';
  const tasks = await cycle(config, state, lists);

  assert.equal(await exists(config, '{Tasks}/Groceries/Milk.md'), true);
  assert.equal(await exists(config, '04-Archive/{Tasks}/Groceries/Bread.md'), true);
  assert.equal(await exists(config, '{Tasks}/Shopping'), false);
  assert.equal(tasks.calls.lists.insert.length, 0, 'the old name does not come back as a list');
  assert.equal(tasks.calls.tasks.insert.length + tasks.calls.tasks.delete.length, 0, 'no task changed list');
  assert.equal(state.tasklistFolders.L2, 'Groceries');
});

test('a folder renamed in the vault renames the list in Google, keeping its tasks and their ids', async () => {
  const config = await makeVault();
  const state = emptyState();
  const lists = [
    { id: 'L1', title: 'My Tasks' },
    { id: 'L2', title: 'Shopping' },
  ];
  await cycle(config, state, lists);
  await writeNote(config, '{Tasks}/Shopping/Milk.md', taskNote('Milk', 'g1', 'L2'));
  await writeNote(config, '04-Archive/{Tasks}/Shopping/Bread.md', {
    ...taskNote('Bread', 'g2', 'L2'),
    status: 'completed',
  });
  state.knownTaskIds.L2 = ['g1', 'g2'];

  await fs.rename(
    path.join(config.vaultResolved, '{Tasks}/Shopping'),
    path.join(config.vaultResolved, '{Tasks}/Groceries'),
  );
  const tasks = await cycle(config, state, lists);

  assert.deepEqual(tasks.calls.lists.patch, [{ tasklist: 'L2', requestBody: { title: 'Groceries' } }]);
  assert.equal(tasks.calls.lists.insert.length, 0);
  assert.equal(tasks.calls.tasks.insert.length + tasks.calls.tasks.delete.length, 0, 'no task changed list');
  assert.equal(await exists(config, '04-Archive/{Tasks}/Groceries/Bread.md'), true, 'the archive mirror follows');
  assert.equal(await exists(config, '{Tasks}/Shopping'), false, 'the old folder is not brought back');
  assert.equal(lists[1].title, 'Groceries');
});

test('a folder removed in the vault comes back empty, and a list removed in Google keeps its folder', async () => {
  const config = await makeVault();
  const state = emptyState();
  const lists = [
    { id: 'L1', title: 'My Tasks' },
    { id: 'L2', title: 'Shopping' },
    { id: 'L3', title: 'Garden' },
  ];
  await cycle(config, state, lists);
  await writeNote(config, '{Tasks}/Garden/Seeds.md', taskNote('Seeds', 'g9', 'L3'));

  await fs.rm(path.join(config.vaultResolved, '{Tasks}/Shopping'), { recursive: true });
  lists.splice(2, 1); // Garden deleted in Google
  const tasks = await cycle(config, state, lists);

  assert.equal(await exists(config, '{Tasks}/Shopping'), true, 'the list still exists, so does its folder');
  assert.equal(await exists(config, '{Tasks}/Garden/Seeds.md'), true, 'nothing in the vault is deleted');
  assert.deepEqual(
    tasks.calls.lists.insert.map((c) => c.requestBody?.title),
    ['Garden'],
    'a folder with no list gets one again',
  );
});

test('nothing is created or renamed from the vault while part of it cannot be read', async () => {
  const config = await makeVault();
  const state = emptyState();
  const lists = [{ id: 'L1', title: 'My Tasks' }];
  await mkdir(config, '{Tasks}/Garden');
  await fs.writeFile(path.join(config.vaultResolved, '{Tasks}/Broken.md'), '---\ntitle: [unclosed\n---\n');

  const tasks = await cycle(config, state, lists);
  assert.equal(tasks.calls.lists.insert.length, 0);
});

test('a rename in Google onto a name that already has a folder is reported, not merged', async () => {
  const config = await makeVault();
  const state = emptyState();
  const lists = [
    { id: 'L1', title: 'My Tasks' },
    { id: 'L2', title: 'Shopping' },
  ];
  await cycle(config, state, lists);
  await mkdir(config, '{Tasks}/Groceries');
  await writeNote(config, '{Tasks}/Groceries/Own.md', { title: 'Own', status: 'needsAction' });

  lists[1].title = 'Groceries';
  const tasks = google(lists);
  const ctx = await ingest(config, state, fakeCalendar().client, tasks.client);
  assert.match(ctx.report.problems.get('{Tasks}/Groceries') ?? '', /already has a folder/);
  assert.equal(await exists(config, '{Tasks}/Shopping'), true);
  assert.equal(await exists(config, '{Tasks}/Groceries/Own.md'), true);
  assert.equal(state.tasklistFolders.L2, 'Shopping');
});

test('a note with a google_id but no tasklist_id counts for the list of its folder, so its task is not deleted', async () => {
  const config = await makeVault();
  const state = emptyState();
  const lists = [
    { id: 'L1', title: 'My Tasks' },
    { id: 'L2', title: 'Shopping' },
  ];
  await cycle(config, state, lists);
  await writeNote(config, '{Tasks}/Shopping/Milk.md', taskNote('Milk', 'g1', undefined));
  state.knownTaskIds.L2 = ['g1'];

  const tasks = await cycle(config, state, lists);
  assert.equal(tasks.calls.tasks.delete.length, 0);
  assert.deepEqual(state.knownTaskIds.L2, ['g1']);
});
