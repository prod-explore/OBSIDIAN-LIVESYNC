import test from 'node:test';
import assert from 'node:assert/strict';
import { errorMessage, isAlreadyGone, isFileMissing, isGone } from '../errors.js';
import { apiError } from './fakes.js';

test('errorMessage takes the message of an Error and the text of anything else', () => {
  assert.equal(errorMessage(new Error('boom')), 'boom');
  assert.equal(errorMessage('plain'), 'plain');
  assert.equal(errorMessage(42), '42');
});

test('file errors are recognised by their code', () => {
  assert.equal(isFileMissing(Object.assign(new Error('x'), { code: 'ENOENT' })), true);
  assert.equal(isFileMissing(Object.assign(new Error('x'), { code: 'EACCES' })), false);
  assert.equal(isFileMissing(undefined), false);
  assert.equal(isFileMissing('ENOENT'), false);
});

test('Google errors are recognised by status or code', () => {
  assert.equal(isGone(apiError(410)), true);
  assert.equal(isGone(apiError(404)), false);
  assert.equal(isGone({ status: 410 }), true);
  assert.equal(isAlreadyGone(apiError(404)), true);
  assert.equal(isAlreadyGone(apiError(410)), true);
  assert.equal(isAlreadyGone(apiError(500)), false);
  assert.equal(isAlreadyGone(null), false);
});
