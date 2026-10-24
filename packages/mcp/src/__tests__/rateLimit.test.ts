import test from 'node:test';
import assert from 'node:assert/strict';
import { WriteLimiter } from '../rateLimit.js';

test('lets `max` writes through per window, then says how long to wait', () => {
  let now = 1_000;
  const limiter = new WriteLimiter(3, 60_000, () => now);
  assert.deepEqual([limiter.take(), limiter.take(), limiter.take()], [null, null, null]);
  now += 10_000;
  assert.equal(limiter.take(), 50, 'the first write frees its slot 60 s after it was made');
});

test('a slot frees up as the oldest write leaves the window', () => {
  let now = 0;
  const limiter = new WriteLimiter(2, 60_000, () => now);
  limiter.take();
  now = 30_000;
  limiter.take();
  assert.notEqual(limiter.take(), null);
  now = 60_001;
  assert.equal(limiter.take(), null, 'the first write is out of the window');
  assert.notEqual(limiter.take(), null, 'the second is still in it');
});

test('refused writes do not use up the window', () => {
  let now = 0;
  const limiter = new WriteLimiter(1, 60_000, () => now);
  limiter.take();
  for (let i = 0; i < 100; i++) limiter.take();
  now = 60_001;
  assert.equal(limiter.take(), null);
});

test('a limit of 0 means no limit', () => {
  const limiter = new WriteLimiter(0, 60_000);
  for (let i = 0; i < 1000; i++) assert.equal(limiter.take(), null);
});
