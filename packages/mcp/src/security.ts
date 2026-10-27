import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { isInTrash } from 'obsidian-livesync-shared';
import { errorCode } from './errors.js';

export class PathTraversalError extends Error {
  constructor(attemptedPath: string) {
    super(`Security Error: Path traversal attempt detected ("${attemptedPath}").`);
    this.name = 'PathTraversalError';
  }
}

/**
 * Hidden files and folders are not part of the notes: `.obsidian/` holds the app's settings, plugin code and the
 * LiveSync plugin's CouchDB credentials. An agent that can read it can leak a password; one that can write it can
 * install a plugin, which is code that headless Obsidian runs. The default trash, `.trash/`, is hidden too.
 */
export class HiddenPathError extends Error {
  constructor(attemptedPath: string) {
    super(`Security Error: hidden files and folders are not reachable through this server ("${attemptedPath}").`);
    this.name = 'HiddenPathError';
  }
}

/**
 * The trash folder (TRASH_DIR, `.trash/` unless set) is not part of the notes either, whatever it is called. It holds
 * the previous versions of deleted, overwritten and edited notes; they stay restorable only while no tool can change
 * them, and a visible trash must not turn up in reads, listings or searches as if it held notes.
 */
export class TrashPathError extends Error {
  constructor(attemptedPath: string) {
    super(`Security Error: the trash folder is not reachable through this server ("${attemptedPath}").`);
    this.name = 'TrashPathError';
  }
}

export interface ResolveOptions {
  /** Only for paths that come from the server's own configuration (the trash folder), never from a client. */
  allowHidden?: boolean;
  /** The configured trash folder (vault-relative): a path at or inside it, directly or through a link, is refused. */
  trashDir?: string;
}

function isInside(root: string, target: string): boolean {
  return target === root || target.startsWith(root + path.sep);
}

/** Does the path (relative to the vault root) pass through a hidden file or folder? */
function isHidden(relative: string): boolean {
  return relative.split(path.sep).some((segment) => segment.startsWith('.'));
}

/**
 * Rejects paths that reach outside the vault through a symbolic link.
 *
 * The lexical check in resolveVaultPath() cannot see links: `vault/link -> /etc` makes
 * `link/passwd` look like a vault path while every read or write follows the link out.
 * Walk the path one component at a time and look at what is really on disk. Components
 * that do not exist yet (a note about to be created) are fine; a link that points inside
 * the vault is fine; a link that points outside, or nowhere (a dangling link would be
 * *created* through by a write), is not, and neither is one into a hidden folder.
 */
function assertNoSymlinkEscape(vaultRoot: string, resolved: string, attempted: string, allowHidden: boolean): void {
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
    } catch (err) {
      if (errorCode(err) === 'ENOENT' || errorCode(err) === 'ENOTDIR') return; // the rest does not exist yet
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
    // `notes -> .obsidian` stays inside the vault and would otherwise be a way round the hidden-path rule.
    if (!allowHidden && isHidden(path.relative(rootReal, real))) throw new HiddenPathError(attempted);
  }
}

/** The real path of `target`; the part of it that does not exist yet is appended as written. */
function realPathOf(target: string): string {
  const rest: string[] = [];
  let existing = target;
  for (;;) {
    try {
      return path.join(fs.realpathSync(existing), ...rest);
    } catch {
      const parent = path.dirname(existing);
      if (parent === existing) return target;
      rest.unshift(path.basename(existing));
      existing = parent;
    }
  }
}

/**
 * Is an absolute path inside the vault the trash folder or inside it? Checked as written and again after following
 * links, so neither a link into the trash nor a link standing in for the trash (or for a folder above it) is a way
 * round the check.
 */
export function isTrashPath(vaultRoot: string, absolutePath: string, trashDir: string): boolean {
  if (isInTrash(path.relative(vaultRoot, absolutePath), trashDir)) return true;
  const rootReal = realPathOf(vaultRoot);
  const trashReal = path.relative(rootReal, realPathOf(path.join(vaultRoot, trashDir)));
  const real = path.relative(rootReal, realPathOf(absolutePath));
  return isInTrash(real, trashDir) || (!trashReal.startsWith('..') && isInTrash(real, trashReal));
}

/**
 * Resolves a vault-relative path and guarantees the result stays inside vaultRoot,
 * both lexically and after following symbolic links.
 * Throws PathTraversalError for anything that would escape the vault
 * (e.g. "../../etc/passwd", an absolute path like "/etc/passwd", or a link that leads out),
 * HiddenPathError for a path through a hidden file or folder such as `.obsidian/`, and TrashPathError for a path in
 * `options.trashDir`.
 */
export function resolveVaultPath(vaultRoot: string, relativePath: string, options: ResolveOptions = {}): string {
  const resolved = path.resolve(vaultRoot, relativePath);
  if (!isInside(vaultRoot, resolved)) {
    throw new PathTraversalError(relativePath);
  }
  const allowHidden = options.allowHidden ?? false;
  if (!allowHidden && isHidden(path.relative(vaultRoot, resolved))) {
    throw new HiddenPathError(relativePath);
  }
  assertNoSymlinkEscape(vaultRoot, resolved, relativePath, allowHidden);
  if (options.trashDir !== undefined && isTrashPath(vaultRoot, resolved, options.trashDir)) {
    throw new TrashPathError(relativePath);
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
