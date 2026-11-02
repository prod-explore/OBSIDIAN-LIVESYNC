import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ARCHIVE_PREFIX,
  CALENDAR_FOLDER,
  SYNCED_ROOTS,
  SYSTEMS_FOLDER,
  TASKS_FOLDER,
  syncFolderKind,
} from '../index.js';

test('the layout names are the ones the sync and its documentation use', () => {
  assert.deepEqual(
    [TASKS_FOLDER, CALENDAR_FOLDER, ARCHIVE_PREFIX, SYSTEMS_FOLDER],
    ['{Tasks}', '{Calendar}', '04-Archive', '_Systems'],
  );
  assert.deepEqual(SYNCED_ROOTS, ['{Tasks}', '{Calendar}', '04-Archive']);
});

test('the synced roots, both archive mirrors and _Systems are the layout', () => {
  for (const rel of [
    '{Tasks}',
    '{Calendar}',
    '04-Archive',
    '04-Archive/{Tasks}',
    '04-Archive/{Calendar}',
    '_Systems',
  ]) {
    assert.equal(syncFolderKind(rel), 'layout', rel);
  }
});

test('a first-level folder of {Tasks} or its archive mirror is a task list', () => {
  for (const rel of ['{Tasks}/Project A', '04-Archive/{Tasks}/Project A', '{Tasks}/Untitled (2)']) {
    assert.equal(syncFolderKind(rel), 'task-list', rel);
  }
});

test('a YYYY-MM folder of {Calendar} or its archive mirror is a calendar month', () => {
  for (const rel of ['{Calendar}/2026-11', '04-Archive/{Calendar}/2025-01']) {
    assert.equal(syncFolderKind(rel), 'calendar-month', rel);
  }
});

test('the path is compared in any case, with either separator, and normalised', () => {
  for (const [rel, kind] of [
    ['{tasks}', 'layout'],
    ['04-ARCHIVE\\{TASKS}', 'layout'],
    ['./{Tasks}/', 'layout'],
    ['{Tasks}//Project A/', 'task-list'],
    ['Notes/../{Tasks}/Project A', 'task-list'],
    ['04-archive/{calendar}/2026-01', 'calendar-month'],
  ] as const) {
    assert.equal(syncFolderKind(rel), kind, rel);
  }
});

test('every other folder is not part of the layout', () => {
  for (const rel of [
    '',
    '.',
    'Projects',
    'Projects/{Tasks}',
    '{Tasks}/Project A/Sub',
    '{Calendar}/Trips',
    '{Calendar}/2026-11/Day',
    '04-Archive/Old notes',
    '04-Archive/_Systems',
    '_Systems/duplicates',
  ]) {
    assert.equal(syncFolderKind(rel), undefined, rel);
  }
});
