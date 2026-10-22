import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveVaultPath, tokensMatch, PathTraversalError } from '../security.js';

import * as fs from 'fs';
import * as os from 'os';
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

// ── Symbolic links ──────────────────────────────────────────────────────────

function makeSandbox() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'obs-sec-'));
  const vault = path.join(base, 'vault');
  const outside = path.join(base, 'outside');
  fs.mkdirSync(path.join(vault, 'Notes'), { recursive: true });
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'secret.md'), 'secret');
  fs.writeFileSync(path.join(vault, 'Notes', 'ok.md'), 'ok');
  return { base, vault, outside, done: () => fs.rmSync(base, { recursive: true, force: true }) };
}

test('resolveVaultPath blocks a symlinked folder that leads outside the vault', () => {
  const s = makeSandbox();
  try {
    fs.symlinkSync(s.outside, path.join(s.vault, 'link'));
    assert.throws(() => resolveVaultPath(s.vault, 'link/secret.md'), PathTraversalError);
    assert.throws(() => resolveVaultPath(s.vault, 'link'), PathTraversalError);
    // Writing a NEW note through the link must be refused too.
    assert.throws(() => resolveVaultPath(s.vault, 'link/new.md'), PathTraversalError);
  } finally { s.done(); }
});

test('resolveVaultPath blocks a symlinked file that leads outside the vault', () => {
  const s = makeSandbox();
  try {
    fs.symlinkSync(path.join(s.outside, 'secret.md'), path.join(s.vault, 'Notes', 'innocent.md'));
    assert.throws(() => resolveVaultPath(s.vault, 'Notes/innocent.md'), PathTraversalError);
  } finally { s.done(); }
});

test('resolveVaultPath blocks a dangling symlink (a write would create the target outside)', () => {
  const s = makeSandbox();
  try {
    fs.symlinkSync(path.join(s.outside, 'not-there.md'), path.join(s.vault, 'dangling.md'));
    assert.throws(() => resolveVaultPath(s.vault, 'dangling.md'), PathTraversalError);
  } finally { s.done(); }
});

test('resolveVaultPath blocks a link nested behind a link that stays inside', () => {
  const s = makeSandbox();
  try {
    fs.symlinkSync(s.outside, path.join(s.vault, 'Notes', 'out'));
    fs.symlinkSync(path.join(s.vault, 'Notes'), path.join(s.vault, 'alias'));
    assert.throws(() => resolveVaultPath(s.vault, 'alias/out/secret.md'), PathTraversalError);
  } finally { s.done(); }
});

test('resolveVaultPath allows a symlink that stays inside the vault', () => {
  const s = makeSandbox();
  try {
    fs.symlinkSync(path.join(s.vault, 'Notes'), path.join(s.vault, 'alias'));
    assert.equal(resolveVaultPath(s.vault, 'alias/ok.md'), path.join(s.vault, 'alias', 'ok.md'));
  } finally { s.done(); }
});

test('resolveVaultPath works when the vault root itself is a symlink', () => {
  const s = makeSandbox();
  try {
    const rootLink = path.join(s.base, 'vault-link');
    fs.symlinkSync(s.vault, rootLink);
    assert.equal(resolveVaultPath(rootLink, 'Notes/ok.md'), path.join(rootLink, 'Notes', 'ok.md'));
    assert.throws(() => resolveVaultPath(rootLink, '../outside/secret.md'), PathTraversalError);
  } finally { s.done(); }
});

test('resolveVaultPath allows paths that do not exist yet inside a real vault', () => {
  const s = makeSandbox();
  try {
    assert.equal(resolveVaultPath(s.vault, 'New/Deep/note.md'), path.join(s.vault, 'New', 'Deep', 'note.md'));
  } finally { s.done(); }
});
