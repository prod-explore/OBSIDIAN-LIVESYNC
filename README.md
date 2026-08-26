# obsidian-livesync-mcp

> **Self-hosted Obsidian knowledge base with a private MCP Server** — expose your personal notes to any AI agent over a secure, authenticated endpoint.

[![Node.js](https://img.shields.io/badge/Node.js-20-green?logo=node.js)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue?logo=typescript)](https://www.typescriptlang.org)
[![Docker](https://img.shields.io/badge/Docker-Compose-blue?logo=docker)](https://www.docker.com)
[![MCP](https://img.shields.io/badge/MCP-Streamable%20HTTP%20%2B%20SSE-purple)](https://modelcontextprotocol.io)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow)](LICENSE)

---

## What is this?

This project turns an **Obsidian vault** (backed by CouchDB for real-time sync via the [Self-Hosted LiveSync](https://github.com/vrtmrz/obsidian-livesync) plugin) into a private **MCP (Model Context Protocol) Server** that any AI agent can securely query.

Once deployed, AI tools like **Claude Desktop**, **Cursor**, **Google Antigravity IDE**, or any MCP-compatible client can:

- 📖 **Read** notes from your vault
- ✍️ **Write** new notes or update existing ones
- ✏️ **Edit** notes by replacing a specific range of lines — no need to rewrite the whole file
- 🔍 **Search** notes by keyword
- 📁 **List** a folder's immediate contents
- 🔀 **Move / rename** notes (atomic, refuses to silently overwrite)
- 🗑️ **Delete** notes — soft delete only, moved to `.trash/` rather than unlinked

All traffic goes through an authenticated HTTPS endpoint — your notes never touch any third-party cloud.

---

## Architecture

```
┌──────────────────────────────────────────┐
│           AI Clients (local PC)          │
│  Claude Desktop  │  Antigravity IDE      │
│  Cursor / Cline  │  Claude Web           │
└────────┬─────────┴──────────┬────────────┘
         │  GET /mcp/sse      │  POST /mcp/sse
         │  (Legacy SSE)      │  (Streamable HTTP)
         ▼                    ▼
┌─────────────────────────────────────────────┐
│         Nginx Reverse Proxy (HTTPS)         │
│         obsidian.yourdomain.com             │
│  /mcp/* → obsidian-mcp:3000                 │
│  /*     → obsidian-couchdb:5984             │
└────────────────┬────────────────────────────┘
                 │  Docker internal network
    ┌────────────┼────────────────┐
    ▼            ▼                ▼
 CouchDB    Obsidian          MCP Server
 (data)     Headless          (Node.js)
            (LiveSync)        reads/writes
            writes .md ──────► /vault
```

**Key design decisions:**
- **Dual-protocol MCP**: Supports both the new `StreamableHTTP` transport (Antigravity, Cursor) and the legacy `SSE` transport (Claude Desktop) on the same endpoint — `POST /mcp/sse` vs `GET /mcp/sse`
- **Stateless Streamable HTTP**: No session management overhead for modern clients
- **Per-connection MCP instances**: Each SSE session gets its own isolated `McpServer` instance to prevent SDK cross-connection errors
- **Fail-secure auth**: Token validated via `?token=` query param or `Authorization: Bearer` header; `/.well-known/oauth-*` returns clean 404 to prevent misbehaviour with OAuth-aware clients
- **Path traversal protection**: All vault file access uses `path.resolve()` + `startsWith()` checks

---

## Stack

| Component | Technology |
|---|---|
| Notes database | [CouchDB](https://couchdb.apache.org/) |
| Real-time sync | [Obsidian LiveSync plugin](https://github.com/vrtmrz/obsidian-livesync) |
| MCP Server | Node.js 20, TypeScript, Express.js |
| MCP SDK | [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk) |
| Containerization | Docker + Docker Compose |
| Reverse Proxy | Nginx + Let's Encrypt (Certbot) |

---

## Prerequisites

- A server or SBC (e.g. Raspberry Pi 4+) running Linux with Docker & Docker Compose installed
- A domain name pointed to your server's public IP
- SSL certificate (managed by Certbot, already configured in the Nginx setup)
- Obsidian app on at least one device with the **Self-Hosted LiveSync** plugin

---

## Quick Start

### 1. Clone

```bash
git clone https://github.com/yourusername/obsidian-livesync-mcp.git
cd obsidian-livesync-mcp
```

### 2. Configure environment

```bash
cp .env.example .env
nano .env
```

Fill in all three secrets:

```env
# Secret token for MCP Server authentication
MCP_API_KEY=your_super_secret_random_string

# Credentials for CouchDB
COUCHDB_USER=admin
COUCHDB_PASSWORD=your_super_secret_couchdb_password

# Credentials for the Obsidian GUI (VNC – only needed for initial setup)
VNC_USER=admin
VNC_PASSWORD=your_super_secret_vnc_password
```

> **Tip:** Generate a strong `MCP_API_KEY` with `openssl rand -base64 32`

### 3. Create Docker network & start

```bash
docker network create obsidian
docker compose up -d
```

### 4. Configure Nginx

Copy `REVERSE-PROXY/conf.d/obsidian.conf` to your Nginx `conf.d/` directory, replacing `obsidian.yourdomain.com` with your actual domain. Reload Nginx after issuing a Let's Encrypt certificate.

### 5. Initial Obsidian vault setup

On first run, the Obsidian Headless container starts a KasmVNC GUI accessible at `http://localhost:3000` (only from the server itself via SSH tunnel or Raspberry Pi Connect):

```bash
# On your local machine:
ssh -L 3000:localhost:3000 user@your-server
# Then open http://localhost:3000 in your browser
```

Inside the Obsidian GUI:
1. Create a new vault at `/vault`
2. Install the **Self-Hosted LiveSync** plugin
3. Configure it to connect to `http://obsidian-couchdb:5984` with your CouchDB credentials
4. Click **Fetch** to pull your existing notes from the database

After setup, the GUI is no longer needed. Remove the port mapping from `docker-compose.yml` and restart.

---

## MCP Tools

The server exposes the following tools to AI agents:

### `get_path`
Reads a note **or** lists a folder — auto-detected from the path. One tool instead of two keeps the schema smaller.
```
path: "Folder/My Note.md"   # reads the note
path: "Folder"              # lists the folder's immediate children
path: ""                    # lists the vault root
```

### `get_vault_tree`
Returns a full recursive snapshot of every path in the vault (directory and file names only — no content). Skips `.trash/` and all dotfiles/dotdirs.

**Recommended calling convention for agents:** call on first vault contact per session, and again after > 5 minutes of inactivity. This prevents operating on stale paths when files have been moved or renamed outside the current session (e.g. via Obsidian on a phone).
```
(no arguments)
```

### `write_note`
Creates or overwrites a Markdown note in the vault (creates missing directories automatically).
```
path: "Folder/New Note.md"
content: "# Hello\n\nThis note was written by an AI agent."
```

### `edit_note`
Replaces a range of lines in an existing note without touching the rest of the file. Read the note first to determine line numbers. Setting `end_line` to `start_line - 1` inserts `new_content` without removing any lines; passing an empty `new_content` deletes the specified lines.
```
path:        "Folder/My Note.md"
start_line:  5         # first line to replace (1-indexed)
end_line:    7         # last line to replace (inclusive)
new_content: "Updated paragraph text."
```

### `search_notes`
Recursively searches all `.md` files for a keyword (case-insensitive, matches filename and content).
```
query: "project ideas"
```

### `move_note`
Moves or renames a note. Atomic (`fs.rename`, not copy+delete). Refuses to overwrite an existing file at the destination unless you explicitly opt in.
```
from: "Inbox/draft.md"
to: "02-Areas/Health/draft.md"
overwrite: false   # default
```

### `delete_note`
Soft delete only — moves the note into a `.trash/` folder inside the vault with a timestamp prefix, rather than calling `unlink`. Nothing this tool does is unrecoverable; worst case, go dig the file back out of `.trash/`.
```
path: "Old Notes/stale.md"
```

---

## AI Client Configuration

### Claude Desktop

Edit `%LOCALAPPDATA%\Claude-3p\claude_desktop_config.json` (Windows) or `~/.config/Claude/claude_desktop_config.json` (macOS/Linux):

```json
{
  "mcpServers": {
    "obsidian": {
      "type": "sse",
      "url": "https://obsidian.yourdomain.com/mcp/sse?token=YOUR_MCP_API_KEY"
    }
  }
}
```

### Google Antigravity / Cursor / Cline

Create `.agents/mcp_config.json` in your project root (workspace-scoped), or `~/.gemini/config/mcp_config.json` (global):

```json
{
  "mcpServers": {
    "obsidian": {
      "type": "sse",
      "url": "https://obsidian.yourdomain.com/mcp/sse?token=YOUR_MCP_API_KEY"
    }
  }
}
```

---

## Operations

```bash
# Start everything
docker compose up -d

# Rebuild MCP server after code changes
docker compose up -d --build obsidian-mcp

# Stop GUI + MCP, keep database running
docker stop obsidian-headless obsidian-mcp

# View MCP server logs
docker logs -f obsidian-mcp

# Reload Nginx config
cd REVERSE-PROXY && docker compose restart

# Health check
curl "https://obsidian.yourdomain.com/mcp/health?token=YOUR_MCP_API_KEY"
# → {"status":"ok","vaultPath":"/vault"}
```

---

## Security

| Layer | Mechanism |
|---|---|
| Transport | HTTPS with Let's Encrypt certificate |
| Authentication | Bearer token (`?token=` or `Authorization: Bearer`), compared with `crypto.timingSafeEqual` over SHA-256 hashes (not `===`, which leaks timing information) |
| Path traversal | `path.resolve()` + `startsWith()` on every file operation — unit tested, see `mcp-src/src/__tests__/` |
| Destructive operations | `delete_note` never calls `unlink` — moves to `.trash/` instead. `move_note` refuses to overwrite an existing destination unless told to. |
| SSE session lifecycle | Sessions are swept on a timer if a client disconnects without firing `close` (e.g. a phone sleeping mid-connection), bounding worst-case memory growth on long-running deployments |
| Obsidian GUI | No host port exposed post-setup |
| OAuth confusion | Nginx returns plain 404 on `/.well-known/oauth-*` |
| SSE buffering | `gzip off` + `proxy_buffering off` on `/mcp/` block |

---

## Development

```bash
cd mcp-src
npm install
npm test          # type-checks, builds, runs the unit test suite
npm run dev        # tsc --watch + node --watch for local iteration
```

Source is organized by responsibility rather than as one file:

```
mcp-src/src/
├── config.ts          # env loading/validation
├── security.ts         # path traversal guard + constant-time auth compare
├── server.ts           # express app, transports, auth middleware, SSE session sweep
├── index.ts             # entrypoint — wires config + server, handles graceful shutdown
├── tools/
│   ├── types.ts         # shared result helpers (ok/fail)
│   ├── getPath.ts       # get_path: read note OR list folder (replaces read_note + list_folder)
│   ├── vaultTree.ts     # get_vault_tree: recursive path snapshot
│   ├── writeNote.ts
│   ├── editNote.ts
│   ├── searchNotes.ts
│   ├── moveNote.ts
│   ├── deleteNote.ts
│   └── index.ts         # registers all tools onto a server instance
└── __tests__/
    ├── security.test.ts
    └── getPath.test.ts
```

See [`AGENTS.md`](./AGENTS.md) for conventions to follow when adding or changing tools — especially around what this project will and won't expose to an AI agent.

---

## Calendar & Tasks Sync

This repository includes a standalone background service (`obsidian-gcal-sync`) that continuously bidirectionally synchronizes Google Calendar events and Google Tasks with your Obsidian vault. It is **not** an MCP tool, but it operates directly on the vault's Markdown files, allowing the AI agent (and you) to enrich them with context.

### Features & Limitations (v1)
- **Ingest**: Fully pulls new events/tasks from Google and creates or updates files in `_Calendar/` and `_Tasks/`.
- **Push**: **Only updates frontmatter.** Changes to the event/task `status`, `start`, `end`, and `due` dates are pushed back to Google.
- **Title and Body edits are NEVER pushed back.** This guarantees your local notes and AI context are never accidentally clobbered by Google's API limitations or length constraints.
- **Conflict Resolution**: If a file is modified locally and updated remotely on Google at the same time, Google wins. Your local changes are appended to `_Systems/sync-conflicts.md` so no data is ever silently lost. Deletes on Google only "soft-delete" (status: cancelled) locally.

### Setup Instructions

1. **Obtain Google OAuth Credentials**: Create a Google Cloud project, enable the Calendar API and Tasks API, and create an OAuth Client ID (Desktop app).
2. **Generate a Refresh Token**:
   ```bash
   cd gcal-sync-src
   npm run get-token
   ```
   Follow the console instructions to log in via your browser. The terminal will print a refresh token.
3. **Configure Environment Variables**:
   Copy `.env.example` to `.env` and fill in your details:
   ```env
   GOOGLE_CLIENT_ID=your_client_id
   GOOGLE_CLIENT_SECRET=your_client_secret
   GOOGLE_REFRESH_TOKEN=token_from_step_2
   CALENDAR_IDS=primary
   TASKLIST_IDS=@default
   POLL_INTERVAL_MINUTES=5
   ```
4. **Deploy**:
   ```bash
   docker compose up -d --build
   ```

---

## License

MIT — use freely, self-host happily.
