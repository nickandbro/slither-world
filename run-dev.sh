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

(
  cd "${ROOT_DIR}/backend"
  PORT="${BACKEND_PORT}" cargo run
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
