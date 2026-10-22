import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { computeSyncHash } from '../sync/hash.js';
import { sweepCancelled } from '../sync/retention.js';
import type { RawFrontmatter } from '../markdown/notes.js';
import {
  emptyState,
  exists,
  fakeCalendar,
  fakeTasks,
  makeVault,
  push,
  removeVaults,
  syncContext,
  writeNote,
} from './fakes.js';

after(removeVaults);

const NOW = new Date('2026-06-01T12:00:00.000Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

const synced = (fm: RawFrontmatter): RawFrontmatter => ({
  ...fm,
  sync_hash: computeSyncHash(fm),
  synced_at: daysAgo(1),
});

const cancelledTask = (over: RawFrontmatter = {}): RawFrontmatter =>
  synced({
    type: 'task',
    google_id: 'g1',
    tasklist_id: 'L1',
    title: 'Gone',
    status: 'cancelled',
    updated: daysAgo(45),
    source: 'google',
    ...over,
  });

const PATH = '04-Archive/{Tasks}/2026-04-01-Gone-g1.md';

async function sweep(
  over: Partial<Parameters<typeof makeVault>[0]> = {},
  setup: (c: Awaited<ReturnType<typeof makeVault>>) => Promise<void>,
  state = emptyState(),
) {
  const config = await makeVault(over);
  await setup(config);
  const ctx = syncContext(config, state, fakeCalendar().client, fakeTasks().client, { now: () => NOW });
  const removed = await sweepCancelled(ctx);
  return { config, removed, state, ctx };
}

test('a cancelled task note with nothing in its body is removed once it is older than the retention', async () => {
  const state = { ...emptyState(), knownTaskIds: { L1: ['g1', 'g2'] } };
  const { config, removed } = await sweep({}, (c) => writeNote(c, PATH, cancelledTask()), state);
  assert.equal(removed, 1);
  assert.equal(await exists(config, PATH), false);
  assert.deepEqual(state.knownTaskIds.L1, ['g2'], 'forgotten, so push does not go and delete it on Google');
});

test('the removal is not followed by a deletion on Google', async () => {
  const state = { ...emptyState(), knownTaskIds: { L1: ['g1'] } };
  const config = await makeVault();
  await writeNote(config, PATH, cancelledTask());
  const tasks = fakeTasks();
  await sweepCancelled(syncContext(config, state, fakeCalendar().client, tasks.client, { now: () => NOW }));

  await push(config, state, fakeCalendar().client, tasks.client);

  assert.deepEqual(tasks.calls.tasks.delete, []);
});

test('a note that is younger than the retention stays', async () => {
  const { config, removed } = await sweep({}, (c) => writeNote(c, PATH, cancelledTask({ updated: daysAgo(10) })));
  assert.equal(removed, 0);
  assert.equal(await exists(config, PATH), true);
});

test('a note with text in its body is never removed', async () => {
  const { config, removed } = await sweep({}, (c) => writeNote(c, PATH, cancelledTask(), 'what I found out about it'));
  assert.equal(removed, 0);
  assert.equal(await exists(config, PATH), true);
});

test('only cancelled notes expire', async () => {
  const { config, removed } = await sweep({}, (c) => writeNote(c, PATH, cancelledTask({ status: 'completed' })));
  assert.equal(removed, 0);
  assert.equal(await exists(config, PATH), true);
});

test('a note with an edit waiting to be pushed stays', async () => {
  const { config, removed } = await sweep({}, (c) => writeNote(c, PATH, { ...cancelledTask(), title: 'Edited since' }));
  assert.equal(removed, 0);
  assert.equal(await exists(config, PATH), true);
});

test('a note that cannot be dated is left alone rather than guessed at', async () => {
  const { config, removed } = await sweep({}, (c) =>
    writeNote(
      c,
      PATH,
      (() => {
        const fm = cancelledTask();
        delete fm.updated;
        delete fm.synced_at;
        return fm;
      })(),
    ),
  );
  assert.equal(removed, 0);
  assert.equal(await exists(config, PATH), true);
});

test('with CANCELLED_RETENTION_DAYS=0 nothing is ever removed', async () => {
  const { config, removed } = await sweep({ cancelledRetentionDays: 0 }, (c) =>
    writeNote(c, PATH, cancelledTask({ updated: daysAgo(900) })),
  );
  assert.equal(removed, 0);
  assert.equal(await exists(config, PATH), true);
});

test('the retention is the configured number of days', async () => {
  const { removed } = await sweep({ cancelledRetentionDays: 7 }, (c) =>
    writeNote(c, PATH, cancelledTask({ updated: daysAgo(8) })),
  );
  assert.equal(removed, 1);
});

test('cancelled events expire the same way, wherever they sit', async () => {
  const state = { ...emptyState(), knownEventIds: { primary: ['e1'] } };
  const eventPath = '{Calendar}/2026-03/2026-03-04-1830-Dinner-e1.md';
  const { config, removed } = await sweep(
    {},
    (c) =>
      writeNote(
        c,
        eventPath,
        synced({
          type: 'event',
          google_id: 'e1',
          calendar_id: 'primary',
          title: 'Dinner',
          status: 'cancelled',
          updated: daysAgo(60),
        }),
      ),
    state,
  );
  assert.equal(removed, 1);
  assert.equal(await exists(config, eventPath), false);
  assert.deepEqual(state.knownEventIds.primary, []);
});
