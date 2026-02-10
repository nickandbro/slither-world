# Repository Guidelines

This repo is split into a Vite + React + TypeScript frontend and a Rust (Tokio) backend. Cloudflare Workers serve the static frontend build and proxy matchmaking/room traffic to the Rust server; gameplay authority and leaderboard persistence remain on the Rust backend.

## Project Gist
Spherical Snake is a multiplayer, slither-style snake game where players steer glowing snakes across a tiny planet. Snakes can overlap their own bodies (self-collision is non-lethal), while head-to-body collisions with other snakes remain lethal. The React/Three.js client renders a static planet patch atlas (fixed topology) with camera/view-based patch + environment culling and an HUD (including compact head-anchored oxygen depletion meters plus a radial score interval gauge) with selectable WebGL/WebGPU backends. A Rust server (Tokio + Axum) runs the authoritative game loop and sends per-session, view-scoped snapshots over WebSockets. The in-game leaderboard panel is a realtime room scorecard driven by snapshot player data (top 5 alive snakes). Persisted leaderboard entries are still stored in SQLite on the backend via API routes.

## Project Structure & Module Organization
- `frontend/` — Vite + React client and Cloudflare Worker for static asset serving plus matchmaking/room proxying.
- `frontend/src/` — React UI source (`App.tsx`, `main.tsx`, CSS, and `assets/`).
- `frontend/src/app/` — app-level UI decomposition (`components/`) and shared app runtime helpers (`core/`).
- `frontend/src/game/` — client gameplay helpers (math, camera, snapshots, HUD, storage).
- `frontend/src/game/wsProtocol.ts` — binary WebSocket codec (ArrayBuffer/DataView).
- `frontend/src/game/skins.ts` — localStorage snake-skin design persistence + selection helpers.
- `frontend/src/render/` — Three.js renderer entrypoint (`webglScene.ts`) plus runtime internals (`render/core/sceneRuntime.ts`).
- `frontend/src/services/` — client API wrappers (leaderboard + backend URL helpers).
- `frontend/worker/` — Cloudflare Worker entry (`worker/index.ts`) that serves `dist/client` assets and proxies `/api/matchmake` + `/api/room/:room`.
- `frontend/public/` — static assets copied as-is.
- `frontend/docs/` — Cloudflare Workers reference notes.
- `frontend/dist/` — production build output.
- `frontend/vite.config.ts`, `frontend/tsconfig.*.json`, `frontend/wrangler*.toml/jsonc`, `frontend/eslint.config.js` — frontend tooling/config.
- `backend/` — Rust server (Tokio runtime) for multiplayer + leaderboard.
- `backend/src/game/` — authoritative game loop, math, digestion, snake logic, room handling.
- `backend/src/protocol.rs` — binary WebSocket protocol codec + constants.
- `backend/src/shared/` — shared helpers (name sanitization + room token signing).
- `backend/migrations/` — SQLite schema migrations.
- `backend/data/` — default SQLite database location.

## Build, Test, and Development Commands
Repo root (recommended for full stack):
- `./run-e2e.sh` — start backend + frontend for Playwright E2E (ports 8790 + 5177 by default).
- `./run-local-dev-copy.sh` — local stack runner on ports 8788 + 8818 by default. `--worker` mode (default) is production-like (standalone backend + local Wrangler Worker) and defaults to watch mode (backend restarts via `cargo watch`; frontend rebuilds via `vite build --watch` with a browser refresh). Use `WATCH=0` or `--no-watch` for one-shot; use `--vite` for Vite dev server HMR (no rebuild, backend accessed directly).
- `./scripts/simulate-lag-spikes.sh start|stop|status` — macOS-only PF/dummynet lag simulation helper. Defaults to backend-only shaping (`BACKEND_PORT`, default `8788`); use `PORTS=...` only when intentionally shaping additional ports.
- `./scripts/run-lag-automation.sh` — single automated lag scenario run (bot drives movement/boost while lag shaping is active). Writes `report.json` under `output/lag-tests/<run-label>/`.
- `./scripts/lag-autotune.sh` — multi-candidate lag tuning sweep. Runs repeated `run-lag-automation.sh` scenarios and ranks candidates by motion stability + delay metrics.
- Frontend production deploy script (`frontend/package.json`) uses an obfuscated client build (`npm run build:obfuscated`) before `wrangler deploy -c wrangler.toml`.

