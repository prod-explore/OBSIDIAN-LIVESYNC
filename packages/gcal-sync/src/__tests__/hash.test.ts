import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeSyncHash, isLocallyModified } from '../sync/hash.js';

const fields = { title: 'Dentist', status: 'needsAction', due: '2026-11-02' };
const syncedAt = '2026-10-20T10:00:00.000Z';
const syncedMs = Date.parse(syncedAt);

test('with sync_hash, the content decides and the file time does not', () => {
  const note = { ...fields, sync_hash: computeSyncHash(fields), synced_at: syncedAt };
  assert.equal(isLocallyModified(note, syncedMs + 3_600_000), false, 'touched by LiveSync, not edited');
  assert.equal(isLocallyModified({ ...note, title: 'Dentist at 9' }, syncedMs), true);
});

test('a note without sync_hash (added by hand or by another app) falls back to the file time', () => {
  const note = { ...fields, synced_at: syncedAt };
  assert.equal(isLocallyModified(note, syncedMs + 1_000), false, 'within the slack for the write by the sync');
  assert.equal(isLocallyModified(note, syncedMs + 60_000), true, 'changed after the sync wrote it');
});

test('a note with neither sync_hash nor synced_at counts as unchanged', () => {
  assert.equal(isLocallyModified(fields, Date.now()), false);
});
