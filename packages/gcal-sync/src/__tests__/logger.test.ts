import test from 'node:test';
import assert from 'node:assert/strict';
import { createLogger, loggerFromEnv, redact, type LoggerOptions } from '../logger.js';

function capture(options: LoggerOptions = {}) {
  const lines: Array<{ level: string; line: string }> = [];
  const log = createLogger({ ...options, write: (line, level) => lines.push({ level, line }) });
  return { log, lines };
}

test('json lines carry time, level, message and fields', () => {
  const { log, lines } = capture({ format: 'json' });
  log.info('Created task', { googleId: 'g1', n: 2 });
  const entry = JSON.parse(lines[0].line);
  assert.equal(entry.level, 'info');
  assert.equal(entry.msg, 'Created task');
  assert.equal(entry.googleId, 'g1');
  assert.equal(entry.n, 2);
  assert.ok(!Number.isNaN(Date.parse(entry.time)));
});

test('text lines read like a sentence with key=value pairs', () => {
  const { log, lines } = capture({ format: 'text' });
  log.child({ scope: 'sync' }).warn('Skipping', { path: 'a b.md' });
  assert.match(lines[0].line, /^\S+ WARN\s+\[sync\] Skipping path=a b\.md$/);
});

test('the level filters what is written', () => {
  const { log, lines } = capture({ level: 'warn' });
  log.debug('d');
  log.info('i');
  log.warn('w');
  log.error('e');
  assert.deepEqual(
    lines.map((l) => l.level),
    ['warn', 'error'],
  );
  const silent = capture({ level: 'silent' });
  silent.log.error('nothing');
  assert.deepEqual(silent.lines, []);
});

test('errors are written as name, message and code', () => {
  const { log, lines } = capture();
  log.error('failed', { error: Object.assign(new Error('boom'), { code: 'EACCES' }) });
  assert.deepEqual(JSON.parse(lines[0].line).error, { name: 'Error', message: 'boom', code: 'EACCES' });
});

test('a child logger adds its fields to every line', () => {
  const { log, lines } = capture();
  log.child({ scope: 'push' }).child({ run: 7 }).info('x');
  const entry = JSON.parse(lines[0].line);
  assert.equal(entry.scope, 'push');
  assert.equal(entry.run, 7);
});

test('warnOnce says it once per key', () => {
  const { log, lines } = capture();
  log.warnOnce('k', 'first');
  log.warnOnce('k', 'second');
  log.warnOnce('other', 'third');
  assert.deepEqual(
    lines.map((l) => JSON.parse(l.line).msg),
    ['first', 'third'],
  );
});

test('a token in a URL never reaches the log, in either format', () => {
  for (const format of ['json', 'text'] as const) {
    const { log, lines } = capture({ format });
    log.info('GET /mcp?token=s3cret&x=1', {
      url: 'https://example.org/mcp?x=1&token=s3cret',
      error: new Error('failed for /mcp?token=s3cret'),
    });
    assert.ok(!lines[0].line.includes('s3cret'), `${format}: ${lines[0].line}`);
    assert.match(lines[0].line, /token=\[redacted\]/);
  }
});

test('fields named like a secret are masked, and bearer tokens are redacted', () => {
  const { log, lines } = capture();
  log.info('x', { refreshToken: 'abc', clientSecret: 'def', authorization: 'ghi', other: 'visible' });
  const entry = JSON.parse(lines[0].line);
  assert.deepEqual(
    [entry.refreshToken, entry.clientSecret, entry.authorization, entry.other],
    ['[redacted]', '[redacted]', '[redacted]', 'visible'],
  );
  assert.equal(redact('Authorization: Bearer abc.def-123'), 'Authorization: Bearer [redacted]');
  assert.equal(redact('nothing to hide'), 'nothing to hide');
});

test('LOG_LEVEL and LOG_FORMAT come from the environment; a bad level falls back to info', () => {
  const lines: string[] = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string) => (lines.push(String(chunk)), true)) as typeof process.stdout.write;
  try {
    loggerFromEnv({ LOG_LEVEL: 'debug', LOG_FORMAT: 'json' }).debug('shown');
    loggerFromEnv({ LOG_LEVEL: 'nonsense', LOG_FORMAT: 'json' }).debug('hidden');
    loggerFromEnv({ LOG_LEVEL: 'nonsense', LOG_FORMAT: 'json' }).info('shown too');
  } finally {
    process.stdout.write = originalWrite;
  }
  assert.deepEqual(
    lines.map((l) => JSON.parse(l).msg),
    ['shown', 'shown too'],
  );
});