## Testing Expectations
- Default validation should be lightweight: prefer targeted checks such as `npm run build`, `npm run lint`, and focused backend/frontend tests relevant to the change.
- Do **not** create new Playwright E2E specs for every change by default.
- Do **not** run `npm run test:e2e` unless the user explicitly asks for E2E execution.
- Only add or run E2E coverage when explicitly requested by the user (or when the task is explicitly E2E-focused).
- For lag-handling changes, prefer script-based validation over ad hoc manual checks:
  - Run at least one automated baseline pass (`./scripts/run-lag-automation.sh --profile harsh --duration-secs 45 --no-screenshot`).
  - For tuning work, run `./scripts/lag-autotune.sh` and compare `best-candidate.json` + per-run `report.json` outputs.
- If you see Chrome console warnings like `[Violation] 'requestAnimationFrame' handler took <N>ms` (visible stutter), enable the optional rAF perf instrumentation (`?rafPerf=1`) and capture `window.__SNAKE_DEBUG__.getRafPerfInfo()`. During investigation, slow frames were dominated by `renderMs` (time spent inside `webgl.render()`), which points to renderer/GPU stalls (often shader/pipeline warm-up). The issue resolved after the renderer warmed up (a short run or a reload), with no evidence that snapshot interpolation/HUD work was the source.
- If you see Chrome console warnings like `[Violation] 'requestAnimationFrame' handler took <N>ms` (visible stutter), enable the optional rAF perf instrumentation (`?rafPerf=1`) and capture `window.__SNAKE_DEBUG__.getRafPerfInfo()` plus `window.__SNAKE_DEBUG__.getRenderPerfInfo()`. Slow frames dominated by `renderMs` point to work inside `webgl.render()` (renderer/GPU stalls, pass-level spikes, or shader/pipeline compilation); with `?rafPerf=1`, the console slow-frame warning also emits a `[render] ...` line with pass timings (`passWorld`, `passOccluders`, `passPellets`, `passDepthRebuild`, `passLakes`).

## Configuration & Deployment Notes
- Production deployment specifics (as of February 8, 2026):
  - Cloudflare production hostnames: `https://slitherworld.com` and `https://www.slitherworld.com`.
  - Workers.dev fallback hostname remains available: `https://snake-game.nickbrooks085.workers.dev`.
  - Worker routes are managed as zone routes: `slitherworld.com/*` and `www.slitherworld.com/*` -> service `snake-game`.
  - Hetzner control-plane host: `snake-control-prod` (`178.156.136.148`) running backend image `ghcr.io/nickandbro/slither-world-backend:prod-20260208-lag-autotune-73d9c68`.
  - Hetzner firewalls are in place:
    - Control-plane firewall `snake-control-fw`: allow inbound `80/tcp` from internet and `22/tcp` only from trusted admin IPs.
    - Room firewall `snake-room-fw`: allow inbound `80/tcp` from internet and block SSH ingress.
    - Firewalls are also attached by label selectors (`app=spherical-snake-control` / `app=spherical-snake-room`) as a fleet-wide safety net.
  - Current warm room server naming: `snake-room-<room-id>` (one room per server), managed by control-plane labels `app=spherical-snake-room` and `managed_by=snake-control`.
  - Autoscale knobs in production are `ROOM_CAPACITY=25`, `MIN_WARM_ROOMS=1`, and `ROOM_IDLE_SCALE_DOWN_SECS=180`.
  - Control-plane room provisioning requires `HETZNER_ROOM_FIREWALL_IDS` (comma-separated firewall IDs) so newly autoscaled room servers inherit firewall rules at create time.
  - Production network port mode is `PORT=80` and `ROOM_PORT=80` for control-plane/room containers.
  - Registry pull mode is required for room bootstrapping: control-plane must have `ROOM_IMAGE` plus `ROOM_REGISTRY_USERNAME`/`ROOM_REGISTRY_PASSWORD` to pull private GHCR images.
  - Worker must set `CONTROL_PLANE_ORIGIN` to a hostname (Hetzner reverse-DNS host is used in prod), not a raw IP, to avoid Cloudflare direct-IP upstream rejection.
  - Worker secrets must match control-plane values exactly: `ROOM_TOKEN_SECRET` and `ROOM_PROXY_SECRET`.
  - Room IDs are not short aliases. Treat server-assigned `roomId` values as opaque IDs (length up to 64) and do not truncate before websocket connect; token `roomId` and websocket path room must match exactly.
  - Operational runbook/details should also be kept in `infra/deployment-notes.md` whenever production deployment settings change.
