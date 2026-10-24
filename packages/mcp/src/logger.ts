/**
 * NOTE: this file is kept byte-identical in packages/gcal-sync/src/logger.ts and packages/mcp/src/logger.ts (CI checks it).
 *
 * A small structured logger: one line per event, `json` (default when there is no terminal, which is what
 * `docker logs` and a log shipper want) or `text` (default at a terminal). Level and format come from LOG_LEVEL
 * (debug, info, warn, error, silent) and LOG_FORMAT (json, text).
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';
export type LogFormat = 'json' | 'text';
export type Fields = Record<string, unknown>;

export interface Logger {
  debug(message: string, fields?: Fields): void;
  info(message: string, fields?: Fields): void;
  warn(message: string, fields?: Fields): void;
  error(message: string, fields?: Fields): void;
  /** A warning that is written once per `key` for the life of the process, for a condition that would otherwise repeat every cycle. */
  warnOnce(key: string, message: string, fields?: Fields): void;
  /** The same logger with extra fields on every line (for example `{ scope: 'push' }`). */
  child(bindings: Fields): Logger;
}

export interface LoggerOptions {
  level?: LogLevel;
  format?: LogFormat;
  /** Where lines go. The default is stdout, and stderr for warnings and errors. */
  write?: (line: string, level: Exclude<LogLevel, 'silent'>) => void;
  bindings?: Fields;
}

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

function levelFrom(value: string | undefined): LogLevel {
  const v = value?.trim().toLowerCase();
  return v && v in ORDER ? (v as LogLevel) : 'info';
}

/**
 * Secrets never reach a log. The MCP server accepts its token in the URL (`?token=…`) because some clients cannot
 * send a header, so a URL or an error message can carry one; fields named like a secret are masked outright, at any
 * depth, and so are secret-named keys inside JSON text (an error that quotes a response body).
 */
const SECRET_NAME = String.raw`[\w-]*(?:token|secret|password|passwd)|api[-_]?key|apikey|key|authorization`;
const URL_SECRET = new RegExp(String.raw`([?&](?:${SECRET_NAME})=)[^&\s"'\\]+`, 'gi');
const JSON_SECRET = new RegExp(String.raw`(\\?"(?:${SECRET_NAME})\\?"\s*:\s*\\?")(?:[^"\\]|\\[^"])*`, 'gi');
const BEARER = /(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi;
const SECRET_FIELD = /token|secret|password|passwd|authorization|api[-_]?key|cookie/i;

export function redact(text: string): string {
  return text.replace(URL_SECRET, '$1[redacted]').replace(JSON_SECRET, '$1[redacted]').replace(BEARER, '$1[redacted]');
}

/**
 * Errors become `{ name, message, code }`; plain objects and arrays are walked so a secret-named field is masked at
 * any depth, and a reference back up the structure becomes "[circular]" instead of making the logger throw.
 * Everything else (dates, numbers, strings) is left to JSON.
 */
function plain(value: unknown, parents: object[] = []): unknown {
  if (value instanceof Error) {
    const { code } = value as Error & { code?: unknown };
    return { name: value.name, message: value.message, ...(code !== undefined ? { code } : {}) };
  }
  if (typeof value !== 'object' || value === null) return value;
  if (parents.includes(value)) return '[circular]';
  const inside = [...parents, value];
  if (Array.isArray(value)) return value.map((item: unknown) => plain(item, inside));
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;
  return cleanFields(value as Fields, inside);
}

function cleanFields(fields: Fields, parents: object[] = []): Fields {
  const cleaned: Fields = {};
  for (const [key, value] of Object.entries(fields))
    cleaned[key] = SECRET_FIELD.test(key) ? '[redacted]' : plain(value, parents);
  return cleaned;
}

function formatLine(format: LogFormat, level: string, message: string, fields: Fields): string {
  const time = new Date().toISOString();
  const cleaned = cleanFields(fields);

  if (format === 'json') return redact(JSON.stringify({ time, level, msg: message, ...cleaned }));

  const { scope, ...rest } = cleaned;
  const extras = Object.entries(rest)
    .map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`)
    .join(' ');
  return redact(
    `${time} ${level.toUpperCase().padEnd(5)} ${scope ? `[${String(scope)}] ` : ''}${message}${extras ? ` ${extras}` : ''}`,
  );
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? 'info';
  const format = options.format ?? 'json';
  const write =
    options.write ??
    ((line: string, lineLevel: Exclude<LogLevel, 'silent'>) => {
      (lineLevel === 'warn' || lineLevel === 'error' ? process.stderr : process.stdout).write(`${line}\n`);
    });
  const bindings = options.bindings ?? {};
  const seen = new Set<string>();

  const emit = (lineLevel: Exclude<LogLevel, 'silent'>, message: string, fields?: Fields) => {
    if (ORDER[lineLevel] < ORDER[level]) return;
    write(formatLine(format, lineLevel, message, { ...bindings, ...fields }), lineLevel);
  };

  return {
    debug: (message, fields) => emit('debug', message, fields),
    info: (message, fields) => emit('info', message, fields),
    warn: (message, fields) => emit('warn', message, fields),
    error: (message, fields) => emit('error', message, fields),
    warnOnce(key, message, fields) {
      if (seen.has(key)) return;
      seen.add(key);
      emit('warn', message, fields);
    },
    child: (extra) => createLogger({ ...options, level, format, write, bindings: { ...bindings, ...extra } }),
  };
}

/** The process-wide logger, configured from the environment. */
export function loggerFromEnv(env: NodeJS.ProcessEnv = process.env): Logger {
  const format: LogFormat =
    env.LOG_FORMAT === 'text' || env.LOG_FORMAT === 'json' ? env.LOG_FORMAT : process.stdout.isTTY ? 'text' : 'json';
  return createLogger({ level: levelFrom(env.LOG_LEVEL), format });
}

export const logger: Logger = loggerFromEnv();
