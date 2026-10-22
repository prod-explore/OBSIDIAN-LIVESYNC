import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs/promises';
import * as path from 'path';
import type { calendar_v3, tasks_v1 } from 'googleapis';
import { computeSyncHash } from '../sync/hash.js';
import {
  apiError,
  dateFromNow,
  emptyState,
  exists,
  fakeCalendar,
  fakeTasks,
  ingest,
  listNotes,
  makeVault,
  readNote,
  removeVaults,
  today,
  writeNote,
  type Call,
} from './fakes.js';

after(removeVaults);

const D = dateFromNow(200);
const MONTH = D.slice(0, 7);
const EVENT_ID = 'abcdefgh1234';
const EVENT_PATH = `{Calendar}/${MONTH}/${D}-1830-Dinner-abcdefgh.md`;

const event = (over: calendar_v3.Schema$Event = {}): calendar_v3.Schema$Event => ({
  id: EVENT_ID,
  status: 'confirmed',
  summary: 'Dinner',
  start: { dateTime: `${D}T18:30:00+01:00` },
  end: { dateTime: `${D}T19:30:00+01:00` },
  updated: '2026-01-01T10:00:00.000Z',
  ...over,
});

const eventsPage =
  (items: calendar_v3.Schema$Event[], nextSyncToken = 'tok-next') =>
  () => ({ data: { items, nextSyncToken } });

// ── calendar ────────────────────────────────────────────────────────────────

test('a new Google event becomes a note at its dated path, with Google data in the frontmatter', async () => {
  const config = await makeVault();
  const state = emptyState();
  const cal = fakeCalendar({
    list: eventsPage(
      [
        event({
          description: 'bring wine',
          reminders: { useDefault: false, overrides: [{ minutes: 10 }, { minutes: 60 }, { minutes: 1440 }] },
        }),
      ],
      'tok1',
    ),
  });

  await ingest(config, state, cal.client, fakeTasks().client);

  const { frontmatter, body } = await readNote(config, EVENT_PATH);
  assert.equal(frontmatter.type, 'event');
  assert.equal(frontmatter.google_id, EVENT_ID);
  assert.equal(frontmatter.calendar_id, 'primary');
  assert.equal(frontmatter.source, 'google');
  assert.equal(frontmatter.title, 'Dinner');
  assert.equal(frontmatter.status, 'confirmed');
  assert.equal(frontmatter.start, `${D}T18:30:00+01:00`);
  assert.equal(frontmatter.description, 'bring wine');
  assert.deepEqual(frontmatter.reminders, ['10m', '1h', '1d']);
  assert.equal(frontmatter.sync_hash, computeSyncHash(frontmatter));
  assert.equal(body.trim(), '');
  assert.deepEqual(state.knownEventIds.primary, [EVENT_ID]);
  assert.equal(state.calendarTokens.primary, 'tok1');
  assert.ok(cal.calls.list[0].timeMin, 'the first run only asks for recent history');
  assert.equal(cal.calls.list[0].syncToken, undefined);
});

test('an all-day event gets 0000 in its name and a plain date', async () => {
  const config = await makeVault();
  const cal = fakeCalendar({ list: eventsPage([event({ summary: 'Holiday', start: { date: D }, end: { date: D } })]) });

  await ingest(config, emptyState(), cal.client, fakeTasks().client);

  const { frontmatter } = await readNote(config, `{Calendar}/${MONTH}/${D}-0000-Holiday-abcdefgh.md`);
  assert.equal(frontmatter.start, D);
});

test('an event whose month is over goes straight to the archive', async () => {
  const config = await makeVault();
  const cal = fakeCalendar({
    list: eventsPage([
      event({ summary: 'Old', start: { dateTime: '2020-01-15T09:00:00Z' }, end: { dateTime: '2020-01-15T10:00:00Z' } }),
    ]),
  });

  await ingest(config, emptyState(), cal.client, fakeTasks().client);

  assert.deepEqual(await listNotes(config), ['04-Archive/{Calendar}/2020-01/2020-01-15-0900-Old-abcdefgh.md']);
});

test('an instance more than two years ahead is ignored (endless recurrences)', async () => {
  const config = await makeVault();
  const state = emptyState();
  const far = dateFromNow(900);
  const cal = fakeCalendar({ list: eventsPage([event({ start: { date: far }, end: { date: far } })]) });

  await ingest(config, state, cal.client, fakeTasks().client);

  assert.deepEqual(await listNotes(config), []);
  assert.deepEqual(state.knownEventIds, {});
});