- Backend API routes:
  - `POST /api/matchmake` (JSON, room token issuance for worker-mediated room joins).
  - `GET /api/leaderboard` and `POST /api/leaderboard` (JSON).
  - `GET /api/room/:room` WebSocket endpoint for multiplayer (binary frames).
- Standalone backend mode also serves `POST /api/matchmake` and is configurable with `STANDALONE_MATCHMAKE_CAPACITY`, `STANDALONE_ROOM_TOKEN_TTL_SECS`, and `STANDALONE_ROOM_ORIGIN`.
- For localhost worker testing, `STANDALONE_ROOM_ORIGIN` should use `http://localhost:<port>` (not raw IPv4) so worker room-origin normalization does not rewrite it to a Hetzner hostname.
- Debug-only route (guarded by `ENABLE_DEBUG_COMMANDS=1`):
  - `POST /api/debug/kill?room=<room>&target=bot|human|any` — force-kill a player for tests.
- Frontend can target the backend with `VITE_BACKEND_URL` (e.g. `http://localhost:8787`). When unset, it uses same-origin.
- Debug UI controls (renderer/collider/day-night/debug panel toggles) are enabled in `import.meta.env.DEV` or when `VITE_E2E_DEBUG=1`.
- `window.__SNAKE_DEBUG__` runtime hooks are exposed during local runs (including `run-local-dev-copy.sh`). Network debug logging defaults on localhost and can be toggled via `?netDebug=1|0` or localStorage key `spherical_snake_net_debug`.
- Menu snake-skin designs are stored in localStorage (`spherical_snake_skins_v1` for saved designs, `spherical_snake_selected_skin_v1` for the current selection).
- Frontend renderer selection is controlled by URL query param `renderer=auto|webgpu|webgl` and persisted to localStorage key `spherical_snake_renderer`.
- Default renderer mode is `auto`: it attempts WebGPU first and falls back to WebGL with a status note if WebGPU is unavailable or init fails.
- Changing renderer mode from the control panel performs a full page reload (required because canvas context type cannot be switched in-place).
- Startup flow is a pre-spawn hero menu over the live world: before gameplay starts, the menu shows a pilot-name input, a primary play button (`Play` on initial load, `Play again` after returning from a death), and a lower-right `Change skin` button.
- `Change skin` opens a 3D preview + saved-design picker plus a builder flow; builder designs can be seeded with `1..=8` colors and repeat to fill the 8-slot spawn pattern.
- Pre-spawn hero copy is intentionally minimal: title text is `Slither World` with no subtitle or pilot-name label.
- Pre-spawn menu controls use an immediate, clean drop-in CSS entrance (title/input/button short stagger) with reduced-motion fallback.
- Clicking `Play`/`Play again` fades the menu overlay out before spawn/join is sent and before the menu-to-gameplay camera blend begins.
- Pre-spawn menu overlay does not dim the scene; the live world remains fully visible behind the controls.
- The client always boots into room `main` for the pre-spawn menu view (with live bots/world already running beneath the menu); room switching remains available from the in-game control panel after spawn.
- Menu framing uses an elevated pre-spawn camera offset so the planet rim sits around mid-screen, then blends smoothly into snake-follow gameplay camera after clicking `Play`.
- On local death, the client keeps gameplay view briefly for the death-to-pellet moment, then smoothly animates the camera back to the pre-spawn menu framing.
- After that death-return, the player remains deferred-spawn on the menu (no automatic respawn) until they click `Play again`.
- During pre-spawn, gameplay HUD/panels (bottom-left player-stats text, control panel, leaderboard) remain hidden and are restored after entering gameplay.
- The in-game right-side leaderboard is a realtime overlay (not a card UI): it ranks the top 5 alive snakes in the active room by live score (`score + scoreFraction`) and shows a crown icon beside `#1`.
- Renderer initialization is async; when touching render bootstrapping, ensure the latest server `Environment` and debug flags are applied immediately after scene creation to avoid visual collider desync from backend-authoritative collisions.
- Debug collider toggles (mountain outlines, lake collider boundary, cactus collider rings) are surfaced in the control panel in dev/e2e only and persist to localStorage keys `spherical_snake_mountain_debug`, `spherical_snake_lake_debug`, `spherical_snake_tree_debug` (legacy `treeCollider`/key naming is still used internally for cactus collider debug state).
- Terrain wireframe toggle is surfaced in dev/e2e and persists to `spherical_snake_terrain_wireframe_debug` (legacy read fallback: `spherical_snake_terrain_tessellation_debug`).
- Backend SQLite uses `DATABASE_URL` (default: `sqlite://data/leaderboard.db`). Migrations run at startup.
- Cloudflare Worker serves static assets and proxies matchmaking/room websocket traffic; no Durable Objects or D1 bindings remain.
- The client renders interpolated snapshots from the server tick; avoid bypassing the snapshot buffer when changing netcode or visuals.
- Snapshot interpolation should preserve meta-derived fields on `PlayerSnapshot` (e.g. `skinColors`) so cosmetics remain stable during interpolation.
- Client lag-spike mitigation is playout-buffer based and currently includes: capped jitter-derived delay (`netJitterDelayMaxTicks`), arrival-gap reentry cooldown/hysteresis, smooth playout-delay retargeting, and spike-class camera behavior (camera hold/recovery for harder spikes like `stale`/`seq-gap`, milder handling for `arrival-gap`).
- Current default lag-tuning baseline (`frontend/src/app/core/constants.ts`): `netBaseDelayTicks=1.85`, `netMinDelayTicks=1.8`, `netMaxDelayTicks=4.6`, `netJitterDelayMultiplier=1.2`, `netJitterDelayMaxTicks=0.9`, `netSpikeDelayBoostTicks=1.35`, `netDelayBoostDecayPerSec=220`, `netSpikeImpairmentHoldMs=250`, `netSpikeImpairmentMaxHoldMs=850`.
- Digestion bumps are identity-tracked across snapshots: each digestion item includes a stable `id` plus `progress`, and interpolation is ID-based to prevent bump jumps when older digestions complete during tail growth.
- Boosting is length-backed on the server. While boosting, snakes drain tail length smoothly over time and auto-stop at a per-life boost floor set from the spawned snake length (never below `MIN_SURVIVAL_LENGTH`); on spawn/respawn, score initializes to the spawned snake length. Boost can also burn pending (in-flight) digestion growth as fuel when at the floor so boosting stays responsive even before the tail visibly grows. Boost start is gated by whole-score threshold (`spawn floor + 1`, so default spawn length `8` requires score `9` to begin boosting; fractional `8.x` cannot start). `PlayerSnapshot` includes `scoreFraction` for the radial score interval HUD. The in-game text HUD shows bottom-left `Your length` (integer score) and `Your rank` (`1-5` only when present in the realtime top-5 list, otherwise `-`, always rendered as `of <total players>`). The head-anchored radial gauge depletes the spendable reserve above that life's spawn floor (empty at spawn-length floor), uses whole-number center text, and applies a green->yellow->red fill ramp by remaining reserve. Gauge capacity is seeded from reserve at boost start, can grow mid-boost if reserve exceeds the current cap (pellet gains), and the displayed fill smoothly retargets to cap/reserve changes instead of snapping. The red crossed-circle lockout overlay is shown only when the player is actively trying to boost while below the start threshold, plus a brief post-depletion flash while boost input is still held; during lockout rendering, only the crossed-circle is drawn (no gauge ring/fill/text), and fade-out keeps the lockout visual held until opacity reaches zero to avoid gauge glimmer.
- Client boost visuals are split intentionally: the viewport speed-line overlay (`.boost-fx`) remains a local screen-space effect, while world-space boost visuals include ground skid marks and a front-of-head draft hemisphere.
- Oxygen drains while underwater; `PlayerSnapshot` includes `oxygen` for the HUD and the client renders a fishbowl with crack shader as oxygen runs low. Reaching zero oxygen causes immediate death (no periodic body-shrink phase), and there is no separate red damage-blink effect.
- Snake girth is server-authoritative and grows per added node (equivalent to `+10%` per 10 nodes), capped at `2.0x`. Girth scales snake/environment collider radii (including spawn safety checks and head-to-body snake collision radii). Self-collision is non-lethal (snakes may overlap themselves).
- In dev/e2e, `window.__SNAKE_DEBUG__.getRendererInfo()` reports `{ requestedBackend, activeBackend, fallbackReason }` for renderer assertions.
- In dev/e2e, `window.__SNAKE_DEBUG__.getMenuFlowInfo()` reports `{ phase, hasSpawned, cameraBlend, cameraDistance }` for pre-spawn flow and camera-transition assertions.
- In dev/e2e, terrain/culling assertions use `window.__SNAKE_DEBUG__.getTerrainPatchInfo()` and `window.__SNAKE_DEBUG__.getEnvironmentCullInfo()`.
- In dev/e2e, snake-grounding assertions use `window.__SNAKE_DEBUG__.getSnakeGroundingInfo()` and read `{ minClearance, maxPenetration, maxAppliedLift, sampleCount }`.
- In dev/e2e, boost-draft assertions can use `window.__SNAKE_DEBUG__.getBoostDraftInfo(id)` and read `{ visible, opacity, planeCount }` (`planeCount` is currently `1` for the hemispherical draft mesh).
- Net smoothing/motion debug hooks:
  - `window.__SNAKE_DEBUG__.getNetSmoothingInfo()` returns `{ lagSpikeActive, lagSpikeCause, playoutDelayMs, delayBoostMs, jitterMs, jitterDelayMs, receiveIntervalMs, staleMs, impairmentMsRemaining, maxExtrapolationMs, latestSeq, seqGapDetected, tuningRevision, tuningOverrides }`.
  - `window.__SNAKE_DEBUG__.getMotionStabilityInfo()` returns `{ backwardCorrectionCount, minHeadDot, sampleCount }`.
  - `window.__SNAKE_DEBUG__.getNetLagEvents()` / `getNetLagReport()` expose event timelines; `clearNetLagEvents()` resets them.
  - `window.__SNAKE_DEBUG__.setNetTuningOverrides(overrides)` / `resetNetTuningOverrides()` apply runtime net-tuning changes for local testing; `getNetTuningOverrides()` and `getResolvedNetTuning()` expose current tuning.
