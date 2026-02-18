#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOCAL_PORT="${LOCAL_PORT:-8818}"
BACKEND_PORT="${BACKEND_PORT:-8788}"
BACKEND_URL="http://127.0.0.1:${BACKEND_PORT}"
ROOM_ORIGIN_URL="http://localhost:${BACKEND_PORT}"
LOCAL_URL="http://localhost:${LOCAL_PORT}"
WATCH="${WATCH:-1}"
FRONTEND_MODE="${FRONTEND_MODE:-worker}" # worker|vite
ROCK_PELLET_FREQ_MULT="${SNAKE_DEBUG_ROCK_PELLET_FREQ_MULT:-}"
BACKEND_HEALTH_TIMEOUT_SECS="${BACKEND_HEALTH_TIMEOUT_SECS:-40}"

usage() {
  cat <<EOF
Usage: ./run-local-dev-copy.sh [--watch|--no-watch] [--worker|--vite] [--rock-pellet-freq-mult <mult>]

Starts a local stack on :${LOCAL_PORT} with a standalone backend on :${BACKEND_PORT}.

Frontend modes:
  --worker (default): production-like static build served by a local Cloudflare Worker.
  --vite: Vite dev server (HMR, no rebuild); API requests go directly to the backend.

Watch mode (default: on):
  - Backend restarts on changes (via cargo-watch)
  - Worker mode: frontend rebuilds on changes (vite build --watch; refresh the page)
  - Vite mode: frontend uses Vite HMR

Set WATCH=0 or pass --no-watch to disable backend restarts.
Set BACKEND_HEALTH_TIMEOUT_SECS to adjust backend startup wait before failing (default: 40).
Debug:
  --rock-pellet-freq-mult <mult>
      Bias small-pellet spawns near mountain/rock edges by multiplier (e.g. 20).
      Equivalent env var: SNAKE_DEBUG_ROCK_PELLET_FREQ_MULT=<mult>
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --watch)
      WATCH=1
      shift
      ;;
    --no-watch)
      WATCH=0
      shift
      ;;
    --worker)
      FRONTEND_MODE="worker"
      shift
      ;;
    --vite)
      FRONTEND_MODE="vite"
      shift
      ;;
    --rock-pellet-freq-mult)
      ROCK_PELLET_FREQ_MULT="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

collect_descendants() {
  local parent_pid="$1"
  local child_pid
  while read -r child_pid; do
    [[ -z "${child_pid}" ]] && continue
    echo "${child_pid}"
    collect_descendants "${child_pid}"
  done < <(pgrep -P "${parent_pid}" 2>/dev/null || true)
}

stop_process_tree() {
  local root_pid="$1"
  [[ -z "${root_pid}" ]] && return
  if ! kill -0 "${root_pid}" >/dev/null 2>&1; then
    return
  fi

  local pid
  local descendants
  descendants="$(collect_descendants "${root_pid}" | tr '\n' ' ')"

  for pid in ${descendants}; do
    kill -TERM "${pid}" >/dev/null 2>&1 || true
  done
  kill -TERM "${root_pid}" >/dev/null 2>&1 || true

  for _ in $(seq 1 30); do
    local alive=0
    for pid in ${descendants}; do
      if kill -0 "${pid}" >/dev/null 2>&1; then
        alive=1
        break
      fi
    done
    if [[ "${alive}" -eq 0 ]] && ! kill -0 "${root_pid}" >/dev/null 2>&1; then
      return
    fi
    sleep 0.1
  done

  for pid in ${descendants}; do
    kill -KILL "${pid}" >/dev/null 2>&1 || true
  done
  kill -KILL "${root_pid}" >/dev/null 2>&1 || true
}

cleanup() {
  if [[ "${CLEANUP_DONE:-0}" == "1" ]]; then
    return
  fi
  CLEANUP_DONE=1
  stop_process_tree "${WORKER_PID:-}"
  stop_process_tree "${FRONTEND_PID:-}"
  stop_process_tree "${FRONTEND_BUILD_PID:-}"
  stop_process_tree "${BACKEND_PID:-}"
}

trap cleanup EXIT INT TERM

get_mtime_secs() {
  local path="$1"
  if [[ ! -e "${path}" ]]; then
    echo "0"
    return
  fi

  if command -v python3 >/dev/null 2>&1; then
    python3 - "$path" <<'PY'
import os
import sys
try:
  print(int(os.stat(sys.argv[1]).st_mtime))
except FileNotFoundError:
  print(0)
PY
    return
  fi

  if stat -c %Y "${path}" >/dev/null 2>&1; then
    stat -c %Y "${path}"
    return
  fi
  stat -f %m "${path}"
}

