#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOCAL_PORT="${LOCAL_PORT:-8818}"
BACKEND_PORT="${BACKEND_PORT:-8788}"
BACKEND_URL="http://127.0.0.1:${BACKEND_PORT}"
ROOM_ORIGIN_URL="http://localhost:${BACKEND_PORT}"
LOCAL_URL="http://localhost:${LOCAL_PORT}"

cleanup() {
  if [[ -n "${WORKER_PID:-}" ]]; then
    kill "${WORKER_PID}" >/dev/null 2>&1 || true
  fi
  if [[ -n "${BACKEND_PID:-}" ]]; then
    kill "${BACKEND_PID}" >/dev/null 2>&1 || true
  fi
}

trap cleanup EXIT INT TERM

require_command() {
  local command_name="$1"
  if ! command -v "${command_name}" >/dev/null 2>&1; then
    echo "${command_name} is required but was not found in PATH." >&2
    exit 1
  fi
}

require_command cargo
require_command npm
require_command npx
require_command curl

if lsof -iTCP:"${BACKEND_PORT}" -sTCP:LISTEN -Pn >/dev/null 2>&1; then
  echo "Backend port ${BACKEND_PORT} is already in use." >&2
  exit 1
fi
if lsof -iTCP:"${LOCAL_PORT}" -sTCP:LISTEN -Pn >/dev/null 2>&1; then
  echo "Local worker port ${LOCAL_PORT} is already in use." >&2
  exit 1
fi

if [[ -f "${ROOT_DIR}/.env" ]]; then
  set -a
  source "${ROOT_DIR}/.env"
  set +a
fi

if [[ -z "${ROOM_TOKEN_SECRET:-}" ]]; then
  echo "ROOM_TOKEN_SECRET is required. Set it in .env or the shell environment." >&2
  exit 1
fi
if [[ -z "${ROOM_PROXY_SECRET:-}" ]]; then
  echo "ROOM_PROXY_SECRET is required. Set it in .env or the shell environment." >&2
  exit 1
fi

(
  cd "${ROOT_DIR}/backend"
  PORT="${BACKEND_PORT}" \
    SNAKE_ROLE=standalone \
    ROOM_TOKEN_SECRET="${ROOM_TOKEN_SECRET}" \
    STANDALONE_ROOM_ORIGIN="${ROOM_ORIGIN_URL}" \
    cargo run
) &
BACKEND_PID=$!
echo "Standalone backend starting on ${BACKEND_URL} (PID ${BACKEND_PID})"

for _ in $(seq 1 40); do
  if curl -fsS "${BACKEND_URL}/api/health" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

if ! curl -fsS "${BACKEND_URL}/api/health" >/dev/null 2>&1; then
  echo "Backend failed to become healthy at ${BACKEND_URL}/api/health" >&2
  exit 1
fi

if ! curl -fsS -X POST "${BACKEND_URL}/api/matchmake" \
  -H "Content-Type: application/json" \
  --data "{}" >/dev/null 2>&1; then
  echo "Backend matchmaking failed at ${BACKEND_URL}/api/matchmake" >&2
  exit 1
fi

(
  cd "${ROOT_DIR}/frontend"
  npm run build
  npx wrangler dev \
    -c wrangler.dev.toml \
    --local \
    --ip 127.0.0.1 \
    --port "${LOCAL_PORT}" \
    --var "CONTROL_PLANE_ORIGIN:${BACKEND_URL}" \
    --var "ROOM_TOKEN_SECRET:${ROOM_TOKEN_SECRET}" \
    --var "ROOM_PROXY_SECRET:${ROOM_PROXY_SECRET}"
) &
WORKER_PID=$!
echo "Local worker starting on ${LOCAL_URL} (PID ${WORKER_PID})"

for _ in $(seq 1 40); do
  if curl -fsS "${LOCAL_URL}" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

if ! curl -fsS "${LOCAL_URL}" >/dev/null 2>&1; then
  echo "Worker failed to become ready at ${LOCAL_URL}" >&2
  exit 1
fi

echo "Local dev copy ready:"
echo "  App: ${LOCAL_URL}"
echo "  Matchmake: ${LOCAL_URL}/api/matchmake"
echo "  Backend health: ${BACKEND_URL}/api/health"

wait "${BACKEND_PID}" "${WORKER_PID}"
