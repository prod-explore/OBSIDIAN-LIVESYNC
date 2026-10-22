import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { evaluateHealth, readStatus, staleAfterMinutes, writeStatus, type SyncStatus } from '../status.js';

const NOW = new Date('2026-06-01T12:00:00.000Z');
const minutesAgo = (n: number) => new Date(NOW.getTime() - n * 60_000).toISOString();

const status = (over: Partial<SyncStatus> = {}): SyncStatus => ({
  version: 1,
  lastAttemptAt: minutesAgo(1),
  lastSuccessAt: minutesAgo(1),
  lastDurationMs: 800,
  errors: 0,
  problems: {},
  removedCancelled: 0,
  pollIntervalMinutes: 5,
  ...over,
});

test('healthy: the last cycle succeeded a moment ago', () => {
  const health = evaluateHealth(status(), NOW);
  assert.equal(health.healthy, true);
  assert.match(health.reason, /last successful sync 1 minute/);
});

test('notes that need attention are mentioned but do not make the sync unhealthy', () => {
  const health = evaluateHealth(status({ problems: { '{Tasks}/Bad.md': 'due is not a date' } }), NOW);
  assert.equal(health.healthy, true);
  assert.match(health.reason, /1 note\(s\) need attention/);
});

test('one failed cycle after a recent success is not yet unhealthy', () => {
  const health = evaluateHealth(status({ lastAttemptAt: minutesAgo(0), lastSuccessAt: minutesAgo(5), errors: 2 }), NOW);
  assert.equal(health.healthy, true);
});

test('unhealthy once the last success is older than three polls plus a margin, and it says why it is failing', () => {
  const limit = staleAfterMinutes(5);
  assert.equal(limit, 20);
  assert.equal(evaluateHealth(status({ lastSuccessAt: minutesAgo(limit) }), NOW).healthy, true);
  const stale = evaluateHealth(status({ lastSuccessAt: minutesAgo(limit + 1), errors: 1, lastError: 'invalid_grant' }), NOW);
  assert.equal(stale.healthy, false);
  assert.match(stale.reason, /21 minutes ago/);
  assert.match(stale.reason, /invalid_grant/);
});

test('the limit follows the poll interval', () => {
  assert.equal(evaluateHealth(status({ pollIntervalMinutes: 30, lastSuccessAt: minutesAgo(60) }), NOW).healthy, true);
  assert.equal(evaluateHealth(status({ pollIntervalMinutes: 1, lastSuccessAt: minutesAgo(9) }), NOW).healthy, false);
});

test('unhealthy before the first cycle has finished, and before the first success', () => {
  assert.equal(evaluateHealth(undefined, NOW).healthy, false);
  const never = evaluateHealth(status({ lastSuccessAt: undefined, errors: 1, lastError: 'invalid_grant' }), NOW);
  assert.equal(never.healthy, false);
  assert.match(never.reason, /invalid_grant/);
});

test('a status file round-trips, and a missing or damaged one reads as "no status"', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gcal-status-'));
  try {
    const file = path.join(dir, 'nested', 'status.json');
    assert.equal(await readStatus(file), undefined);

    await writeStatus(file, status());
    assert.deepEqual(await readStatus(file), status());
    assert.deepEqual(await fs.readdir(path.dirname(file)), ['status.json'], 'no temporary file is left behind');

    await fs.writeFile(file, '{"version": 1, "lastAtt');
    assert.equal(await readStatus(file), undefined);
    await fs.writeFile(file, '{"version": 2}');
    assert.equal(await readStatus(file), undefined);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
