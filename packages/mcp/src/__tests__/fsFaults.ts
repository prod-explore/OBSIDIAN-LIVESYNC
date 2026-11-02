// Makes fs/promises.writeFile fail for one file, to test what happens when a note cannot be written. Permissions
// cannot do this reliably: tests may run as root, which ignores them.
import { mock } from 'node:test';
import { syncBuiltinESMExports } from 'node:module';
import fsp from 'fs/promises';
import * as path from 'path';

export async function withWriteFailing<T>(file: string, run: () => Promise<T>): Promise<T> {
  const original = fsp.writeFile;
  const blocked = path.resolve(file);
  const writeFile: typeof fsp.writeFile = (target, ...rest) => {
    if (typeof target === 'string' && path.resolve(target) === blocked) {
      return Promise.reject(Object.assign(new Error('EACCES: permission denied (simulated)'), { code: 'EACCES' }));
    }
    return original(target, ...rest);
  };
  const spy = mock.method(fsp, 'writeFile', writeFile);
  // `import * as fs from 'fs/promises'` elsewhere sees the replacement only after the ESM bindings are re-synced.
  syncBuiltinESMExports();
  try {
    return await run();
  } finally {
    spy.mock.restore();
    syncBuiltinESMExports();
  }
}