test('pages are followed until Google hands over the next sync token', async () => {
  const config = await makeVault();
  const state = emptyState();
  const cal = fakeCalendar({
    list: (p) =>
      p.pageToken
        ? { data: { items: [event({ id: 'second-id-0001', summary: 'Two' })], nextSyncToken: 'tok9' } }
        : { data: { items: [event({ id: 'first-id-00001', summary: 'One' })], nextPageToken: 'p2' } },
  });

  await ingest(config, state, cal.client, fakeTasks().client);

  assert.equal((await listNotes(config, '{Calendar}')).length, 2);
  assert.equal(cal.calls.list.length, 2);
  assert.equal(state.calendarTokens.primary, 'tok9');
});

test('Google changing an event renames the note, keeps its private body and rewrites links to it', async () => {
  const config = await makeVault();
  const state = emptyState();
  const first = fakeCalendar({ list: eventsPage([event()]) });
  await ingest(config, state, first.client, fakeTasks().client);

  const created = await readNote(config, EVENT_PATH);
  await writeNote(config, EVENT_PATH, created.frontmatter, 'my private notes');
  await writeNote(
    config,
    'Daily.md',
    {},
    `See [[${EVENT_PATH.split('/').pop()!.replace('.md', '')}]] and [[${EVENT_PATH.split('/').pop()!.replace('.md', '')}|the dinner]].`,
  );

  const second = fakeCalendar({
    list: eventsPage([event({ summary: 'Supper', updated: '2026-01-02T10:00:00.000Z' })]),
  });
  await ingest(config, state, second.client, fakeTasks().client);

  const renamed = `{Calendar}/${MONTH}/${D}-1830-Supper-abcdefgh.md`;
  assert.equal(await exists(config, EVENT_PATH), false);
  const { frontmatter, body } = await readNote(config, renamed);
  assert.equal(frontmatter.title, 'Supper');
  assert.equal(body.trim(), 'my private notes');
  const daily = (await readNote(config, 'Daily.md')).body;
  assert.ok(
    daily.includes(`[[${D}-1830-Supper-abcdefgh]]`) && daily.includes(`[[${D}-1830-Supper-abcdefgh|the dinner]]`),
    daily,
  );
});

test('a note edited in Obsidian after Google last changed the event is left for push', async () => {
  const config = await makeVault();
  const state = emptyState();
  await ingest(config, state, fakeCalendar({ list: eventsPage([event()]) }).client, fakeTasks().client);

  const note = await readNote(config, EVENT_PATH);
  await writeNote(config, EVENT_PATH, { ...note.frontmatter, description: 'edited here' }); // sync_hash is now stale

  await ingest(config, state, fakeCalendar({ list: eventsPage([event()]) }).client, fakeTasks().client);

  assert.equal((await readNote(config, EVENT_PATH)).frontmatter.description, 'edited here');
  assert.equal(await exists(config, '_Systems/sync-conflicts.md'), false);
});

test('when Google changed after the local edit, Google wins and the loser is written to the conflict log', async () => {
  const config = await makeVault();
  const state = emptyState();
  await ingest(config, state, fakeCalendar({ list: eventsPage([event()]) }).client, fakeTasks().client);

  const note = await readNote(config, EVENT_PATH);
  await writeNote(config, EVENT_PATH, { ...note.frontmatter, title: 'Local title' });

  const later = new Date(Date.now() + 3_600_000).toISOString();
  await ingest(
    config,
    state,
    fakeCalendar({ list: eventsPage([event({ summary: 'Google title', updated: later })]) }).client,
    fakeTasks().client,
  );

  const renamed = `{Calendar}/${MONTH}/${D}-1830-Google title-abcdefgh.md`;
  assert.equal((await readNote(config, renamed)).frontmatter.title, 'Google title');
  const log = await fs.readFile(path.join(config.vaultResolved, '_Systems/sync-conflicts.md'), 'utf-8');
  assert.ok(log.includes('Local title') && log.includes('Google title'), log);
});

test('a cancelled event we never had produces no note', async () => {
  const config = await makeVault();
  const state = emptyState();
  const cal = fakeCalendar({ list: eventsPage([{ id: EVENT_ID, status: 'cancelled' }]) });

  await ingest(config, state, cal.client, fakeTasks().client);

  assert.deepEqual(await listNotes(config), []);
  assert.deepEqual(state.knownEventIds, {});
});

