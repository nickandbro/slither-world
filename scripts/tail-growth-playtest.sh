#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

APP_URL="${APP_URL:-http://localhost:8818}"
BACKEND_PORT="${BACKEND_PORT:-8788}"
DURATION_SECS="${DURATION_SECS:-90}"
POLL_MS="${POLL_MS:-120}"
OUTPUT_DIR="${OUTPUT_DIR:-${ROOT_DIR}/output/tail-growth-tests}"
RUN_LABEL=""
NO_STACK_START=0
HEADLESS=0
AUTO_PLAY=1
NO_SCREENSHOT=0

STACK_PID=""
STACK_LOG=""
RUN_DIR=""

usage() {
  cat <<USAGE
Usage: $(basename "$0") [options]

Options:
  --app-url <url>         App URL (default: ${APP_URL})
  --backend-port <port>   Backend port for health check (default: ${BACKEND_PORT})
  --duration-secs <secs>  Capture duration (default: ${DURATION_SECS})
  --poll-ms <ms>          Poll interval (default: ${POLL_MS})
  --output-dir <dir>      Output root dir (default: ${OUTPUT_DIR})
  --run-label <label>     Optional run folder label
  --no-stack-start        Do not run ./run-local-dev-copy.sh
  --headed                Run recorder in headed mode (default)
  --headless              Run recorder in headless mode
  --auto-play             Recorder auto-clicks Play (default)
  --no-auto-play          Do not auto-click Play
  --no-screenshot         Do not capture end screenshot
  -h, --help              Show help
USAGE
}

require_cmd() {
  local cmd="$1"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Missing required command: ${cmd}" >&2
    exit 1
  fi
}

wait_for_http() {
  local url="$1"
  local timeout_secs="$2"
  local start_ts
  start_ts="$(date +%s)"

  while true; do
    if curl -fsS "$url" >/dev/null 2>&1; then
      return 0
    fi
    local now_ts
    now_ts="$(date +%s)"
    if (( now_ts - start_ts >= timeout_secs )); then
      echo "Timed out waiting for ${url}" >&2
      return 1
    fi
    sleep 1
  done
}

cleanup() {
  set +e
  if [[ -n "$STACK_PID" ]] && kill -0 "$STACK_PID" >/dev/null 2>&1; then
    kill "$STACK_PID" >/dev/null 2>&1 || true
    wait "$STACK_PID" 2>/dev/null || true
  fi
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --app-url)
        APP_URL="$2"
        shift 2
        ;;
      --backend-port)
        BACKEND_PORT="$2"
        shift 2
        ;;
      --duration-secs)
        DURATION_SECS="$2"
        shift 2
        ;;
      --poll-ms)
        POLL_MS="$2"
        shift 2
        ;;
      --output-dir)
        OUTPUT_DIR="$2"
        shift 2
        ;;
      --run-label)
        RUN_LABEL="$2"
        shift 2
        ;;
      --no-stack-start)
        NO_STACK_START=1
        shift
        ;;
      --headless)
        HEADLESS=1
        shift
        ;;
      --headed)
        HEADLESS=0
        shift
        ;;
      --no-auto-play)
        AUTO_PLAY=0
        shift
        ;;
      --auto-play)
        AUTO_PLAY=1
        shift
        ;;
      --no-screenshot)
        NO_SCREENSHOT=1
        shift
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
}

main() {
  parse_args "$@"

  require_cmd node
  require_cmd npm
  require_cmd curl

  if ! awk -v v="$DURATION_SECS" 'BEGIN { exit !(v > 0) }'; then
    echo "--duration-secs must be > 0" >&2
    exit 1
  fi

  if ! awk -v v="$POLL_MS" 'BEGIN { exit !(v >= 40) }'; then
    echo "--poll-ms must be >= 40" >&2
    exit 1
  fi

  if [[ -z "$RUN_LABEL" ]]; then
    RUN_LABEL="run-$(date -u +%Y%m%dT%H%M%SZ)-manual"
  fi

  RUN_DIR="${OUTPUT_DIR}/${RUN_LABEL}"
  mkdir -p "$RUN_DIR"

  trap cleanup EXIT INT TERM

  echo "[tail-playtest] run_dir=${RUN_DIR}"
  echo "[tail-playtest] app_url=${APP_URL} duration_secs=${DURATION_SECS} poll_ms=${POLL_MS}"

  if [[ "$NO_STACK_START" -eq 0 ]]; then
    STACK_LOG="${RUN_DIR}/local-dev-copy.log"
    (
      cd "$ROOT_DIR"
      ./run-local-dev-copy.sh
    ) >"$STACK_LOG" 2>&1 &
    STACK_PID=$!
    echo "[tail-playtest] started run-local-dev-copy.sh pid=${STACK_PID}"

    wait_for_http "${APP_URL}" 240
    wait_for_http "http://127.0.0.1:${BACKEND_PORT}/api/health" 240
    echo "[tail-playtest] app and backend are reachable"
  else
    wait_for_http "${APP_URL}" 90
    wait_for_http "http://127.0.0.1:${BACKEND_PORT}/api/health" 90
    echo "[tail-playtest] attach mode: existing app/backend detected"
  fi

  RECORDER_CMD=(
    node
    "${ROOT_DIR}/scripts/tail-growth-recorder.mjs"
    --app-url "$APP_URL"
    --duration-secs "$DURATION_SECS"
    --poll-ms "$POLL_MS"
    --output-dir "$OUTPUT_DIR"
    --run-label "$RUN_LABEL"
  )

  if [[ "$HEADLESS" -eq 1 ]]; then
    RECORDER_CMD+=(--headless)
  else
    RECORDER_CMD+=(--headed)
  fi

  if [[ "$AUTO_PLAY" -eq 1 ]]; then
    RECORDER_CMD+=(--auto-play)
  else
    RECORDER_CMD+=(--no-auto-play)
  fi

  if [[ "$NO_SCREENSHOT" -eq 0 ]]; then
    RECORDER_CMD+=(--screenshot "${RUN_DIR}/snapshot.png")
  else
    RECORDER_CMD+=(--no-screenshot)
  fi

  "${RECORDER_CMD[@]}" | tee "${RUN_DIR}/recorder-summary.log"

  echo "[tail-playtest] report=${RUN_DIR}/report.json"
  echo "[tail-playtest] tail-events=${RUN_DIR}/tail-events.json"
  echo "[tail-playtest] all-player-events=${RUN_DIR}/all-player-events.json"
  echo "[tail-playtest] samples=${RUN_DIR}/samples.json"
}

main "$@"
