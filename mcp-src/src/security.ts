import * as path from 'path';
import * as crypto from 'crypto';

export class PathTraversalError extends Error {
  constructor(attemptedPath: string) {
    super(`Security Error: Path traversal attempt detected ("${attemptedPath}").`);
    this.name = 'PathTraversalError';
  }
}

/**
 * Resolves a vault-relative path and guarantees the result stays inside vaultRoot.
 * Throws PathTraversalError for anything that would escape the vault
 * (e.g. "../../etc/passwd", or an absolute path like "/etc/passwd").
 */
export function resolveVaultPath(vaultRoot: string, relativePath: string): string {
  const resolved = path.resolve(vaultRoot, relativePath);
  if (resolved !== vaultRoot && !resolved.startsWith(vaultRoot + path.sep)) {
    throw new PathTraversalError(relativePath);
  }
  return resolved;
}

/**
 * Constant-time comparison of the supplied token against the configured API key.
 * Plain `===` leaks timing information proportional to how many leading characters
 * match, which is enough to brute-force a token over many requests. Hashing both
 * sides to a fixed length before comparing also avoids leaking the key's length
 * and sidesteps timingSafeEqual's requirement that both buffers be equal length.
 */
export function tokensMatch(provided: string, expected: string): boolean {
  const providedHash = crypto.createHash('sha256').update(provided).digest();
  const expectedHash = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(providedHash, expectedHash);
}
