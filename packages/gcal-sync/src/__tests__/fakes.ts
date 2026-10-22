// Shared helpers for the sync tests: a throw-away vault and in-memory stand-ins for the two Google clients.
// Only the calls the sync makes are implemented; every handler can be replaced per test.
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type { calendar_v3, tasks_v1 } from 'googleapis';
import type { Config } from '../config.js';
import { createLogger } from '../logger.js';
import { createContext, type SyncContext } from '../sync/context.js';
import { ingestGoogleData } from '../sync/ingest.js';
import { pushVaultData } from '../sync/push/index.js';
import { emptyState as freshState, type SyncState } from '../sync/state.js';
import { parseNote, serializeNote } from '../markdown/frontmatter.js';
import type { RawFrontmatter } from '../markdown/notes.js';

// ── vault ───────────────────────────────────────────────────────────────────

const vaults: string[] = [];

/** Register with `after(removeVaults)` in each test file. */
export async function removeVaults(): Promise<void> {
  await Promise.all(vaults.splice(0).map((v) => fs.rm(v, { recursive: true, force: true })));
}

export async function makeVault(overrides: Partial<Config> = {}): Promise<Config> {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), 'gcal-sync-'));
  vaults.push(vault);
  return {
    vaultPath: vault,
    vaultResolved: vault,
    clientId: 'x',
    clientSecret: 'x',
    refreshToken: 'x',
    calendarIds: ['primary'],
    tasklistIds: ['@default'],
    pollIntervalMinutes: 5,
    allowMassDelete: false,
    cancelledRetentionDays: 30,
    ...overrides,
  };
}

export const emptyState = freshState;

export async function writeNote(config: Config, rel: string, frontmatter: RawFrontmatter, body = ''): Promise<void> {
  const full = path.join(config.vaultResolved, rel);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, serializeNote(frontmatter, body), 'utf-8');
}

export async function readNote(config: Config, rel: string) {
  return parseNote(await fs.readFile(path.join(config.vaultResolved, rel), 'utf-8'));
}

export async function exists(config: Config, rel: string): Promise<boolean> {
  return fs.access(path.join(config.vaultResolved, rel)).then(() => true, () => false);
}

/** Every .md file under `rel` (vault-relative, forward slashes), sorted. */
export async function listNotes(config: Config, rel = ''): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string) {
    for (const entry of await fs.readdir(path.join(config.vaultResolved, dir), { withFileTypes: true }).catch(() => [])) {
      const next = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(next);
      else if (entry.name.endsWith('.md')) out.push(next);
    }
  }
  await walk(rel);
  return out.sort();
}

// ── sync context ────────────────────────────────────────────────────────────

/** A log line the test run captured. */
export interface Captured { level: string; line: string }

/** A context over fake clients. Its logger is silent unless `lines` is given to collect what is logged. */
export function syncContext(
  config: Config,
  state: SyncState,
  calendar: calendar_v3.Calendar,
  tasks: tasks_v1.Tasks,
  options: { lines?: Captured[]; now?: () => Date } = {},
): SyncContext {
  const { lines } = options;
  const log = createLogger({ level: lines ? 'debug' : 'silent', format: 'text', write: (line, level) => lines?.push({ level, line }) });
  return createContext({ config, state, calendar, tasks, log, now: options.now });
}

/** One ingest pass; returns the context so a test can look at `report`. */
export async function ingest(config: Config, state: SyncState, calendar: calendar_v3.Calendar, tasks: tasks_v1.Tasks): Promise<SyncContext> {
  const ctx = syncContext(config, state, calendar, tasks);
  await ingestGoogleData(ctx);
  return ctx;
}

/** One push pass; returns the context so a test can look at `report`. */
export async function push(config: Config, state: SyncState, calendar: calendar_v3.Calendar, tasks: tasks_v1.Tasks): Promise<SyncContext> {
  const ctx = syncContext(config, state, calendar, tasks);
  await pushVaultData(ctx);
  return ctx;
}

// ── dates ───────────────────────────────────────────────────────────────────

