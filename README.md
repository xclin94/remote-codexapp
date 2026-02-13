# Codex Remote Web Chat

Self-hosted browser UI for OpenAI Codex (via MCP), with OTP/TOTP auth, resumable chat sessions, interactive browser terminal, and one-command deployment. Search tags: `codex`, `remote`, `web chat`, `terminal`, `otp`, `totp`, `nginx`, `systemd`, `nodejs`.

This project is a small Node.js + React frontend/backend app that exposes Codex as a web service. It is designed for remote access from another machine (internet or LAN) and includes path-based proxy support under `/codex`.

## Features

- Web chat UI for Codex sessions
- Streaming assistant responses with auto-reconnect
- OTP login (console OTP) and optional TOTP login
- Persistent sessions/chats via `DATA_DIR` (default: `data`)
- `/status` command support with usage/rate-limit status
- `/web help` in chat for web-only commands
- Interactive terminal (WebSocket + PTY) with session-scoped terminal tabs
- Terminal management APIs (`POST /api/terminal`, `GET /api/terminals`, `GET /ws/terminal`)
- Remote deployment script with Nginx + systemd bootstrap
- Interactive prompt mode for deployment domain
- Existing `/codex` route replacement on target machine

## Architecture

- `server/` API: Node.js/Express service, wraps local `codex mcp-server`
- `web/` Frontend: Vite + React, deployed from `web/dist`
- Persistence: `server/.env` config + `DATA_DIR` JSON files
- Optional reverse proxy path: default `NGINX_PATH=/codex`

## Quick Start (Local)

1. Install dependencies

```bash
npm install
```

2. Configure environment

```bash
cd server
cp .env.example .env
# edit server/.env
# IMPORTANT: codex runtime needs OPENAI credentials in env, typically OPENAI_API_KEY
```

3. Start

```bash
cd ..
npm run start
```

4. Open service

- Local: `http://127.0.0.1:18888`
- LAN/WAN: set `HOST=0.0.0.0` in `server/.env`, then open `http://<server-ip>:18888`

If you can’t access from another machine, open inbound TCP `18888` in firewall/security group.

## Auth

### OTP

- On login page click `Request OTP`
- Read 6-digit code from server log
- Enter code and verify

### TOTP (recommended for persistent remote devices)

1. Configure:

```bash
cd server
node -e "const { authenticator } = require('otplib'); console.log(authenticator.generateSecret());"
```

2. Set env:

- `AUTH_MODE=totp`
- `TOTP_SECRET=<your secret>`
- `PRINT_TOTP_QR=true`

3. Restart and scan QR (if exposed via login UI)

Optional:

- `EXPOSE_TOTP_URI=true` enables QR modal in web login
- `EXPOSE_TOTP_URI=false` keeps QR hidden (recommended for internet exposure)

## CLI-like Web Commands

- `/web help`
- `/web status`
- `/resume`
- `/status` is handled server-side and shows live status for running sessions

### Credential login

- Create credential tokens via API (`POST /api/auth/credential`) after normal login.
- Use credential token to create a fresh session (`POST /api/auth/credential/login`) without OTP/TOTP.
- List and revoke credentials via `GET /api/auth/credentials` and `POST /api/auth/credential/revoke`.
- Store credentials securely; the token is shown once when created and cannot be read again later.

## Terminal Support

- Create terminal: `POST /api/terminal`
- List terminal sessions: `GET /api/terminals`
- Connect terminal websocket:
  - direct: `GET /ws/terminal?terminalId=<id>`
  - under `/codex`: `GET /codex/ws/terminal?terminalId=<id>`
- Terminal and chat are peer sessions in the sidebar; switching tabs swaps the main content area
- If deployed under `/codex`, compatibility APIs are also available:
  - `POST /codex/api/terminal`
  - `GET /codex/api/terminals`

### Nginx requirement for terminal websocket

When reverse-proxying `/codex`, websocket upgrade headers are required in the `/codex/` location:

```nginx
proxy_set_header Upgrade $http_upgrade;
proxy_set_header Connection $connection_upgrade;
```

## Deployment (One-command, target machine)

Use on a fresh host:

```bash
git clone git@github.com:JasonShui716/remote-codexapp.git /opt/remote-codexapp
cd /opt/remote-codexapp
chmod +x scripts/deploy-remote.sh

# Option A: interactive domain input
sudo APP_DIR=/opt/remote-codexapp \
  NGINX_PATH=/codex \
  APP_PORT=18888 \
  bash scripts/deploy-remote.sh

# Option B: explicit domain (non-interactive)
sudo APP_DIR=/opt/remote-codexapp \
  DOMAIN=your.domain.com \
  NGINX_PATH=/codex \
  APP_PORT=18888 \
  bash scripts/deploy-remote.sh
```

For first deploy, leave `DOMAIN` empty in interactive mode and input your host when prompted.

### One-click wrapper (recommended)

You can also use the wrapper script (it runs `deploy-remote.sh` with sane defaults):

```bash
# interactive domain prompt
bash scripts/deploy-one-click.sh

# or pass domain directly
bash scripts/deploy-one-click.sh your.domain.com
```

Common overrides:

```bash
APP_DIR=/opt/remote-codexapp \
APP_PORT=18888 \
NGINX_PATH=/codex \
GIT_BRANCH=main \
bash scripts/deploy-one-click.sh your.domain.com
```

### What deploy script does

- Pulls or clones repo
- `npm install` and `npm run build`
- Writes/patches `server/.env` (`HOST/PORT/CODEX_CWD`)
- Installs/updates systemd unit `/etc/systemd/system/codex-remoteapp.service`
- Generates/reloads Nginx config for reverse proxy path
- Includes websocket upgrade forwarding for terminal (`/codex/ws/terminal`)
- Auto-replaces existing bindings on `/codex` (backed up as `.bak.<timestamp>`)

Skip nginx config (code-only update):

```bash
sudo SKIP_NGINX=1 bash scripts/deploy-remote.sh
```

## Run in background

```bash
npm run restart
```

Defaults:

- log: `/tmp/codex_remoteapp.log`
- pid: `.codex_remoteapp.pid`
- port: `PORT` from `server/.env` (fallback `18888`)

Optional override:

```bash
CODEREMOTEAPP_LOG=/path/to/log npm run restart
```

## API Quick Reference

- `GET /api/me`
- `POST /api/chats` (create chat)
- `GET /api/chats`
- `GET /api/chats/:id`
- `POST /api/chats/:id/send`
- `GET /api/chats/:id/stream`
- `POST /api/chats/:id/abort`
- `POST /api/terminal`
- `GET /api/terminals`
- `POST /api/auth/otp/request`
- `POST /api/auth/otp/verify`
- `POST /api/auth/totp/verify`
- `POST /api/auth/credential/login`
- `POST /api/auth/credential`
- `GET /api/auth/credentials`
- `POST /api/auth/credential/revoke`

And compatibility `Nginx path` endpoints are also available:

- `POST /codex/api/terminal`
- `GET /codex/api/terminals`

## Notes

- Requires local `codex` binary available in PATH (`codex --version`)
- Approval policy examples: `never`, `on-request`, etc. (configured by env)
- Chats and terminal sessions are session-scoped; terminal history is kept in memory by session map
