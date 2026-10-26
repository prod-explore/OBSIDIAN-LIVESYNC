// Task lists <-> subfolders of {Tasks}/: created, renamed and deleted in both directions (a folder goes to the trash).
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
  apiError,
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

/** Two lists with a note each (one of them archived), as a finished cycle leaves them. */
async function twoLists() {
  const config = await makeVault();
  const state = emptyState();
  const lists = [
    { id: 'L1', title: 'My Tasks' },
    { id: 'L2', title: 'Shopping' },
    { id: 'L3', title: 'Garden' },
  ];
  await cycle(config, state, lists);
  await writeNote(config, '{Tasks}/Shopping/Milk.md', taskNote('Milk', 'g1', 'L2'));
  await writeNote(config, '04-Archive/{Tasks}/Shopping/Bread.md', {
    ...taskNote('Bread', 'g2', 'L2'),
    status: 'completed',
  });
  await writeNote(config, '{Tasks}/Garden/Seeds.md', taskNote('Seeds', 'g3', 'L3'));
  state.knownTaskIds.L2 = ['g1', 'g2'];
  state.knownTaskIds.L3 = ['g3'];
  return { config, state, lists };
}

const trashed = async (config: Config) =>
  (await fs.readdir(path.join(config.vaultResolved, '.trash')).catch(() => [] as string[])).map((f) =>
    f.replace(/^[^_]+__/, ''),
  );

test('a folder deleted in the vault deletes its list in Google; its archive folder goes to the trash', async () => {
  const { config, state, lists } = await twoLists();
  await fs.rm(path.join(config.vaultResolved, '{Tasks}/Shopping'), { recursive: true });

  const tasks = await cycle(config, state, lists);
  assert.deepEqual(tasks.calls.lists.delete, [{ tasklist: 'L2' }]);
  assert.deepEqual(
    lists.map((l) => l.id),
    ['L1', 'L3'],
  );
  assert.equal(tasks.calls.tasks.delete.length, 0, 'the tasks went with the list, not one by one');
  assert.deepEqual(await trashed(config), ['04-Archive__{Tasks}__Shopping']);
  assert.equal(await exists(config, '{Tasks}/Shopping'), false, 'not brought back');
  assert.equal(state.tasklistFolders.L2, undefined);
  assert.equal(state.knownTaskIds.L2, undefined);
  assert.equal(await exists(config, '{Tasks}/Garden/Seeds.md'), true);
});

test('a list deleted in Google moves its folder and archive folder, notes and all, to the trash', async () => {
  const { config, state, lists } = await twoLists();
  lists.splice(1, 1); // Shopping deleted in Google

  const tasks = await cycle(config, state, lists);
  assert.deepEqual((await trashed(config)).sort(), ['04-Archive__{Tasks}__Shopping', '{Tasks}__Shopping']);
  const kept = (await fs.readdir(path.join(config.vaultResolved, '.trash'))).find((f) =>
    /^[^_]+__\{Tasks\}__Shopping$/.test(f),
  );
  assert.deepEqual(await fs.readdir(path.join(config.vaultResolved, '.trash', kept!)), ['Milk.md']);
  assert.equal(tasks.calls.lists.insert.length, 0, 'the deleted list is not made again');
  assert.equal(tasks.calls.tasks.delete.length + tasks.calls.tasks.insert.length, 0);
  assert.equal(state.tasklistFolders.L2, undefined);
  assert.equal(state.knownTaskIds.L2, undefined);
});

test('an emptied folder and an empty list both stay, empty', async () => {
  const { config, state, lists } = await twoLists();
  await fs.rm(path.join(config.vaultResolved, '{Tasks}/Garden/Seeds.md')); // folder emptied in the vault
  state.knownTaskIds.L3 = []; // and the list empty in Google

  const tasks = await cycle(config, state, lists);
  assert.equal(tasks.calls.lists.delete.length, 0);
  assert.equal(await exists(config, '{Tasks}/Garden'), true);
  assert.equal(lists.length, 3);
  assert.deepEqual(await trashed(config), []);
});

test('nothing is deleted on either side while the vault is not fully readable', async () => {
  const { config, state, lists } = await twoLists();
  await fs.rm(path.join(config.vaultResolved, '{Tasks}/Garden'), { recursive: true });
  lists.splice(1, 1); // Shopping deleted in Google
  await fs.writeFile(path.join(config.vaultResolved, '{Tasks}/Broken.md'), '---\ntitle: [unclosed\n---\n');

  const tasks = await cycle(config, state, lists);
  assert.equal(tasks.calls.lists.delete.length, 0);
  assert.equal(tasks.calls.lists.insert.length, 0, 'the folder of the deleted list does not get a new list');
  assert.equal(await exists(config, '{Tasks}/Shopping/Milk.md'), true);
  assert.deepEqual(await trashed(config), []);
  assert.equal(state.tasklistFolders.L2, 'Shopping', 'remembered, so the deletion is carried out once it is safe');
});

