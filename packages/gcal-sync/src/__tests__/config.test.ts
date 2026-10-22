import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../config.js';

const BASE = {
  VAULT_PATH: '/vault',
  GOOGLE_CLIENT_ID: 'id',
  GOOGLE_CLIENT_SECRET: 'secret',
  GOOGLE_REFRESH_TOKEN: 'refresh',
};

const KEYS = ['VAULT_PATH', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN', 'CALENDAR_IDS', 'TASKLIST_IDS', 'POLL_INTERVAL_MINUTES', 'ALLOW_MASS_DELETE'];

/** Runs fn with exactly BASE + env set (everything else this config reads is unset), then restores the real environment. */
function withEnv<T>(env: Record<string, string>, fn: () => T, without: string[] = []): T {
  const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, BASE, env);
  for (const k of without) delete process.env[k];
  try {
    return fn();
  } finally {
    for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
}

test('defaults: primary calendar, default task list, every 5 minutes, mass deletion off', () => {
  const c = withEnv({}, loadConfig);
  assert.deepEqual(c.calendarIds, ['primary']);
  assert.deepEqual(c.tasklistIds, ['@default']);
  assert.equal(c.pollIntervalMinutes, 5);
  assert.equal(c.allowMassDelete, false);
});

test('id lists are split on commas and trimmed', () => {
  const c = withEnv({ CALENDAR_IDS: ' primary , work@group.calendar.google.com ,', TASKLIST_IDS: 'a,b' }, loadConfig);
  assert.deepEqual(c.calendarIds, ['primary', 'work@group.calendar.google.com']);
  assert.deepEqual(c.tasklistIds, ['a', 'b']);
});

test('a missing credential is an error that names the variable', () => {
  for (const name of ['VAULT_PATH', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN']) {
    assert.throws(() => withEnv({}, loadConfig, [name]), new RegExp(name));
  }
});

test('the poll interval must be a whole number of minutes from 1 to 59', () => {
  assert.equal(withEnv({ POLL_INTERVAL_MINUTES: '1' }, loadConfig).pollIntervalMinutes, 1);
  assert.equal(withEnv({ POLL_INTERVAL_MINUTES: '59' }, loadConfig).pollIntervalMinutes, 59);
  for (const bad of ['0', '60', '-5', '2.5', '5min', 'abc']) {
    assert.throws(() => withEnv({ POLL_INTERVAL_MINUTES: bad }, loadConfig), /POLL_INTERVAL_MINUTES/, bad);
  }
});

test('mass deletion is only enabled by the exact value "true"', () => {
  assert.equal(withEnv({ ALLOW_MASS_DELETE: 'true' }, loadConfig).allowMassDelete, true);
  for (const v of ['1', 'yes', 'TRUE', '']) assert.equal(withEnv({ ALLOW_MASS_DELETE: v }, loadConfig).allowMassDelete, false, v);
});