/** A calendar date `days` from today, as YYYY-MM-DD (UTC). The sync archives by comparing with "now", so tests state dates relative to it. */
export function dateFromNow(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

export const today = () => dateFromNow(0);

// ── Google fakes ────────────────────────────────────────────────────────────

/** A request body, as loosely as the tests need to read it. */
export type Body = Record<string, unknown>;

/** The part of a Google request that the fakes and the tests look at. */
export interface Call {
  tasklist?: string;
  task?: string;
  calendarId?: string;
  eventId?: string;
  syncToken?: string;
  pageToken?: string;
  timeMin?: string;
  updatedMin?: string;
  showDeleted?: boolean;
  requestBody?: Body;
}

/** An insert or a patch: always has a body. */
export interface Written extends Call {
  requestBody: Body;
}

type Method = 'list' | 'get' | 'insert' | 'patch' | 'delete';
type ParamsOf<M extends Method> = M extends 'insert' | 'patch' ? Written : Call;
type Handlers<M extends Method> = { [K in M]?: (params: ParamsOf<K>) => unknown };
type Calls<M extends Method> = { [K in M]: ParamsOf<K>[] };

function recorder<M extends Method>(names: readonly M[], handlers: Handlers<M>, defaults: Required<Handlers<M>>) {
  const calls = Object.fromEntries(names.map((n) => [n, []])) as unknown as Calls<M>;
  const fns = Object.fromEntries(
    names.map((n) => [
      n,
      async (params: ParamsOf<M>) => {
        (calls[n] as ParamsOf<M>[]).push(params);
        return ((handlers[n] ?? defaults[n]) as (p: ParamsOf<M>) => unknown)(params);
      },
    ]),
  ) as Record<M, (params: ParamsOf<M>) => Promise<unknown>>;
  return { calls, fns };
}

let idCounter = 0;
const nextId = (prefix: string) => `${prefix}${String(++idCounter).padStart(8, '0')}`;

export function fakeCalendar(handlers: Handlers<'list' | 'insert' | 'patch' | 'delete'> = {}) {
  const { calls, fns } = recorder(['list', 'insert', 'patch', 'delete'] as const, handlers, {
    list: () => ({ data: { items: [], nextSyncToken: 'sync-1' } }),
    insert: () => ({ data: { id: nextId('evt'), updated: new Date().toISOString() } }),
    patch: () => ({ data: { updated: new Date().toISOString() } }),
    delete: () => ({ data: {} }),
  });
  return { client: { events: fns } as unknown as calendar_v3.Calendar, calls };
}

export interface TaskListSpec { id: string; title: string }

export function fakeTasks(
  opts: { lists?: TaskListSpec[]; defaultId?: string; listApi?: Handlers<'list' | 'get' | 'insert'> } = {},
  handlers: Handlers<'list' | 'insert' | 'patch' | 'delete'> = {},
) {
  const lists = opts.lists ?? [{ id: 'L1', title: 'My Tasks' }];
  const defaultId = opts.defaultId ?? lists[0]?.id;
  const listApi = recorder(['list', 'get', 'insert'] as const, {
    insert: (p) => {
      const created = { id: nextId('list'), title: String(p.requestBody?.title) };
      lists.push(created);
      return { data: created };
    },
    ...opts.listApi,
  }, {
    list: () => ({ data: { items: lists } }),
    get: () => ({ data: { id: defaultId } }),
    insert: () => ({ data: {} }),
  });
  const taskApi = recorder(['list', 'insert', 'patch', 'delete'] as const, handlers, {
    list: () => ({ data: { items: [] } }),
    insert: () => ({ data: { id: nextId('task'), updated: new Date().toISOString() } }),
    patch: () => ({ data: { updated: new Date().toISOString() } }),
    delete: () => ({ data: {} }),
  });
  return {
    client: { tasklists: listApi.fns, tasks: taskApi.fns } as unknown as tasks_v1.Tasks,
    calls: { lists: listApi.calls, tasks: taskApi.calls },
    lists,
  };
}

/** A Google API error as the client library throws it. */
export function apiError(code: number, message = `HTTP ${code}`): Error {
  return Object.assign(new Error(message), { code, status: code });
}
