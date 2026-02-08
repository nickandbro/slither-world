# Deployment Notes (Cloudflare + Hetzner)

## Current Production Topology
- Cloudflare worker + static client:
  - Primary hostnames: `https://slitherworld.com`, `https://www.slitherworld.com`
  - Workers.dev fallback: `https://snake-game.nickbrooks085.workers.dev`
  - Zone routes: `slitherworld.com/*` and `www.slitherworld.com/*` -> `snake-game`
- Hetzner control-plane VM:
  - `snake-control-prod`
  - IPv4: `178.156.136.148`
- Room autoscaling model:
  - One room per Hetzner VM (`snake-room-*`)
  - Capacity per room: `25`
  - Warm-room floor: `1`
  - Scale-down idle window: `180s`

## Current Runtime Image
- Backend image in use:
  - `ghcr.io/nickandbro/slither-world-backend:prod-20260208-firewall-amd64-022020`

## Firewall Posture (2026-02-08)
- Control-plane firewall:
  - Name: `snake-control-fw`
  - ID: `10502341`
  - Inbound allow: `80/tcp` from `0.0.0.0/0`, `::/0`
  - Inbound allow: `22/tcp` from trusted admin CIDR only
- Room firewall:
  - Name: `snake-room-fw`
  - ID: `10502342`
  - Inbound allow: `80/tcp` from `0.0.0.0/0`, `::/0`
  - SSH inbound blocked by default
- Attachment strategy:
  - Label-selector attach for existing fleet:
    - Control selector: `app=spherical-snake-control,managed_by=snake-control`
    - Room selector: `app=spherical-snake-room,managed_by=snake-control`
  - Create-time attach for new room servers via control-plane env:
    - `HETZNER_ROOM_FIREWALL_IDS=10502342`

## Critical Fixes Applied (2026-02-08)
- `7d6e7e9`: fixed room cloud-init startup script generation and worker room-origin normalization for WS proxying.
- `6a7a591`: fixed idle room scale-down heartbeat activity tracking.
- `prod-20260208-firewall-amd64-022020`: added control-plane create-time firewall assignment (`HETZNER_ROOM_FIREWALL_IDS`) for autoscaled room VMs.
- Room ID truncation fix (WS token mismatch):
  - Frontend no longer truncates server-assigned room IDs before websocket connect.
  - Frontend room sanitization length increased to `64`.
  - Backend control-plane preferred room sanitization length increased to `64`.

## WS Failure Root Cause (Resolved)
- Symptom:
  - Browser websocket failed when URL contained a truncated room ID, e.g. `room-e0d805ef307540a`.
  - Token claim contained full room ID (e.g. `room-e0d805ef307540a0b0315c6a8f787d47`), causing path/token mismatch.
- Cause:
  - Frontend `sanitizeRoomName()` previously truncated to 20 characters.
- Resolution:
  - Increased room-name bound to 64 and stopped truncating `assignment.roomId` from `/api/matchmake`.

## Cloudflare Worker Settings
- Required vars/secrets:
  - Var: `CONTROL_PLANE_ORIGIN=http://static.148.136.156.178.clients.your-server.de`
  - Secret: `ROOM_TOKEN_SECRET`
  - Secret: `ROOM_PROXY_SECRET`
- Note:
  - Worker-to-origin proxying must avoid direct Cloudflare IP-style upstreams; Hetzner reverse DNS hostname is used.

## Hetzner Control-Plane Env Highlights
- `SNAKE_ROLE=control`
- `PORT=80`
- `ROOM_PORT=80`
- `ROOM_CAPACITY=25`
- `MIN_WARM_ROOMS=1`
- `ROOM_IDLE_SCALE_DOWN_SECS=180`
- `HETZNER_LOCATION=ash`
- `HETZNER_SERVER_TYPE=cpx11`
- `HETZNER_IMAGE=ubuntu-24.04`
- `HETZNER_ROOM_FIREWALL_IDS=10502342`
- `ROOM_REGISTRY_USERNAME=<configured>`
- `ROOM_REGISTRY_PASSWORD=<configured>`

## Verification Checklist Used
- Matchmake through worker returns `200`.
- WS connect through worker stays open/stable.
- Load test to 25 active joined sessions keeps assignment to one room.
- 26th assignment creates a second room/server.
- Newly created room server has `snake-room-fw` attached on create (not only after selector reconciliation).
- After all clients disconnect and idle threshold elapses, room fleet scales back to one warm room.

## Firewall Rollout Verification (2026-02-08)
- Control-plane container env includes:
  - `HETZNER_ROOM_FIREWALL_IDS=10502342`
  - `ROOM_IMAGE=ghcr.io/nickandbro/slither-world-backend:prod-20260208-firewall-amd64-022020`
- Autoscale validation created a fresh room VM:
  - Room ID: `room-b771b8625e774b2bac5e5a1a26218f34`
  - Hetzner server ID: `120348252`
  - Firewall on server public net: `10502342` with status `applied`
