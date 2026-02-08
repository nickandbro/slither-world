#!/usr/bin/env bash
set -euo pipefail

# macOS local-network lag simulator for Snake dev/testing traffic.
# Applies dummynet rules only to TCP traffic on configured localhost ports.
#
# Usage:
#   ./scripts/simulate-lag-spikes.sh start
#   ./scripts/simulate-lag-spikes.sh stop
#   ./scripts/simulate-lag-spikes.sh status
#
# Common overrides:
#   BACKEND_PORT=8788
#   BASE_DELAY_MS=320 BASE_PLR=0.10 BASE_BW=600Kbit/s
#   SPIKE_ENABLED=1 SPIKE_EVERY_SECS=2.2 SPIKE_DURATION_SECS=3.8
#   SPIKE_DELAY_MS=7000 SPIKE_PLR=0.99 SPIKE_BW=35Kbit/s
#   # Optional multi-port override (not backend-only):
#   PORTS=8818,8788

readonly SCRIPT_NAME="$(basename "$0")"
readonly ANCHOR_NAME="com.apple/snake-lag"
readonly PIPE_ID="${PIPE_ID:-51000}"
readonly STATE_FILE="/tmp/snake-lag-sim.state"
readonly ANCHOR_FILE="/tmp/snake-lag-sim.pf.conf"
readonly LOOP_LOG_FILE="/tmp/snake-lag-sim.loop.log"

BACKEND_PORT="${BACKEND_PORT:-8788}"
PORTS_CSV="${PORTS:-${BACKEND_PORT}}"
BASE_DELAY_MS="${BASE_DELAY_MS:-320}"
BASE_PLR="${BASE_PLR:-0.10}"
BASE_BW="${BASE_BW:-600Kbit/s}"
SPIKE_ENABLED="${SPIKE_ENABLED:-1}"
SPIKE_EVERY_SECS="${SPIKE_EVERY_SECS:-2.2}"
SPIKE_DURATION_SECS="${SPIKE_DURATION_SECS:-3.8}"
SPIKE_DELAY_MS="${SPIKE_DELAY_MS:-7000}"
SPIKE_PLR="${SPIKE_PLR:-0.99}"
SPIKE_BW="${SPIKE_BW:-35Kbit/s}"
PARSED_PORTS=()

require_macos() {
  if [[ "$(uname -s)" != "Darwin" ]]; then
    echo "${SCRIPT_NAME} is macOS-only (requires pfctl + dnctl)." >&2
    exit 1
  fi
}

require_cmd() {
  local cmd="$1"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Required command not found: ${cmd}" >&2
    exit 1
  fi
}

ensure_root() {
  if [[ "${EUID}" -ne 0 ]]; then
    exec sudo -E "$0" "$@"
  fi
}

trim_spaces() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

parse_ports() {
  local input="$1"
  PARSED_PORTS=()
  IFS=',' read -r -a raw_ports <<< "$input"
  for raw in "${raw_ports[@]}"; do
    local port
    port="$(trim_spaces "$raw")"
    if [[ -z "$port" ]]; then
      continue
    fi
    if [[ ! "$port" =~ ^[0-9]{1,5}$ ]]; then
      echo "Invalid port in PORTS: ${port}" >&2
      exit 1
    fi
    if (( port < 1 || port > 65535 )); then
      echo "Port out of range in PORTS: ${port}" >&2
      exit 1
    fi
    PARSED_PORTS+=("$port")
  done

  if [[ "${#PARSED_PORTS[@]}" -eq 0 ]]; then
    echo "No valid ports found in PORTS (${input})." >&2
    exit 1
  fi
}

validate_probability() {
  local value="$1"
  local label="$2"
  if ! awk -v v="$value" 'BEGIN { exit !(v >= 0 && v <= 1) }'; then
    echo "${label} must be between 0.0 and 1.0. Got: ${value}" >&2
    exit 1
  fi
}

validate_positive_number() {
  local value="$1"
  local label="$2"
  if ! awk -v v="$value" 'BEGIN { exit !(v > 0) }'; then
    echo "${label} must be > 0. Got: ${value}" >&2
    exit 1
  fi
}

format_pf_ports() {
  local -a ports=("$@")
  if [[ "${#ports[@]}" -eq 1 ]]; then
    printf '%s' "${ports[0]}"
    return
  fi

  local joined=""
  local idx=0
  for port in "${ports[@]}"; do
    if (( idx > 0 )); then
      joined+=", "
    fi
    joined+="${port}"
    idx=$((idx + 1))
  done
  printf '{ %s }' "$joined"
}

