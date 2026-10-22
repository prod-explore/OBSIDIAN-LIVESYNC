import * as fs from 'fs/promises';
import * as path from 'path';
import { resolveVaultPath } from '../markdown/paths.js';
import type { SyncContext } from './context.js';

const CONFLICT_LOG = '_Systems/sync-conflicts.md';

/** Appends what lost (and why) to the conflict log in the vault, so a decision the sync made for you can be looked at later. */
export async function logConflict(
  ctx: SyncContext,
  resourceName: string,
  localValue: unknown,
  googleValue: unknown,
  reason: string,
): Promise<void> {
  const fullPath = resolveVaultPath(ctx.config.vaultResolved, CONFLICT_LOG);

  const timestamp = ctx.now().toISOString();
  let entry = `\n\n### 🔴 Conflict: ${resourceName} - ${timestamp}\n`;
  entry += `**Reason**: ${reason}\n`;
  entry += `- **Vault value**: \`${JSON.stringify(localValue)}\`\n`;
  entry += `- **Google value**: \`${JSON.stringify(googleValue)}\`\n`;

  try {
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.appendFile(fullPath, entry, 'utf-8');
    ctx.log.info('Conflict logged', { resource: resourceName, log: CONFLICT_LOG });
  } catch (err) {
    ctx.fail('Could not write the conflict log', err, { resource: resourceName });
  }
}