- Tail growth debug hooks (opt-in via `?tailDebug=1`):
  - `window.__SNAKE_DEBUG__.getTailGrowthEvents()` returns the recent tail-growth event log (rx + render samples).
  - `window.__SNAKE_DEBUG__.getTailGrowthReport()` returns a compact summary (including recent `shrink`/`stretch` events).
  - `window.__SNAKE_DEBUG__.clearTailGrowthEvents()` clears the tail-growth log.
- rAF perf debug hooks (opt-in via `?rafPerf=1`):
  - `window.__SNAKE_DEBUG__.getRafPerfInfo()` returns `{ frameCount, slowFrameCount, maxTotalMs, lastFrame, slowFrames, ... }` with per-frame phase timings including `renderMs`.
  - `window.__SNAKE_DEBUG__.getRenderPerfInfo()` returns `{ frameCount, slowFrameCount, maxTotalMs, lastFrame, slowFrames, ... }` with renderer-side timings (setup/snakes/pellets/visibility/water plus per-pass `passWorldMs`, `passOccludersMs`, `passPelletsMs`, `passDepthRebuildMs`, `passLakesMs`).
  - `window.__SNAKE_DEBUG__.clearRafPerf()` resets the collected rAF perf samples.
- Spawning is collision-safe: new spawns are rejected if any node overlaps existing alive snakes. Respawn retries are delayed if no safe spot is found.
- Multiplayer WebSocket payloads are custom binary frames (versioned header). Current protocol version is `13`; when the protocol changes, deploy frontend and backend together. Join frames include `FLAG_JOIN_DEFER_SPAWN` so clients can connect/update identity without immediate spawn (used by the pre-spawn menu flow) plus `FLAG_JOIN_SKIN` to attach an optional skin pattern (`u8 skin_len` then `skin_len * (u8 r,g,b)`; max 8). The server still accepts JSON `Text` frames for backwards compatibility, but always sends binary. Client codec lives in `frontend/src/game/wsProtocol.ts`. State/init snapshots include `u16 total_players` plus a per-session view-scoped player list; the server always includes the local player and includes remote players only when they have a visible non-stub snake window for that session view. Player payload entries include `f32 score_fraction` (after `score`), then `f32 oxygen` + `u8 is_boosting` + `f32 girth_scale` + `f32 tail_extension`, and pellet payload entries are encoded as `u32 pellet_id` + quantized normal (`i16 x/y/z`) + `u8 color_index` + `u8 size`.
- Player meta payloads (init meta table + `TYPE_PLAYER_META`) append `u8 skin_len` + `skin_len * (u8 r,g,b)` immediately after the `color` string; `skin_len=0` means "no skin pattern".
- Player digestion payload entries are encoded as `u32 digestion_id` + `f32 progress` + `f32 strength` in the binary stream (count remains `u8`).
- Small pellet digestion behavior is merged per player per tick: consumed pellet growth fractions are aggregated into one digestion event with weighted bump strength; when digestion reaches the tail, its growth is applied authoritatively by draining tail growth at a dynamic per-substep rate (`base + mult * sqrt(backlog)`, clamped) so `tail_extension` grows smoothly while large bursts catch up faster than linear before full-node commits.
- Tail node commits from digestion are paced at a maximum of one node per movement substep; excess fractional growth stays in `tail_extension` for later substeps (carryover). Growth-node placement continues the current tail arc (not `pos_queue` history) and reseeds the previous tail node's queue so the newly committed node doesn't snap on its first follow steps.
- Pellet economy is intentionally decoupled between growth and score: big pellets grant `0.10` physical growth, small pellets grant `1/20` of big growth (`0.005`), and scoring is normalized in big-pellet units so `1` big pellet still yields `+1` score.
- Early-length evasive pellets are server-authored: connected human players with snake length `8..=20` receive owner-bound evasive big-pellet opportunities on a per-player cooldown (~60s with jitter), spawned near the owner in a locally safe area away from other heads/colliders. Evasive pellets use smooth, slight zig-zag motion and only evade while the bound owner is actively chasing; near-mouth behavior is open capture (owner, other humans, or bots): when within suction radius of any mouth they are pulled toward that mouth and then consumed once inside consume angle. Evasive movement is capped below boost top speed so boosted snakes can still catch them.

