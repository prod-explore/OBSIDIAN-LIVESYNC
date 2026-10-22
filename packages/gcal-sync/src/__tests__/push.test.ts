import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs/promises';
import * as path from 'path';
import { pushVaultData } from '../sync/push.js';
import { computeSyncHash } from '../sync/hash.js';
import {
  apiError, dateFromNow, emptyState, exists, fakeCalendar, fakeTasks, listNotes, makeVault, readNote, removeVaults, writeNote,
} from './fakes.js';

after(removeVaults);

const D = dateFromNow(200);
const MONTH = D.slice(0, 7);

/** A note the way ingest leaves it: the hash matches, so it counts as untouched. */
const synced = (fm: Record<string, any>) => ({ ...fm, sync_hash: computeSyncHash(fm), synced_at: new Date().toISOString() });

// ── tasks ───────────────────────────────────────────────────────────────────

test('a new task note is created in Google, and the note learns its id', async () => {
  const config = await makeVault();
  const state = emptyState();
  await writeNote(config, '{Tasks}/Buy milk.md', { title: 'Buy milk', status: 'needsAction', due: '2031-05-04', description: 'semi-skimmed' }, 'private body');
  const tasks = fakeTasks({}, { insert: () => ({ data: { id: 'gtask-1', updated: '2026-02-01T08:00:00.000Z' } }) });

  await pushVaultData(config, state, fakeCalendar().client, tasks.client);

  assert.deepEqual(tasks.calls.tasks.insert[0], {
    tasklist: 'L1',
    requestBody: { title: 'Buy milk', status: 'needsAction', due: '2031-05-04T00:00:00.000Z', notes: 'semi-skimmed' },
  });
  const { frontmatter, body } = await readNote(config, '{Tasks}/Buy milk.md');
  assert.equal(frontmatter.google_id, 'gtask-1');
  assert.equal(frontmatter.tasklist_id, 'L1');
  assert.equal(frontmatter.source, 'obsidian');
  assert.equal(frontmatter.push_pending, undefined);
  assert.equal(frontmatter.sync_hash, computeSyncHash(frontmatter));
  assert.equal(body.trim(), 'private body', 'the body never goes to Google');
  assert.deepEqual(state.knownTaskIds.L1, ['gtask-1']);
});

test('a note that has not changed makes no API calls', async () => {
  const config = await makeVault();
  await writeNote(config, '{Tasks}/Buy milk.md', synced({ title: 'Buy milk', status: 'needsAction', google_id: 'g1', tasklist_id: 'L1', source: 'google' }));
  const tasks = fakeTasks();

  await pushVaultData(config, { ...emptyState(), knownTaskIds: { L1: ['g1'] } }, fakeCalendar().client, tasks.client);

  assert.deepEqual(tasks.calls.tasks.insert, []);
  assert.deepEqual(tasks.calls.tasks.patch, []);
  assert.deepEqual(tasks.calls.tasks.delete, []);
});

test('an edited task note is patched in Google', async () => {
  const config = await makeVault();
  const fm = synced({ title: 'Buy milk', status: 'needsAction', google_id: 'g1', tasklist_id: 'L1', source: 'google' });
  await writeNote(config, '{Tasks}/Buy milk.md', { ...fm, title: 'Buy oat milk' });
  const tasks = fakeTasks();

  await pushVaultData(config, { ...emptyState(), knownTaskIds: { L1: ['g1'] } }, fakeCalendar().client, tasks.client);

  assert.equal(tasks.calls.tasks.patch.length, 1);
  assert.equal(tasks.calls.tasks.patch[0].task, 'g1');
  assert.equal(tasks.calls.tasks.patch[0].requestBody.title, 'Buy oat milk');
  const after = (await readNote(config, '{Tasks}/Buy milk.md')).frontmatter;
  assert.equal(after.sync_hash, computeSyncHash(after));
});

test('ticking a task off in the vault completes it in Google and archives the note', async () => {
  const config = await makeVault();
  const fm = synced({ title: 'Buy milk', status: 'needsAction', google_id: 'g1', tasklist_id: 'L1', source: 'google' });
  await writeNote(config, '{Tasks}/Buy milk.md', { ...fm, status: 'completed' });
  const tasks = fakeTasks();

  await pushVaultData(config, { ...emptyState(), knownTaskIds: { L1: ['g1'] } }, fakeCalendar().client, tasks.client);

  assert.equal(tasks.calls.tasks.patch[0].requestBody.status, 'completed');
  assert.deepEqual(await listNotes(config), ['04-Archive/{Tasks}/Buy milk.md']);
});

