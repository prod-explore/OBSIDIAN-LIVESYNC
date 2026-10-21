import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

export class PathTraversalError extends Error {
  constructor(attemptedPath: string) {
    super(`Security Error: Path traversal attempt detected ("${attemptedPath}").`);
    this.name = 'PathTraversalError';
  }
}

function isInside(root: string, target: string): boolean {
  return target === root || target.startsWith(root + path.sep);
}

/**
 * Rejects paths that reach outside the vault through a symbolic link.
 *
 * The lexical check in resolveVaultPath() cannot see links: `vault/link -> /etc` makes
 * `link/passwd` look like a vault path while every read or write follows the link out.
 * Walk the path one component at a time and look at what is really on disk. Components
 * that do not exist yet (a note about to be created) are fine; a link that points inside
 * the vault is fine; a link that points outside, or nowhere (a dangling link would be
 * *created* through by a write), is not.
 */
function assertNoSymlinkEscape(vaultRoot: string, resolved: string, attempted: string): void {
  let rootReal: string;
  try {
    rootReal = fs.realpathSync(vaultRoot);
  } catch {
    return; // no vault on disk yet: nothing can be linked out of it
  }

  let current = vaultRoot;
  for (const segment of path.relative(vaultRoot, resolved).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(current);
    } catch (err: any) {
      if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return; // the rest does not exist yet
      throw err;
    }
    if (!stat.isSymbolicLink()) continue;

    let real: string;
    try {
      real = fs.realpathSync(current);
    } catch {
      throw new PathTraversalError(attempted); // dangling link
    }
    if (!isInside(rootReal, real)) throw new PathTraversalError(attempted);
  }
}

/**
 * Resolves a vault-relative path and guarantees the result stays inside vaultRoot,
 * both lexically and after following symbolic links.
 * Throws PathTraversalError for anything that would escape the vault
 * (e.g. "../../etc/passwd", an absolute path like "/etc/passwd", or a link that leads out).
 */
export function resolveVaultPath(vaultRoot: string, relativePath: string): string {
  const resolved = path.resolve(vaultRoot, relativePath);
  if (!isInside(vaultRoot, resolved)) {
    throw new PathTraversalError(relativePath);
  }
  assertNoSymlinkEscape(vaultRoot, resolved, relativePath);
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
