# Codex Remote Web Chat (OTP)

Minimal web chat UI that talks to a small Node server which runs the local `codex` CLI (via MCP) and streams events back to the browser. Auth is a simple OTP printed to the server console.

## Run

1. Configure the server env:

```bash
cd server
cp .env.example .env
# edit server/.env (sandbox/approval policy/cwd)
# IMPORTANT: `codex` itself needs OpenAI credentials (typically OPENAI_API_KEY) in the environment.
```

2. Build + start:

```bash
cd ..
npm install
npm run start
```

3. Open the URL printed by the server.
   - Local: `http://127.0.0.1:18888`
   - LAN/WAN: set `HOST=0.0.0.0` in `server/.env`, then open `http://<server-ip>:18888`
   - If you still can't reach it from another machine, your cloud firewall / security group likely blocks `18888` (open inbound TCP `18888`).

4. Login:
- Click **Request OTP**
- Check the server console log for the OTP
- Enter the 6-digit code and **Verify**

### Restart (background)

Use this command to restart the app and keep it running after you close terminal windows:

```bash
npm run restart
```

Defaults:
- log: `/tmp/codex_remoteapp.log`
- pid: `.codex_remoteapp.pid`
- port: `PORT` from `server/.env` (fallback `18888`)

Optional overrides:

```bash
CODEREMOTEAPP_LOG=/path/to/log npm run restart
```

## Notes

- This uses the installed `codex` CLI (`codex mcp-server`). Verify with `codex --version`.
- Default approval policy is permissive (`never`) and the UI will not require command approval by default.
- Default startup Codex config (if not overridden in `.env`) is:
  - `CODEX_MODEL=gpt-5.3-codex-spark`
  - `CODEX_REASONING_EFFORT=high`
  - `CODEX_SANDBOX=danger-full-access`
  - `CODEX_APPROVAL_POLICY=never`
- Sessions/chats are persisted via `DATA_DIR` (default `data`) and survive backend restarts for unexpired sessions.
- OTP is not delivered anywhere except server logs (intended for local/dev).
- The chat supports a few CLI-like slash commands; type `/web help` in the chat.
  - Web-only commands live under `/web ...` (type `/web help`). All other `/...` inputs are sent to Codex unchanged.
- The app now also supports `/status` (or `/web status`) and returns live server-side status for all sessions, not just the active chat, so it behaves closer to CLI behavior.
  - It reads usage/rate-limit data by default from `CODEX_CLI_STATUS_URL`.
  - If `CODEX_CLI_STATUS_URL` is not set, it defaults to the built-in endpoint `http://127.0.0.1:${PORT}/api/cli-status`.
  - If you prefer to keep your own source, set `CODEX_CLI_STATUS_URL` to another JSON endpoint.
  - If an external endpoint is unavailable, it uses a local fallback:
    - in-memory usage/rate-limit snapshots for this process
    - and latest token_count/rate limit records from `<CODEX_HOME>/sessions` (default `~/.codex/sessions`), so `/status` can keep showing account-level usage even when current chat runtime is empty.
  - If no usable usage data exists, UI still keeps the session/rate-limit lines and shows `cli.usage.error=...` when appropriate.
- In `AUTH_MODE=totp`, all devices that log in with the same TOTP QR share the same logical session (same chat list + Codex session state).
- Streaming is buffered server-side per chat turn: if the browser disconnects mid-run, Codex continues and the assistant message is still persisted; reloading the page shows the latest output.

Persistence:

- Set `DATA_DIR` (default `data`) in `.env` to keep chats across server restarts.
- On startup, all unexpired sessions/chats in that directory are loaded automatically.
- This enables a resumable session: after restart, active chats and their messages come back and `get /api/status` reflects them.

## TOTP (scan-to-setup)

If you want the scan-style OTP (Google Authenticator / 1Password), switch to TOTP:

1. Generate a base32 secret (example):

```bash
cd server
node -e "const { authenticator } = require('otplib'); console.log(authenticator.generateSecret());"
```

2. Set in `server/.env`:
- `AUTH_MODE=totp`
- `TOTP_SECRET=<your secret>`
- `PRINT_TOTP_QR=true`

3. Restart `npm run start` and scan the QR printed in the server console.

Optional (web QR):
- If you also set `EXPOSE_TOTP_URI=true`, the login page will have a "Setup Authenticator (QR)" button that opens a modal and shows the QR.
- QR/URI is **one-time globally**: after the first successful TOTP login, the server writes `server/.totp_provisioned` and will no longer serve/print the QR even after restart (delete the file to re-provision).
- If `EXPOSE_TOTP_URI` is `false`, the modal will show a "not available" message (recommended if the service is exposed to the internet).

## GitHub publish + one-click deploy to another machine

### Publish to GitHub

```bash
git init
git remote add origin git@github.com:JasonShui716/remote-codexapp.git
git add .
git commit -m "Initial commit: remote codex app"
git branch -M main
git push -u origin main
```

### One-command deploy on target machine

```bash
git clone git@github.com:JasonShui716/remote-codexapp.git /opt/remote-codexapp
cd /opt/remote-codexapp
chmod +x scripts/deploy-remote.sh

# Option 1: interactive domain input (recommended on first deploy)
sudo APP_DIR=/opt/remote-codexapp \
  NGINX_PATH=/codex \
  APP_PORT=18888 \
  bash scripts/deploy-remote.sh

# Option 2: explicit domain via env variable
sudo APP_DIR=/opt/remote-codexapp \
  DOMAIN=your.domain.com \
  NGINX_PATH=/codex \
  APP_PORT=18888 \
  bash scripts/deploy-remote.sh
```

The deploy script will:

- sync/pull project code
- run `npm install` and `npm run build`
- write/patch `server/.env` (`HOST/PORT/CODEX_CWD`)
- install and restart `systemd` service `/etc/systemd/system/codex-remoteapp.service`
- generate/rewrite Nginx config for `NGINX_PATH` and reload Nginx

If your target already has another `/codex` route, existing configs containing `location /codex/` are backed up to `.bak.<timestamp>` and replaced automatically.

If you only want code updates without touching Nginx config:

```bash
sudo SKIP_NGINX=1 bash scripts/deploy-remote.sh
```
