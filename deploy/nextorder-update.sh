#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/nextorder/app}"
STACK_DIR="${STACK_DIR:-/opt/nextorder}"
BRANCH="${BRANCH:-main}"
PM2_APP="${PM2_APP:-nexorder}"
PORT="${PORT:-3000}"
LOCK_FILE="$STACK_DIR/.deploy.lock"
SHARED_DIR="$STACK_DIR/shared"
SHARED_DATA_DIR="$SHARED_DIR/data"
SHARED_UPLOAD_DIR="$SHARED_DIR/uploads/products"
DATA_MARKER="$SHARED_DATA_DIR/.managed-by-nextorder-deploy"
UPLOAD_MARKER="$SHARED_UPLOAD_DIR/.managed-by-nextorder-deploy"
PREV_SHA=""
NEW_SHA=""
CHANGED_FILES_FILE=""

log() {
  printf '[nextorder-deploy] %s\n' "$*"
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    log "command '$1' belum terinstall"
    exit 1
  fi
}

check_node_version() {
  require_cmd node
  local major
  major="$(node -p "parseInt(process.versions.node.split('.')[0], 10)" 2>/dev/null || echo 0)"
  if [ "${major:-0}" -lt 18 ]; then
    log "Node.js minimal versi 18. Versi saat ini: $(node -v 2>/dev/null || echo tidak-terdeteksi)"
    exit 1
  fi
}

acquire_lock() {
  local wait_seconds="${LOCK_WAIT_SECONDS:-180}"
  install -d "$STACK_DIR"
  exec 9>"$LOCK_FILE"

  if flock -n 9; then
    printf '%s\n' "$$" > "$LOCK_FILE"
    log "lock deploy didapat (pid $$)"
    trap 'rm -f "$LOCK_FILE"' EXIT
    return 0
  fi

  log "deploy lain masih berjalan; menunggu maksimal ${wait_seconds} detik"
  if ! flock -w "$wait_seconds" 9; then
    log "timeout menunggu lock deploy setelah ${wait_seconds} detik"
    exit 1
  fi

  printf '%s\n' "$$" > "$LOCK_FILE"
  log "lock deploy didapat setelah menunggu (pid $$)"
  trap 'rm -f "$LOCK_FILE"' EXIT
}

copy_dir_contents_if_exists() {
  local source_dir="$1"
  local target_dir="$2"
  if [ -d "$source_dir" ]; then
    install -d "$target_dir"
    cp -a "$source_dir/." "$target_dir/" 2>/dev/null || true
  fi
}

prepare_shared_dirs_before_reset() {
  install -d "$SHARED_DATA_DIR" "$SHARED_UPLOAD_DIR"

  # Migrasi pertama: kalau data masih berupa folder biasa dari repo/VPS lama,
  # salin ke shared storage. Setelah marker ada, jangan overwrite shared data
  # dari folder repo default agar data produksi tidak ketimpa saat deploy berikutnya.
  if [ ! -f "$DATA_MARKER" ]; then
    if [ -e "$APP_DIR/data" ] && [ ! -L "$APP_DIR/data" ]; then
      log "migrasi data JSON ke $SHARED_DATA_DIR"
      copy_dir_contents_if_exists "$APP_DIR/data" "$SHARED_DATA_DIR"
    fi
    touch "$DATA_MARKER"
  fi

  if [ ! -f "$UPLOAD_MARKER" ]; then
    if [ -e "$APP_DIR/public/uploads/products" ] && [ ! -L "$APP_DIR/public/uploads/products" ]; then
      log "migrasi upload produk ke $SHARED_UPLOAD_DIR"
      copy_dir_contents_if_exists "$APP_DIR/public/uploads/products" "$SHARED_UPLOAD_DIR"
    fi
    touch "$UPLOAD_MARKER"
  fi
}

