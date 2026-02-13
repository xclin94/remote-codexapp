# Codex Remote Web Chat（中文）

[English](README.md) | [中文](README.zh-CN.md)

这是一个自托管的 OpenAI Codex（通过 MCP）Web 界面，支持 OTP/TOTP 登录、可恢复会话、浏览器交互式 Terminal，以及一键部署。

该项目由 Node.js 后端 + React 前端组成，适合在局域网或公网远程访问，并支持通过 `/codex` 路径反向代理。

## 功能

- Codex Web Chat UI
- 流式回复与自动重连
- OTP（控制台验证码）与可选 TOTP 登录
- 会话与聊天持久化（`DATA_DIR`，默认 `data`）
- `/status` 状态与用量信息
- 聊天内 `/web help` 命令
- 交互式 Terminal（WebSocket + PTY），并与聊天会话同级切换
- Terminal 管理 API（`POST /api/terminal`、`GET /api/terminals`、`GET /ws/terminal`）
- 远程部署脚本（Nginx + systemd）

## 架构

- `server/`：Node.js/Express API，封装本地 `codex mcp-server`
- `web/`：Vite + React 前端，产物在 `web/dist`
- 持久化：`server/.env` + `DATA_DIR` 下 JSON
- 可选反向代理路径：默认 `NGINX_PATH=/codex`

## 本地快速启动

1. 安装依赖

```bash
npm install
```

2. 配置环境变量

```bash
cd server
cp .env.example .env
# 编辑 server/.env
# 重要：运行 codex 需要 OpenAI 凭据（通常是 OPENAI_API_KEY）
```

3. 启动

```bash
cd ..
npm run start
```

4. 打开服务

- 本机：`http://127.0.0.1:18888`
- 局域网/公网：在 `server/.env` 设置 `HOST=0.0.0.0`，然后访问 `http://<server-ip>:18888`

如果其他机器无法访问，请放通 `18888` 端口。

## 登录认证

### OTP

- 登录页点击 `Request OTP`
- 在后端日志中查看 6 位验证码
- 输入并验证

### TOTP（推荐）

1. 生成密钥：

```bash
cd server
node -e "const { authenticator } = require('otplib'); console.log(authenticator.generateSecret());"
```

2. 设置环境变量：

- `AUTH_MODE=totp`
- `TOTP_SECRET=<你的密钥>`
- `PRINT_TOTP_QR=true`

3. 重启后扫码（如果登录页开启二维码展示）

可选项：

- `EXPOSE_TOTP_URI=true`：登录页可显示二维码
- `EXPOSE_TOTP_URI=false`：隐藏二维码（公网更安全）

## Web 命令

- `/web help`
- `/web status`
- `/resume`
- `/status` 由后端处理，可显示运行中的实时状态

### 凭据登录（Credential）

- 登录后可通过 API 创建凭据：`POST /api/auth/credential`
- 使用凭据免 OTP/TOTP 登录：`POST /api/auth/credential/login`
- 凭据列表与吊销：
  - `GET /api/auth/credentials`
  - `POST /api/auth/credential/revoke`
- 凭据明文只在创建时返回一次，请妥善保存

## Terminal 支持

- 创建 terminal：`POST /api/terminal`
- 获取 terminal 列表：`GET /api/terminals`
- 连接 terminal websocket：
  - 直连：`GET /ws/terminal?terminalId=<id>`
  - `/codex` 路径下：`GET /codex/ws/terminal?terminalId=<id>`
- Terminal 与 Chat 是同级会话，点击侧栏 tab 切换主区域
- `/codex` 兼容 API：
  - `POST /codex/api/terminal`
  - `GET /codex/api/terminals`

### Nginx 要求（Terminal WebSocket）

如果通过 `/codex` 反向代理，`/codex/` 的 location 必须带 websocket 升级头：

```nginx
proxy_set_header Upgrade $http_upgrade;
proxy_set_header Connection $connection_upgrade;
```

## 部署（目标机一键）

在目标机执行：

```bash
git clone git@github.com:JasonShui716/remote-codexapp.git /opt/remote-codexapp
cd /opt/remote-codexapp
chmod +x scripts/deploy-remote.sh

# 方式 A：交互式输入域名
APP_DIR=/opt/remote-codexapp \
  NGINX_PATH=/codex \
  APP_PORT=18888 \
  bash scripts/deploy-remote.sh

# 方式 B：显式传入域名
APP_DIR=/opt/remote-codexapp \
  DOMAIN=your.domain.com \
  NGINX_PATH=/codex \
  APP_PORT=18888 \
  bash scripts/deploy-remote.sh
```

首次部署如果使用交互模式，可把 `DOMAIN` 留空后按提示输入。

### 一键包装脚本（推荐）

```bash
# 交互输入域名
bash scripts/deploy-one-click.sh

# 或直接传域名
bash scripts/deploy-one-click.sh your.domain.com
```

常用覆盖参数：

```bash
APP_DIR=/opt/remote-codexapp \
APP_PORT=18888 \
NGINX_PATH=/codex \
GIT_BRANCH=main \
bash scripts/deploy-one-click.sh your.domain.com
```

### 部署脚本会做什么

- 拉取/克隆仓库
- 执行 `npm install` 与 `npm run build`
- git/npm 以 `APP_USER` 身份执行（不依赖 `sudo npm`）
- 写入/更新 `server/.env`（`HOST/PORT/CODEX_CWD`）
- 安装/更新 systemd 服务：`/etc/systemd/system/codex-remoteapp.service`
- 生成并重载 Nginx 配置
- 自动包含 terminal websocket 代理头（`/codex/ws/terminal`）
- 发现已有 `/codex` 绑定时自动替换并备份

仅更新代码（不改 Nginx）：

```bash
sudo SKIP_NGINX=1 bash scripts/deploy-remote.sh
```

## 后台运行

```bash
npm run restart
```

默认值：

- 日志：`/tmp/codex_remoteapp.log`
- PID：`.codex_remoteapp.pid`
- 端口：`server/.env` 的 `PORT`（默认 `18888`）

可选日志路径覆盖：

```bash
CODEREMOTEAPP_LOG=/path/to/log npm run restart
```

## API 快速参考

- `GET /api/me`
- `POST /api/chats`
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

`/codex` 兼容端点：

- `POST /codex/api/terminal`
- `GET /codex/api/terminals`

## 备注

- 需要本机可用 `codex` 命令（`codex --version`）
- 审批策略示例：`never`、`on-request` 等（由环境变量控制）
- 聊天与 terminal 都是 session 级别；terminal 历史默认在内存中维护