pipe_config_cmd() {
  local delay_ms="$1"
  local plr="$2"
  local bw="$3"

  local -a cmd=(
    dnctl
    pipe
    "${PIPE_ID}"
    config
    delay
    "${delay_ms}ms"
    plr
    "${plr}"
  )
  if [[ -n "$bw" ]]; then
    cmd+=(bw "$bw")
  fi
  "${cmd[@]}" >/dev/null
}

write_anchor_file() {
  local pf_ports="$1"
  cat >"${ANCHOR_FILE}" <<EOF
dummynet in quick on lo0 proto tcp from any to any port ${pf_ports} pipe ${PIPE_ID}
dummynet in quick on lo0 proto tcp from any port ${pf_ports} to any pipe ${PIPE_ID}
dummynet out quick on lo0 proto tcp from any to any port ${pf_ports} pipe ${PIPE_ID}
dummynet out quick on lo0 proto tcp from any port ${pf_ports} to any pipe ${PIPE_ID}
EOF
}

load_anchor_rules() {
  local output cleaned
  output="$(pfctl -a "${ANCHOR_NAME}" -f "${ANCHOR_FILE}" 2>&1)" || {
    printf '%s\n' "${output}" >&2
    exit 1
  }

  cleaned="$(printf '%s\n' "${output}" | sed \
    -e '/Use of -f option/d' \
    -e '/present in the main ruleset added by the system at startup/d' \
    -e '/See \/etc\/pf.conf for further details/d' \
    -e '/No ALTQ support in kernel/d' \
    -e '/ALTQ related functions disabled/d')"
  if [[ -n "${cleaned//[[:space:]]/}" ]]; then
    printf '%s\n' "${cleaned}" >&2
  fi
}

enable_pf_and_get_token() {
  local output token
  output="$(pfctl -E 2>&1 || true)"
  token="$(printf '%s\n' "${output}" | awk '/Token/ { print $NF }' | tail -n 1)"
  if [[ -z "${token}" ]]; then
    echo "Failed to enable pf and acquire token." >&2
    printf '%s\n' "${output}" >&2
    exit 1
  fi
  printf '%s' "${token}"
}

start_spike_loop() {
  (
    while true; do
      sleep "${SPIKE_EVERY_SECS}"
      printf '%s spike_on delay=%sms plr=%s bw=%s\n' \
        "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" \
        "${SPIKE_DELAY_MS}" \
        "${SPIKE_PLR}" \
        "${SPIKE_BW:-none}"
      pipe_config_cmd "${SPIKE_DELAY_MS}" "${SPIKE_PLR}" "${SPIKE_BW}"
      sleep "${SPIKE_DURATION_SECS}"
      printf '%s spike_off delay=%sms plr=%s bw=%s\n' \
        "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" \
        "${BASE_DELAY_MS}" \
        "${BASE_PLR}" \
        "${BASE_BW:-none}"
      pipe_config_cmd "${BASE_DELAY_MS}" "${BASE_PLR}" "${BASE_BW}"
    done
  ) >>"${LOOP_LOG_FILE}" 2>&1 &
  printf '%s' "$!"
}

cleanup_from_state() {
  local pf_token="${1:-}"
  local loop_pid="${2:-}"

  if [[ -n "${loop_pid}" ]] && kill -0 "${loop_pid}" >/dev/null 2>&1; then
    kill "${loop_pid}" >/dev/null 2>&1 || true
    wait "${loop_pid}" 2>/dev/null || true
  fi

  pfctl -a "${ANCHOR_NAME}" -F all >/dev/null 2>&1 || true
  dnctl pipe "${PIPE_ID}" delete >/dev/null 2>&1 || true

  if [[ -n "${pf_token}" ]]; then
    pfctl -X "${pf_token}" >/dev/null 2>&1 || true
  fi
}

write_state() {
  local pf_token="$1"
  local loop_pid="$2"
  cat >"${STATE_FILE}" <<EOF
PF_TOKEN="${pf_token}"
LOOP_PID="${loop_pid}"
PIPE_ID="${PIPE_ID}"
ANCHOR_NAME="${ANCHOR_NAME}"
PORTS_CSV="${PORTS_CSV}"
SPIKE_ENABLED="${SPIKE_ENABLED}"
EOF
}

read_state_var() {
  local key="$1"
  if [[ ! -f "${STATE_FILE}" ]]; then
    return 1
  fi
  awk -F= -v k="${key}" '$1 == k { gsub(/^"/, "", $2); gsub(/"$/, "", $2); print $2 }' "${STATE_FILE}" | tail -n 1
}

