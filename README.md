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
- 🔍 **Search** notes by keyword

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

The server exposes three tools to AI agents:

### `read_note`
Reads the content of a Markdown note from the vault.
```
path: "Folder/My Note.md"
```

### `write_note`
Creates or overwrites a Markdown note in the vault (creates missing directories automatically).
```
path: "Folder/New Note.md"
content: "# Hello\n\nThis note was written by an AI agent."
```

### `search_notes`
Recursively searches all `.md` files for a keyword (case-insensitive, matches filename and content).
```
query: "project ideas"
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
| Authentication | Bearer token (`?token=` or `Authorization: Bearer`) |
| Path traversal | `path.resolve()` + `startsWith()` on every file operation |
| Obsidian GUI | No host port exposed post-setup |
| OAuth confusion | Nginx returns plain 404 on `/.well-known/oauth-*` |
| SSE buffering | `gzip off` + `proxy_buffering off` on `/mcp/` block |

---

## License

MIT — use freely, self-host happily.
