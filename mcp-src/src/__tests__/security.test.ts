import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveVaultPath, tokensMatch, PathTraversalError } from '../security.js';

import * as path from 'path';

const VAULT_ROOT = path.resolve('/vault');

test('resolveVaultPath allows a simple relative path', () => {
  const result = resolveVaultPath(VAULT_ROOT, 'Folder/Note.md');
  assert.equal(result, path.join(VAULT_ROOT, 'Folder/Note.md'));
});

test('resolveVaultPath allows the vault root itself', () => {
  const result = resolveVaultPath(VAULT_ROOT, '');
  assert.equal(result, VAULT_ROOT);
});

test('resolveVaultPath blocks parent-directory traversal', () => {
  assert.throws(() => resolveVaultPath(VAULT_ROOT, '../../etc/passwd'), PathTraversalError);
});

test('resolveVaultPath blocks an absolute path outside the vault', () => {
  assert.throws(() => resolveVaultPath(VAULT_ROOT, '/etc/passwd'), PathTraversalError);
});

test('resolveVaultPath blocks a sneaky path that starts inside but escapes', () => {
  assert.throws(() => resolveVaultPath(VAULT_ROOT, 'Folder/../../etc/passwd'), PathTraversalError);
});

test('resolveVaultPath does not false-positive on a sibling folder with a shared prefix', () => {
  // "/vault-other" starts with "/vault" as a raw string, but is not inside "/vault" —
  // the trailing path.sep check in resolveVaultPath exists specifically to catch this.
  assert.throws(() => resolveVaultPath(VAULT_ROOT, '../vault-other/secret.md'), PathTraversalError);
});

test('tokensMatch accepts matching tokens', () => {
  assert.equal(tokensMatch('correct-key', 'correct-key'), true);
});

test('tokensMatch rejects a wrong token', () => {
  assert.equal(tokensMatch('wrong-key', 'correct-key'), false);
});

test('tokensMatch handles tokens of different lengths without throwing', () => {
  assert.equal(tokensMatch('short', 'a-much-longer-expected-key'), false);
});