test('nothing is deleted when Google cannot list the task lists', async () => {
  const { config, state } = await twoLists();
  await fs.rm(path.join(config.vaultResolved, '{Tasks}/Garden'), { recursive: true });
  const tasks = fakeTasks({
    listApi: {
      list: () => {
        throw apiError(503);
      },
    },
  });
  await ingest(config, state, fakeCalendar().client, tasks.client);
  await push(config, state, fakeCalendar().client, tasks.client);
  assert.equal(tasks.calls.lists.delete.length, 0);
  assert.equal(await exists(config, '{Tasks}/Shopping/Milk.md'), true);
  assert.deepEqual(await trashed(config), []);
  assert.equal(state.tasklistFolders.L3, 'Garden');
});

test('no list is deleted when {Tasks}/ itself is missing (an unmounted vault)', async () => {
  const { config, state, lists } = await twoLists();
  await fs.rm(path.join(config.vaultResolved, '{Tasks}'), { recursive: true });

  const tasks = google(lists);
  const ctx = await ingest(config, state, fakeCalendar().client, tasks.client);
  assert.equal(tasks.calls.lists.delete.length, 0);
  assert.match(ctx.report.firstError ?? '', /Refusing to delete 2 task list\(s\).*\{Tasks\} itself is missing/);
  assert.equal(await exists(config, '{Tasks}/Shopping'), false, 'not recreated either');
  assert.equal(state.tasklistFolders.L2, 'Shopping');
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

test('a rename in Google onto a name that already has a folder gets a numbered folder, nothing is merged', async () => {
  const config = await makeVault();
  const state = emptyState();
  const lists = [
    { id: 'L1', title: 'My Tasks' },
    { id: 'L2', title: 'Shopping' },
  ];
  await cycle(config, state, lists);
  await writeNote(config, '{Tasks}/Shopping/Milk.md', taskNote('Milk', 'g1', 'L2'));
  await mkdir(config, '{Tasks}/Groceries');
  await writeNote(config, '{Tasks}/Groceries/Own.md', { title: 'Own', status: 'needsAction' });

  lists[1].title = 'Groceries';
  const tasks = google(lists);
  await ingest(config, state, fakeCalendar().client, tasks.client);
  assert.equal(state.tasklistFolders.L2, 'Groceries (2)');
  assert.equal(await exists(config, '{Tasks}/Groceries (2)/Milk.md'), true);
  assert.equal(await exists(config, '{Tasks}/Groceries/Own.md'), true);
  assert.equal(await exists(config, '{Tasks}/Shopping'), false);
  assert.equal(tasks.calls.lists.insert.length, 0);
});

test('a list renamed on both sides in one cycle stays one list, under the name from Google, with the same tasks', async () => {
  const config = await makeVault();
  const state = emptyState();
  const lists = [
    { id: 'L1', title: 'My Tasks' },
    { id: 'L2', title: 'Shopping' },
    { id: 'L3', title: 'Errands' },
  ];
  await cycle(config, state, lists);
  await writeNote(config, '{Tasks}/Shopping/Milk.md', taskNote('Milk', 'g1', 'L2'));
  await writeNote(config, '04-Archive/{Tasks}/Shopping/Bread.md', {
    ...taskNote('Bread', 'g2', 'L2'),
    status: 'completed',
  });
  state.knownTaskIds.L2 = ['g1', 'g2'];

  // The vault renames the folder to "Food"; Google renames the list to "Errands", a name another list's folder has.
  await fs.rename(path.join(config.vaultResolved, '{Tasks}/Shopping'), path.join(config.vaultResolved, '{Tasks}/Food'));
  lists[1].title = 'Errands';
  const tasks = await cycle(config, state, lists);

  assert.equal(tasks.calls.lists.insert.length, 0, 'no second list');
  assert.equal(tasks.calls.lists.patch.length, 0, "Google's name is kept");
  assert.equal(tasks.calls.tasks.insert.length + tasks.calls.tasks.delete.length, 0, 'the tasks keep their ids');
  assert.equal(state.tasklistFolders.L2, 'Errands (2)');
  assert.equal(await exists(config, '{Tasks}/Errands (2)/Milk.md'), true);
  assert.equal(await exists(config, '04-Archive/{Tasks}/Errands (2)/Bread.md'), true);
  assert.equal(await exists(config, '{Tasks}/Food'), false);
  assert.equal(await exists(config, '{Tasks}/Shopping'), false);
  assert.deepEqual(state.knownTaskIds.L2, ['g1', 'g2']);

  const next = await cycle(config, state, lists);
  assert.equal(next.calls.lists.insert.length + next.calls.lists.patch.length, 0, 'and it stays settled');
});

test('a list renamed on both sides while the vault is not fully readable is moved when its folder is found, else waits', async () => {
  const config = await makeVault();
  const state = emptyState();
  const lists = [
    { id: 'L1', title: 'My Tasks' },
    { id: 'L2', title: 'Shopping' },
  ];
  await cycle(config, state, lists);
  await fs.rename(path.join(config.vaultResolved, '{Tasks}/Shopping'), path.join(config.vaultResolved, '{Tasks}/Food'));
  await fs.writeFile(path.join(config.vaultResolved, '{Tasks}/Broken.md'), '---\ntitle: [unclosed\n---\n');
  lists[1].title = 'Groceries';

  const tasks = google(lists);
  await ingest(config, state, fakeCalendar().client, tasks.client);
  assert.equal(state.tasklistFolders.L2, 'Shopping', 'no folder holds its notes and the view is partial: not settled');
  assert.equal(await exists(config, '{Tasks}/Groceries'), false);
  assert.ok(
    !tasks.calls.tasks.list.some((c) => c.tasklist === 'L2'),
    'its tasks are not pulled, so none can bring the old folder back',
  );
  assert.equal(tasks.calls.lists.insert.length, 0);
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

test('lists whose names make the same folder name get one folder each, numbered, and keep them', async () => {
  const config = await makeVault();
  const state = emptyState();
  const lists = [
    { id: 'L1', title: 'My Tasks' },
    { id: 'L2', title: 'Shopping' },
    { id: 'L3', title: 'Shopping' },
    { id: 'L4', title: 'Shopping' },
    { id: 'L5', title: 'Work: Q4' },
    { id: 'L6', title: 'Work- Q4' },
  ];
  await cycle(config, state, lists);
  assert.deepEqual(state.tasklistFolders, {
    L2: 'Shopping',
    L3: 'Shopping (2)',
    L4: 'Shopping (3)',
    L5: 'Work- Q4',
    L6: 'Work- Q4 (2)',
  });

  // Next cycle: nothing is renamed or created, a pulled task lands in its own list's folder, and a note written in
  // a numbered folder goes to that list.
  await writeNote(config, '{Tasks}/Shopping (2)/Mine.md', { title: 'Mine', status: 'needsAction' });
  const tasks = fakeTasks(
    { lists, defaultId: 'L1' },
    {
      list: (p) => ({
        data: {
          items:
            p.tasklist === 'L3'
              ? [{ id: 'pulled00x', title: 'Eggs', status: 'needsAction', updated: '2026-10-01T00:00:00.000Z' }]
              : [],
        },
      }),
    },
  );
  await ingest(config, state, fakeCalendar().client, tasks.client);
  await push(config, state, fakeCalendar().client, tasks.client);

  assert.deepEqual(state.tasklistFolders.L3, 'Shopping (2)');
  assert.equal(tasks.calls.lists.insert.length + tasks.calls.lists.patch.length, 0);
  const inFolder = await fs.readdir(path.join(config.vaultResolved, '{Tasks}/Shopping (2)'));
  assert.ok(
    inFolder.some((f) => f.includes('Eggs')),
    inFolder.join(', '),
  );
  assert.deepEqual(
    tasks.calls.tasks.insert.map((c) => c.tasklist),
    ['L3'],
  );
});

test('a folder that exists only in the archive never creates a list', async () => {
  const config = await makeVault();
  const state = emptyState();
  const lists = [{ id: 'L1', title: 'My Tasks' }];
  await mkdir(config, '04-Archive/{Tasks}/Old project');
  await writeNote(config, '04-Archive/{Tasks}/Old project/Done.md', { title: 'Done', status: 'completed' });

  const tasks = google(lists);
  await ingest(config, state, fakeCalendar().client, tasks.client);
  const ctx = await push(config, state, fakeCalendar().client, tasks.client);
  assert.equal(tasks.calls.lists.insert.length, 0);
  assert.equal(tasks.calls.tasks.insert.length, 0);
  assert.equal(await exists(config, '{Tasks}/Old project'), false);
  assert.match(ctx.report.problems.get('04-Archive/{Tasks}/Old project/Done.md') ?? '', /never create one/);
  assert.equal(ctx.report.errors, 0, 'a note left alone on purpose is not a failure');
});

test('a deleted list goes to the trash folder set in TRASH_DIR', async () => {
  const config = await makeVault({ trashDir: '_System/deleted' });
  const state = emptyState();
  const lists = [
    { id: 'L1', title: 'My Tasks' },
    { id: 'L2', title: 'Shopping' },
  ];
  await cycle(config, state, lists);
  lists.splice(1, 1);
  await cycle(config, state, lists);
  const inTrash = await fs.readdir(path.join(config.vaultResolved, '_System/deleted'));
  assert.deepEqual(
    inTrash.map((f) => f.replace(/^[^_]+__/, '')),
    ['{Tasks}__Shopping'],
  );
  assert.equal(await exists(config, '.trash'), false);
});
