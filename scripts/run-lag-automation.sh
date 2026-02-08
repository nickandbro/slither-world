#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

APP_URL="${APP_URL:-http://localhost:8818}"
BACKEND_PORT="${BACKEND_PORT:-8788}"
PROFILE="${PROFILE:-harsh}"
DURATION_SECS="${DURATION_SECS:-90}"
OUTPUT_DIR="${OUTPUT_DIR:-${ROOT_DIR}/output/lag-tests}"
RUN_LABEL=""
HEADLESS=1
NO_STACK_START=0
NO_LAG_CONTROL=0
REQUIRE_PASS=0
NO_SCREENSHOT=0
TUNING_OVERRIDES_JSON="${TUNING_OVERRIDES_JSON:-}"

STACK_PID=""
STACK_LOG=""
RUN_DIR=""
REPORT_JSON=""
LAG_STARTED=0

usage() {
  cat <<USAGE
Usage: $(basename "$0") [options]

Options:
  --app-url <url>                  App URL (default: ${APP_URL})
  --backend-port <port>            Backend port for lag shaping (default: ${BACKEND_PORT})
  --duration-secs <secs>           Bot run duration (default: ${DURATION_SECS})
  --profile <balanced|harsh|extreme>
  --output-dir <dir>               Output root directory (default: ${OUTPUT_DIR})
  --run-label <label>              Optional run folder label
  --tuning-overrides-json <json>   JSON overrides for __SNAKE_DEBUG__.setNetTuningOverrides
  --no-stack-start                 Do not run ./run-local-dev-copy.sh
  --no-lag-control                 Do not start/stop lag simulation
  --headed                         Run browser in headed mode
  --require-pass                   Exit non-zero if verdict fails
  --no-screenshot                  Do not capture end-of-run screenshot
  -h, --help                       Show this help
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

configure_profile() {
  case "$PROFILE" in
    balanced)
      BASE_DELAY_MS=100
      BASE_PLR=0.01
      BASE_BW=4Mbit/s
      SPIKE_EVERY_SECS=5
      SPIKE_DURATION_SECS=1.2
      SPIKE_DELAY_MS=1200
      SPIKE_PLR=0.20
      SPIKE_BW=800Kbit/s
      ;;
    harsh)
      BASE_DELAY_MS=120
      BASE_PLR=0.01
      BASE_BW=4Mbit/s
      SPIKE_EVERY_SECS=3
      SPIKE_DURATION_SECS=1.8
      SPIKE_DELAY_MS=1800
      SPIKE_PLR=0.35
      SPIKE_BW=450Kbit/s
      ;;
    extreme)
      BASE_DELAY_MS=140
      BASE_PLR=0.02
      BASE_BW=2Mbit/s
      SPIKE_EVERY_SECS=2.5
      SPIKE_DURATION_SECS=2.2
      SPIKE_DELAY_MS=2600
      SPIKE_PLR=0.45
      SPIKE_BW=250Kbit/s
      ;;
    *)
      echo "Unknown profile: ${PROFILE}" >&2
      exit 1
      ;;
  esac
}