link_shared_paths_after_reset() {
  install -d "$SHARED_DATA_DIR" "$SHARED_UPLOAD_DIR" "$APP_DIR/public/uploads"

  # Kalau commit terbaru membawa file JSON default baru, salin hanya file yang belum ada di shared.
  if [ -d "$APP_DIR/data" ] && [ ! -L "$APP_DIR/data" ]; then
    for file in "$APP_DIR"/data/*.json; do
      [ -e "$file" ] || continue
      base="$(basename "$file")"
      if [ ! -f "$SHARED_DATA_DIR/$base" ]; then
        cp -a "$file" "$SHARED_DATA_DIR/$base"
      fi
    done
    rm -rf "$APP_DIR/data"
  fi
  ln -sfn "$SHARED_DATA_DIR" "$APP_DIR/data"

  if [ -d "$APP_DIR/public/uploads/products" ] && [ ! -L "$APP_DIR/public/uploads/products" ]; then
    copy_dir_contents_if_exists "$APP_DIR/public/uploads/products" "$SHARED_UPLOAD_DIR"
    rm -rf "$APP_DIR/public/uploads/products"
  fi
  ln -sfn "$SHARED_UPLOAD_DIR" "$APP_DIR/public/uploads/products"

  touch "$DATA_MARKER" "$UPLOAD_MARKER"
}

update_repo_incremental() {
  cd "$APP_DIR"
  PREV_SHA="$(git rev-parse HEAD 2>/dev/null || true)"
  log "commit sebelum update: ${PREV_SHA:-belum ada}"
  log "fetch perubahan dari origin/$BRANCH"
  git fetch --prune origin "$BRANCH"
  NEW_SHA="$(git rev-parse "origin/${BRANCH}")"
  log "commit target: $NEW_SHA"

  CHANGED_FILES_FILE="$(mktemp)"
  if [ -n "$PREV_SHA" ] && git cat-file -e "$PREV_SHA^{commit}" 2>/dev/null; then
    git diff --name-status "$PREV_SHA" "$NEW_SHA" > "$CHANGED_FILES_FILE" || true
  else
    git ls-tree -r --name-only "$NEW_SHA" | sed 's/^/A\t/' > "$CHANGED_FILES_FILE"
  fi

  if [ -s "$CHANGED_FILES_FILE" ]; then
    log "file berubah/baru/dihapus sejak deploy terakhir:"
    sed 's/^/[nextorder-deploy]   /' "$CHANGED_FILES_FILE" | head -n 200
  else
    log "tidak ada perubahan file di repository"
  fi

  git reset --hard "$NEW_SHA"
}

install_dependencies() {
  cd "$APP_DIR"
  if [ -f package-lock.json ]; then
    log "install dependency dengan npm ci --omit=dev"
    npm ci --omit=dev
  else
    log "install dependency dengan npm install --omit=dev"
    npm install --omit=dev
  fi
}

restart_pm2() {
  cd "$APP_DIR"
  export NODE_ENV=production
  export PORT="$PORT"
  export VERCEL=0

  if ! command -v pm2 >/dev/null 2>&1; then
    log "pm2 belum ada; install pm2 global"
    npm install -g pm2
  fi

  log "reload/start PM2 app $PM2_APP"
  pm2 reload ecosystem.config.cjs --only "$PM2_APP" --update-env || pm2 start ecosystem.config.cjs --only "$PM2_APP"
  pm2 save
}

wait_healthcheck() {
  local url="http://127.0.0.1:${PORT}/healthz"
  local attempts="${HEALTHCHECK_ATTEMPTS:-30}"

  if ! command -v curl >/dev/null 2>&1; then
    log "curl tidak ada; healthcheck dilewati"
    return 0
  fi

  log "menunggu healthcheck $url"
  while [ "$attempts" -gt 0 ]; do
    if curl -fsS "$url" >/dev/null 2>&1; then
      log "healthcheck OK"
      return 0
    fi
    sleep 2
    attempts=$((attempts - 1))
  done

  log "healthcheck gagal. Log PM2 terakhir:"
  pm2 logs "$PM2_APP" --lines 120 --nostream || true
  return 1
}

main() {
  require_cmd git
  require_cmd npm
  check_node_version

  acquire_lock

  if [ ! -d "$APP_DIR/.git" ]; then
    log "APP_DIR bukan repo git: $APP_DIR"
    log "Clone repo terlebih dahulu ke $APP_DIR, lalu jalankan deploy ulang."
    exit 1
  fi

  prepare_shared_dirs_before_reset
  update_repo_incremental
  link_shared_paths_after_reset
  install_dependencies
  restart_pm2
  wait_healthcheck

  log "deploy selesai"
}

main "$@"
