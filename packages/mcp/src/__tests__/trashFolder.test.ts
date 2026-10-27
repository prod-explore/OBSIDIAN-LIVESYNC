// A visible TRASH_DIR is as unreachable as the default hidden one: the copies in it stay restorable only while no
// tool can read them as notes, change them or move them.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs/promises';
import * as path from 'path';
import { makeHarness, text, type Harness, type ToolResult } from './harness.js';

let h: Harness;
let copy: string;
before(async () => {
  h = await makeHarness({ trashDir: '_deleted' });
  await h.write('Plan.md', 'the plan');
  await h.write('Hub.md', 'see [[Plan]] (zebra-word)');
  await h.call('delete_note', { path: 'Hub.md' });
  [copy] = await h.files('_deleted');
});
after(() => h.cleanup());

const refused = (res: ToolResult) => {
  assert.equal(res.isError, true, text(res));
  assert.match(text(res), /trash folder is not reachable/);
};

test('delete_note puts the note in the configured trash folder', () => {
  assert.match(copy, /^_deleted\/[^/]+__Hub\.md$/);
});

test('no tool reads, writes, edits, deletes or moves anything in the trash folder, whatever the case', async () => {
  const attempts = [
    h.call('get_path', { path: '_deleted' }),
    h.call('get_path', { path: copy }),
    h.call('get_path', { path: copy.replace('_deleted', '_Deleted') }),
    h.call('get_vault_tree', { path: '_deleted' }),
    h.call('write_note', { path: '_deleted/planted.md', content: 'x' }),
    h.call('write_note', { path: copy, content: 'x', overwrite: true }),
    h.call('edit_note', { path: copy, start_line: 1, end_line: 1, new_content: 'x' }),
    h.call('delete_note', { path: copy }),
    h.call('move_note', { from: copy, to: 'Restored.md' }),
    h.call('move_note', { from: 'Plan.md', to: '_deleted/Plan.md' }),
  ];
  for (const res of await Promise.all(attempts)) refused(res);
  assert.deepEqual(await h.files('_deleted'), [copy]);
  assert.equal(await h.read('Plan.md'), 'the plan');
});

test('a link to the trash folder, or to a folder above it, is no way in', async () => {
  await fs.symlink(path.join(h.vault, '_deleted'), path.join(h.vault, 'bin-link'));
  await fs.symlink(h.vault, path.join(h.vault, 'root-link'));
  try {
    const name = path.posix.basename(copy);
    refused(await h.call('get_path', { path: `bin-link/${name}` }));
    refused(await h.call('write_note', { path: 'bin-link/planted.md', content: 'x' }));
    refused(await h.call('get_path', { path: `root-link/${copy}` }));
    assert.doesNotMatch(text(await h.call('get_path', { path: 'root-link' })), /_deleted/);
  } finally {
    await fs.rm(path.join(h.vault, 'bin-link'));
    await fs.rm(path.join(h.vault, 'root-link'));
  }
});

test('listings and searches leave the trash folder out', async () => {
  assert.doesNotMatch(text(await h.call('get_path', { path: '' })), /_deleted/);
  assert.doesNotMatch(text(await h.call('get_vault_tree', { depth: -1 })), /_deleted/);
  assert.match(text(await h.call('search_notes', { query: 'zebra-word' })), /No notes found/);
});

test('move_note rewrites the links in the notes, never in the copies in the trash folder', async () => {
  await h.write('Index.md', '[[Plan]]');
  const before = await h.read(copy);
  const res = await h.call('move_note', { from: 'Plan.md', to: 'Roadmap.md' });
  assert.equal(res.isError, undefined, text(res));
  assert.equal(await h.read('Index.md'), '[[Roadmap]]');
  assert.equal(await h.read(copy), before);
});