test('a cancelled event we have is marked cancelled where it is', async () => {
  const config = await makeVault();
  const state = emptyState();
  await ingest(config, state, fakeCalendar({ list: eventsPage([event()]) }).client, fakeTasks().client);

  await ingest(
    config,
    state,
    fakeCalendar({ list: eventsPage([{ id: EVENT_ID, status: 'cancelled', updated: '2026-01-03T00:00:00.000Z' }]) })
      .client,
    fakeTasks().client,
  );

  assert.deepEqual(await listNotes(config, '{Calendar}'), [EVENT_PATH]);
  assert.equal((await readNote(config, EVENT_PATH)).frontmatter.status, 'cancelled');
});

test('an expired sync token (410) restarts with a full sync instead of failing for ever', async () => {
  const config = await makeVault();
  const state = emptyState();
  state.calendarTokens.primary = 'stale';
  const cal = fakeCalendar({
    list: (p) => {
      if (p.syncToken === 'stale') throw apiError(410, 'Sync token is no longer valid');
      return { data: { items: [event()], nextSyncToken: 'fresh' } };
    },
  });

  await ingest(config, state, cal.client, fakeTasks().client);

  assert.equal(state.calendarTokens.primary, 'fresh');
  assert.equal(await exists(config, EVENT_PATH), true);
  assert.equal(cal.calls.list.length, 2);
  assert.equal(cal.calls.list[1].syncToken, undefined);
});

test('a token that keeps being refused is dropped, so the next cycle can start clean', async () => {
  const config = await makeVault();
  const state = emptyState();
  state.calendarTokens.primary = 'stale';
  const cal = fakeCalendar({
    list: () => {
      throw apiError(410);
    },
  });

  await ingest(config, state, cal.client, fakeTasks().client);

  assert.equal(state.calendarTokens.primary, undefined);
});

test('any other error leaves the sync token alone and does not throw', async () => {
  const config = await makeVault();
  const state = emptyState();
  state.calendarTokens.primary = 'keep-me';
  const cal = fakeCalendar({
    list: () => {
      throw apiError(500, 'backend error');
    },
  });

  await assert.doesNotReject(ingest(config, state, cal.client, fakeTasks().client));

  assert.equal(state.calendarTokens.primary, 'keep-me');
});

// ── tasks ───────────────────────────────────────────────────────────────────

const task = (over: tasks_v1.Schema$Task = {}): tasks_v1.Schema$Task => ({
  id: 'tasknumber1',
  title: 'Buy milk',
  status: 'needsAction',
  updated: '2026-02-01T08:00:00.000Z',
  ...over,
});

const taskPages = (byList: Record<string, tasks_v1.Schema$Task[]>) => (p: Call) => ({
  data: { items: byList[p.tasklist ?? ''] ?? [] },
});

test('Google tasks become notes: the default list in {Tasks}, other lists in a folder named after them', async () => {
  const config = await makeVault();
  const state = emptyState();
  const tasks = fakeTasks(
    {
      lists: [
        { id: 'L1', title: 'My Tasks' },
        { id: 'L2', title: 'Work/Home' },
      ],
    },
    {
      list: taskPages({
        L1: [task({ due: '2031-05-04T00:00:00.000Z', notes: 'semi-skimmed' })],
        L2: [task({ id: 'othertask99', title: 'Ship it', status: 'completed' })],
      }),
    },
  );

  await ingest(config, state, fakeCalendar().client, tasks.client);

  const open = await readNote(config, `{Tasks}/${today()}-Buy milk-tasknumb.md`);
  assert.equal(open.frontmatter.tasklist_id, 'L1');
  assert.equal(open.frontmatter.due, '2031-05-04');
  assert.equal(open.frontmatter.description, 'semi-skimmed');
  assert.equal(open.frontmatter.sync_hash, computeSyncHash(open.frontmatter));
  const done = await readNote(config, `04-Archive/{Tasks}/Work-Home/${today()}-Ship it-othertas.md`);
  assert.equal(done.frontmatter.status, 'completed');
  assert.deepEqual(state.knownTaskIds, { L1: ['tasknumber1'], L2: ['othertask99'] });
  assert.equal(
    state.tasksTokens.L1,
    '2026-02-01T08:00:00.001Z',
    'the watermark is one millisecond past the newest task',
  );
});

test('completing a task in Google archives its note, un-completing brings it back', async () => {
  const config = await makeVault();
  const state = emptyState();
  const run = (t: tasks_v1.Schema$Task) =>
    ingest(config, state, fakeCalendar().client, fakeTasks({}, { list: taskPages({ L1: [t] }) }).client);

  await run(task());
  await run(task({ status: 'completed', updated: '2026-02-02T08:00:00.000Z' }));
  assert.deepEqual(await listNotes(config), [`04-Archive/{Tasks}/${today()}-Buy milk-tasknumb.md`]);

  await run(task({ status: 'needsAction', updated: '2026-02-03T08:00:00.000Z' }));
  assert.deepEqual(await listNotes(config), [`{Tasks}/${today()}-Buy milk-tasknumb.md`]);
});

