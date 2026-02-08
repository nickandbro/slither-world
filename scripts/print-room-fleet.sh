#!/usr/bin/env bash
set -euo pipefail

CONTROL_URL="${CONTROL_URL:-http://localhost:8787}"
if [[ -z "${ROOM_HEARTBEAT_TOKEN:-}" ]]; then
  echo "ROOM_HEARTBEAT_TOKEN is required." >&2
  exit 1
fi

URL="${CONTROL_URL%/}/internal/rooms?token=${ROOM_HEARTBEAT_TOKEN}"
if command -v jq >/dev/null 2>&1; then
  curl -fsS "${URL}" | jq .
else
  curl -fsS "${URL}"
fi