## Debug / Test Utilities
- `scripts/debug-kill.sh` — helper to hit the debug kill endpoint (defaults to room `main`, target `bot`).
- `scripts/simulate-lag-spikes.sh` — macOS lag simulator wrapper (`start|stop|status`) over `pfctl` + `dnctl`.
  - Default mode is backend-only shaping via `BACKEND_PORT` (`8788` by default).
  - Use `PORTS=8818,8788` only when intentionally shaping both worker and backend.
- `scripts/run-lag-automation.sh` — launches local stack (unless `--no-stack-start`), enables lag shaping (unless `--no-lag-control`), runs an automated bot driver, and writes a run report.
  - Common flags: `--profile harsh|balanced|extreme`, `--duration-secs <n>`, `--tuning-overrides-json '<json>'`, `--no-screenshot`.
- `scripts/lag-autotune.sh` — runs a multi-candidate tuning sweep and writes:
  - `autotune-summary.json` (all candidates),
  - `best-candidate.json` (ranked result set + best candidate),
  - per-candidate `runs/<label>/report.json`.
- Recommended lag regression workflow:
  1. `./scripts/run-lag-automation.sh --profile harsh --duration-secs 45 --no-screenshot`
  2. Inspect `output/lag-tests/<run-label>/report.json`:
     - `p95NonSpikeDelayMs <= 170`
     - `p95SpikeDelayMs <= 240`
     - `maxSpikeStartsIn5s <= 3`
     - `mismatchMaxMs <= 350`
     - `backwardCorrectionRate <= 0.002` and `minHeadDot >= 0.995`
  3. If tuning is needed, run `./scripts/lag-autotune.sh --profile harsh --duration-secs 30` and apply/verify the winning override set.

