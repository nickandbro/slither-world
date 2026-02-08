# Cloudflare + Hetzner Deployment Guide

This project now supports three backend runtime roles via `SNAKE_ROLE`:

- `standalone` (default): existing single-process local/dev mode.
- `control`: matchmaking + autoscaler + Hetzner API provisioning.
- `room`: one authoritative game room per server.

## 1) Build and publish the room image

Publish an image that runs the backend binary and exposes port `8787`.

Example image entrypoint should run:

```bash
SNAKE_ROLE=room PORT=8787 ./snake-game-backend
```

Set the image tag in control-plane env var `ROOM_IMAGE`.

## 2) Deploy control-plane (Hetzner VM or any host)

Required env vars:

```bash
SNAKE_ROLE=control
PORT=8787
HETZNER_API_TOKEN=...
ROOM_IMAGE=ghcr.io/<org>/<repo>:<tag>
CONTROL_PLANE_URL=https://control.your-domain.com
ROOM_HEARTBEAT_TOKEN=<shared-secret>
ROOM_TOKEN_SECRET=<shared-secret>
ROOM_PROXY_SECRET=<shared-secret>
ROOM_CAPACITY=25
MIN_WARM_ROOMS=1
ROOM_IDLE_SCALE_DOWN_SECS=180
HETZNER_LOCATION=ash
HETZNER_SERVER_TYPE=cpx11
HETZNER_IMAGE=ubuntu-24.04
HETZNER_ROOM_FIREWALL_IDS=<comma-separated-firewall-ids>
ROOM_PORT=8787
```

Notes:

- `CONTROL_PLANE_URL` must be reachable by room servers.
- `HETZNER_ROOM_FIREWALL_IDS` is required and is applied at server-create time so every autoscaled room gets firewall rules immediately.
- Control-plane exposes:
  - `POST /api/matchmake`
  - `POST /internal/room-heartbeat` (Bearer auth with `ROOM_HEARTBEAT_TOKEN`)
  - `GET /internal/rooms?token=<ROOM_HEARTBEAT_TOKEN>` (ops/debug)

## 2.1) Configure Hetzner firewalls (recommended baseline)

Create a control-plane firewall:
- Inbound `80/tcp` from `0.0.0.0/0` and `::/0`
- Inbound `22/tcp` only from trusted admin IP CIDRs

Create a room firewall:
- Inbound `80/tcp` from `0.0.0.0/0` and `::/0`
- No SSH ingress

Attach firewalls in two ways:
- Set `HETZNER_ROOM_FIREWALL_IDS` to the room firewall ID(s) so new room servers are born with the policy.
- Also attach by label selectors for existing fleet safety:
  - control-plane selector: `app=spherical-snake-control,managed_by=snake-control`
  - room selector: `app=spherical-snake-room,managed_by=snake-control`

## 3) Deploy Cloudflare Worker

Worker now:

- Serves static frontend assets.
- Proxies `POST /api/matchmake` to control-plane.
- Verifies room tokens and proxies `/api/room/:room` websocket upgrades to room servers.

Set Wrangler var:

```bash
CONTROL_PLANE_ORIGIN=https://control.your-domain.com
```

Set Worker secrets:

```bash
wrangler secret put ROOM_TOKEN_SECRET
wrangler secret put ROOM_PROXY_SECRET
```

`ROOM_TOKEN_SECRET` and `ROOM_PROXY_SECRET` must exactly match control-plane values.

## 4) Local smoke test

Control-plane:

```bash
cd backend
SNAKE_ROLE=control \
HETZNER_API_TOKEN=... \
ROOM_IMAGE=... \
CONTROL_PLANE_URL=http://localhost:8787 \
ROOM_HEARTBEAT_TOKEN=dev-heartbeat \
ROOM_TOKEN_SECRET=dev-room-token \
ROOM_PROXY_SECRET=dev-room-proxy \
cargo run
```

Frontend dev (direct to control-plane endpoints):

```bash
cd frontend
VITE_BACKEND_URL=http://localhost:8787 npm run dev
```

## 5) Autoscaling behavior

- Matchmaking assigns to first non-full room (`playerCount < 25`).
- If all rooms are full, control-plane provisions a new Hetzner server and room.
- Room servers send heartbeats every 2 seconds with current player count.
- Control-plane scales down rooms when:
  - `playerCount == 0`
  - room has been idle longer than `ROOM_IDLE_SCALE_DOWN_SECS`
  - warm room floor `MIN_WARM_ROOMS` is still satisfied.
