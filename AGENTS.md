# AGENTS.md

Instructions for anyone — human or AI coding agent — making changes to this
repository. This project hands file-system write access to an AI client over
the network; the bar for what's safe to add is correspondingly higher than a
typical side project.

## Before touching anything

1. `cd mcp-src && npm test` — must pass before *and* after your change.
2. `npx tsc --noEmit` — this project runs in `strict` mode. Don't loosen it
   to make an error disappear; fix the type.
3. If you're not sure whether a change is safe, prefer the smaller, more
   reversible option and say so in the PR/commit description.

## Non-negotiable rules for tool code (`src/tools/`)

These exist because the client calling these tools is an LLM, not a human
typing a command — it can be wrong, it can be prompt-injected by content it
reads, and it will not double-check itself the way a person would.

- **Every path parameter goes through `resolveVaultPath()`.** No new tool
  gets to touch the filesystem with a raw `path.join`/`path.resolve` on
  user-supplied input. This is the one guard that keeps every tool inside
  the vault; skipping it once defeats the point of having it anywhere.
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
   (`readNote.ts`, `moveNote.ts`, etc.).
2. Export a `registerX(server, { config }: ToolContext)` function.
3. Use `ok()` / `fail()` from `tools/types.ts` for the return shape — don't
   hand-roll the `{ content: [...] }` object inline.
4. Register it in `tools/index.ts`.
5. Document it in `README.md` under "MCP Tools" with the same format as the
   others (one-line description + example arguments).
6. If it touches the filesystem, write the traversal test case in
   `__tests__/` alongside the existing ones — copy the pattern from
   `security.test.ts` rather than inventing a new style.

## Tool roadmap — things worth adding later

Ideas that came up while auditing this project, ranked by how safe they are
to hand an agent:

- **`get_backlinks(path)`** — read-only: return every note that links to a
  given note. Genuinely useful for restructuring work, zero risk, easy add.
- **`append_note(path, text)`** — append without needing to read-then-write
  the whole file first. Lower risk than `write_note` since it can't
  accidentally truncate existing content; still needs the same path guard.
- **Rate limiting on mutating endpoints** — not a tool, an infra addition.
  Right now a compromised or malfunctioning client could write/delete in a
  tight loop. Even a naive token-bucket in front of `write_note`/`delete_note`/
  `move_note` would bound the damage.

Deliberately **not** on this list, and shouldn't be added without a real
conversation about why: shell execution, permanent (non-trash) delete,
recursive folder delete/move, arbitrary HTTP fetch from within a tool, or
anything that reads `.env`/secrets back to the client.

## Ops & Troubleshooting Notes

### Incident: vault sync broke post-deploy (resolved)

**Root cause:** `obsidian-mcp` container was writing files as `root`, while `obsidian-headless` runs as `PUID=1000`. Headless couldn't `mkdir`/write into root-owned folders (`EACCES`), which cascaded into ~18 files stuck as "possibly unprocessed" and sync getting suspended.

**Fix applied:** `chown -R 1000:1000` on `/vault`, added `user: "1000:1000"` to `obsidian-mcp` in `docker-compose.yml`. A `USER node` directive is now also baked into `mcp-src/Dockerfile` itself, so a future `docker compose build` can't silently reintroduce root-owned files if the compose override ever gets removed.

### LiveSync Config

If you see LiveSync config rule violations in the plugin log (`handleFilenameCaseSensitive`, `usePluginSyncV2`, `customChunkSize`), it's worth aligning these across devices (phone + headless) to avoid future config-mismatch weirdness.

### Backups


Currently, there is no automated backup (relying on manual phone copies). A nightly cron `tar` snapshot on the raspi is the recommended actual fix, not yet set up.
