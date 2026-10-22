// Whole cycles (ingest, then push) against a fake Google that remembers what it was told:
// the interesting failures of a two-way sync only show when the two halves meet.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs/promises';
import * as path from 'path';
import { ingestGoogleData } from '../sync/ingest.js';
import { pushVaultData } from '../sync/push.js';
import { emptyState, exists, fakeCalendar, fakeTasks, listNotes, makeVault, readNote, removeVaults, writeNote } from './fakes.js';

after(removeVaults);

/** An in-memory Google Tasks with one list; list() honours showDeleted and updatedMin like the real one. */
function googleTasks() {
  const store = new Map<string, any>();
  let clock = Date.parse('2026-02-01T08:00:00.000Z');
  const stamp = () => new Date((clock += 1000)).toISOString();
  const fake = fakeTasks({}, {
    insert: (p) => {
      const t = { id: `gtask${store.size + 1}xxxx`, ...p.requestBody, updated: stamp() };
      store.set(t.id, t);
      return { data: t };
    },
    patch: (p) => {
      const t = { ...store.get(p.task), ...p.requestBody, updated: stamp() };
      store.set(t.id, t);
      return { data: t };
    },
    delete: (p) => {
      const t = store.get(p.task);
      if (!t || t.deleted) throw Object.assign(new Error('gone'), { code: 404 });
      store.set(p.task, { ...t, deleted: true, updated: stamp() });
      return {};
    },
    list: (p) => ({
      data: {
        items: [...store.values()].filter((t) => (p.showDeleted || !t.deleted) && (!p.updatedMin || t.updated >= p.updatedMin)),
      },
    }),
  });
  return { ...fake, store, stamp };
}

async function cycle(config: Awaited<ReturnType<typeof makeVault>>, state: ReturnType<typeof emptyState>, g: ReturnType<typeof googleTasks>) {
  const cal = fakeCalendar();
  await ingestGoogleData(config, state, cal.client, g.client);
  await pushVaultData(config, state, cal.client, g.client);
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
  assert.deepEqual(await listNotes(config), [], 'Google reports the deleted task on the next pull; that must not recreate a note');
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
