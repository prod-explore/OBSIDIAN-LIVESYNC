import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs/promises';
import * as path from 'path';
import { computeSyncHash } from '../sync/hash.js';
import { indexWinners } from '../sync/duplicates.js';
import { readTaskNote, type NoteFields, type RawFrontmatter } from '../markdown/notes.js';
import type { ScannedNote } from '../sync/scan.js';
import { emptyState, exists, fakeCalendar, fakeTasks, ingest, listNotes, makeVault, push, readNote, removeVaults, writeNote } from './fakes.js';

after(removeVaults);

/** A note the way a finished sync leaves it: the hash matches, so it counts as untouched. */
const synced = (fm: RawFrontmatter): RawFrontmatter => ({ ...fm, sync_hash: computeSyncHash(fm), synced_at: '2026-02-01T09:00:00.000Z' });

const base = { type: 'task', google_id: 'g1', tasklist_id: 'L1', source: 'google', title: 'Buy milk' };

test('two notes with one google_id: the one changed last stays, the other is set aside and logged', async () => {
  const config = await makeVault();
  const state = { ...emptyState(), knownTaskIds: { L1: ['g1'] } };
  await writeNote(config, '{Tasks}/Buy milk.md', synced({ ...base, status: 'needsAction', updated: '2026-02-01T08:00:00.000Z' }), 'old body');
  await writeNote(config, '04-Archive/{Tasks}/Buy milk.md', synced({ ...base, status: 'completed', updated: '2026-02-05T08:00:00.000Z' }), 'newer body');
  const tasks = fakeTasks();

  const ctx = await push(config, state, fakeCalendar().client, tasks.client);

  const left = (await listNotes(config)).filter((n) => !n.startsWith('_Systems/'));
  assert.deepEqual(left, ['04-Archive/{Tasks}/Buy milk.md']);
  assert.equal((await readNote(config, '04-Archive/{Tasks}/Buy milk.md')).body.trim(), 'newer body');

  const aside = (await listNotes(config, '_Systems/duplicates')).map((n) => n.split('/').pop());
  assert.equal(aside.length, 1);
  assert.match(aside[0] ?? '', /\{Tasks\} - Buy milk\.md$/);

  const log = await fs.readFile(path.join(config.vaultResolved, '_Systems/sync-conflicts.md'), 'utf-8');
  assert.match(log, /Same google_id as 04-Archive\/\{Tasks\}\/Buy milk\.md/);

  assert.deepEqual([tasks.calls.tasks.insert, tasks.calls.tasks.patch, tasks.calls.tasks.delete], [[], [], []], 'Google hears nothing about it');
  assert.deepEqual(state.knownTaskIds.L1, ['g1'], 'the task is still known, so it is not mistaken for a deleted one');
  assert.equal(ctx.report.errors, 0);
});

test('a copy edited here counts as the newest, whatever its old `updated` says', async () => {
  const config = await makeVault();
  const state = { ...emptyState(), knownTaskIds: { L1: ['g1'] } };
  await writeNote(config, '{Tasks}/Buy milk.md', { ...synced({ ...base, status: 'needsAction', updated: '2026-02-01T08:00:00.000Z' }), title: 'Buy oat milk' });
  await writeNote(config, '04-Archive/{Tasks}/Buy milk.md', synced({ ...base, status: 'needsAction', updated: '2026-03-01T08:00:00.000Z' }));
  const tasks = fakeTasks();

  await push(config, state, fakeCalendar().client, tasks.client);

  assert.equal((await readNote(config, '{Tasks}/Buy milk.md')).frontmatter.title, 'Buy oat milk', 'the edit is not lost');
  assert.equal(await exists(config, '04-Archive/{Tasks}/Buy milk.md'), false);
  assert.equal(tasks.calls.tasks.patch.length, 1, 'and it is pushed');
});

test('equal `updated`: the copy in the place its state calls for wins', async () => {
  const notes = (status: string) => [
    note('{Tasks}/A.md', { google_id: 'g1', status, updated: '2026-02-01T08:00:00.000Z' }),
    note('04-Archive/{Tasks}/A.md', { google_id: 'g1', status, updated: '2026-02-01T08:00:00.000Z' }),
  ];
  assert.equal(indexWinners('task', notes('needsAction')).get('g1'), '{Tasks}/A.md');
  assert.equal(indexWinners('task', notes('completed')).get('g1'), '04-Archive/{Tasks}/A.md');
});

test('the answer does not depend on the order the notes are found in', () => {
  const a = note('{Tasks}/A.md', { google_id: 'g1', status: 'needsAction', updated: '2026-02-01T08:00:00.000Z' });
  const b = note('{Tasks}/Project/A.md', { google_id: 'g1', status: 'needsAction', updated: '2026-02-01T08:00:00.000Z' });
  assert.equal(indexWinners('task', [a, b]).get('g1'), indexWinners('task', [b, a]).get('g1'));
});

test('notes without an id are never treated as copies of each other', async () => {
  const config = await makeVault();
  await writeNote(config, '{Tasks}/One.md', { title: 'Same', status: 'needsAction' });
  await writeNote(config, '{Tasks}/Two.md', { title: 'Same', status: 'needsAction' });
  const tasks = fakeTasks();

  await push(config, emptyState(), fakeCalendar().client, tasks.client);

  assert.equal(tasks.calls.tasks.insert.length, 2);
  assert.deepEqual((await listNotes(config)).sort(), ['{Tasks}/One.md', '{Tasks}/Two.md']);
});

test('ingest applies a Google change to the winning copy and leaves the other for push to set aside', async () => {
  const config = await makeVault();
  const state = emptyState();
  await writeNote(config, '{Tasks}/Buy milk.md', synced({ ...base, status: 'needsAction', updated: '2026-02-01T08:00:00.000Z' }), 'in active');
  await writeNote(config, '04-Archive/{Tasks}/Buy milk.md', synced({ ...base, status: 'completed', updated: '2026-02-03T08:00:00.000Z' }), 'in archive');
  const tasks = fakeTasks({}, { list: () => ({ data: { items: [{ id: 'g1', title: 'Buy milk!', status: 'completed', updated: '2026-02-09T08:00:00.000Z' }] } }) });

  await ingest(config, state, fakeCalendar().client, tasks.client);

  assert.equal((await readNote(config, '04-Archive/{Tasks}/Buy milk.md')).frontmatter.title, 'Buy milk!');
  const loser = await readNote(config, '{Tasks}/Buy milk.md');
  assert.equal(loser.frontmatter.title, 'Buy milk', 'the losing copy is not written to');
  assert.equal(loser.body.trim(), 'in active');
});

/** A scanned note without a file behind it, for the pure tests. */
function note(relative: string, raw: RawFrontmatter): ScannedNote<NoteFields> {
  const slash = relative.lastIndexOf('/');
  const read = readTaskNote(raw);
  return {
    relative,
    relFolder: relative.slice(0, slash),
    file: relative.slice(slash + 1),
    fullPath: `/vault/${relative}`,
    mtimeMs: 0,
    raw,
    note: read.note,
    problems: read.problems,
    body: '',
  };
}
