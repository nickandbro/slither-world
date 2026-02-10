#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

usage() {
  cat <<'EOF'
Usage: scripts/deploy-prod.sh [options]

Deploys backend (GHCR image + Hetzner control-plane/rooms) and frontend (Cloudflare Worker) to production.

Options:
  --skip-backend        Skip backend image build/push and server rollout.
  --skip-frontend       Skip Cloudflare Worker deploy.
  --skip-room-rollout   Skip deleting room servers (keeps existing room VMs running old ROOM_IMAGE).
  --skip-verify         Skip post-deploy matchmake + websocket upgrade verification.
  --no-commit-image     Update infra/prod-backend-image.txt but do not commit/push it.
  -h, --help            Show this help.

Environment variables:
  IMAGE_REPO        Backend image repo (default: ghcr.io/nickandbro/slither-world-backend)
  IMAGE_TAG         Override computed image tag (default: prod-YYYYMMDD-<git short sha>)
  IMAGE_FILE        File to write deployed image to (default: infra/prod-backend-image.txt)
  GHCR_USERNAME     Username for GHCR docker login (default: nickandbro)
  BUILDER           Docker buildx builder (default: desktop-linux)
  PLATFORM          Docker build platform (default: linux/amd64)

  CONTROL_HOST      Hetzner control-plane host (default: 178.156.136.148)
  CONTROL_USER      SSH user (default: root)
  CONTROL_SSH_KEY   SSH key for control-plane (default: ~/.ssh/hetzner_server)

  PROD_ORIGIN       Public prod origin for verification (default: https://slitherworld.com)
EOF
}

SKIP_BACKEND=0
SKIP_FRONTEND=0
SKIP_ROOM_ROLLOUT=0
SKIP_VERIFY=0
NO_COMMIT_IMAGE=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-backend) SKIP_BACKEND=1 ;;
    --skip-frontend) SKIP_FRONTEND=1 ;;
    --skip-room-rollout) SKIP_ROOM_ROLLOUT=1 ;;
    --skip-verify) SKIP_VERIFY=1 ;;
    --no-commit-image) NO_COMMIT_IMAGE=1 ;;
    -h|--help) usage; exit 0 ;;
    *)
      echo "Unknown arg: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

require_cmd git
require_cmd curl
require_cmd openssl
require_cmd python3
require_cmd ssh

if [[ "$SKIP_FRONTEND" -eq 0 ]]; then
  require_cmd npm
fi

if [[ "$SKIP_BACKEND" -eq 0 ]]; then
  require_cmd docker
  require_cmd gh
fi

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [[ "$BRANCH" != "main" ]]; then
  echo "Refusing to deploy from non-main branch: $BRANCH" >&2
  exit 1
fi

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "Working tree is dirty. Commit or stash changes first." >&2
  exit 1
fi

git fetch origin main >/dev/null
read -r behind ahead < <(git rev-list --left-right --count origin/main...HEAD)
if [[ "${behind}" != "0" ]]; then
  echo "Local main is behind origin/main (behind=${behind}). Pull/rebase first." >&2
  exit 1
fi
if [[ "${ahead}" != "0" ]]; then
  git push origin main
fi

DATE_UTC="$(date -u +%Y%m%d)"
CODE_SHA="$(git rev-parse --short HEAD)"
IMAGE_REPO="${IMAGE_REPO:-ghcr.io/nickandbro/slither-world-backend}"
IMAGE_TAG="${IMAGE_TAG:-prod-${DATE_UTC}-${CODE_SHA}}"
IMAGE="${IMAGE_REPO}:${IMAGE_TAG}"
LATEST_IMAGE="${IMAGE_REPO}:latest"

CONTROL_HOST="${CONTROL_HOST:-178.156.136.148}"
CONTROL_USER="${CONTROL_USER:-root}"
CONTROL_SSH_KEY="${CONTROL_SSH_KEY:-$HOME/.ssh/hetzner_server}"
SSH_TARGET="${CONTROL_USER}@${CONTROL_HOST}"

IMAGE_FILE="${IMAGE_FILE:-infra/prod-backend-image.txt}"
PROD_ORIGIN="${PROD_ORIGIN:-https://slitherworld.com}"

echo "Deploy plan:"
echo "  backend:  $([[ \"$SKIP_BACKEND\" -eq 0 ]] && echo yes || echo no)"
echo "  frontend: $([[ \"$SKIP_FRONTEND\" -eq 0 ]] && echo yes || echo no)"
echo "  rooms:    $([[ \"$SKIP_ROOM_ROLLOUT\" -eq 0 ]] && echo yes || echo no)"
echo "  verify:   $([[ \"$SKIP_VERIFY\" -eq 0 ]] && echo yes || echo no)"
echo "  image:    ${IMAGE}"

ssh_control() {
  ssh -i "$CONTROL_SSH_KEY" \
    -o IdentitiesOnly=yes \
    -o BatchMode=yes \
    -o StrictHostKeyChecking=accept-new \
    -o ConnectTimeout=10 \
    "$SSH_TARGET" "$@"
}