## Planet Rendering Notes
- Default terrain path is a fixed-topology patch atlas (`PLANET_PATCH_ENABLED`): a full deformed icosphere is built once, partitioned into static spherical bins (`buildPlanetPatchAtlas`), and each patch mesh visibility is toggled per-frame (`updatePlanetPatchVisibility`) based on camera view angle + hysteresis.
- Environment objects are camera/view-culled per-frame (`updateEnvironmentVisibility`) with horizon-aware occlusion handling and zoom-dependent preload margins so trees/cactuses/rocks/pebbles render ahead of the edge when zoomed out.
- Tree culling is height-aware: both trunk-base and canopy-top sample points are used so tall edge trees stay visible at zoom-out.
- Cactus culling is multi-point and branch-aware: trunk base/top plus left/right arm tip sample points are used so branch silhouettes do not pop late near the horizon.
- Environment generation is biome-aware and deterministic: a desert region (`DESERT_BIOME_ANGLE`) hosts cactuses (`DESERT_CACTUS_COUNT`), while lakes and mountains are kept out of the desert region.
- Cactuses are serialized through the legacy `trees` payload for protocol compatibility (`width_scale < 0` means cactus) and are rendered client-side as connected spine tubes (`TubeGeometry`) plus cap/joint spheres, with slight base sink into terrain.
- Lake visibility is view-angle-driven (`updateLakeVisibility`) with generous edge margins/hysteresis to avoid late edge pop-in at high zoom distances.
- Snake visual grounding is mesh-aware: segment/head/tail placement samples the deformed terrain mesh (with analytic fallback) and applies a tiny positive contact clearance to reduce slope clipping and z-fighting.
- Self-overlap crossings are rendered without lifting segments; the client uses a subtle additive glow overlay on self-overlapping spans so crossings stay readable on the 3D planet.
- Snake body visuals are smooth-shaded and use a repeat-wrapped per-player skin texture (`map` + `emissiveMap`) to create ring-band stripes along the tube with optional 8-slot color patterns; tail cap UVs are generated so stripe bands and the active pattern cycle continue down the cap without snapping/wrapping to the next repeat.
- Snake skin UV progression includes fractional tail extension so stripe bands and color patterns advance smoothly as length accrues (no "only at full-node commit" pop). Snapshot interpolation for `snakeDetail='full'` blends length-units (`snakeLen + tailExtension`) and re-derives `{ snakeTotalLen, tailExtension }` across commit boundaries to avoid one-frame shrink/pops under rapid growth. The tail extension point is biased toward the raw last-segment direction near full extension so rapid growth commits don't visibly "pop" the tail tip.
- Menu skin screens render a separate 3D preview snake as an overlay pass (separate scene/camera) after the main world/lake passes; it clears depth before rendering so it does not contaminate the multipass pellet occlusion pipeline.
- Pointer aiming uses a 3D curved arrow overlay rendered after the main world/lake passes in `frontend/src/render/core/sceneRuntime.ts`; it calls `renderer.clearDepth()` before rendering so the arrow appears above everything while still self-occluding correctly.
- Pointer input is screen-space: `frontend/src/App.tsx` forwards pointer coords to the renderer via `setPointerScreen(x, y, active)`, and the renderer exposes a derived steering axis via `getPointerAxis()` (computed from a cursor ray hit on the planet surface).
- The pointer arrow mesh is a single continuous low-poly extruded `BufferGeometry` (shaft + head) curved along the great-circle arc toward the cursor.
- To stay stable over sharp low-poly terrain (e.g., dunes), the arrow body uses a constant-radius shell based on the cursor hit (`tipRadius + lift`) instead of resampling terrain height per segment.
- Boost draft visuals are rendered as a front-anchored hemispherical shell near the snake head (low-opacity blue/white wisp tint, shader-based edge fade to full transparency at boundaries) and are only visible while that snake is actively boosting.
- Boost draft/trail shaders are warmed once during renderer bootstrap to reduce first-use stalls, and boost trail meshes are pooled/rebuilt allocation-light to reduce GC spikes when boost toggles.
- Digestion bulges are applied in tube-ring space with identity-tracked progress, and the visual start is anchored by a fixed node index near the neck (default: one node behind the head) instead of a percentage-based body offset. Bulge intensity scales down as snake girth increases so larger snakes show subtler swallow bumps.
- Pellet visuals use a slither-style multi-layer sprite stack in color buckets (`THREE.Points`) for high counts: dark under-shadow + bright core + near/far additive glow layers with seeded per-pellet orbital wobble. Rendering uses a multipass depth composition: world base pass (without pellets/lakes), pellet-occluder depth pass (environment + opaque snakes), pellet pass (depth-tested for partial occlusion), full-depth rebuild pass, then lakes rendered last so underwater pellets still read through water overlay. Dead/fading transparent snakes are excluded from pellet occluder depth so pellets remain visible through them. The multipass path is intentionally allocation-light (reused scratch arrays and one shared snake-occluder mask across passes); preserve that when iterating on render passes. Keep near-side horizon culling (with margin), updates allocation-light, and per-pellet terrain grounding so sprites stay on top of elevated/sunken terrain. For extremely large visible pellet counts (mass deaths), wobble is disabled to avoid main-thread stalls.
- Shoreline fill and shoreline line meshes are generated from the full deformed planet geometry in both patch and fallback paths to keep lake edges coherent.
- Fallback terrain path (when patch mode is disabled) renders a full deformed icosphere mesh (`createIcosphereGeometry` + `applyLakeDepressions`).
- Lakes are rendered with backend-specific paths:
  - WebGL: per-lake spherical meshes masked with `onBeforeCompile`.
  - WebGPU: generated lake surface geometry fallback for near visual parity.
- To prevent shoreline seams, terrain depth is clamped to at least the lake surface depth, lake surfaces are slightly overdrawn/expanded, and lake materials use polygon offset to win depth testing.
- Fishbowl crack visuals are exact in WebGL (`onBeforeCompile`) and approximated in WebGPU for parity without WebGL-only shader hooks.
- Renderer bootstrap/fallback selection lives in `frontend/src/render/webglScene.ts`; scene/runtime implementation lives in `frontend/src/render/core/sceneRuntime.ts` (`buildPlanetPatchAtlas`, `updatePlanetPatchVisibility`, `updateEnvironmentVisibility`, `updateLakeVisibility`, `createLakes`, `sampleLakes`, `applyLakeDepressions`, `createLakeMaskMaterial`, `createLakeSurfaceGeometry`).
- Mountain collider outlines are generated on the backend (smoothed radial samples) and visualized on the client via the debug overlay; lake and tree collider rings are rendered as line loops when debug is enabled.
