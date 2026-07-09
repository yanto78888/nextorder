#!/usr/bin/env bash
set -euo pipefail

REPO_URL="${1:-}"
BRANCH="${2:-main}"
APP_DIR="${APP_DIR:-/opt/nextorder/app}"
STACK_DIR="${STACK_DIR:-/opt/nextorder}"

if [ -z "$REPO_URL" ]; then
  cat >&2 <<USAGE
Usage:
  bash deploy/install-auto-deploy.sh <git-repo-ssh-url> [branch]

Contoh:
  bash deploy/install-auto-deploy.sh git@github.com:USERNAME/nextorder.git main
USAGE
  exit 1
fi

log() {
  printf '[nextorder-install] %s\n' "$*"
}

if command -v apt-get >/dev/null 2>&1; then
  apt-get update
  apt-get install -y git curl ca-certificates
fi

if ! command -v node >/dev/null 2>&1; then
  log "Node.js belum terinstall. Install Node.js 18+ dulu, lalu jalankan ulang script ini."
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  log "npm belum terinstall. Install npm dulu, lalu jalankan ulang script ini."
  exit 1
fi

NODE_MAJOR="$(node -p "parseInt(process.versions.node.split('.')[0], 10)" 2>/dev/null || echo 0)"
if [ "${NODE_MAJOR:-0}" -lt 18 ]; then
  log "Node.js minimal versi 18. Versi saat ini: $(node -v 2>/dev/null || echo tidak-terdeteksi)"
  log "Install Node.js 18+ dulu, lalu jalankan ulang script ini."
  exit 1
fi

if ! command -v pm2 >/dev/null 2>&1; then
  npm install -g pm2
fi

mkdir -p "$STACK_DIR"
if [ ! -d "$APP_DIR/.git" ]; then
  mkdir -p "$(dirname "$APP_DIR")"
  git clone -b "$BRANCH" "$REPO_URL" "$APP_DIR"
else
  log "repo sudah ada di $APP_DIR"
fi

cd "$APP_DIR"
git fetch --prune origin "$BRANCH"
git checkout -q "$BRANCH" || true
install -m 0755 deploy/nextorder-update.sh /usr/local/bin/nextorder-update
APP_DIR="$APP_DIR" STACK_DIR="$STACK_DIR" BRANCH="$BRANCH" /usr/local/bin/nextorder-update
pm2 startup || true

log "install selesai. Push ke branch $BRANCH akan auto deploy lewat GitHub Actions."
