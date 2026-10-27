import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_TRASH_DIR, isInTrash, resolveTrashDir, trashedName } from '../index.js';

test('TRASH_DIR unset or blank is .trash', () => {
  assert.equal(DEFAULT_TRASH_DIR, '.trash');
  for (const value of [undefined, '', '   ']) assert.equal(resolveTrashDir(value), '.trash');
});

test('TRASH_DIR is normalised to a vault-relative folder with forward slashes', () => {
  assert.equal(resolveTrashDir('_deleted'), '_deleted');
  assert.equal(resolveTrashDir(' _System/deleted/ '), '_System/deleted');
  assert.equal(resolveTrashDir('_System\\deleted'), '_System/deleted');
  assert.equal(resolveTrashDir('./a/../.bin'), '.bin');
});

test('a TRASH_DIR outside the vault, or the vault root itself, is refused with the variable named', () => {
  for (const value of ['/tmp/trash', 'C:\\trash', '..', '../outside', 'a/../../outside', '.', './', 'a/..']) {
    assert.throws(() => resolveTrashDir(value), /TRASH_DIR must be a folder inside the vault/, value);
  }
});

test('trashed names carry a timestamp and the flattened path', () => {
  const at = new Date('2026-10-26T12:34:56.789Z');
  assert.equal(trashedName('Folder/Sub\\Note.md', at), '2026-10-26T12-34-56-789Z__Folder__Sub__Note.md');
});

test('isInTrash matches the trash folder and what is inside it, in any case and with either separator', () => {
  for (const rel of [
    '_deleted',
    '_deleted/',
    '_deleted/Note.md',
    '_Deleted/a/b.md',
    '_deleted\\Note.md',
    './_deleted/x',
  ]) {
    assert.equal(isInTrash(rel, '_deleted'), true, rel);
  }
  for (const rel of ['', '.', '_deleted-old/Note.md', 'Notes/_deleted/x.md', '_deletedNote.md', '../_deleted']) {
    assert.equal(isInTrash(rel, '_deleted'), false, rel);
  }
  assert.equal(isInTrash('_System/deleted/x.md', '_System/deleted'), true);
  assert.equal(isInTrash('_System/other.md', '_System/deleted'), false);
});