cmd_start() {
  parse_ports "${PORTS_CSV}"
  local -a ports=("${PARSED_PORTS[@]}")

  validate_positive_number "${BASE_DELAY_MS}" "BASE_DELAY_MS"
  validate_probability "${BASE_PLR}" "BASE_PLR"
  validate_positive_number "${SPIKE_DELAY_MS}" "SPIKE_DELAY_MS"
  validate_probability "${SPIKE_PLR}" "SPIKE_PLR"
  validate_positive_number "${SPIKE_EVERY_SECS}" "SPIKE_EVERY_SECS"
  validate_positive_number "${SPIKE_DURATION_SECS}" "SPIKE_DURATION_SECS"

  # Remove any previous local state for this script before re-applying.
  cmd_stop >/dev/null 2>&1 || true

  local pf_ports
  pf_ports="$(format_pf_ports "${ports[@]}")"
  local pf_token
  pf_token="$(enable_pf_and_get_token)"
  write_anchor_file "${pf_ports}"
  load_anchor_rules

  pipe_config_cmd "${BASE_DELAY_MS}" "${BASE_PLR}" "${BASE_BW}"
  : >"${LOOP_LOG_FILE}"

  local loop_pid=""
  if [[ "${SPIKE_ENABLED}" == "1" ]]; then
    loop_pid="$(start_spike_loop)"
  fi

  write_state "${pf_token}" "${loop_pid}"
  echo "Lag simulation enabled on localhost ports: ${PORTS_CSV}"
  echo "Backend-only default is active when PORTS is not explicitly set (BACKEND_PORT=${BACKEND_PORT})."
  echo "Base profile: delay=${BASE_DELAY_MS}ms plr=${BASE_PLR} bw=${BASE_BW:-none}"
  if [[ "${SPIKE_ENABLED}" == "1" ]]; then
    echo "Spike profile: every ${SPIKE_EVERY_SECS}s for ${SPIKE_DURATION_SECS}s, delay=${SPIKE_DELAY_MS}ms plr=${SPIKE_PLR} bw=${SPIKE_BW:-none}"
    echo "Spike loop PID: ${loop_pid}"
  else
    echo "Spike profile: disabled"
  fi
  echo "Use '${SCRIPT_NAME} status' to inspect, '${SCRIPT_NAME} stop' to clean up."
}

cmd_stop() {
  local pf_token loop_pid
  pf_token="$(read_state_var PF_TOKEN || true)"
  loop_pid="$(read_state_var LOOP_PID || true)"
  cleanup_from_state "${pf_token}" "${loop_pid}"

  rm -f "${STATE_FILE}" "${ANCHOR_FILE}"

  echo "Lag simulation disabled."
}

cmd_status() {
  local pf_token loop_pid
  pf_token="$(read_state_var PF_TOKEN || true)"
  loop_pid="$(read_state_var LOOP_PID || true)"

  if [[ -f "${STATE_FILE}" ]]; then
    echo "State file: ${STATE_FILE}"
    echo "PF token: ${pf_token:-<none>}"
    if [[ -n "${loop_pid}" ]] && kill -0 "${loop_pid}" >/dev/null 2>&1; then
      echo "Spike loop: running (PID ${loop_pid})"
    elif [[ -n "${loop_pid}" ]]; then
      echo "Spike loop: not running (stale PID ${loop_pid})"
    else
      echo "Spike loop: disabled"
    fi
  else
    echo "State file not found; lag simulation may be disabled."
  fi

  echo
  echo "PF dummynet rules (${ANCHOR_NAME}):"
  pfctl -a "${ANCHOR_NAME}" -s dummynet 2>/dev/null || true
  echo
  echo "PF filter rules (${ANCHOR_NAME}) (expected empty):"
  pfctl -a "${ANCHOR_NAME}" -s rules 2>/dev/null || true
  echo
  echo "dummynet pipe (${PIPE_ID}):"
  dnctl pipe show "${PIPE_ID}" 2>/dev/null || true
  echo
  echo "Spike loop log tail (${LOOP_LOG_FILE}):"
  if [[ -f "${LOOP_LOG_FILE}" ]]; then
    tail -n 20 "${LOOP_LOG_FILE}"
  else
    echo "<no spike log yet>"
  fi
}

main() {
  require_macos
  require_cmd pfctl
  require_cmd dnctl

  local action="${1:-}"
  if [[ -z "${action}" ]]; then
    echo "Usage: ${SCRIPT_NAME} {start|stop|status}" >&2
    exit 1
  fi

  ensure_root "$@"

  case "${action}" in
    start) cmd_start ;;
    stop) cmd_stop ;;
    status) cmd_status ;;
    *)
      echo "Unknown action: ${action}" >&2
      echo "Usage: ${SCRIPT_NAME} {start|stop|status}" >&2
      exit 1
      ;;
  esac
}

main "$@"