test('moving a task note into a list folder moves the task: old one deleted, new one created in the (new) list', async () => {
  const config = await makeVault();
  const state = { ...emptyState(), knownTaskIds: { L1: ['g1'] } };
  await writeNote(config, '{Tasks}/Project A/Buy milk.md', synced({ title: 'Buy milk', status: 'needsAction', google_id: 'g1', tasklist_id: 'L1', source: 'google' }));
  const tasks = fakeTasks({}, { insert: () => ({ data: { id: 'g2', updated: '2026-02-01T08:00:00.000Z' } }) });

  await pushVaultData(config, state, fakeCalendar().client, tasks.client);

  assert.equal(tasks.calls.lists.insert[0].requestBody.title, 'Project A');
  assert.deepEqual(tasks.calls.tasks.delete.map((c) => [c.tasklist, c.task]), [['L1', 'g1']]);
  const created = tasks.lists.find((l) => l.title === 'Project A')!;
  assert.equal(tasks.calls.tasks.insert[0].tasklist, created.id);
  const { frontmatter } = await readNote(config, '{Tasks}/Project A/Buy milk.md');
  assert.equal(frontmatter.google_id, 'g2');
  assert.equal(frontmatter.tasklist_id, created.id);
});

test('a folder named like a list whose title had illegal characters finds that list instead of creating another', async () => {
  const config = await makeVault();
  await writeNote(config, '{Tasks}/Work-Home/Ship it.md', { title: 'Ship it', status: 'needsAction' });
  const tasks = fakeTasks({ lists: [{ id: 'L1', title: 'My Tasks' }, { id: 'L2', title: 'Work/Home' }] });

  await pushVaultData(config, emptyState(), fakeCalendar().client, tasks.client);

  assert.deepEqual(tasks.calls.lists.insert, []);
  assert.equal(tasks.calls.tasks.insert[0].tasklist, 'L2');
});

test('an insert that was interrupted (push_pending, no id) is retried', async () => {
  const config = await makeVault();
  await writeNote(config, '{Tasks}/Buy milk.md', { title: 'Buy milk', status: 'needsAction', push_pending: true, tasklist_id: 'L1' });
  const tasks = fakeTasks({}, { insert: () => ({ data: { id: 'g1', updated: '2026-02-01T08:00:00.000Z' } }) });

  await pushVaultData(config, emptyState(), fakeCalendar().client, tasks.client);

  const { frontmatter } = await readNote(config, '{Tasks}/Buy milk.md');
  assert.equal(frontmatter.google_id, 'g1');
  assert.equal(frontmatter.push_pending, undefined);
});

test('when Google refuses a new task the note stays as it was and the next cycle tries again', async () => {
  const config = await makeVault();
  const state = emptyState();
  await writeNote(config, '{Tasks}/Buy milk.md', { title: 'Buy milk', status: 'needsAction' });

  const failing = fakeTasks({}, { insert: () => { throw apiError(503, 'backend unavailable'); } });
  await assert.doesNotReject(pushVaultData(config, state, fakeCalendar().client, failing.client));
  const failed = (await readNote(config, '{Tasks}/Buy milk.md')).frontmatter;
  assert.equal(failed.google_id, undefined);
  assert.equal(failed.push_pending, undefined);

  const working = fakeTasks({}, { insert: () => ({ data: { id: 'g1', updated: '2026-02-01T08:00:00.000Z' } }) });
  await pushVaultData(config, state, fakeCalendar().client, working.client);
  assert.equal((await readNote(config, '{Tasks}/Buy milk.md')).frontmatter.google_id, 'g1');
});

test('when Google cannot be asked which list a folder means, nothing is pushed into the wrong one', async () => {
  const config = await makeVault();
  await writeNote(config, '{Tasks}/Project A/Buy milk.md', { title: 'Buy milk', status: 'needsAction' });
  const tasks = fakeTasks();
  (tasks.client.tasklists as any).list = async () => { throw apiError(503); };

  await assert.doesNotReject(pushVaultData(config, emptyState(), fakeCalendar().client, tasks.client));

  assert.deepEqual(tasks.calls.tasks.insert, []);
  assert.equal((await readNote(config, '{Tasks}/Project A/Buy milk.md')).frontmatter.google_id, undefined);
});

test('deleting a note deletes the Google record, and a record already gone is not an error', async () => {
  const config = await makeVault();
  const state = { ...emptyState(), knownTaskIds: { L1: ['gone-1', 'gone-2'] }, knownEventIds: { primary: ['gone-event'] } };
  const tasks = fakeTasks({}, { delete: (p) => { if (p.task === 'gone-2') throw apiError(404); return {}; } });
  const cal = fakeCalendar();

  await pushVaultData(config, state, cal.client, tasks.client);

  assert.deepEqual(tasks.calls.tasks.delete.map((c) => c.task), ['gone-1', 'gone-2']);
  assert.deepEqual(cal.calls.delete.map((c) => c.eventId), ['gone-event']);
  assert.deepEqual(state.knownTaskIds.L1, []);
  assert.deepEqual(state.knownEventIds.primary, []);
});

