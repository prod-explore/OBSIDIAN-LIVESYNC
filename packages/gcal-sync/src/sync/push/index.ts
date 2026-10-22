import type { SyncContext } from '../context.js';
import { eventKind } from './events.js';
import { pushKind } from './folder.js';
import { taskKind } from './tasks.js';

/** Sends what changed in the vault to Google: tasks first, then events. */
export async function pushVaultData(ctx: SyncContext): Promise<void> {
  await pushKind(ctx, taskKind);
  await pushKind(ctx, eventKind);
}
