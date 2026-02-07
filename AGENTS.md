# Repository Guidelines

This repo is split into a Vite + React + TypeScript frontend and a Rust (Tokio) backend. Cloudflare Workers now only serve the static frontend build; multiplayer and leaderboard traffic goes to the Rust server.

## Project Gist
Spherical Snake is a multiplayer, slither-style snake game where players steer glowing snakes across a tiny planet. The React/Three.js client renders a static planet patch atlas (fixed topology) with camera/view-based patch + environment culling and an HUD (including compact head-anchored stamina/oxygen depletion meters) with selectable WebGL/WebGPU backends. A Rust server (Tokio + Axum) runs the authoritative game loop and sends per-session, view-scoped snapshots over WebSockets. The leaderboard is stored in SQLite on the backend.

## Project Structure & Module Organization
- `frontend/` — Vite + React client and Cloudflare Worker for static asset serving.
- `frontend/src/` — React UI source (`App.tsx`, `main.tsx`, CSS, and `assets/`).
- `frontend/src/game/` — client gameplay helpers (math, camera, snapshots, HUD, storage).
- `frontend/src/game/wsProtocol.ts` — binary WebSocket codec (ArrayBuffer/DataView).
- `frontend/src/render/` — Three.js scene + renderer backend selection (`webglScene.ts`).
- `frontend/src/services/` — client API wrappers (leaderboard + backend URL helpers).
- `frontend/worker/` — minimal Cloudflare Worker entry (`worker/index.ts`) that serves `dist/`.
- `frontend/public/` — static assets copied as-is.
- `frontend/docs/` — Cloudflare Workers reference notes.
- `frontend/dist/` — production build output.
- `frontend/vite.config.ts`, `frontend/tsconfig.*.json`, `frontend/wrangler*.toml/jsonc`, `frontend/eslint.config.js` — frontend tooling/config.
- `backend/` — Rust server (Tokio runtime) for multiplayer + leaderboard.
- `backend/src/game/` — authoritative game loop, math, digestion, snake logic, room handling.
- `backend/src/protocol.rs` — binary WebSocket protocol codec + constants.
- `backend/src/shared/` — shared helpers (name sanitization).
- `backend/migrations/` — SQLite schema migrations.
- `backend/data/` — default SQLite database location.

## Build, Test, and Development Commands
Repo root (recommended for full stack):
- `./run-dev.sh` — run backend + frontend for local dev (ports 8788 + 5177 by default). Uses `cargo watch` for backend hot reload when available and falls back to `cargo run` if install fails.
- `./run-e2e.sh` — start backend + frontend for Playwright E2E (ports 8790 + 5177 by default).

## Testing Expectations
- Default validation should be lightweight: prefer targeted checks such as `npm run build`, `npm run lint`, and focused backend/frontend tests relevant to the change.
- Do **not** create new Playwright E2E specs for every change by default.
- Do **not** run `npm run test:e2e` unless the user explicitly asks for E2E execution.
- Only add or run E2E coverage when explicitly requested by the user (or when the task is explicitly E2E-focused).

## Configuration & Deployment Notes
- Backend API routes:
  - `GET /api/leaderboard` and `POST /api/leaderboard` (JSON).
  - `GET /api/room/:room` WebSocket endpoint for multiplayer (binary frames).
- Debug-only route (guarded by `ENABLE_DEBUG_COMMANDS=1`):
  - `POST /api/debug/kill?room=<room>&target=bot|human|any` — force-kill a player for tests.