// ── calendar ────────────────────────────────────────────────────────────────

test('a new event note is created in Google and moved to its dated path', async () => {
  const config = await makeVault();
  const state = emptyState();
  await writeNote(config, '{Calendar}/Dinner.md', {
    title: 'Dinner',
    start: `${D}T18:30:00+01:00`,
    end: `${D}T19:30:00+01:00`,
    description: 'bring wine',
    reminders: ['10m', '1h', '1d'],
  }, 'private body');
  const cal = fakeCalendar({ insert: () => ({ data: { id: 'abcdefgh1234', updated: '2026-02-01T08:00:00.000Z' } }) });

  await pushVaultData(config, state, cal.client, fakeTasks().client);

  assert.deepEqual(cal.calls.insert[0], {
    calendarId: 'primary',
    requestBody: {
      summary: 'Dinner',
      description: 'bring wine',
      reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 10 }, { method: 'popup', minutes: 60 }, { method: 'popup', minutes: 1440 }] },
      start: { dateTime: `${D}T18:30:00+01:00` },
      end: { dateTime: `${D}T19:30:00+01:00` },
    },
  });
  assert.deepEqual(await listNotes(config), [`{Calendar}/${MONTH}/${D}-1830-Dinner-abcdefgh.md`]);
  const { frontmatter, body } = await readNote(config, `{Calendar}/${MONTH}/${D}-1830-Dinner-abcdefgh.md`);
  assert.equal(frontmatter.google_id, 'abcdefgh1234');
  assert.equal(body.trim(), 'private body');
  assert.deepEqual(state.knownEventIds.primary, ['abcdefgh1234']);
});

test('reminders: "default" means the calendar default', async () => {
  const config = await makeVault();
  await writeNote(config, '{Calendar}/Dinner.md', { title: 'Dinner', start: `${D}T18:30:00+01:00`, end: `${D}T19:30:00+01:00`, reminders: ['default'] });
  const cal = fakeCalendar();

  await pushVaultData(config, emptyState(), cal.client, fakeTasks().client);

  assert.deepEqual(cal.calls.insert[0].requestBody.reminders, { useDefault: true });
});

test('a date written the way Obsidian\'s date property writes it (unquoted) is an all-day event, not midnight UTC', async () => {
  const config = await makeVault();
  await fs.mkdir(path.join(config.vaultResolved, '{Calendar}'), { recursive: true });
  await fs.writeFile(path.join(config.vaultResolved, '{Calendar}/Holiday.md'), `---\ntitle: Holiday\nstart: ${D}\nend: ${dateFromNow(201)}\n---\n`);
  const cal = fakeCalendar();

  await pushVaultData(config, emptyState(), cal.client, fakeTasks().client);

  assert.deepEqual(cal.calls.insert[0].requestBody.start, { date: D });
  assert.deepEqual(cal.calls.insert[0].requestBody.end, { date: dateFromNow(201) });
});

test('rescheduling an event note patches Google and renames the note', async () => {
  const config = await makeVault();
  const old = `{Calendar}/${MONTH}/${D}-1830-Dinner-abcdefgh.md`;
  const fm = synced({ title: 'Dinner', status: 'confirmed', start: `${D}T18:30:00+01:00`, end: `${D}T19:30:00+01:00`, google_id: 'abcdefgh1234', calendar_id: 'primary', source: 'google' });
  await writeNote(config, old, { ...fm, start: `${D}T20:00:00+01:00` });
  const cal = fakeCalendar();

  await pushVaultData(config, { ...emptyState(), knownEventIds: { primary: ['abcdefgh1234'] } }, cal.client, fakeTasks().client);

  assert.equal(cal.calls.patch[0].eventId, 'abcdefgh1234');
  assert.equal(cal.calls.patch[0].requestBody.start.dateTime, `${D}T20:00:00+01:00`);
  assert.deepEqual(await listNotes(config), [`{Calendar}/${MONTH}/${D}-2000-Dinner-abcdefgh.md`]);
});

test('a note under a README name is never pushed', async () => {
  const config = await makeVault();
  await writeNote(config, '{Tasks}/README.md', { title: 'About this folder' });
  const tasks = fakeTasks();

  await pushVaultData(config, emptyState(), fakeCalendar().client, tasks.client);

  assert.deepEqual(tasks.calls.tasks.insert, []);
  assert.equal(await exists(config, '{Tasks}/README.md'), true);
});
