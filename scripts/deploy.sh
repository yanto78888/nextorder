#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR="${APP_DIR:-$ROOT_DIR}"
STACK_DIR="${STACK_DIR:-/opt/nextorder}"
BRANCH="${BRANCH:-main}"

APP_DIR="$APP_DIR" STACK_DIR="$STACK_DIR" BRANCH="$BRANCH" bash "$ROOT_DIR/deploy/nextorder-update.sh"
