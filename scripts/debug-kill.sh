#!/usr/bin/env bash
set -euo pipefail

BACKEND_URL="${BACKEND_URL:-http://localhost:8790}"
ROOM="${ROOM:-main}"
TARGET="${TARGET:-bot}"

curl -fsS -X POST "${BACKEND_URL}/api/debug/kill?room=${ROOM}&target=${TARGET}"
