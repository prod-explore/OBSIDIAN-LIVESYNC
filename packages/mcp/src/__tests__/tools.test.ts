// write_note, edit_note, delete_note, move_note, get_path and get_vault_tree against a real (temporary) vault.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { makeHarness, text, type Harness } from './harness.js';

let h: Harness;
before(async () => {
  h = await makeHarness();
});
after(() => h.cleanup());

/** The trash holds files named `<timestamp>__<path with / as __>`. */
const trashed = async () => (await h.files('.trash')).map((f) => f.replace(/^\.trash\/[^_]+__/, ''));

test('write_note creates the note, and the folders above it', async () => {
  const res = await h.call('write_note', { path: 'Projects/New/Plan.md', content: '# Plan' });
  assert.equal(res.isError, undefined);
  assert.equal(await h.read('Projects/New/Plan.md'), '# Plan');
});

test('write_note refuses to replace a note unless asked to, and says how', async () => {
  await h.write('write/exists.md', 'original');
  const res = await h.call('write_note', { path: 'write/exists.md', content: 'new' });
  assert.equal(res.isError, true);
  assert.match(text(res), /already exists.*overwrite: true/);
  assert.equal(await h.read('write/exists.md'), 'original');
});

test('write_note with overwrite keeps the previous version in the trash', async () => {
  await h.write('write/replaced.md', 'before');
  const res = await h.call('write_note', { path: 'write/replaced.md', content: 'after', overwrite: true });
  assert.equal(res.isError, undefined);
  assert.match(text(res), /previous version backed up to \.trash\//);
  assert.equal(await h.read('write/replaced.md'), 'after');
  const saved = (await h.files('.trash')).find((f) => f.endsWith('write__replaced.md'));
  assert.ok(saved, 'the old version is in the trash');
  assert.equal(await h.read(saved), 'before');
});

test('write_note will not write outside the vault', async () => {
  const res = await h.call('write_note', { path: '../escaped.md', content: 'x' });
  assert.equal(res.isError, true);
  assert.match(text(res), /traversal/i);
  assert.equal(
    await fs.access(path.join(h.vault, '..', 'escaped.md')).then(
      () => true,
      () => false,
    ),
    false,
  );
});

test('delete_note moves the note to the trash instead of removing it', async () => {
  await h.write('delete/Old.md', 'keep me findable');
  const res = await h.call('delete_note', { path: 'delete/Old.md' });
  assert.equal(res.isError, undefined);
  assert.match(text(res), /Moved to trash: delete\/Old\.md/);
  assert.equal(await h.exists('delete/Old.md'), false);
  const saved = (await h.files('.trash')).find((f) => f.endsWith('delete__Old.md'));
  assert.ok(saved);
  assert.equal(await h.read(saved), 'keep me findable');
});

test('delete_note on a note that is not there is an error, not a silent success', async () => {
  const res = await h.call('delete_note', { path: 'delete/Missing.md' });
  assert.equal(res.isError, true);
  assert.match(text(res), /does not exist/);
});

test('delete_note will not touch anything outside the vault', async () => {
  const res = await h.call('delete_note', { path: '../../etc/hostname' });
  assert.equal(res.isError, true);
  assert.match(text(res), /traversal/i);
});

test('move_note renames the note and rewrites the links that point at it', async () => {
  await h.write('move/Old name.md', '# Old');
  await h.write('move/Linker.md', 'See [[Old name]] and [[Old name|the alias]].');
  const res = await h.call('move_note', { from: 'move/Old name.md', to: 'move/New name.md' });
  assert.equal(res.isError, undefined);
  assert.match(text(res), /Updated 1 backlink/);
  assert.equal(await h.exists('move/Old name.md'), false);
  assert.equal(await h.read('move/Linker.md'), 'See [[New name]] and [[New name|the alias]].');
});

test('move_note creates the destination folder', async () => {
  await h.write('move/Loose.md', 'x');
  const res = await h.call('move_note', { from: 'move/Loose.md', to: 'move/archive/2026/Loose.md' });
  assert.equal(res.isError, undefined);
  assert.equal(await h.read('move/archive/2026/Loose.md'), 'x');
});

test('move_note does not clobber an existing note unless told to; then the clobbered one goes to the trash', async () => {
  await h.write('move/a.md', 'from a');
  await h.write('move/b.md', 'old b');
  const refused = await h.call('move_note', { from: 'move/a.md', to: 'move/b.md' });
  assert.equal(refused.isError, true);
  assert.match(text(refused), /already exists/);
  assert.equal(await h.read('move/b.md'), 'old b');

  const done = await h.call('move_note', { from: 'move/a.md', to: 'move/b.md', overwrite: true });
  assert.equal(done.isError, undefined);
  assert.match(text(done), /backed up to \.trash\//);
  assert.equal(await h.read('move/b.md'), 'from a');
  assert.ok((await trashed()).includes('move__b.md'));
});

test('move_note: same source and destination is a no-op, a missing source an error', async () => {
  await h.write('move/same.md', 'x');
  assert.match(text(await h.call('move_note', { from: 'move/same.md', to: 'move/same.md' })), /Nothing to do/);
  const missing = await h.call('move_note', { from: 'move/none.md', to: 'move/other.md' });
  assert.equal(missing.isError, true);
  assert.match(text(missing), /Source note does not exist/);
});

test('move_note will not move a note out of the vault', async () => {
  await h.write('move/inside.md', 'x');
  const res = await h.call('move_note', { from: 'move/inside.md', to: '../outside.md' });
  assert.equal(res.isError, true);
  assert.equal(await h.exists('move/inside.md'), true);
});

test('get_path reads a note and lists a folder, hiding dotfiles', async () => {
  await h.write('get/Note.md', 'hello');
  await h.write('get/sub/Inner.md', 'inner');
  await h.write('get/.hidden.md', 'secret');
  assert.equal(text(await h.call('get_path', { path: 'get/Note.md' })), 'hello');
  const listing = text(await h.call('get_path', { path: 'get' }));
  assert.match(listing, /📄 Note\.md {2}→ {2}get\/Note\.md/);
  assert.match(listing, /📁 sub {2}→ {2}get\/sub/);
  assert.ok(!listing.includes('.hidden'));
});

test('get_path says so for an empty folder and a missing path', async () => {
  await fs.mkdir(path.join(h.vault, 'get-empty'));
  assert.match(text(await h.call('get_path', { path: 'get-empty' })), /^\(empty\) get-empty$/);
  const missing = await h.call('get_path', { path: 'get/nothing.md' });
  assert.equal(missing.isError, true);
  assert.match(text(missing), /Path not found/);
});

test('get_vault_tree draws folders before files, hides dot folders, and stops at the depth asked for', async () => {
  await h.write('tree/B folder/deep/Leaf.md', '');
  await h.write('tree/B folder/Mid.md', '');
  await h.write('tree/A.md', '');
  await h.write('tree/.obsidian/app.json', '');

  const shallow = text(await h.call('get_vault_tree', { path: 'tree' }));
  assert.equal(shallow, ['tree/', '├── B folder/', '│   ├── deep/', '│   └── Mid.md', '└── A.md'].join('\n'));

  const flat = text(await h.call('get_vault_tree', { path: 'tree', depth: 0 }));
  assert.equal(flat, ['tree/', '├── B folder/', '└── A.md'].join('\n'));

  const full = text(await h.call('get_vault_tree', { path: 'tree', depth: -1 }));
  assert.ok(full.includes('Leaf.md'));
  assert.ok(!full.includes('.obsidian'));
});

test('get_vault_tree: the vault root, a file, a missing folder', async () => {
  assert.match(text(await h.call('get_vault_tree')), /^\(vault root\)/);
  const file = await h.call('get_vault_tree', { path: 'get/Note.md' });
  assert.equal(file.isError, true);
  assert.match(text(file), /not a directory/);
  const missing = await h.call('get_vault_tree', { path: 'no/such/folder' });
  assert.equal(missing.isError, true);
  assert.match(text(missing), /Path not found/);
});

test('no tool writes, edits, moves or deletes inside a hidden folder such as .obsidian or the trash', async () => {
  await h.write('.obsidian/community-plugins.json', '["obsidian-livesync"]');
  await h.write('guard/Note.md', 'note');

  const attempts = [
    h.call('write_note', { path: '.obsidian/plugins/evil/main.js', content: 'require("child_process")' }),
    h.call('write_note', { path: '.obsidian/community-plugins.json', content: '["evil"]', overwrite: true }),
    h.call('edit_note', { path: '.obsidian/community-plugins.json', start_line: 1, end_line: 1, new_content: '[]' }),
    h.call('delete_note', { path: '.obsidian/community-plugins.json' }),
    h.call('move_note', { from: 'guard/Note.md', to: '.obsidian/plugins/evil/main.js' }),
    h.call('move_note', { from: '.obsidian/community-plugins.json', to: 'guard/plugins.md' }),
    h.call('write_note', { path: '.trash/planted.md', content: 'x' }),
  ];
  for (const res of await Promise.all(attempts)) {
    assert.equal(res.isError, true, text(res));
    assert.match(text(res), /hidden/i);
  }
  assert.equal(await h.read('.obsidian/community-plugins.json'), '["obsidian-livesync"]');
  assert.equal(await h.exists('.obsidian/plugins'), false);
  assert.equal(await h.read('guard/Note.md'), 'note');
  assert.equal(await h.exists('.trash/planted.md'), false);
});

test('write_note will not create a note through a symbolic link that leads out, or dangles', async () => {
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'obs-outside-'));
  try {
    await fs.symlink(outside, path.join(h.vault, 'out-link'));
    await fs.symlink(path.join(outside, 'planted.md'), path.join(h.vault, 'dangling.md'));
    for (const target of ['out-link/planted.md', 'dangling.md']) {
      const res = await h.call('write_note', { path: target, content: 'x', overwrite: true });
      assert.equal(res.isError, true, text(res));
      assert.match(text(res), /traversal/i);
    }
    assert.deepEqual(await fs.readdir(outside), []);
  } finally {
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test('delete_note, write_note and move_note refuse folders, so nothing is ever removed or moved recursively', async () => {
  await h.write('bulk/Project/a.md', 'a');
  await h.write('bulk/Project/b.md', 'b');
  await h.write('bulk/single.md', 'single');

  const attempts = {
    'delete a folder': await h.call('delete_note', { path: 'bulk/Project' }),
    'overwrite a folder': await h.call('write_note', { path: 'bulk/Project', content: 'x', overwrite: true }),
    'move a folder': await h.call('move_note', { from: 'bulk/Project', to: 'bulk/Moved' }),
    'move onto a folder': await h.call('move_note', { from: 'bulk/single.md', to: 'bulk/Project', overwrite: true }),
  };
  for (const [what, res] of Object.entries(attempts)) {
    assert.equal(res.isError, true, `${what}: ${text(res)}`);
    assert.match(text(res), /folder/, what);
  }
  assert.deepEqual(await h.files('bulk'), ['bulk/Project/a.md', 'bulk/Project/b.md', 'bulk/single.md']);
  assert.equal(await h.exists('bulk/Moved'), false);
  assert.ok(!(await trashed()).some((f) => f.startsWith('bulk__Project')));
});

test('edit_note leaves the previous version of the note in the trash', async () => {
  await h.write('edit/kept.md', 'one\ntwo\nthree');
  const res = await h.call('edit_note', { path: 'edit/kept.md', start_line: 2, end_line: 2, new_content: 'TWO' });
  assert.equal(res.isError, undefined);
  assert.match(text(res), /previous version backed up to \.trash\//);
  assert.equal(await h.read('edit/kept.md'), 'one\nTWO\nthree');
  const saved = (await h.files('.trash')).find((f) => f.endsWith('edit__kept.md'));
  assert.ok(saved, 'the old version is in the trash');
  assert.equal(await h.read(saved), 'one\ntwo\nthree');
});

test('a refused edit leaves nothing in the trash', async () => {
  await h.write('edit/refused.md', 'only line');
  const res = await h.call('edit_note', { path: 'edit/refused.md', start_line: 5, end_line: 5, new_content: 'x' });
  assert.equal(res.isError, true);
  assert.ok(!(await h.files('.trash')).some((f) => f.endsWith('edit__refused.md')));
});

test('writes past the limit are refused with a wait time; reads and the vault are untouched', async () => {
  const limited = await makeHarness({ writeLimit: { max: 3, windowMs: 60_000 } });
  try {
    await limited.write('seed.md', 'one\ntwo');
    const results = [
      await limited.call('write_note', { path: 'a.md', content: '1' }),
      await limited.call('edit_note', { path: 'seed.md', start_line: 1, end_line: 1, new_content: 'ONE' }),
      await limited.call('move_note', { from: 'a.md', to: 'b.md' }),
    ];
    assert.deepEqual(
      results.map((r) => r.isError),
      [undefined, undefined, undefined],
    );

    for (const [tool, args] of [
      ['write_note', { path: 'c.md', content: '3' }],
      ['edit_note', { path: 'seed.md', start_line: 2, end_line: 2, new_content: 'TWO' }],
      ['move_note', { from: 'b.md', to: 'd.md' }],
      ['delete_note', { path: 'b.md' }],
    ] as const) {
      const res = await limited.call(tool, args);
      assert.equal(res.isError, true, tool);
      assert.match(text(res), /Too many changes.*Try again in \d+s/, tool);
    }
    assert.equal(await limited.exists('c.md'), false);
    assert.equal(await limited.read('seed.md'), 'ONE\ntwo');
    assert.equal(await limited.exists('b.md'), true, 'the note that was not deleted is still there');

    const read = await limited.call('get_path', { path: 'seed.md' });
    assert.equal(read.isError, undefined, 'reading is never limited');
  } finally {
    await limited.cleanup();
  }
});