- Frontend can target the backend with `VITE_BACKEND_URL` (e.g. `http://localhost:8787`). When unset, it uses same-origin.
- Frontend debug hooks are enabled when `VITE_E2E_DEBUG=1` (exposes `window.__SNAKE_DEBUG__` for Playwright).
- Frontend renderer selection is controlled by URL query param `renderer=auto|webgpu|webgl` and persisted to localStorage key `spherical_snake_renderer`.
- Default renderer mode is `auto`: it attempts WebGPU first and falls back to WebGL with a status note if WebGPU is unavailable or init fails.
- Changing renderer mode from the control panel performs a full page reload (required because canvas context type cannot be switched in-place).
- Startup flow is a pre-spawn hero menu over the live world: before gameplay starts, the menu shows only a pilot-name input and a `Play` button.
- Pre-spawn hero copy is intentionally minimal: title text is `Slither World` with no subtitle or pilot-name label.
- Pre-spawn menu overlay does not dim the scene; the live world remains fully visible behind the controls.
- The client always boots into room `main` for the pre-spawn menu view (with live bots/world already running beneath the menu); room switching remains available from the in-game control panel after spawn.
- Menu framing uses an elevated pre-spawn camera offset so the planet rim sits around mid-screen, then blends smoothly into snake-follow gameplay camera after clicking `Play`.
- During pre-spawn, gameplay HUD/panels (scorebar, control panel, leaderboard, info panel) remain hidden and are restored after entering gameplay.
- Renderer initialization is async; when touching render bootstrapping, ensure the latest server `Environment` and debug flags are applied immediately after scene creation to avoid visual collider desync from backend-authoritative collisions.
- Debug collider toggles (mountain outlines, lake collider boundary, cactus collider rings) are surfaced in the control panel in dev/e2e only and persist to localStorage keys `spherical_snake_mountain_debug`, `spherical_snake_lake_debug`, `spherical_snake_tree_debug` (legacy `treeCollider`/key naming is still used internally for cactus collider debug state).
- Terrain wireframe toggle is surfaced in dev/e2e and persists to `spherical_snake_terrain_wireframe_debug` (legacy read fallback: `spherical_snake_terrain_tessellation_debug`).
- Backend SQLite uses `DATABASE_URL` (default: `sqlite://data/leaderboard.db`). Migrations run at startup.
- Cloudflare Worker serves static assets only; no Durable Objects or D1 bindings remain.
- The client renders interpolated snapshots from the server tick; avoid bypassing the snapshot buffer when changing netcode or visuals.
- Digestion bumps are identity-tracked across snapshots: each digestion item includes a stable `id` plus `progress`, and interpolation is ID-based to prevent bump jumps when older digestions complete during tail growth.
- Boosting is stamina-gated on the server. Stamina drains while boosting and recharges when not boosting; `PlayerSnapshot` includes `stamina` for the HUD. The local stamina bar is head-anchored and only shown while below max (depleting/recharging).
- Client boost visuals are split intentionally: the viewport speed-line overlay (`.boost-fx`) remains a local screen-space effect, while world-space boost visuals include ground skid marks and a front-of-head draft hemisphere.
- Oxygen drains while underwater; `PlayerSnapshot` includes `oxygen` for the HUD and the client renders a fishbowl with crack shader as oxygen runs low. Reaching zero oxygen causes immediate death (no periodic body-shrink phase), and there is no separate red damage-blink effect.
- Snake girth is server-authoritative and grows per added node (equivalent to `+10%` per 10 nodes), capped at `2.0x`. Girth scales snake/environment collider radii (including spawn safety checks), and self-collision near-head checks are widened for thicker snakes to avoid false deaths.
- In dev/e2e, `window.__SNAKE_DEBUG__.getRendererInfo()` reports `{ requestedBackend, activeBackend, fallbackReason }` for renderer assertions.
- In dev/e2e, `window.__SNAKE_DEBUG__.getMenuFlowInfo()` reports `{ phase, hasSpawned, cameraBlend, cameraDistance }` for pre-spawn flow and camera-transition assertions.
- In dev/e2e, terrain/culling assertions use `window.__SNAKE_DEBUG__.getTerrainPatchInfo()` and `window.__SNAKE_DEBUG__.getEnvironmentCullInfo()`.
- In dev/e2e, snake-grounding assertions use `window.__SNAKE_DEBUG__.getSnakeGroundingInfo()` and read `{ minClearance, maxPenetration, maxAppliedLift, sampleCount }`.
- In dev/e2e, boost-draft assertions can use `window.__SNAKE_DEBUG__.getBoostDraftInfo(id)` and read `{ visible, opacity, planeCount }` (`planeCount` is currently `1` for the hemispherical draft mesh).
- Spawning is collision-safe: new spawns are rejected if any node overlaps existing alive snakes. Respawn retries are delayed if no safe spot is found.
- Multiplayer WebSocket payloads are custom binary frames (versioned header). Current protocol version is `10`; when the protocol changes, deploy frontend and backend together. Join frames include `FLAG_JOIN_DEFER_SPAWN` so clients can connect/update identity without immediate spawn (used by the pre-spawn menu flow). The server still accepts JSON `Text` frames for backwards compatibility, but always sends binary. Client codec lives in `frontend/src/game/wsProtocol.ts`. State/init snapshots include `u16 total_players` plus a per-session view-scoped player list; the server always includes the local player and includes remote players only when they have a visible non-stub snake window for that session view. Player payload entries include `u8 is_boosting` + `f32 girth_scale` + `f32 tail_extension` (after `oxygen`), and pellet payload entries are encoded as `u32 pellet_id` + quantized normal (`i16 x/y/z`) + `u8 color_index` + `u8 size`.
- Player digestion payload entries are encoded as `u32 digestion_id` + `f32 progress` + `f32 strength` in the binary stream (count remains `u8`).
- Small pellet digestion behavior is merged per player per tick: consumed pellet growth fractions are aggregated into one digestion event with weighted bump strength; growth is applied authoritatively at tail arrival (including fractional tail extension before full-node commits).
- Tail node commits from digestion are paced at a maximum of one node per movement substep; excess fractional growth stays in `tail_extension` for later substeps to avoid burst tail jumps.
- Pellet economy is intentionally decoupled between growth and score: big pellets grant `0.10` physical growth, small pellets grant `1/20` of big growth (`0.005`), and scoring is normalized in big-pellet units so `1` big pellet still yields `+1` score.

