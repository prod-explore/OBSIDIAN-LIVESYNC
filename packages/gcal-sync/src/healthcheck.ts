/**
 * Container health check: exit 0 when the last successful sync is recent, 1 otherwise. The reason is printed, so
 * `docker inspect --format '{{json .State.Health}}' <container>` shows why. It reads only status.json and imports
 * nothing heavy, so it starts fast.
 */
import { dataDir } from './sync/state.js';
import { evaluateHealth, readStatus, statusFilePath } from './status.js';

try {
  const health = evaluateHealth(await readStatus(statusFilePath(dataDir())), new Date());
  process.stdout.write(`${health.reason}\n`);
  process.exit(health.healthy ? 0 : 1);
} catch (err) {
  process.stdout.write(`cannot read the sync status: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
