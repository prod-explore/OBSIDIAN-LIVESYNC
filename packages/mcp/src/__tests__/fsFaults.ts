// Faults and races injected into fs/promises, for what a real vault cannot be made to do on cue. Permissions cannot
// make a write fail reliably (tests may run as root, which ignores them), and a race has to land between two calls.
import { mock } from 'node:test';
import { syncBuiltinESMExports } from 'node:module';
import fsp from 'fs/promises';
import * as path from 'path';

/** Runs `run` with fsp[method] replaced; `import * as fs from 'fs/promises'` elsewhere sees it once re-synced. */
async function withReplaced<K extends 'writeFile' | 'rmdir', T>(
  method: K,
  replacement: (typeof fsp)[K],
  run: () => Promise<T>,
): Promise<T> {
  const spy = mock.method(fsp, method, replacement);
  syncBuiltinESMExports();
  try {
    return await run();
  } finally {
    spy.mock.restore();
    syncBuiltinESMExports();
  }
}

/** Makes fs/promises.writeFile fail for one file, to test what happens when a note cannot be written. */
export async function withWriteFailing<T>(file: string, run: () => Promise<T>): Promise<T> {
  const original = fsp.writeFile;
  const blocked = path.resolve(file);
  const writeFile: typeof fsp.writeFile = (target, ...rest) => {
    if (typeof target === 'string' && path.resolve(target) === blocked) {
      return Promise.reject(Object.assign(new Error('EACCES: permission denied (simulated)'), { code: 'EACCES' }));
    }
    return original(target, ...rest);
  };
  return withReplaced('writeFile', writeFile, run);
}

/** Runs `before` right before each fs/promises.rmdir, as another writer could: everything checked earlier is stale. */
export async function withBeforeRmdir<T>(before: (folder: string) => Promise<void>, run: () => Promise<T>): Promise<T> {
  const original = fsp.rmdir;
  const rmdir: typeof fsp.rmdir = async (target, ...rest) => {
    await before(String(target));
    return original(target, ...rest);
  };
  return withReplaced('rmdir', rmdir, run);
}
