# obsidian-livesync

A self-hosted Obsidian vault in one Docker Compose project: CouchDB keeps your devices in sync through the
[Self-hosted LiveSync](https://github.com/vrtmrz/obsidian-livesync) plugin, an MCP server lets AI clients read and edit
the notes over HTTPS, and a sync service keeps Google Calendar and Google Tasks in step with notes in the vault.

[[Q1: Does this run for you day to day (on a Raspberry Pi?), since when, and with how many devices? One factual sentence here, e.g. "Runs my own vault on a Raspberry Pi 5 since …"]]

[[Q2: Why did you build it? One sentence of motivation, e.g. what you wanted that Obsidian Sync or an existing MCP plugin did not give you.]]

```
 Obsidian on phone / laptop            AI client (Claude, …)                Google Calendar & Tasks
  (LiveSync plugin)                         │  HTTPS, bearer token                   ▲
        │ HTTPS                             │                                        │ OAuth, polled
        ▼                                   ▼                                        │
 ┌──────────────────────────── nginx (your reverse proxy, TLS) ─────────────┐        │
 │   /            → obsidian-couchdb:5984     /mcp/ → obsidian-mcp:3000     │        │
 └──────────┬───────────────────────────────────────────┬───────────────────┘        │
            ▼                                           ▼                            │
     ┌─────────────┐   LiveSync   ┌────────────────┐   ┌──────────────┐   ┌──────────┴─────────┐
     │   CouchDB   │◄────────────►│ headless       │   │ obsidian-mcp │   │ obsidian-gcal-sync │
     │  ./data     │              │ Obsidian       │   │  (Node, TS)  │   │    (Node, TS)      │
     └─────────────┘              └───────┬────────┘   └──────┬───────┘   └─────────┬──────────┘
                                          │ reads/writes      │ reads/writes        │ reads/writes
                                          ▼                   ▼                     ▼
                                  ./vault/vault-mcp: the vault as plain Markdown files
```

## What an AI client sees

Real output from the local try-out below, against a two-note demo vault:

```text
$ mcp get_vault_tree '{}'
(vault root)
├── Projects/
│   └── Plan.md
└── Welcome.md

$ mcp move_note '{"from":"Projects/Plan.md","to":"Projects/Roadmap.md"}'
Moved Projects/Plan.md → Projects/Roadmap.md. Updated 1 backlink(s).

$ mcp get_path '{"path":"Welcome.md"}'
# Welcome

See [[Roadmap]].

$ mcp get_path '{"path":"../../etc/passwd"}'
Error accessing path: Security Error: Path traversal attempt detected ("../../etc/passwd").

$ mcp get_path '{"path":".obsidian/plugins/obsidian-livesync/data.json"}'
Error accessing path: Security Error: hidden files and folders are not reachable through this server (".obsidian/plugins/obsidian-livesync/data.json").

$ mcp delete_note '{"path":"Welcome.md"}'
Moved to trash: Welcome.md → .trash/2026-10-25T20-44-42-312Z__Welcome.md
```

[[Q3: Do you want a screenshot or short recording here (for example an AI client answering from the vault, or a task note next to the same task in Google Tasks)? There is no image in the repository yet; it must not show private notes or a client's data.]]

## Try the MCP server locally

No Docker and no Google account needed. Requires Node.js 22 or newer, `curl` and `jq`.

```bash
npm ci
npm run build --workspace packages/mcp

mkdir -p demo-vault/Projects
printf '# Welcome\n\nSee [[Plan]].\n' > demo-vault/Welcome.md
printf '# Plan\n\n- ship it\n' > demo-vault/Projects/Plan.md

MCP_API_KEY=demo-key VAULT_PATH=./demo-vault node packages/mcp/dist/index.js
```

In a second terminal, from the same directory:

```bash
curl -s -H 'Authorization: Bearer demo-key' localhost:3000/mcp/health

# Call a tool over MCP's streamable HTTP transport and print the text it returns.
mcp() {
  curl -s localhost:3000/mcp/sse \
    -H 'Authorization: Bearer demo-key' -H 'Content-Type: application/json' \
    -H 'Accept: application/json, text/event-stream' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"$1\",\"arguments\":$2}}" |
    sed -n 's/^data: //p' | jq -r '.result.content[0].text'
}

mcp get_vault_tree '{}'
mcp move_note '{"from":"Projects/Plan.md","to":"Projects/Roadmap.md"}'
mcp get_path '{"path":"Welcome.md"}'
```

`demo-vault/` is in `.gitignore`. Stop the server with Ctrl+C.

## Deploy the stack

Requirements: a Linux host with Docker Compose, a domain name, and a reverse proxy with TLS in front of the stack
(an [nginx example](deploy/nginx-obsidian.conf.example) is included). No container publishes a port; the proxy reaches
them over a shared Docker network.

[[Q4: On which hardware have you run the full stack (Raspberry Pi model and RAM, or x86 server)? Headless Obsidian is an Electron app and the heaviest container; a tested minimum belongs here.]]

**1. Configure.**

```bash
docker network create obsidian        # once; the reverse proxy joins this network too
cp .env.example .env
openssl rand -hex 32                  # run once per secret: MCP_API_KEY, COUCHDB_PASSWORD, VNC_PASSWORD
```

Use hex (or URL-safe) for `MCP_API_KEY`: a base64 key can contain `+`, which a client that sends the key as `?token=`
must URL-encode, or the server reads it as a space and answers 403.
Both `obsidian-headless` and `obsidian-gcal-sync` set `TZ=Europe/Warsaw` in `docker-compose.yml`; change it to yours.

**2. Start CouchDB, headless Obsidian and the MCP server.**

```bash
docker compose up -d --build couchdb obsidian-headless obsidian-mcp
```

Compose refuses to start while any required secret in `.env` is empty.

**3. Set up the vault once.** Open the headless Obsidian GUI through an SSH tunnel, create the vault `vault-mcp` in
`/vault`, install Self-hosted LiveSync, point it at `http://obsidian-couchdb:5984` and fetch. The steps are in
[docs/operations.md](docs/operations.md#setting-up-the-vault).

**4. Put the reverse proxy in front.** Copy [`deploy/nginx-obsidian.conf.example`](deploy/nginx-obsidian.conf.example),
replace `obsidian.example.com`, get a certificate. It sends `/mcp/` to the MCP server and everything else to CouchDB, and
logs MCP requests without their query string. Then point the LiveSync plugin on each device at `https://<your domain>`.

**5. Optional: Google Calendar and Tasks.**

1. In Google Cloud, enable the Google Calendar API and the Google Tasks API and create an OAuth client that allows the
   redirect URI `http://localhost:3000/oauth2callback`. Put its id and secret in `.env` (`GOOGLE_CLIENT_ID`,
   `GOOGLE_CLIENT_SECRET`).
2. On a machine with a browser, with the repository's dependencies installed (`npm ci`) and nothing else on port 3000:

   ```bash
   npm run get-token --workspace packages/gcal-sync
   ```

   Open the printed link, consent, and copy the printed `GOOGLE_REFRESH_TOKEN=…` into `.env`.
3. Set `CALENDAR_IDS` (default `primary`), then:

   ```bash
   docker compose up -d --build obsidian-gcal-sync
   ```

How notes map to events and tasks: [docs/google-sync.md](docs/google-sync.md). Backups, health checks, logs and
recovery: [docs/operations.md](docs/operations.md).

## Connect an MCP client

| | |
|---|---|
| URL | `https://<your domain>/mcp/sse` |
| Transport | Streamable HTTP (`POST`), stateless; legacy SSE (`GET`, messages to `/mcp/messages`) for older clients |
| Auth | `Authorization: Bearer <MCP_API_KEY>`, or `?token=<MCP_API_KEY>` for clients that only take a URL |

Prefer the header: a token in a URL can end up in a proxy's error log
([details](docs/operations.md#mcp-server)). On connect, every client is told to read `_Systems/AGENTS.md` in the vault if
it exists; the file is yours to write, and `MCP_INSTRUCTIONS` replaces or (`none`) removes the hint.

[[Q5: Which MCP clients have you connected (Claude.ai custom connector, Claude Desktop, Claude Code, others)? A "tested with" line here, and a config snippet for the one you use most.]]

## MCP tools

| Tool | What it does | Example arguments |
|---|---|---|
| `get_path` | Reads a note, or lists a folder's direct children | `{"path": "Projects/Plan.md"}` |
| `get_vault_tree` | Tree of folder and file names, depth 1 by default, `-1` for all | `{"path": "Projects", "depth": -1}` |
| `search_notes` | Case-insensitive substring search over note names and contents, at most 100 results | `{"query": "invoice"}` |
| `write_note` | Creates a note and its folders; replaces one only with `overwrite: true`, old version to the trash | `{"path": "Inbox/Idea.md", "content": "# Idea"}` |
| `edit_note` | Replaces a range of lines (`end_line = start_line - 1` inserts); old version copied to the trash | `{"path": "Inbox/Idea.md", "start_line": 1, "end_line": 1, "new_content": "# Better idea"}` |
| `move_note` | Moves or renames a note and rewrites wikilinks and Markdown links to it | `{"from": "Inbox/Idea.md", "to": "Projects/Idea.md"}` |
| `delete_note` | Moves a note to `.trash/`; nothing is ever unlinked | `{"path": "Inbox/Idea.md"}` |

## How it works

**Everything works on plain files.** The MCP server and the Google sync never talk to CouchDB. They read and write
Markdown in `./vault/vault-mcp`, and a headless Obsidian (the `lscr.io/linuxserver/obsidian` image) running the LiveSync
plugin picks up those files and replicates them to CouchDB and from there to every device. The services stay small and testable against a
temporary folder, and never depend on LiveSync's database format. The cost is a full Electron app on the server: it is
the heaviest container, runs without the default seccomp profile, and needs a one-time manual setup through its GUI.

**Two TypeScript packages, one lockfile.** `packages/mcp` (Express and the MCP SDK) and `packages/gcal-sync`
(googleapis, node-cron) are npm workspaces. Each has its own image, built from the repository root. They share a
structured logger, kept as two identical files so each image stays self-contained; CI fails if they differ.

**The sync treats the vault as user data it must not lose.** Only front matter is synced, never the note body. Edits are
detected by a hash of the synced fields, not by file time, which LiveSync changes on its own. Conflicts are settled by
last write, and the losing version is written to a log in the vault. Deleting a note deletes the item in Google, so
deletions stop when part of the vault could not be read, or when most of a list disappears at once (an unmounted volume
looks exactly like that). The full rules: [docs/google-sync.md](docs/google-sync.md).

[[Q6: Do you want a short comparison with alternatives (Obsidian Sync, the Local REST API plugin with an MCP bridge, other Obsidian MCP servers)? Only if you can confirm each point; otherwise this stays out.]]

### Security model

The MCP server hands file-system write access to a client that can be wrong or prompt-injected by the notes it reads.
The design limits what such a client can do; it does not judge intent.

- **One key, required.** The server does not start without `MCP_API_KEY`. Tokens are compared in constant time
  (SHA-256 of both sides, then `timingSafeEqual`). A rejected request is logged with method, status and path, never the
  token.
- **Inside the vault, outside hidden folders.** Every client path goes through `resolveVaultPath()`: `..`, absolute
  paths and symbolic links that lead out of the vault (or dangle) are refused, and so is any path through a hidden folder.
  `.obsidian/` holds the LiveSync plugin's CouchDB password and plugin code that headless Obsidian would run.
- **Nothing is destroyed.** Delete, overwrite and edit keep the previous version in `.trash/`. Tools act on one note at a
  time and refuse folders. There is no shell, no recursive operation and no permanent delete.
- **Bounded.** At most 120 changes a minute for the whole server (`MCP_WRITE_LIMIT_PER_MINUTE`); request bodies up to
  5 MB (`MCP_BODY_LIMIT`).
- **Logs without secrets.** Both services mask `?token=`, bearer tokens, OAuth parameters and secret-named fields at any
  depth.
- **Containers.** The two Node services run as uid 1000 with a read-only root file system, all capabilities dropped and
  `no-new-privileges`. No service publishes a port.

Reporting a vulnerability and what is in scope: [SECURITY.md](SECURITY.md).

## Known limits

- **One key, full access.** Every client gets read and write access to the whole vault; there are no per-client keys,
  no read-only mode, and the write limit is shared by all clients.
- **Search is a scan.** `search_notes` reads every note on each call (no index) and matches substrings only.
- **Polling, not push.** Google changes reach the vault after at most one poll interval (1 to 59 minutes, default 5).
- **Fixed layout.** The sync's folders (`{Tasks}`, `{Calendar}`, `04-Archive`, `_Systems`) cannot be renamed.
- **Moving a task between lists** deletes it in the old list and re-creates it in the new one, with a new Google id.
- **Headless Obsidian is not pinned** (`latest`), and needs its GUI once per new vault.
- **No built-in backup.** What to back up is listed in [docs/operations.md](docs/operations.md#what-lives-where).

## Development

```bash
npm ci
npm test               # per package: type-check, build, run the node:test suites
npm run lint           # ESLint with type-aware rules: no any, no floating promises, no console
npm run format:check   # Prettier
npm run typecheck
npm run test:coverage  # fails under the coverage floors in packages/*/.c8rc.json
```

Tests run against real temporary vaults; the Google APIs are replaced by in-memory fakes
(`packages/gcal-sync/src/__tests__/fakes.ts`). The MCP tests include a real HTTP server for authentication, transports
and body limits.

CI (`.github/workflows/ci.yml`) runs lint, format, types, both test suites with coverage (the report is in each run's
summary), `npm audit` for runtime dependencies, both Docker builds, a check that `docker-compose.yml` rejects empty
secrets, and a gitleaks secret scan. CodeQL runs on every push and weekly. Dependabot proposes npm, base image,
Compose and Actions updates.

Rules for changing the MCP tools (path guard, recovery path, no shell) are in [AGENTS.md](AGENTS.md). Changes are
listed in [CHANGELOG.md](CHANGELOG.md).

## License

[MIT](LICENSE)
