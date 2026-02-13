#!/usr/bin/env bash
set -euo pipefail

# One-command wrapper around deploy-remote.sh.
# Usage:
#   bash scripts/deploy-one-click.sh [domain]
# Examples:
#   bash scripts/deploy-one-click.sh
#   bash scripts/deploy-one-click.sh www.example.com

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
ROOT_DIR="$(cd -- "${SCRIPT_DIR}/.." >/dev/null 2>&1 && pwd)"

APP_DIR="${APP_DIR:-/opt/remote-codexapp}"
DOMAIN="${1:-${DOMAIN:-}}"
NGINX_PATH="${NGINX_PATH:-/codex}"
APP_PORT="${APP_PORT:-18888}"
REPO_URL="${REPO_URL:-git@github.com:JasonShui716/remote-codexapp.git}"
GIT_BRANCH="${GIT_BRANCH:-main}"
APP_USER="${APP_USER:-${SUDO_USER:-$(id -un)}}"
SKIP_NGINX="${SKIP_NGINX:-0}"
SKIP_SERVICE="${SKIP_SERVICE:-0}"

echo "[deploy-one-click] APP_DIR=${APP_DIR}"
echo "[deploy-one-click] DOMAIN=${DOMAIN:-<interactive>}"
echo "[deploy-one-click] NGINX_PATH=${NGINX_PATH}"
echo "[deploy-one-click] APP_PORT=${APP_PORT}"
echo "[deploy-one-click] GIT_BRANCH=${GIT_BRANCH}"
echo "[deploy-one-click] APP_USER=${APP_USER}"
echo "[deploy-one-click] SKIP_NGINX=${SKIP_NGINX} SKIP_SERVICE=${SKIP_SERVICE}"

run_deploy() {
  env \
    APP_DIR="${APP_DIR}" \
    DOMAIN="${DOMAIN}" \
    NGINX_PATH="${NGINX_PATH}" \
    APP_PORT="${APP_PORT}" \
    REPO_URL="${REPO_URL}" \
    GIT_BRANCH="${GIT_BRANCH}" \
    APP_USER="${APP_USER}" \
    SKIP_NGINX="${SKIP_NGINX}" \
    SKIP_SERVICE="${SKIP_SERVICE}" \
    bash "${ROOT_DIR}/scripts/deploy-remote.sh"
}

run_deploy