require_command() {
  local command_name="$1"
  if ! command -v "${command_name}" >/dev/null 2>&1; then
    echo "${command_name} is required but was not found in PATH." >&2
    exit 1
  fi
}

require_command cargo
require_command npm
require_command curl
require_command pgrep
if [[ "${FRONTEND_MODE}" == "worker" ]]; then
  require_command npx
fi

if [[ "${WATCH}" == "1" ]]; then
  require_command cargo-watch
fi

if lsof -iTCP:"${BACKEND_PORT}" -sTCP:LISTEN -Pn >/dev/null 2>&1; then
  echo "Backend port ${BACKEND_PORT} is already in use." >&2
  exit 1
fi
if lsof -iTCP:"${LOCAL_PORT}" -sTCP:LISTEN -Pn >/dev/null 2>&1; then
  echo "Local port ${LOCAL_PORT} is already in use." >&2
  exit 1
fi

if [[ -f "${ROOT_DIR}/.env" ]]; then
  set -a
  source "${ROOT_DIR}/.env"
  set +a
fi
if [[ -z "${ROCK_PELLET_FREQ_MULT}" ]] && [[ -n "${SNAKE_DEBUG_ROCK_PELLET_FREQ_MULT:-}" ]]; then
  ROCK_PELLET_FREQ_MULT="${SNAKE_DEBUG_ROCK_PELLET_FREQ_MULT}"
fi
if [[ -n "${ROCK_PELLET_FREQ_MULT}" ]]; then
  if ! awk -v v="${ROCK_PELLET_FREQ_MULT}" 'BEGIN { exit !(v > 0) }'; then
    echo "--rock-pellet-freq-mult must be a number > 0" >&2
    exit 1
  fi
fi

if [[ -z "${ROOM_TOKEN_SECRET:-}" ]]; then
  echo "ROOM_TOKEN_SECRET is required. Set it in .env or the shell environment." >&2
  exit 1
fi
if [[ "${FRONTEND_MODE}" == "worker" ]] && [[ -z "${ROOM_PROXY_SECRET:-}" ]]; then
  echo "ROOM_PROXY_SECRET is required. Set it in .env or the shell environment." >&2
  exit 1
fi

BACKEND_ENV=(
  PORT="${BACKEND_PORT}"
  SNAKE_ROLE=standalone
  ROOM_TOKEN_SECRET="${ROOM_TOKEN_SECRET}"
  STANDALONE_ROOM_ORIGIN="${ROOM_ORIGIN_URL}"
)
if [[ -n "${ROCK_PELLET_FREQ_MULT}" ]]; then
  BACKEND_ENV+=(SNAKE_DEBUG_ROCK_PELLET_FREQ_MULT="${ROCK_PELLET_FREQ_MULT}")
  echo "Debug rock pellet multiplier enabled: ${ROCK_PELLET_FREQ_MULT}x"
fi

if [[ "${WATCH}" == "1" ]]; then
  (
    cd "${ROOT_DIR}/backend"
    exec env \
      "${BACKEND_ENV[@]}" \
      cargo watch -q -w src -w migrations -w Cargo.toml -x run
  ) &
else
  (
    cd "${ROOT_DIR}/backend"
    exec env \
      "${BACKEND_ENV[@]}" \
      cargo run
  ) &
fi
BACKEND_PID=$!
echo "Standalone backend starting on ${BACKEND_URL} (PID ${BACKEND_PID})"

for _ in $(seq 1 "${BACKEND_HEALTH_TIMEOUT_SECS}"); do
  if curl -fsS "${BACKEND_URL}/api/health" >/dev/null 2>&1; then
    break
  fi
  if ! kill -0 "${BACKEND_PID}" >/dev/null 2>&1; then
    echo "Backend process exited before becoming healthy." >&2
    exit 1
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

if [[ "${FRONTEND_MODE}" == "vite" ]]; then
  (
    cd "${ROOT_DIR}/frontend"
    exec env \
      VITE_BACKEND_URL="${BACKEND_URL}" \
      npm run dev -- --host 127.0.0.1 --port "${LOCAL_PORT}" --strictPort
  ) &
  FRONTEND_PID=$!
  echo "Vite dev server starting on ${LOCAL_URL} (PID ${FRONTEND_PID})"
