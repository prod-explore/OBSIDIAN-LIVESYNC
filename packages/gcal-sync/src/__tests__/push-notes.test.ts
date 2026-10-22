// What push does with notes it cannot take at face value: values YAML typed differently than expected, values that
// make no sense, and files it cannot read. None of them may stop the other notes, and none may look like a deletion.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs/promises';
import * as path from 'path';
import { computeSyncHash } from '../sync/hash.js';
import { emptyState, exists, fakeCalendar, fakeTasks, makeVault, push, readNote, removeVaults, writeNote } from './fakes.js';

after(removeVaults);

const rawNote = (config: Awaited<ReturnType<typeof makeVault>>, rel: string, text: string) => {
  const full = path.join(config.vaultResolved, rel);
  return fs.mkdir(path.dirname(full), { recursive: true }).then(() => fs.writeFile(full, text, 'utf-8'));
};

test('a due that is not a date skips that note, says why, and does not stop the others', async () => {
  const config = await makeVault();
  await writeNote(config, '{Tasks}/Bad.md', { title: 'Bad', status: 'needsAction', due: 'tomorrow' });
  await writeNote(config, '{Tasks}/Good.md', { title: 'Good', status: 'needsAction' });
  const tasks = fakeTasks();

  const ctx = await push(config, emptyState(), fakeCalendar().client, tasks.client);

  assert.deepEqual(tasks.calls.tasks.insert.map((c) => c.requestBody.title), ['Good']);
  assert.equal(ctx.report.errors, 0, 'a note that needs fixing is not a failed cycle');
  assert.match(ctx.report.problems.get('{Tasks}/Bad.md') ?? '', /due "tomorrow" is not a date/);
  assert.equal((await readNote(config, '{Tasks}/Bad.md')).frontmatter.due, 'tomorrow', 'the note is left exactly as it was');
});

test('a note that cannot be pushed is still a note: its task is not deleted on Google', async () => {
  const config = await makeVault();
  const fm = { title: 'Bad', status: 'needsAction', google_id: 'g1', tasklist_id: 'L1', due: 'tomorrow' };
  await writeNote(config, '{Tasks}/Bad.md', { ...fm, sync_hash: 'x' });
  const tasks = fakeTasks();

  await push(config, { ...emptyState(), knownTaskIds: { L1: ['g1'] } }, fakeCalendar().client, tasks.client);

  assert.deepEqual(tasks.calls.tasks.delete, []);
});

test('a due written as an unquoted date (YAML reads a Date) is pushed as that day', async () => {
  const config = await makeVault();
  await rawNote(config, '{Tasks}/Dated.md', '---\ntitle: Dated\nstatus: needsAction\ndue: 2031-05-04\n---\n');
  const tasks = fakeTasks();

  await push(config, emptyState(), fakeCalendar().client, tasks.client);

  assert.equal(tasks.calls.tasks.insert[0].requestBody.due, '2031-05-04T00:00:00.000Z');
  assert.equal((await readNote(config, '{Tasks}/Dated.md')).frontmatter.due, '2031-05-04');
});

test('a google_id the YAML parser read as a number still matches the manifest', async () => {
  const config = await makeVault();
  await rawNote(config, '{Tasks}/Numeric.md', `---\ntitle: Numeric\nstatus: needsAction\ngoogle_id: 1234567890\ntasklist_id: L1\nsync_hash: ${computeSyncHash({ title: 'Numeric', status: 'needsAction' })}\n---\n`);
  const tasks = fakeTasks();

  await push(config, { ...emptyState(), knownTaskIds: { L1: ['1234567890'] } }, fakeCalendar().client, tasks.client);

  assert.deepEqual(tasks.calls.tasks.delete, []);
  assert.deepEqual(tasks.calls.tasks.insert, []);
});

test('"cancelled" is not sent to Google Tasks, which has no such status; the rest of the edit is', async () => {
  const config = await makeVault();
  const fm = { title: 'Old', status: 'needsAction', google_id: 'g1', tasklist_id: 'L1', source: 'google' };
  await writeNote(config, '{Tasks}/Old.md', { ...fm, sync_hash: computeSyncHash(fm), synced_at: '2026-02-01T09:00:00.000Z', title: 'Old, dropped', status: 'cancelled' });
  const tasks = fakeTasks();

  await push(config, { ...emptyState(), knownTaskIds: { L1: ['g1'] } }, fakeCalendar().client, tasks.client);

  assert.equal(tasks.calls.tasks.patch[0].requestBody.title, 'Old, dropped');
  assert.equal('status' in tasks.calls.tasks.patch[0].requestBody, false);
  assert.equal(await exists(config, '04-Archive/{Tasks}/Old.md'), true, 'it is still filed as finished');
});

test('a new event note without a start is reported, not sent to Google to be refused', async () => {
  const config = await makeVault();
  await writeNote(config, '{Calendar}/Dinner.md', { title: 'Dinner' });
  const calendar = fakeCalendar();

  const ctx = await push(config, emptyState(), calendar.client, fakeTasks().client);

  assert.deepEqual(calendar.calls.insert, []);
  assert.match(ctx.report.problems.get('{Calendar}/Dinner.md') ?? '', /start is missing/);
  assert.equal(ctx.report.errors, 0);
});

test('a note with broken YAML is reported, the others are pushed, and nothing is deleted on Google that cycle', async () => {
  const config = await makeVault();
  await rawNote(config, '{Tasks}/Broken.md', '---\ntitle: [unclosed\nstatus: needsAction\n---\n');
  await writeNote(config, '{Tasks}/Fine.md', { title: 'Fine', status: 'needsAction' });
  const tasks = fakeTasks();

  const ctx = await push(config, { ...emptyState(), knownTaskIds: { L1: ['whose-note-is-broken'] } }, fakeCalendar().client, tasks.client);

  assert.deepEqual(tasks.calls.tasks.insert.map((c) => c.requestBody.title), ['Fine']);
  assert.match(ctx.report.problems.get('{Tasks}/Broken.md') ?? '', /not valid YAML/);
  assert.deepEqual(tasks.calls.tasks.delete, [], 'the vault was not fully understood, so a missing id proves nothing');
});

test('deleting works again once every note can be read', async () => {
  const config = await makeVault();
  await writeNote(config, '{Tasks}/Fine.md', { title: 'Fine', status: 'needsAction' });
  const tasks = fakeTasks();

  await push(config, { ...emptyState(), knownTaskIds: { L1: ['gone'] } }, fakeCalendar().client, tasks.client);

  assert.deepEqual(tasks.calls.tasks.delete, [{ tasklist: 'L1', task: 'gone' }]);
});
