import test from 'node:test';
import assert from 'node:assert/strict';
import { isPastMonth, ARCHIVE_PREFIX } from '../sync/archive.js';

const NOW = new Date('2026-09-15T12:00:00Z'); // fixed "today" for all cases below

test('an event dated in a fully past month is past', () => {
  assert.equal(isPastMonth('2026-08-31', NOW), true);
  assert.equal(isPastMonth('2025-01-01T09:00:00Z', NOW), true);
});

test('an event earlier THIS month is not past — whole month must elapse first', () => {
  assert.equal(isPastMonth('2026-09-01', NOW), false);
  assert.equal(isPastMonth('2026-09-14T23:59:00Z', NOW), false);
});

test('an event later this month or in the future is not past', () => {
  assert.equal(isPastMonth('2026-09-30', NOW), false);
  assert.equal(isPastMonth('2026-10-01', NOW), false);
  assert.equal(isPastMonth('2027-01-01', NOW), false);
});

test('accepts both plain dates and full dateTimes identically', () => {
  assert.equal(isPastMonth('2026-08-15', NOW), isPastMonth('2026-08-15T18:30:00+02:00', NOW));
});

test('ARCHIVE_PREFIX is the shared vault folder name', () => {
  assert.equal(ARCHIVE_PREFIX, '04-Archive');
});