if [[ "$SKIP_BACKEND" -eq 0 ]]; then
  echo "Building + pushing backend image..."
  gh auth token | docker login ghcr.io -u "${GHCR_USERNAME:-nickandbro}" --password-stdin >/dev/null
  docker buildx build \
    --builder "${BUILDER:-desktop-linux}" \
    --platform "${PLATFORM:-linux/amd64}" \
    --push \
    -t "${IMAGE}" \
    -t "${LATEST_IMAGE}" \
    backend

  echo "Rolling control-plane to ${IMAGE}..."
  ssh_control bash -s -- "$IMAGE" <<'EOF'
set -euo pipefail

NEW_IMAGE="$1"
ENV_FILE="/root/snake-control.env"

cp -a "$ENV_FILE" "${ENV_FILE}.bak.$(date +%Y%m%d-%H%M%S)"
sed -i "s|^ROOM_IMAGE=.*$|ROOM_IMAGE=${NEW_IMAGE}|" "$ENV_FILE"

docker pull "$NEW_IMAGE" >/dev/null
docker rm -f snake-control >/dev/null 2>&1 || true
docker run -d \
  --name snake-control \
  --restart unless-stopped \
  --env-file "$ENV_FILE" \
  -p 80:80 \
  "$NEW_IMAGE" >/dev/null

for i in $(seq 1 30); do
  if curl -fsS http://127.0.0.1/api/health >/dev/null 2>&1; then
    echo "health-ok"
    exit 0
  fi
  sleep 1
done

docker logs --tail 120 snake-control || true
echo "health-timeout" >&2
exit 1
EOF

  if [[ "$SKIP_ROOM_ROLLOUT" -eq 0 ]]; then
    echo "Deleting room servers to force ROOM_IMAGE rollout..."
    ssh_control bash -s <<'EOF'
set -euo pipefail

python3 - <<'PY'
import json
import urllib.parse
import urllib.request

def read_env_value(path: str, key: str):
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            if line.startswith(key + "="):
                return line.strip().split("=", 1)[1]
    return None

token = read_env_value("/root/snake-control.env", "HETZNER_API_TOKEN")
if not token:
    raise SystemExit("missing HETZNER_API_TOKEN")

selector = "app=spherical-snake-room,managed_by=snake-control"
url = "https://api.hetzner.cloud/v1/servers?label_selector=" + urllib.parse.quote(selector)
req = urllib.request.Request(url, headers={"Authorization": "Bearer " + token})
with urllib.request.urlopen(req, timeout=20) as resp:
    data = json.load(resp)
servers = data.get("servers", [])
print(f"room_servers={len(servers)}")
for s in servers:
    sid = s.get("id")
    name = s.get("name")
    labels = s.get("labels") or {}
    room_id = labels.get("room_id")
    print(f"deleting serverId={sid} name={name} room_id={room_id}")
    del_url = f"https://api.hetzner.cloud/v1/servers/{sid}"
    del_req = urllib.request.Request(del_url, method="DELETE", headers={"Authorization": "Bearer " + token})
    with urllib.request.urlopen(del_req, timeout=30) as del_resp:
        del_resp.read()
print("delete_requests_submitted")
PY

docker restart snake-control >/dev/null
for i in $(seq 1 30); do
  if curl -fsS http://127.0.0.1/api/health >/dev/null 2>&1; then
    echo "health-ok"
    exit 0
  fi
  sleep 1
done

docker logs --tail 160 snake-control || true
echo "health-timeout" >&2
exit 1
EOF
  fi
fi

if [[ "$SKIP_FRONTEND" -eq 0 ]]; then
  echo "Deploying frontend worker..."
  npm -C frontend run deploy
fi

if [[ "$SKIP_VERIFY" -eq 0 ]]; then
  echo "Verifying production endpoints..."
  matchmake_json="$(curl -fsS -X POST "${PROD_ORIGIN%/}/api/matchmake" -H 'content-type: application/json' -d '{}')"
  room_id="$(python3 -c 'import json,sys; print(json.load(sys.stdin)[\"roomId\"])' <<<"$matchmake_json")"
  room_token="$(python3 -c 'import json,sys; print(json.load(sys.stdin)[\"roomToken\"])' <<<"$matchmake_json")"

  ws_key="$(openssl rand -base64 16)"
  ws_headers="$(curl --http1.1 -sS --max-time 5 -D - -o /dev/null \
    -H 'Connection: Upgrade' \
    -H 'Upgrade: websocket' \
    -H 'Sec-WebSocket-Version: 13' \
    -H \"Sec-WebSocket-Key: ${ws_key}\" \
    \"${PROD_ORIGIN%/}/api/room/${room_id}?rt=${room_token}\" 2>/dev/null || true)"

  if ! grep -qE '^HTTP/1\\.1 101 ' <<<"$ws_headers"; then
    echo "WebSocket upgrade failed; headers:" >&2
    echo "$ws_headers" >&2
    exit 1
  fi

  echo "verify-ok"
fi

if [[ "$SKIP_BACKEND" -eq 0 ]]; then
  echo "Updating ${IMAGE_FILE} -> ${IMAGE}"
  printf '%s\n' "$IMAGE" > "$IMAGE_FILE"

  if [[ "$NO_COMMIT_IMAGE" -eq 0 ]]; then
    git add "$IMAGE_FILE"
    if ! git diff --cached --quiet -- "$IMAGE_FILE"; then
      git commit -m "chore(infra): update prod backend image to ${IMAGE_TAG}"
      git push origin main
    fi
  fi
fi

echo "Done."
