import test from 'node:test';
import assert from 'node:assert/strict';
import { parseNote } from '../markdown/frontmatter.js';
import { dateText, readEventNote, readTaskNote } from '../markdown/notes.js';

const read = (yaml: string) => parseNote(`---\n${yaml}\n---\nbody`).frontmatter;

test('an unquoted date (YAML reads it as a Date) becomes YYYY-MM-DD', () => {
  const { note, problems } = readTaskNote(read('due: 2031-05-04'));
  assert.equal(note.due, '2031-05-04');
  assert.deepEqual(problems, []);
});

test('numbers where text is expected become text', () => {
  const { note } = readTaskNote(read('google_id: 1234567890\ntitle: 2026\ndescription: 42'));
  assert.deepEqual([note.google_id, note.title, note.description], ['1234567890', '2026', '42']);
});

test('timestamps the YAML parser turned into Dates are text again', () => {
  const { note } = readTaskNote(read('updated: 2026-02-01T08:00:00.000Z\nsynced_at: 2026-02-01T08:00:01Z'));
  assert.equal(note.updated, '2026-02-01T08:00:00.000Z');
  assert.equal(note.synced_at, '2026-02-01T08:00:01.000Z');
});

test('a due that is not a date is a problem, and is left out of the typed note', () => {
  const raw = read('due: tomorrow\ntitle: Pay rent');
  const { note, problems } = readTaskNote(raw);
  assert.equal(note.due, undefined);
  assert.equal(note.title, 'Pay rent');
  assert.equal(problems.length, 1);
  assert.match(problems[0], /due "tomorrow" is not a date/);
  assert.equal(raw.due, 'tomorrow', 'what the user wrote is not touched');
});

test('a status Google does not know is a problem', () => {
  const { note, problems } = readTaskNote(read('status: done'));
  assert.equal(note.status, undefined);
  assert.match(problems[0], /status "done" is not one of needsAction, completed, cancelled/);
  assert.deepEqual(readEventNote(read('status: confirmed')).problems, []);
  assert.match(readEventNote(read('status: needsAction')).problems[0], /status "needsAction"/);
});

test('empty values are not problems', () => {
  const { note, problems } = readTaskNote(read('due:\nstatus: ""\ndescription:'));
  assert.deepEqual(problems, []);
  assert.equal(note.due, undefined);
  assert.equal(note.status, undefined);
  assert.equal(note.description, undefined);
});

test("the user's own properties pass through untouched", () => {
  const { note } = readTaskNote(read('title: Plan\nproject: [a, b]\nenergy: 3\nrelated: "[[Other]]"'));
  assert.deepEqual(note.project, ['a', 'b']);
  assert.equal(note.energy, 3);
  assert.equal(note.related, '[[Other]]');
});

test('event dates: a Date at midnight UTC is an all-day date, a date-time stays a date-time', () => {
  const allDay = readEventNote(read('start: 2031-05-04\nend: 2031-05-05'));
  assert.deepEqual([allDay.note.start, allDay.note.end], ['2031-05-04', '2031-05-05']);
  const timed = readEventNote(read('start: "2031-05-04T18:30:00+01:00"'));
  assert.equal(timed.note.start, '2031-05-04T18:30:00+01:00', 'as the sync writes it (quoted), the offset is kept');
  assert.deepEqual(timed.problems, []);
  const bare = readEventNote(read('start: 2031-05-04T18:30:00+01:00'));
  assert.equal(bare.note.start, '2031-05-04T17:30:00.000Z', 'typed by hand without quotes, YAML has already turned it into the same instant in UTC');
});

test('an event with an impossible date is a problem', () => {
  const { note, problems } = readEventNote(read('start: next friday'));
  assert.equal(note.start, undefined);
  assert.match(problems[0], /start "next friday" is not a date/);
});

test('dateText', () => {
  assert.equal(dateText(new Date('2031-05-04T00:00:00.000Z')), '2031-05-04');
  assert.equal(dateText(new Date('2031-05-04T09:15:00.000Z')), '2031-05-04T09:15:00.000Z');
  assert.equal(dateText(' 2031-05-04 '), '2031-05-04');
  assert.equal(dateText(''), undefined);
  assert.equal(dateText(12), undefined);
  assert.equal(dateText(new Date('nope')), undefined);
});
