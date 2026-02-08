#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

APP_URL="${APP_URL:-http://localhost:8818}"
BACKEND_PORT="${BACKEND_PORT:-8788}"
PROFILE="${PROFILE:-harsh}"
DURATION_SECS="${DURATION_SECS:-60}"
OUTPUT_DIR="${OUTPUT_DIR:-${ROOT_DIR}/output/lag-tests}"
HEADLESS=1
NO_STACK_START=0

STACK_PID=""
LAG_STARTED=0
RUN_DIR=""
RUNS_DIR=""
SUMMARY_JSON=""
BEST_JSON=""

usage() {
  cat <<USAGE
Usage: $(basename "$0") [options]

Options:
  --app-url <url>                  App URL (default: ${APP_URL})
  --backend-port <port>            Backend port (default: ${BACKEND_PORT})
  --profile <balanced|harsh|extreme>
  --duration-secs <secs>           Per-candidate duration (default: ${DURATION_SECS})
  --output-dir <dir>               Output root (default: ${OUTPUT_DIR})
  --headed                         Run browser headed
  --no-stack-start                 Attach to already running app/backend
  -h, --help                       Show help
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

append_summary() {
  local label="$1"
  local tuning_json="$2"
  local report_path="$3"
  local run_log="$4"

  node - "$SUMMARY_JSON" "$label" "$tuning_json" "$report_path" "$run_log" <<'NODE'
const fs = require('node:fs')
const [summaryPath, label, tuningJson, reportPath, runLog] = process.argv.slice(2)
const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'))

const entry = {
  label,
  tuningOverrides: JSON.parse(tuningJson),
  reportPath,
  runLog,
  ok: false,
  pass: false,
  score: Number.POSITIVE_INFINITY,
  checks: [],
  error: null,
}

if (!fs.existsSync(reportPath)) {
  entry.error = 'missing report.json'
} else {
  try {
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'))
    entry.ok = true
    entry.pass = !!report?.verdict?.pass
    entry.score = Number.isFinite(report?.verdict?.score) ? report.verdict.score : Number.POSITIVE_INFINITY
    entry.checks = Array.isArray(report?.checks) ? report.checks : []
    entry.aggregates = report?.aggregates ?? null
    entry.motion = report?.motion ?? null
    entry.failedChecks = report?.verdict?.failedChecks ?? []
  } catch (error) {
    entry.error = error instanceof Error ? error.message : String(error)
  }
}

summary.push(entry)
fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`)
NODE
}

choose_best() {
  node - "$SUMMARY_JSON" "$BEST_JSON" <<'NODE'
const fs = require('node:fs')
const [summaryPath, bestPath] = process.argv.slice(2)
const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'))

const usable = summary.filter((entry) => entry.ok)
const ranked = usable
  .slice()
  .sort((a, b) => {
    if (a.pass !== b.pass) return a.pass ? -1 : 1
    return a.score - b.score
  })

const best = ranked[0] ?? null
const output = {
  generatedAtIso: new Date().toISOString(),
  totalCandidates: summary.length,
  usableCandidates: usable.length,
  passCount: usable.filter((entry) => entry.pass).length,
  best,
  ranked,
}

fs.writeFileSync(bestPath, `${JSON.stringify(output, null, 2)}\n`)
console.log(JSON.stringify(output, null, 2))
NODE
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
      --profile)
        PROFILE="$2"
        shift 2
        ;;
      --duration-secs)
        DURATION_SECS="$2"
        shift 2
        ;;
      --output-dir)
        OUTPUT_DIR="$2"
        shift 2
        ;;
      --headed)
        HEADLESS=0
        shift
        ;;
      --no-stack-start)
        NO_STACK_START=1
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

  RUN_DIR="${OUTPUT_DIR}/autotune-$(date -u +%Y%m%dT%H%M%SZ)-${PROFILE}"
  RUNS_DIR="${RUN_DIR}/runs"
  SUMMARY_JSON="${RUN_DIR}/autotune-summary.json"
  BEST_JSON="${RUN_DIR}/best-candidate.json"
  mkdir -p "$RUNS_DIR"
  printf '[]\n' >"$SUMMARY_JSON"

  trap cleanup EXIT INT TERM

  echo "[lag-autotune] run_dir=${RUN_DIR}"

  if [[ "$NO_STACK_START" -eq 0 ]]; then
    (
      cd "$ROOT_DIR"
      ./run-local-dev-copy.sh
    ) >"${RUN_DIR}/local-dev-copy.log" 2>&1 &
    STACK_PID=$!
    echo "[lag-autotune] started run-local-dev-copy.sh pid=${STACK_PID}"

    wait_for_http "${APP_URL}" 240
    wait_for_http "http://127.0.0.1:${BACKEND_PORT}/api/health" 240
  else
    wait_for_http "${APP_URL}" 90
    wait_for_http "http://127.0.0.1:${BACKEND_PORT}/api/health" 90
  fi

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

  declare -a CANDIDATES=(
    'baseline|{}'
    'max-delay-5p5|{"netMaxDelayTicks":5.5}'
    'max-delay-5|{"netMaxDelayTicks":5.0}'
    'max-delay-4p5|{"netMaxDelayTicks":4.5}'
    'base-delay-2|{"netBaseDelayTicks":2.0}'
    'base-delay-1p9|{"netBaseDelayTicks":1.9}'
    'jitter-mult-1p4|{"netJitterDelayMultiplier":1.4}'
    'jitter-mult-1p2|{"netJitterDelayMultiplier":1.2}'
    'jitter-cap-1p3|{"netJitterDelayMaxTicks":1.3}'
    'jitter-cap-0p9|{"netJitterDelayMaxTicks":0.9}'
    'boost-ticks-1p8|{"netSpikeDelayBoostTicks":1.8}'
    'boost-ticks-1p4|{"netSpikeDelayBoostTicks":1.4}'
    'decay-160|{"netDelayBoostDecayPerSec":160}'
    'decay-220|{"netDelayBoostDecayPerSec":220}'
    'impair-hold-320|{"netSpikeImpairmentHoldMs":320}'
    'impair-hold-260|{"netSpikeImpairmentHoldMs":260}'
    'impair-max-1000|{"netSpikeImpairmentMaxHoldMs":1000}'
    'confirm-faster|{"netSpikeEnterConfirmMs":110,"netSpikeExitConfirmMs":220}'
    'combo-arrival-calm|{"netMaxDelayTicks":4.8,"netBaseDelayTicks":1.9,"netJitterDelayMultiplier":1.25,"netJitterDelayMaxTicks":0.95,"netSpikeDelayBoostTicks":1.4,"netDelayBoostDecayPerSec":200,"netSpikeImpairmentHoldMs":280,"netSpikeImpairmentMaxHoldMs":900,"netSpikeEnterConfirmMs":120,"netSpikeExitConfirmMs":230,"localSnakeStabilizerRateSpike":4.0}'
    'combo-smooth-spike|{"netMaxDelayTicks":5.0,"netBaseDelayTicks":2.1,"netJitterDelayMultiplier":1.35,"netJitterDelayMaxTicks":1.05,"netSpikeDelayBoostTicks":1.6,"netDelayBoostDecayPerSec":180,"netSpikeImpairmentHoldMs":300,"netSpikeImpairmentMaxHoldMs":1000,"netSpikeEnterConfirmMs":120,"netSpikeExitConfirmMs":250,"netCameraSpikeFollowRate":4.4,"localSnakeStabilizerRateSpike":3.8}'
    'combo-low-latency-stable|{"netMaxDelayTicks":4.6,"netBaseDelayTicks":1.85,"netJitterDelayMultiplier":1.2,"netJitterDelayMaxTicks":0.9,"netSpikeDelayBoostTicks":1.35,"netDelayBoostDecayPerSec":220,"netSpikeImpairmentHoldMs":250,"netSpikeImpairmentMaxHoldMs":850,"netSpikeEnterConfirmMs":100,"netSpikeExitConfirmMs":210,"netCameraSpikeFollowRate":4.8,"localSnakeStabilizerRateSpike":4.2}'
  )

  local idx=0
  for candidate in "${CANDIDATES[@]}"; do
    idx=$((idx + 1))
    label="${candidate%%|*}"
    tuning_json="${candidate#*|}"
    run_log="${RUN_DIR}/${idx}-${label}.log"

    echo "[lag-autotune] (${idx}/${#CANDIDATES[@]}) running ${label}"

    cmd=(
      "${ROOT_DIR}/scripts/run-lag-automation.sh"
      --no-stack-start
      --no-lag-control
      --app-url "$APP_URL"
      --backend-port "$BACKEND_PORT"
      --duration-secs "$DURATION_SECS"
      --profile "$PROFILE"
      --output-dir "$RUNS_DIR"
      --run-label "$label"
      --no-screenshot
    )

    if [[ "$HEADLESS" -eq 0 ]]; then
      cmd+=(--headed)
    fi
    if [[ "$tuning_json" != '{}' ]]; then
      cmd+=(--tuning-overrides-json "$tuning_json")
    fi

    if "${cmd[@]}" >"$run_log" 2>&1; then
      :
    else
      echo "[lag-autotune] warning: run command failed for ${label}" >&2
    fi

    append_summary "$label" "$tuning_json" "${RUNS_DIR}/${label}/report.json" "$run_log"
  done

  choose_best | tee "${RUN_DIR}/best-summary.log"

  (
    cd "$ROOT_DIR"
    ./scripts/simulate-lag-spikes.sh status
  ) >"${RUN_DIR}/lag-status-end.txt" 2>&1 || true

  echo "[lag-autotune] summary=${SUMMARY_JSON}"
  echo "[lag-autotune] best=${BEST_JSON}"
}

main "$@"
