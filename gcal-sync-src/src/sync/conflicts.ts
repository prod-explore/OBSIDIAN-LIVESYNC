import * as fs from 'fs/promises';
import * as path from 'path';
import { resolveVaultPath } from '../vault/paths.js';

export async function logConflict(
  vaultRoot: string,
  resourceName: string,
  localValue: any,
  googleValue: any,
  reason: string
) {
  const logRelative = '_Systems/sync-conflicts.md';
  const fullPath = resolveVaultPath(vaultRoot, logRelative);
  
  const timestamp = new Date().toISOString();
  let appendStr = `\n\n### 🔴 Conflict: ${resourceName} - ${timestamp}\n`;
  appendStr += `**Reason**: ${reason}\n`;
  appendStr += `- **Vault value**: \`${JSON.stringify(localValue)}\`\n`;
  appendStr += `- **Google value**: \`${JSON.stringify(googleValue)}\`\n`;

  try {
    const dir = path.dirname(fullPath);
    await fs.mkdir(dir, { recursive: true });
    await fs.appendFile(fullPath, appendStr, 'utf-8');
    console.log(`[Conflict Logged] ${resourceName} to ${logRelative}`);
  } catch (err: any) {
    console.error('Failed to write conflict log:', err);
  }
}
