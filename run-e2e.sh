#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FRONTEND_PORT="${FRONTEND_PORT:-5177}"
BACKEND_PORT="${BACKEND_PORT:-8790}"
BACKEND_URL="http://localhost:${BACKEND_PORT}"
E2E_BOT_COUNT="${E2E_BOT_COUNT:-}"
E2E_NO_BOTS_ROOM_PREFIX="${E2E_NO_BOTS_ROOM_PREFIX:-e2e-}"
E2E_DISABLE_OXYGEN="${E2E_DISABLE_OXYGEN:-1}"
if [[ -z "${DATABASE_URL:-}" ]]; then
  DB_FILE="${ROOT_DIR}/backend/data/leaderboard-e2e-$(date +%s).db"
  DATABASE_URL="sqlite://${DB_FILE}"
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

if lsof -iTCP:"${BACKEND_PORT}" -sTCP:LISTEN -Pn >/dev/null 2>&1; then
  echo "Backend port ${BACKEND_PORT} is already in use." >&2
  exit 1
fi

if lsof -iTCP:"${FRONTEND_PORT}" -sTCP:LISTEN -Pn >/dev/null 2>&1; then
  echo "Frontend port ${FRONTEND_PORT} is already in use." >&2
  exit 1
fi

(
  cd "${ROOT_DIR}/backend"
  PORT="${BACKEND_PORT}" \
  DATABASE_URL="${DATABASE_URL}" \
  ENABLE_DEBUG_COMMANDS=1 \
  SNAKE_BOT_COUNT="${E2E_BOT_COUNT}" \
  SNAKE_NO_BOTS_ROOM_PREFIX="${E2E_NO_BOTS_ROOM_PREFIX}" \
  SNAKE_DISABLE_OXYGEN="${E2E_DISABLE_OXYGEN}" \
  cargo run
) &
BACKEND_PID=$!

echo "Backend started on ${BACKEND_URL} (PID ${BACKEND_PID})"

if command -v curl >/dev/null 2>&1; then
  for _ in $(seq 1 30); do
    if curl -fs "${BACKEND_URL}/api/health" >/dev/null 2>&1; then
      break
    fi
    sleep 1
  done
fi

(
  cd "${ROOT_DIR}/frontend"
  VITE_BACKEND_URL="${BACKEND_URL}" VITE_E2E_DEBUG=1 npm run dev -- --port "${FRONTEND_PORT}" --strictPort
) &
FRONTEND_PID=$!

echo "Frontend started on http://localhost:${FRONTEND_PORT} (PID ${FRONTEND_PID})"

wait "${BACKEND_PID}" "${FRONTEND_PID}"
