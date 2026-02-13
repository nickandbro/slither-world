import type { Page } from '@playwright/test'

export type PredictionWaypoint = readonly [number, number]

export type PredictionBoostWindow = {
  startMs: number
  endMs: number
}

const DEFAULT_WAYPOINTS: PredictionWaypoint[] = [
  [0.16, 0.34],
  [0.84, 0.28],
  [0.8, 0.72],
  [0.22, 0.78],
  [0.64, 0.45],
  [0.4, 0.24],
]

function samplePathPoint(waypoints: PredictionWaypoint[], progress01: number): PredictionWaypoint {
  if (waypoints.length <= 1) return waypoints[0] ?? [0.5, 0.5]
  const clamped = Math.max(0, Math.min(1, progress01))
  const segmentCount = waypoints.length - 1
  const scaled = clamped * segmentCount
  const segment = Math.min(segmentCount - 1, Math.floor(scaled))
  const localT = scaled - segment
  const start = waypoints[segment]!
  const end = waypoints[segment + 1]!
  return [
    start[0] + (end[0] - start[0]) * localT,
    start[1] + (end[1] - start[1]) * localT,
  ]
}

export async function runDeterministicPredictionPath(
  page: Page,
  options?: {
    durationMs?: number
    stepMs?: number
    waypoints?: PredictionWaypoint[]
    boostWindows?: PredictionBoostWindow[]
  },
): Promise<void> {
  const viewport = page.viewportSize()
  if (!viewport) {
    throw new Error('Viewport size is required for deterministic pointer path')
  }
  const durationMs = Math.max(250, options?.durationMs ?? 8_000)
  const stepMs = Math.max(16, options?.stepMs ?? 48)
  const waypoints = options?.waypoints?.length ? options.waypoints : DEFAULT_WAYPOINTS
  const boostWindows = options?.boostWindows ?? []

  const [startX, startY] = samplePathPoint(waypoints, 0)
  await page.mouse.move(Math.round(startX * viewport.width), Math.round(startY * viewport.height))
  await page.mouse.down()

  let boostActive = false
  const steps = Math.max(1, Math.ceil(durationMs / stepMs))
  for (let step = 0; step <= steps; step += 1) {
    const elapsedMs = Math.min(durationMs, step * stepMs)
    const progress = elapsedMs / durationMs
    const [x, y] = samplePathPoint(waypoints, progress)
    await page.mouse.move(Math.round(x * viewport.width), Math.round(y * viewport.height))

    const shouldBoost = boostWindows.some(
      (window) => elapsedMs >= window.startMs && elapsedMs < window.endMs,
    )
    if (shouldBoost !== boostActive) {
      if (shouldBoost) {
        await page.keyboard.down('Space')
      } else {
        await page.keyboard.up('Space')
      }
      boostActive = shouldBoost
    }

    if (step < steps) {
      await page.waitForTimeout(stepMs)
    }
  }

  if (boostActive) {
    await page.keyboard.up('Space')
  }
  await page.mouse.up()
}
