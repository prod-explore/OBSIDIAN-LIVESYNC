# AGENTS.md

Instructions for anyone — human or AI coding agent — making changes to this
repository. This project hands file-system write access to an AI client over
the network; the bar for what's safe to add is correspondingly higher than a
typical side project.

## Before touching anything

1. `npm test` at the repository root (or `npm test --workspace packages/mcp`, `packages/gcal-sync` or `packages/shared` for one part) —
   it type-checks, builds and runs every test, and must pass before *and*
   after your change. So must `npm run lint` and `npm run format:check`.
2. Both packages run TypeScript in `strict` mode. Don't loosen it to make an
   error disappear; fix the type. No `any` (the linter refuses it; use
   `unknown` and narrow), and no `console.*`: log through `logger.ts`, which
   masks tokens. `logger.ts` is the same file in both packages (CI diffs them).
   In the sync, front matter is read with `readTaskNote` / `readEventNote`, never
   used raw, and a note that cannot be understood is skipped and reported, not thrown on.
3. If you're not sure whether a change is safe, prefer the smaller, more
   reversible option and say so in the PR/commit description.

## Non-negotiable rules for tool code (`src/tools/`)

These exist because the client calling these tools is an LLM, not a human
typing a command — it can be wrong, it can be prompt-injected by content it
reads, and it will not double-check itself the way a person would.

- **Every path parameter goes through `resolveVaultPath()`.** No new tool
  gets to touch the filesystem with a raw `path.join`/`path.resolve` on
  user-supplied input. This is the one guard that keeps every tool inside
  the vault; skipping it once defeats the point of having it anywhere. It
  also refuses hidden paths (`.obsidian/`, `.trash/`); `allowHidden` is only
  for paths from the server's own config, never from a client.
- **No destructive operation without a recovery path.** `delete_note` moves
  to `.trash/` instead of calling `unlink`, on purpose. If you add a tool
  that removes or overwrites something, it needs the same property —
  either soft-delete, or an explicit `overwrite`/`confirm` flag that
  defaults to `false` (see `move_note`). An agent should have to state
  destructive intent, not stumble into it.
- **No shell/process execution tools.** Nothing in this server should ever
  hand an AI client `exec`, `spawn`, or equivalent. A vault full of
  agent-writable Markdown is a plausible prompt-injection vector; giving
  the same agent a way to run arbitrary commands turns a contained mistake
  into an uncontained one.
- **No bulk/recursive destructive operations.** A `delete_folder` or
  `move_folder` that recurses is a footgun at agent scale — one bad call
  can touch hundreds of files before anyone notices. If bulk operations are
  ever needed, they should be scoped, dry-run-able, and probably still
  operate one file at a time under the hood.
- **New tools get a test if they contain real logic.** Pure functions
  (anything like `security.ts`) get unit tests. Tools that are mostly
  "validate path → fs call → format result" don't need exhaustive coverage,
  but the validation/guard part does.

## Adding a new tool — the pattern

1. New file in `src/tools/`, one tool per file, mirroring the existing ones
   (`getPath.ts`, `moveNote.ts`, etc.).
2. Export a `registerX(server, { config }: ToolContext)` function.
3. Use `ok()` / `fail()` from `tools/types.ts` for the return shape — don't
   hand-roll the `{ content: [...] }` object inline.
4. Register it in `tools/index.ts`.
5. Document it in `README.md` under "MCP Tools" with the same format as the
   others (one-line description + example arguments).
6. If it touches the filesystem, write the traversal test case in
   `__tests__/` alongside the existing ones — unit cases in `security.test.ts`,
   tool-level cases through `harness.ts` (see `getPath.test.ts`) rather than
   inventing a new style.

## Tool roadmap — things worth adding later

Ideas that came up while auditing this project, ranked by how safe they are
to hand an agent:

- **`get_backlinks(path)`** — read-only: return every note that links to a
  given note. Genuinely useful for restructuring work, zero risk, easy add.
- **`append_note(path, text)`** — append without needing to read-then-write
  the whole file first. Lower risk than `write_note` since it can't
  accidentally truncate existing content; still needs the same path guard.

Already done: rate limiting of the tools that change the vault (`rateLimit.ts`,
`MCP_WRITE_LIMIT_PER_MINUTE`). A new tool that writes must call `tooManyWrites(ctx)` first.

Deliberately **not** on this list, and shouldn't be added without a real
conversation about why: shell execution, permanent (non-trash) delete,
recursive folder delete/move, arbitrary HTTP fetch from within a tool, or
anything that reads `.env`/secrets back to the client.

## Operations

Deployment, backups and troubleshooting live in [`docs/operations.md`](docs/operations.md).