else
  if [[ "${WATCH}" == "1" ]]; then
    FRONTEND_BUILD_START_TS="$(date +%s)"
    (
      cd "${ROOT_DIR}/frontend"
      exec npm run build -- --watch
    ) &
    FRONTEND_BUILD_PID=$!
    echo "Frontend build watcher starting (PID ${FRONTEND_BUILD_PID})"

    # Wait for the first build to complete (or at least touch index.html after we started).
    FRONTEND_INDEX_HTML="${ROOT_DIR}/frontend/dist/client/index.html"
    for _ in $(seq 1 240); do
      if [[ -f "${FRONTEND_INDEX_HTML}" ]]; then
        index_mtime="$(get_mtime_secs "${FRONTEND_INDEX_HTML}")"
        if [[ "${index_mtime}" -ge "${FRONTEND_BUILD_START_TS}" ]]; then
          break
        fi
      fi
      if ! kill -0 "${FRONTEND_BUILD_PID}" >/dev/null 2>&1; then
        echo "Frontend build watcher exited before completing the first build." >&2
        exit 1
      fi
      sleep 0.25
    done

    if [[ ! -f "${FRONTEND_INDEX_HTML}" ]]; then
      echo "Frontend build did not produce ${FRONTEND_INDEX_HTML}" >&2
      exit 1
    fi
    index_mtime="$(get_mtime_secs "${FRONTEND_INDEX_HTML}")"
    if [[ "${index_mtime}" -lt "${FRONTEND_BUILD_START_TS}" ]]; then
      echo "Frontend build did not complete within the expected time window." >&2
      exit 1
    fi

    (
      cd "${ROOT_DIR}/frontend"
      exec npx wrangler dev \
        -c wrangler.dev.toml \
        --local \
        --ip 127.0.0.1 \
        --port "${LOCAL_PORT}" \
        --var "CONTROL_PLANE_ORIGIN:${BACKEND_URL}" \
        --var "ROOM_TOKEN_SECRET:${ROOM_TOKEN_SECRET}" \
        --var "ROOM_PROXY_SECRET:${ROOM_PROXY_SECRET}"
    ) &
  else
    (
      cd "${ROOT_DIR}/frontend"
      npm run build
      exec npx wrangler dev \
        -c wrangler.dev.toml \
        --local \
        --ip 127.0.0.1 \
        --port "${LOCAL_PORT}" \
        --var "CONTROL_PLANE_ORIGIN:${BACKEND_URL}" \
        --var "ROOM_TOKEN_SECRET:${ROOM_TOKEN_SECRET}" \
        --var "ROOM_PROXY_SECRET:${ROOM_PROXY_SECRET}"
    ) &
  fi
  WORKER_PID=$!
  echo "Local worker starting on ${LOCAL_URL} (PID ${WORKER_PID})"
fi

for _ in $(seq 1 40); do
  if curl -fsS "${LOCAL_URL}" >/dev/null 2>&1; then
    break
  fi
  if [[ -n "${WORKER_PID:-}" ]] && ! kill -0 "${WORKER_PID}" >/dev/null 2>&1; then
    echo "Worker process exited before becoming ready." >&2
    exit 1
  fi
  if [[ -n "${FRONTEND_PID:-}" ]] && ! kill -0 "${FRONTEND_PID}" >/dev/null 2>&1; then
    echo "Vite dev server exited before becoming ready." >&2
    exit 1
  fi
  sleep 1
done

if ! curl -fsS "${LOCAL_URL}" >/dev/null 2>&1; then
  echo "App failed to become ready at ${LOCAL_URL}" >&2
  exit 1
fi

echo "Local dev copy ready:"
echo "  App: ${LOCAL_URL}"
if [[ "${FRONTEND_MODE}" == "vite" ]]; then
  echo "  Matchmake: ${BACKEND_URL}/api/matchmake"
else
  echo "  Matchmake: ${LOCAL_URL}/api/matchmake"
fi
echo "  Backend health: ${BACKEND_URL}/api/health"

if [[ "${FRONTEND_MODE}" == "vite" ]]; then
  echo ""
  echo "Dev mode:"
  if [[ "${WATCH}" == "1" ]]; then
    echo "  - Backend restarts on backend/ changes"
  else
    echo "  - Backend runs (no auto-restart; pass --watch to restart on changes)"
  fi
  echo "  - Frontend uses Vite HMR"
elif [[ "${WATCH}" == "1" ]]; then
  echo ""
  echo "Watch mode enabled:"
  echo "  - Backend restarts on backend/ changes"
  echo "  - Frontend rebuilds on frontend/ changes (refresh the page to see updates)"
fi

if [[ -n "${FRONTEND_BUILD_PID:-}" ]]; then
  wait "${BACKEND_PID}" "${WORKER_PID}" "${FRONTEND_BUILD_PID}"
elif [[ -n "${FRONTEND_PID:-}" ]]; then
  wait "${BACKEND_PID}" "${FRONTEND_PID}"
else
  wait "${BACKEND_PID}" "${WORKER_PID}"
fi
