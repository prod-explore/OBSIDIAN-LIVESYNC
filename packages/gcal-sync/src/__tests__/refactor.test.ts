import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs/promises';
import * as path from 'path';
import { renameAndRefactorLinks } from '../sync/refactor.js';
import { emptyState, fakeCalendar, fakeTasks, makeVault, removeVaults, syncContext } from './fakes.js';

after(removeVaults);

async function vaultWith(files: Record<string, string>, overrides: Parameters<typeof makeVault>[0] = {}) {
  const config = await makeVault(overrides);
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(config.vaultResolved, rel);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content, 'utf-8');
  }
  const ctx = syncContext(config, emptyState(), fakeCalendar().client, fakeTasks().client);
  const read = (rel: string) => fs.readFile(path.join(config.vaultResolved, rel), 'utf-8');
  return { ctx, read };
}

test('a rename rewrites links in any case, as Obsidian resolves them', async () => {
  const { ctx, read } = await vaultWith({
    '{Calendar}/Team Sync.md': '# event',
    'Daily.md': 'Exact [[Team Sync]], lower [[team sync|alias]], upper [[TEAM SYNC#Notes]].',
  });
  await renameAndRefactorLinks(ctx, '{Calendar}/Team Sync.md', '{Calendar}/Weekly Sync.md');
  assert.equal(
    await read('Daily.md'),
    'Exact [[Weekly Sync]], lower [[Weekly Sync|alias]], upper [[Weekly Sync#Notes]].',
  );
});

test('only whole names are rewritten, and links to other notes are left alone', async () => {
  const { ctx, read } = await vaultWith({
    'Plan.md': '#',
    'Hub.md': '[[plan]] [[Planning]] [[plan b]] [[Other]]',
  });
  await renameAndRefactorLinks(ctx, 'Plan.md', 'Roadmap.md');
  assert.equal(await read('Hub.md'), '[[Roadmap]] [[Planning]] [[plan b]] [[Other]]');
});

test('a rename leaves the copies in a visible trash folder as they were', async () => {
  const trashed = '[[Plan]] as it was before the delete';
  const { ctx, read } = await vaultWith(
    { 'Plan.md': '#', 'Hub.md': '[[Plan]]', '_deleted/2026-01-01__Hub.md': trashed },
    { trashDir: '_deleted' },
  );
  await renameAndRefactorLinks(ctx, 'Plan.md', 'Roadmap.md');
  assert.equal(await read('Hub.md'), '[[Roadmap]]');
  assert.equal(await read('_deleted/2026-01-01__Hub.md'), trashed);
});
