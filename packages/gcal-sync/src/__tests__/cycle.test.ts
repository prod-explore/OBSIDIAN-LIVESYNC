// Whole cycles (ingest, then push) against a fake Google that remembers what it was told:
// the interesting failures of a two-way sync only show when the two halves meet.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs/promises';
import * as path from 'path';
import type { tasks_v1 } from 'googleapis';
import {
  emptyState,
  exists,
  fakeCalendar,
  fakeTasks,
  ingest,
  listNotes,
  makeVault,
  push,
  readNote,
  removeVaults,
  writeNote,
} from './fakes.js';

after(removeVaults);

type StoredTask = tasks_v1.Schema$Task & { tasklist?: string };

/** An in-memory Google Tasks with one list; list() honours showDeleted and updatedMin like the real one. */
function googleTasks(lists?: Array<{ id: string; title: string }>) {
  const store = new Map<string, StoredTask>();
  let clock = Date.parse('2026-02-01T08:00:00.000Z');
  const stamp = () => new Date((clock += 1000)).toISOString();
  const fake = fakeTasks(
    { lists },
    {
      insert: (p) => {
        const t: StoredTask = {
          id: `gtask${store.size + 1}xxxx`,
          ...(p.requestBody as tasks_v1.Schema$Task),
          tasklist: p.tasklist,
          updated: stamp(),
        };
        store.set(t.id as string, t);
        return { data: t };
      },
      patch: (p) => {
        const t: StoredTask = {
          ...store.get(p.task ?? ''),
          ...(p.requestBody as tasks_v1.Schema$Task),
          updated: stamp(),
        };
        store.set(t.id as string, t);
        return { data: t };
      },
      delete: (p) => {
        const t = store.get(p.task ?? '');
        if (!t || t.deleted) throw Object.assign(new Error('gone'), { code: 404 });
        store.set(p.task ?? '', { ...t, deleted: true, updated: stamp() });
        return {};
      },
      list: (p) => ({
        data: {
          items: [...store.values()].filter(
            (t) =>
              t.tasklist === p.tasklist &&
              (p.showDeleted || !t.deleted) &&
              (!p.updatedMin || (t.updated ?? '') >= p.updatedMin),
          ),
        },
      }),
    },
  );
  return { ...fake, store, stamp };
}

async function cycle(
  config: Awaited<ReturnType<typeof makeVault>>,
  state: ReturnType<typeof emptyState>,
  g: ReturnType<typeof googleTasks>,
) {
  const cal = fakeCalendar();
  await ingest(config, state, cal.client, g.client);
  await push(config, state, cal.client, g.client);
}

test('a task made in Obsidian settles after one round trip: no conflict, no second patch', async () => {
  const config = await makeVault();
  const state = emptyState();
  const g = googleTasks();
  await writeNote(config, '{Tasks}/Buy milk.md', { title: 'Buy milk', status: 'needsAction', description: 'semi' });

  await cycle(config, state, g);
  assert.equal(g.calls.tasks.insert.length, 1);

  await cycle(config, state, g);
  await cycle(config, state, g);

  assert.equal(g.calls.tasks.insert.length, 1);
  assert.equal(g.calls.tasks.patch.length, 0, 'what we just pushed must not look like a local edit on the way back');
  assert.equal(await exists(config, '_Systems/sync-conflicts.md'), false);
  assert.deepEqual(await listNotes(config), ['{Tasks}/Buy milk.md']);
});

test('deleting a note deletes the task in Google once, and the deletion does not come back as a note', async () => {
  const config = await makeVault();
  const state = emptyState();
  const g = googleTasks();
  await writeNote(config, '{Tasks}/Buy milk.md', { title: 'Buy milk', status: 'needsAction' });
  await cycle(config, state, g);
  await cycle(config, state, g);

  await fs.rm(path.join(config.vaultResolved, '{Tasks}/Buy milk.md'));
  await cycle(config, state, g);
  await cycle(config, state, g);
  await cycle(config, state, g);

  assert.equal(g.calls.tasks.delete.length, 1);
  assert.deepEqual(
    await listNotes(config),
    [],
    'Google reports the deleted task on the next pull; that must not recreate a note',
  );
  assert.deepEqual(state.knownTaskIds.L1, []);
});

test('completing the task in Google archives the note and nothing is pushed back', async () => {
  const config = await makeVault();
  const state = emptyState();
  const g = googleTasks();
  await writeNote(config, '{Tasks}/Buy milk.md', { title: 'Buy milk', status: 'needsAction' });
  await cycle(config, state, g);
  await cycle(config, state, g);

  const [id] = [...g.store.keys()];
  g.store.set(id, { ...g.store.get(id), status: 'completed', updated: g.stamp() });
  await cycle(config, state, g);
  await cycle(config, state, g);

  assert.deepEqual(await listNotes(config), ['04-Archive/{Tasks}/Buy milk.md']);
  assert.equal((await readNote(config, '04-Archive/{Tasks}/Buy milk.md')).frontmatter.status, 'completed');
  assert.equal(g.calls.tasks.patch.length, 0);
  assert.equal(g.calls.tasks.delete.length, 0);
});

test('ticking a task off in a list subfolder archives it under that list: the task is neither deleted nor re-created', async () => {
  const config = await makeVault();
  const state = emptyState();
  const g = googleTasks([
    { id: 'L1', title: 'My Tasks' },
    { id: 'L2', title: 'Project A' },
  ]);
  await writeNote(config, '{Tasks}/Project A/Plan.md', { title: 'Plan', status: 'needsAction' });
  await cycle(config, state, g);
  await cycle(config, state, g);
  assert.equal(g.calls.tasks.insert.length, 1);
  assert.equal(g.calls.tasks.insert[0].tasklist, 'L2');
  const googleId = (await readNote(config, '{Tasks}/Project A/Plan.md')).frontmatter.google_id;

  // tick it off in the vault (the old hash stays, so this is a local edit)
  const open = await readNote(config, '{Tasks}/Project A/Plan.md');
  await writeNote(config, '{Tasks}/Project A/Plan.md', { ...open.frontmatter, status: 'completed' }, open.body);
  await cycle(config, state, g);
  await cycle(config, state, g);
  await cycle(config, state, g);

  assert.deepEqual(await listNotes(config), ['04-Archive/{Tasks}/Project A/Plan.md']);
  assert.equal(g.calls.tasks.insert.length, 1, 'no second task is created');
  assert.equal(g.calls.tasks.delete.length, 0, 'the task is not deleted in Google');
  assert.equal((await readNote(config, '04-Archive/{Tasks}/Project A/Plan.md')).frontmatter.google_id, googleId);

  // and back: re-opened in the vault, it returns to its list folder
  const done = await readNote(config, '04-Archive/{Tasks}/Project A/Plan.md');
  await writeNote(
    config,
    '04-Archive/{Tasks}/Project A/Plan.md',
    { ...done.frontmatter, status: 'needsAction' },
    done.body,
  );
  await cycle(config, state, g);
  await cycle(config, state, g);
  await cycle(config, state, g);

  assert.deepEqual(await listNotes(config), ['{Tasks}/Project A/Plan.md']);
  assert.equal(g.calls.tasks.insert.length, 1);
  assert.equal(g.calls.tasks.delete.length, 0);
  assert.equal((await readNote(config, '{Tasks}/Project A/Plan.md')).frontmatter.google_id, googleId);
});