## Debug / Test Utilities
- `scripts/debug-kill.sh` — helper to hit the debug kill endpoint (defaults to room `main`, target `bot`).

## Planet Rendering Notes
- Default terrain path is a fixed-topology patch atlas (`PLANET_PATCH_ENABLED`): a full deformed icosphere is built once, partitioned into static spherical bins (`buildPlanetPatchAtlas`), and each patch mesh visibility is toggled per-frame (`updatePlanetPatchVisibility`) based on camera view angle + hysteresis.
- Environment objects are camera/view-culled per-frame (`updateEnvironmentVisibility`) with horizon-aware occlusion handling and zoom-dependent preload margins so trees/cactuses/rocks/pebbles render ahead of the edge when zoomed out.
- Tree culling is height-aware: both trunk-base and canopy-top sample points are used so tall edge trees stay visible at zoom-out.
- Cactus culling is multi-point and branch-aware: trunk base/top plus left/right arm tip sample points are used so branch silhouettes do not pop late near the horizon.
- Environment generation is biome-aware and deterministic: a desert region (`DESERT_BIOME_ANGLE`) hosts cactuses (`DESERT_CACTUS_COUNT`), while lakes and mountains are kept out of the desert region.
- Cactuses are serialized through the legacy `trees` payload for protocol compatibility (`width_scale < 0` means cactus) and are rendered client-side as connected spine tubes (`TubeGeometry`) plus cap/joint spheres, with slight base sink into terrain.
- Lake visibility is view-angle-driven (`updateLakeVisibility`) with generous edge margins/hysteresis to avoid late edge pop-in at high zoom distances.
- Snake visual grounding is mesh-aware: segment/head/tail placement samples the deformed terrain mesh (with analytic fallback) and applies a tiny positive contact clearance to reduce slope clipping and z-fighting.
- Boost draft visuals are rendered as a front-anchored hemispherical shell near the snake head (low-opacity blue/white wisp tint, shader-based edge fade to full transparency at boundaries) and are only visible while that snake is actively boosting.
- Digestion bulges are applied in tube-ring space with identity-tracked progress, and the visual start is anchored by a fixed node index near the neck (default: one node behind the head) instead of a percentage-based body offset. Bulge intensity scales down as snake girth increases so larger snakes show subtler swallow bumps.
- Pellet visuals use a slither-style multi-layer sprite stack in color buckets (`THREE.Points`) for high counts: dark under-shadow + bright core + near/far additive glow layers with seeded per-pellet orbital wobble; keep updates allocation-light and preserve per-pellet terrain grounding so sprites stay on top of elevated/sunken terrain.
- Shoreline fill and shoreline line meshes are generated from the full deformed planet geometry in both patch and fallback paths to keep lake edges coherent.
- Fallback terrain path (when patch mode is disabled) renders a full deformed icosphere mesh (`createIcosphereGeometry` + `applyLakeDepressions`).
- Lakes are rendered with backend-specific paths:
  - WebGL: per-lake spherical meshes masked with `onBeforeCompile`.
  - WebGPU: generated lake surface geometry fallback for near visual parity.
- To prevent shoreline seams, terrain depth is clamped to at least the lake surface depth, lake surfaces are slightly overdrawn/expanded, and lake materials use polygon offset to win depth testing.
- Fishbowl crack visuals are exact in WebGL (`onBeforeCompile`) and approximated in WebGPU for parity without WebGL-only shader hooks.
- Implementation lives in `frontend/src/render/webglScene.ts` (`buildPlanetPatchAtlas`, `updatePlanetPatchVisibility`, `updateEnvironmentVisibility`, `updateLakeVisibility`, `createLakes`, `sampleLakes`, `applyLakeDepressions`, `createLakeMaskMaterial`, `createLakeSurfaceGeometry`).
- Mountain collider outlines are generated on the backend (smoothed radial samples) and visualized on the client via the debug overlay; lake and tree collider rings are rendered as line loops when debug is enabled.
