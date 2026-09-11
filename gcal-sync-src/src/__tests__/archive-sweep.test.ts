import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import type { Config } from '../config.js';
import { sweepCalendarArchive } from '../sync/archive-sweep.js';

async function makeTempVault(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'gcal-sweep-test-'));
}

function fakeConfig(vaultResolved: string): Config {
  return {
    vaultPath: vaultResolved,
    vaultResolved,
    clientId: 'x',
    clientSecret: 'x',
    refreshToken: 'x',
    calendarIds: ['primary'],
    tasklistIds: [],
    pollIntervalMinutes: 15,
  };
}

async function writeNote(vaultRoot: string, relPath: string, content = '---\ntitle: test\n---\nbody'): Promise<void> {
  const full = path.join(vaultRoot, relPath);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, content, 'utf-8');
}

test('sweep is a no-op when {Calendar} does not exist yet', async () => {
  const vault = await makeTempVault();
  await assert.doesNotReject(sweepCalendarArchive(fakeConfig(vault)));
  await fs.rm(vault, { recursive: true, force: true });
});

test('leaves current and future months alone', async () => {
  const vault = await makeTempVault();
  const now = new Date();
  const currentMonth = now.toISOString().slice(0, 7); // "YYYY-MM"

  const activeRelative = `{Calendar}/${currentMonth}/2099-01-01-0000-Future-abcd1234.md`;
  await writeNote(vault, activeRelative);

  await sweepCalendarArchive(fakeConfig(vault));

  await assert.doesNotReject(fs.access(path.join(vault, activeRelative)), 'current-month file should not move');
  await fs.rm(vault, { recursive: true, force: true });
});

test('moves a past-month event into 04-Archive/{Calendar}/YYYY-MM/, filename unchanged', async () => {
  const vault = await makeTempVault();
  const activeRelative = '{Calendar}/2020-01/2020-01-15-1000-Old-meeting-a1b2c3d4.md';
  const content = '---\ntitle: Old meeting\ngoogle_id: abc123\n---\nsome notes';
  await writeNote(vault, activeRelative, content);

  await sweepCalendarArchive(fakeConfig(vault));

  const archivedPath = path.join(vault, '04-Archive/{Calendar}/2020-01/2020-01-15-1000-Old-meeting-a1b2c3d4.md');
  const movedContent = await fs.readFile(archivedPath, 'utf-8');
  assert.equal(movedContent, content);

  await assert.rejects(fs.access(path.join(vault, activeRelative)), 'old location should no longer exist');
  await fs.rm(vault, { recursive: true, force: true });
});

test('is idempotent — running twice in a row does not error on an already-archived event', async () => {
  const vault = await makeTempVault();
  const activeRelative = '{Calendar}/2020-01/2020-01-15-1000-Old-meeting-a1b2c3d4.md';
  await writeNote(vault, activeRelative);

  await sweepCalendarArchive(fakeConfig(vault));
  await assert.doesNotReject(sweepCalendarArchive(fakeConfig(vault)));
  await fs.rm(vault, { recursive: true, force: true });
});

test('handles multiple past months in one pass', async () => {
  const vault = await makeTempVault();
  await writeNote(vault, '{Calendar}/2019-06/2019-06-01-0900-A-11111111.md');
  await writeNote(vault, '{Calendar}/2020-12/2020-12-25-0000-B-22222222.md');

  await sweepCalendarArchive(fakeConfig(vault));

  await assert.doesNotReject(fs.access(path.join(vault, '04-Archive/{Calendar}/2019-06/2019-06-01-0900-A-11111111.md')));
  await assert.doesNotReject(fs.access(path.join(vault, '04-Archive/{Calendar}/2020-12/2020-12-25-0000-B-22222222.md')));
  await fs.rm(vault, { recursive: true, force: true });
});