test('a task deleted in Google marks its note cancelled and archives it', async () => {
  const config = await makeVault();
  const state = emptyState();
  const run = (t: tasks_v1.Schema$Task) =>
    ingest(config, state, fakeCalendar().client, fakeTasks({}, { list: taskPages({ L1: [t] }) }).client);

  await run(task());
  await run(task({ deleted: true, updated: '2026-02-02T08:00:00.000Z' }));

  const [only] = await listNotes(config);
  assert.equal(only, `04-Archive/{Tasks}/${today()}-Buy milk-tasknumb.md`);
  assert.equal((await readNote(config, only)).frontmatter.status, 'cancelled');
});

test('a task deleted in Google that has no note here produces none (this is also what our own deletions look like)', async () => {
  const config = await makeVault();
  const state = emptyState();
  const tasks = fakeTasks({}, { list: taskPages({ L1: [task({ deleted: true })] }) });

  await ingest(config, state, fakeCalendar().client, tasks.client);

  assert.deepEqual(await listNotes(config), []);
  assert.deepEqual(state.knownTaskIds, {});
});

test('one task that cannot be written does not block the others, and the watermark does not skip past it', async () => {
  const config = await makeVault();
  const state = emptyState();
  await fs.mkdir(path.join(config.vaultResolved, `{Tasks}/${today()}-Bad-badtask1.md`), { recursive: true }); // a directory where the file should go
  const tasks = fakeTasks(
    {},
    {
      list: taskPages({
        L1: [
          task({ id: 'badtask1xxx', title: 'Bad', updated: '2026-03-02T00:00:00.000Z' }),
          task({ id: 'goodtask1xx', title: 'Good', updated: '2026-03-01T00:00:00.000Z' }),
        ],
      }),
    },
  );

  await assert.doesNotReject(ingest(config, state, fakeCalendar().client, tasks.client));

  assert.equal(await exists(config, `{Tasks}/${today()}-Good-goodtask.md`), true);
  assert.equal(state.tasksTokens.L1, undefined, 'the failed task has to be fetched again next cycle');
});

test('a very long title still produces a valid file name', async () => {
  const config = await makeVault();
  const state = emptyState();
  const tasks = fakeTasks({}, { list: taskPages({ L1: [task({ title: 'ö'.repeat(300) })] }) });
  const cal = fakeCalendar({ list: eventsPage([event({ summary: 'ł'.repeat(300) })]) });

  await ingest(config, state, cal.client, tasks.client);

  const notes = await listNotes(config);
  assert.equal(notes.length, 2, notes.join('\n'));
  for (const note of notes) assert.ok(Buffer.byteLength(path.basename(note)) <= 255, note);
});

test('a task list created in Google after the first cycle is picked up by the next one', async () => {
  const config = await makeVault();
  const state = emptyState();

  await ingest(config, state, fakeCalendar().client, fakeTasks({ lists: [{ id: 'L1', title: 'My Tasks' }] }).client);
  assert.deepEqual(await listNotes(config), []);

  const later = fakeTasks(
    {
      lists: [
        { id: 'L1', title: 'My Tasks' },
        { id: 'L2', title: 'Holiday' },
      ],
    },
    { list: taskPages({ L2: [task({ id: 'holidaytask1', title: 'Pack' })] }) },
  );
  await ingest(config, state, fakeCalendar().client, later.client);

  assert.deepEqual(await listNotes(config), [`{Tasks}/Holiday/${today()}-Pack-holidayt.md`]);
});

test('every page of task lists is read', async () => {
  const config = await makeVault();
  const pages = [
    { items: [{ id: 'L1', title: 'My Tasks' }], nextPageToken: 'more' },
    { items: [{ id: 'L2', title: 'Second' }] },
  ];
  const tasks = fakeTasks(
    { listApi: { list: (p) => ({ data: p.pageToken ? pages[1] : pages[0] }) } },
    { list: taskPages({ L2: [task({ id: 'secondlist01', title: 'Found' })] }) },
  );

  await ingest(config, emptyState(), fakeCalendar().client, tasks.client);

  assert.equal((await listNotes(config, '{Tasks}/Second')).length, 1);
});
