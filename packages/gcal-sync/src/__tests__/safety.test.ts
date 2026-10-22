import test from 'node:test';
import assert from 'node:assert/strict';
import { isMassDeletion, MASS_DELETE_MIN } from '../sync/safety.js';

test('a handful of deletions is always allowed, even when it is the whole list', () => {
  assert.equal(isMassDeletion(1, 1), false);
  assert.equal(isMassDeletion(MASS_DELETE_MIN, MASS_DELETE_MIN), false);
});

test('everything vanishing from a big list is refused', () => {
  assert.equal(isMassDeletion(40, 40), true);
  assert.equal(isMassDeletion(6, 6), true);
});

test('more than half of a list vanishing at once is refused, half or less is allowed', () => {
  assert.equal(isMassDeletion(21, 40), true);
  assert.equal(isMassDeletion(20, 40), false);
});

test('a normal clean-up of a few notes in a large list is allowed', () => {
  assert.equal(isMassDeletion(8, 200), false);
});

test('an empty manifest has nothing to protect', () => {
  assert.equal(isMassDeletion(0, 0), false);
});
