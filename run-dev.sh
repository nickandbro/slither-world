#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_PORT="${BACKEND_PORT:-8788}"
BACKEND_URL="${BACKEND_URL:-http://localhost:${BACKEND_PORT}}"

pick_port() {
  local start_port="$1"
  local end_port="$2"
  local port
  for ((port=start_port; port<=end_port; port++)); do
    if ! lsof -iTCP:"${port}" -sTCP:LISTEN -Pn >/dev/null 2>&1; then
      echo "${port}"
      return 0
    fi
  done
  return 1
}

if lsof -iTCP:"${BACKEND_PORT}" -sTCP:LISTEN -Pn >/dev/null 2>&1; then
  if picked="$(pick_port 8788 8798)"; then
    BACKEND_PORT="${picked}"
    BACKEND_URL="http://localhost:${BACKEND_PORT}"
  else
    echo "No free backend port found in 8788-8798." >&2
    exit 1
  fi
fi

cleanup() {
  if [[ -n "${FRONTEND_PID:-}" ]]; then
    kill "${FRONTEND_PID}" >/dev/null 2>&1 || true
  fi
  if [[ -n "${BACKEND_PID:-}" ]]; then
    kill "${BACKEND_PID}" >/dev/null 2>&1 || true
  fi
}

trap cleanup EXIT INT TERM

if ! command -v cargo >/dev/null 2>&1; then
  echo "cargo is required but was not found in PATH." >&2
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "npm is required but was not found in PATH." >&2
  exit 1
fi

USE_CARGO_WATCH=1
if ! command -v cargo-watch >/dev/null 2>&1; then
  echo "cargo-watch not found; attempting install for backend hot reload..." >&2
  if ! cargo install cargo-watch --locked --version 8.4.1; then
    echo "Failed to install cargo-watch. Falling back to cargo run." >&2
    echo "Tip: upgrade Rust (rustup update) or install cargo-watch manually." >&2
    USE_CARGO_WATCH=0
  fi
fi

(
  cd "${ROOT_DIR}/backend"
  if [[ "${USE_CARGO_WATCH}" -eq 1 ]]; then
    PORT="${BACKEND_PORT}" cargo watch -w src -w Cargo.toml -w Cargo.lock -w migrations -x run
  else
    PORT="${BACKEND_PORT}" cargo run
  fi
) &
BACKEND_PID=$!

echo "Backend started on ${BACKEND_URL} (PID ${BACKEND_PID})"

(
  cd "${ROOT_DIR}/frontend"
  VITE_BACKEND_URL="${BACKEND_URL}" npm run dev
) &
FRONTEND_PID=$!

echo "Frontend started with VITE_BACKEND_URL=${BACKEND_URL} (PID ${FRONTEND_PID})"

wait "${BACKEND_PID}" "${FRONTEND_PID}"