cleanup() {
  set +e
  if [[ "$LAG_STARTED" -eq 1 ]]; then
    "${ROOT_DIR}/scripts/simulate-lag-spikes.sh" stop >"${RUN_DIR}/lag-stop.log" 2>&1 || true
  fi
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
      --profile)
        PROFILE="$2"
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
      --tuning-overrides-json)
        TUNING_OVERRIDES_JSON="$2"
        shift 2
        ;;
      --no-stack-start)
        NO_STACK_START=1
        shift
        ;;
      --no-lag-control)
        NO_LAG_CONTROL=1
        shift
        ;;
      --headed)
        HEADLESS=0
        shift
        ;;
      --require-pass)
        REQUIRE_PASS=1
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
  require_cmd npx
  require_cmd curl

  if ! awk -v v="$DURATION_SECS" 'BEGIN { exit !(v > 0) }'; then
    echo "--duration-secs must be > 0" >&2
    exit 1
  fi

  configure_profile

  if [[ -z "$RUN_LABEL" ]]; then
    RUN_LABEL="run-$(date -u +%Y%m%dT%H%M%SZ)-${PROFILE}"
  fi

  RUN_DIR="${OUTPUT_DIR}/${RUN_LABEL}"
  mkdir -p "$RUN_DIR"
  REPORT_JSON="${RUN_DIR}/report.json"

  trap cleanup EXIT INT TERM

  echo "[lag-automation] run_dir=${RUN_DIR}"
  echo "[lag-automation] profile=${PROFILE} duration_secs=${DURATION_SECS} app_url=${APP_URL}"

  if [[ "$NO_STACK_START" -eq 0 ]]; then
    STACK_LOG="${RUN_DIR}/local-dev-copy.log"
    (
      cd "$ROOT_DIR"
      ./run-local-dev-copy.sh
    ) >"$STACK_LOG" 2>&1 &
    STACK_PID=$!
    echo "[lag-automation] started run-local-dev-copy.sh pid=${STACK_PID}"

    wait_for_http "${APP_URL}" 240
    wait_for_http "http://127.0.0.1:${BACKEND_PORT}/api/health" 240
    echo "[lag-automation] app and backend are reachable"
  else
    wait_for_http "${APP_URL}" 90
    wait_for_http "http://127.0.0.1:${BACKEND_PORT}/api/health" 90
    echo "[lag-automation] attach mode: existing app/backend detected"
  fi

  if [[ "$NO_LAG_CONTROL" -eq 0 ]]; then
    sudo -v
    (
      cd "$ROOT_DIR"
      PORTS="$BACKEND_PORT" \
      BASE_DELAY_MS="$BASE_DELAY_MS" BASE_PLR="$BASE_PLR" BASE_BW="$BASE_BW" \
      SPIKE_ENABLED=1 SPIKE_EVERY_SECS="$SPIKE_EVERY_SECS" SPIKE_DURATION_SECS="$SPIKE_DURATION_SECS" \
      SPIKE_DELAY_MS="$SPIKE_DELAY_MS" SPIKE_PLR="$SPIKE_PLR" SPIKE_BW="$SPIKE_BW" \
      ./scripts/simulate-lag-spikes.sh start
    ) >"${RUN_DIR}/lag-start.log" 2>&1
    LAG_STARTED=1
    (
      cd "$ROOT_DIR"
      ./scripts/simulate-lag-spikes.sh status
    ) >"${RUN_DIR}/lag-status-start.txt" 2>&1 || true
    echo "[lag-automation] lag simulator started"
  else
    echo "[lag-automation] lag control disabled by flag"
  fi

  BOT_CMD=(
    node
    "${ROOT_DIR}/scripts/lag-bot-runner.mjs"
    --app-url "$APP_URL"
    --duration-secs "$DURATION_SECS"
    --output-json "$REPORT_JSON"
    --scenario-name "$PROFILE"
  )

  if [[ "$NO_SCREENSHOT" -eq 0 ]]; then
    BOT_CMD+=(--screenshot "${RUN_DIR}/snapshot.png")
  fi

  if [[ "$HEADLESS" -eq 0 ]]; then
    BOT_CMD+=(--headed)
  fi
  if [[ -n "$TUNING_OVERRIDES_JSON" ]]; then
    BOT_CMD+=(--tuning-overrides-json "$TUNING_OVERRIDES_JSON")
  fi
  if [[ "$REQUIRE_PASS" -eq 1 ]]; then
    BOT_CMD+=(--require-pass)
  fi

  "${BOT_CMD[@]}" | tee "${RUN_DIR}/bot-summary.log"

  if [[ "$NO_LAG_CONTROL" -eq 0 ]]; then
    (
      cd "$ROOT_DIR"
      ./scripts/simulate-lag-spikes.sh status
    ) >"${RUN_DIR}/lag-status-end.txt" 2>&1 || true
  fi

  echo "[lag-automation] report=${REPORT_JSON}"
}

main "$@"
