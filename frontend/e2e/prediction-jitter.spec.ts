import { expect, test, type Page, type TestInfo } from '@playwright/test'
import path from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { enterGame } from './helpers'
import { runDeterministicPredictionPath } from './predictionPath'

const STORAGE_KEYS = {
  name: 'spherical_snake_player_name',
  best: 'spherical_snake_best_score',
  room: 'spherical_snake_room',
  perturb: 'spherical_snake_prediction_perturb',
}

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ARTIFACT_DIR = path.resolve(__dirname, '../../output/playwright/prediction-jitter')

type PredictionInfo = {
  correctionHardCount: number
}

type PredictionPresentationInfo = {
  bodyMicroReversalRate: number
  sampleCount: number
}

type MotionInfo = {
  backwardCorrectionCount: number
  minHeadDot: number
  sampleCount: number
}

type SegmentParityStats = {
  frontWindowP95Deg: number
  frontMismatchMs: number
}

type PredictionEvent = {
  type: string
  magnitudeDeg?: number | null
}

type SnakeSpacingStats = {
  sampleCount: number
  edgeSampleCount: number
  edgeDeltaP95Deg: number
  edgeDeltaMaxDeg: number
  accordionEventCount: number
  frontEdgeSampleCount: number
  frontEdgeDeltaP95Deg: number
  frontEdgeDeltaMaxDeg: number
  frontAccordionEventCount: number
}

type JitterDiagnostics = {
  prediction: PredictionInfo | null
  predictionPresentation: PredictionPresentationInfo | null
  motion: MotionInfo | null
  segmentParity: SegmentParityStats | null
  predictionEvents: PredictionEvent[]
  spacingStats: SnakeSpacingStats | null
}

async function collectDiagnostics(page: Page): Promise<JitterDiagnostics> {
  return page.evaluate(() => {
    const debugApi = (
      window as Window & {
        __SNAKE_DEBUG__?: {
          getPredictionInfo?: () => PredictionInfo
          getPredictionPresentationInfo?: () => PredictionPresentationInfo
          getMotionStabilityInfo?: () => MotionInfo
          getSegmentParityStats?: () => SegmentParityStats
          getPredictionEvents?: () => PredictionEvent[]
        }
      }
    ).__SNAKE_DEBUG__
    return {
      prediction: debugApi?.getPredictionInfo?.() ?? null,
      predictionPresentation: debugApi?.getPredictionPresentationInfo?.() ?? null,
      motion: debugApi?.getMotionStabilityInfo?.() ?? null,
      segmentParity: debugApi?.getSegmentParityStats?.() ?? null,
      predictionEvents: debugApi?.getPredictionEvents?.() ?? [],
      spacingStats: null,
    }
  })
}

async function startSpacingSampler(page: Page): Promise<void> {
  await page.evaluate(() => {
    type Point = { x: number; y: number; z: number }
    type Sample = { tMs: number; lengthsDeg: number[] }
    const globalWindow = window as Window & {
      __SNAKE_DEBUG__?: {
        getLocalSnakePoints?: (maxNodes?: number) => Point[]
      }
      __PREDICTION_SPACING_SAMPLER__?: {
        timer: number
        samples: Sample[]
      }
    }

    const existing = globalWindow.__PREDICTION_SPACING_SAMPLER__
    if (existing) {
      clearInterval(existing.timer)
    }

    const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))
    const angularDeg = (a: Point, b: Point): number => {
      const dot = a.x * b.x + a.y * b.y + a.z * b.z
      const radians = Math.acos(clamp(dot, -1, 1))
      return Number.isFinite(radians) ? (radians * 180) / Math.PI : 0
    }
    const samples: Sample[] = []
    const timer = window.setInterval(() => {
      const api = globalWindow.__SNAKE_DEBUG__
      const snake = api?.getLocalSnakePoints?.(24) ?? []
      if (snake.length < 8) return
      const startIndex = 1
      const endIndex = Math.min(snake.length - 1, 12)
      if (endIndex <= startIndex) return
      const lengthsDeg: number[] = []
      for (let i = startIndex; i <= endIndex; i += 1) {
        const prev = snake[i - 1]
        const curr = snake[i]
        if (!prev || !curr) continue
        lengthsDeg.push(angularDeg(prev, curr))
      }
      if (lengthsDeg.length < 4) return
      samples.push({
        tMs: performance.now(),
        lengthsDeg,
      })
      if (samples.length > 2_500) {
        samples.splice(0, samples.length - 2_500)
      }
    }, 16)

    globalWindow.__PREDICTION_SPACING_SAMPLER__ = { timer, samples }
  })
}

async function stopSpacingSampler(page: Page): Promise<SnakeSpacingStats | null> {
  return page.evaluate(() => {
    type Sample = { tMs: number; lengthsDeg: number[] }
    const globalWindow = window as Window & {
      __PREDICTION_SPACING_SAMPLER__?: {
        timer: number
        samples: Sample[]
      }
    }
    const holder = globalWindow.__PREDICTION_SPACING_SAMPLER__
    if (!holder) return null
    clearInterval(holder.timer)
    delete globalWindow.__PREDICTION_SPACING_SAMPLER__

    const samples = holder.samples
    if (samples.length < 2) {
      return {
        sampleCount: samples.length,
        edgeSampleCount: 0,
        edgeDeltaP95Deg: 0,
        edgeDeltaMaxDeg: 0,
        accordionEventCount: 0,
        frontEdgeSampleCount: 0,
        frontEdgeDeltaP95Deg: 0,
        frontEdgeDeltaMaxDeg: 0,
        frontAccordionEventCount: 0,
      }
    }

    const deltasDeg: number[] = []
    const frontDeltasDeg: number[] = []
    const frontEdgeCount = 5
    let edgeDeltaMaxDeg = 0
    let frontEdgeDeltaMaxDeg = 0
    let accordionEventCount = 0
    let frontAccordionEventCount = 0
    for (let i = 1; i < samples.length; i += 1) {
      const prev = samples[i - 1]?.lengthsDeg ?? []
      const current = samples[i]?.lengthsDeg ?? []
      const count = Math.min(prev.length, current.length)
      for (let edgeIndex = 0; edgeIndex < count; edgeIndex += 1) {
        const delta = Math.abs((current[edgeIndex] ?? 0) - (prev[edgeIndex] ?? 0))
        if (!Number.isFinite(delta)) continue
        deltasDeg.push(delta)
        edgeDeltaMaxDeg = Math.max(edgeDeltaMaxDeg, delta)
        if (delta > 0.5) {
          accordionEventCount += 1
        }
        if (edgeIndex < frontEdgeCount) {
          frontDeltasDeg.push(delta)
          frontEdgeDeltaMaxDeg = Math.max(frontEdgeDeltaMaxDeg, delta)
          if (delta > 0.35) {
            frontAccordionEventCount += 1
          }
        }
      }
    }
    if (deltasDeg.length === 0) {
      return {
        sampleCount: samples.length,
        edgeSampleCount: 0,
        edgeDeltaP95Deg: 0,
        edgeDeltaMaxDeg: 0,
        accordionEventCount: 0,
        frontEdgeSampleCount: 0,
        frontEdgeDeltaP95Deg: 0,
        frontEdgeDeltaMaxDeg: 0,
        frontAccordionEventCount: 0,
      }
    }
    const sorted = deltasDeg.slice().sort((a, b) => a - b)
    const p95Index = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))
    const sortedFront = frontDeltasDeg.slice().sort((a, b) => a - b)
    const frontP95Index =
      sortedFront.length > 0 ? Math.min(sortedFront.length - 1, Math.floor(sortedFront.length * 0.95)) : 0
    return {
      sampleCount: samples.length,
      edgeSampleCount: deltasDeg.length,
      edgeDeltaP95Deg: sorted[p95Index] ?? 0,
      edgeDeltaMaxDeg,
      accordionEventCount,
      frontEdgeSampleCount: frontDeltasDeg.length,
      frontEdgeDeltaP95Deg: sortedFront[frontP95Index] ?? 0,
      frontEdgeDeltaMaxDeg,
      frontAccordionEventCount,
    }
  })
}

async function saveArtifacts(
  page: Page,
  testInfo: TestInfo,
  label: string,
  diagnostics: JitterDiagnostics,
): Promise<void> {
  await mkdir(ARTIFACT_DIR, { recursive: true })
  const safeLabel = label.replace(/[^a-z0-9_-]+/gi, '-').toLowerCase()
  const base = `${safeLabel}-${Date.now()}`
  const jsonPath = path.join(ARTIFACT_DIR, `${base}.json`)
  const pngPath = path.join(ARTIFACT_DIR, `${base}.png`)
  await writeFile(jsonPath, JSON.stringify(diagnostics, null, 2), 'utf-8')
  await page.screenshot({ path: pngPath, fullPage: true })
  await testInfo.attach(`${safeLabel}.json`, {
    path: jsonPath,
    contentType: 'application/json',
  })
  await testInfo.attach(`${safeLabel}.png`, {
    path: pngPath,
    contentType: 'image/png',
  })
}

function assertWithFailureDump(diagnostics: JitterDiagnostics, assertions: () => void): void {
  try {
    assertions()
  } catch (error) {
    console.error('prediction info', diagnostics.prediction ?? null)
    console.error('prediction presentation info', diagnostics.predictionPresentation ?? null)
    console.error('motion info', diagnostics.motion ?? null)
    console.error('segment parity info', diagnostics.segmentParity ?? null)
    console.error('spacing stats', diagnostics.spacingStats ?? null)
    console.error('last prediction events', diagnostics.predictionEvents.slice(-20))
    throw error
  }
}

test.describe('@prediction-jitter prediction jitter guardrails', () => {
  test.describe.configure({ timeout: 120_000 })

  test.beforeEach(async ({ page }, testInfo) => {
    const room = `e2e-pred-jitter-${Date.now()}-${testInfo.retry}-${testInfo.parallelIndex}`
    await page.addInitScript(
      ({ keys, roomName }) => {
        localStorage.setItem(keys.name, 'E2E Prediction Jitter')
        localStorage.setItem(keys.best, '0')
        localStorage.setItem(keys.room, roomName)
        localStorage.setItem(keys.perturb, '0')
      },
      { keys: STORAGE_KEYS, roomName: room },
    )
  })

  test('baseline_no_jagged_head_steps_webgl @prediction-jitter', async ({ page }, testInfo) => {
    await page.goto('/?renderer=webgl&rafPerf=1')
    await enterGame(page)
    await startSpacingSampler(page)

    await runDeterministicPredictionPath(page, {
      durationMs: 5_000,
      stepMs: 100,
      boostWindows: [
        { startMs: 900, endMs: 1_700 },
        { startMs: 2_800, endMs: 3_500 },
      ],
    })

    const diagnostics = await collectDiagnostics(page)
    diagnostics.spacingStats = await stopSpacingSampler(page)
    await saveArtifacts(page, testInfo, 'baseline_no_jagged_head_steps_webgl', diagnostics)

    assertWithFailureDump(diagnostics, () => {
      const prediction = diagnostics.prediction
      const presentation = diagnostics.predictionPresentation
      const motion = diagnostics.motion
      const segmentParity = diagnostics.segmentParity
      const spacing = diagnostics.spacingStats
      expect(prediction).not.toBeNull()
      expect(presentation).not.toBeNull()
      expect(motion).not.toBeNull()
      expect(segmentParity).not.toBeNull()
      expect(spacing).not.toBeNull()
      expect(presentation?.sampleCount ?? 0).toBeGreaterThanOrEqual(24)
      expect(spacing?.sampleCount ?? 0).toBeGreaterThanOrEqual(30)
      expect(spacing?.edgeSampleCount ?? 0).toBeGreaterThanOrEqual(150)
      expect(spacing?.edgeDeltaP95Deg ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(0.2)
      expect(spacing?.accordionEventCount ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(8)
      expect(spacing?.frontEdgeSampleCount ?? 0).toBeGreaterThanOrEqual(100)
      expect(spacing?.frontEdgeDeltaP95Deg ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(0.18)
      expect(spacing?.frontAccordionEventCount ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(8)
      const backwardRate =
        (motion?.sampleCount ?? 0) > 0
          ? (motion?.backwardCorrectionCount ?? 0) / (motion?.sampleCount ?? 1)
          : Number.POSITIVE_INFINITY
      expect(backwardRate).toBeLessThanOrEqual(0.02)
      expect(motion?.minHeadDot ?? 0).toBeGreaterThanOrEqual(0.995)
      expect(presentation?.bodyMicroReversalRate ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(0.16)
      expect(segmentParity?.frontWindowP95Deg ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(0.9)
      expect(segmentParity?.frontMismatchMs ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(150)
      expect(prediction?.correctionHardCount ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(8)
      const softOverSix = diagnostics.predictionEvents.filter(
        (event) => event.type === 'reconcile_soft' && (event.magnitudeDeg ?? 0) > 6,
      )
      expect(softOverSix.length).toBeLessThanOrEqual(2)
    })
  })

  test('perturbation_no_jagged_head_steps_webgl @prediction-jitter', async ({ page }, testInfo) => {
    await page.goto('/?renderer=webgl&rafPerf=1&predictionPerturb=1')
    await enterGame(page)
    await startSpacingSampler(page)

    await page.evaluate(() => {
      const api = (
        window as Window & {
          __SNAKE_DEBUG__?: {
            setNetTuningOverrides?: (overrides: Record<string, number>) => unknown
          }
        }
      ).__SNAKE_DEBUG__
      api?.setNetTuningOverrides?.({
        netBaseDelayTicks: 1.2,
        netMinDelayTicks: 1.1,
        netJitterDelayMultiplier: 0.6,
      })
    })

    await runDeterministicPredictionPath(page, {
      durationMs: 6_500,
      stepMs: 100,
      boostWindows: [{ startMs: 2_000, endMs: 2_900 }],
    })

    const diagnostics = await collectDiagnostics(page)
    diagnostics.spacingStats = await stopSpacingSampler(page)
    await saveArtifacts(page, testInfo, 'perturbation_no_jagged_head_steps_webgl', diagnostics)

    assertWithFailureDump(diagnostics, () => {
      const prediction = diagnostics.prediction
      const presentation = diagnostics.predictionPresentation
      const motion = diagnostics.motion
      const segmentParity = diagnostics.segmentParity
      const spacing = diagnostics.spacingStats
      expect(prediction).not.toBeNull()
      expect(presentation).not.toBeNull()
      expect(motion).not.toBeNull()
      expect(segmentParity).not.toBeNull()
      expect(spacing).not.toBeNull()
      expect(presentation?.sampleCount ?? 0).toBeGreaterThanOrEqual(24)
      expect(spacing?.sampleCount ?? 0).toBeGreaterThanOrEqual(30)
      expect(spacing?.edgeSampleCount ?? 0).toBeGreaterThanOrEqual(150)
      expect(spacing?.edgeDeltaP95Deg ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(0.32)
      expect(spacing?.accordionEventCount ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(24)
      expect(spacing?.frontEdgeSampleCount ?? 0).toBeGreaterThanOrEqual(100)
      expect(spacing?.frontEdgeDeltaP95Deg ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(0.28)
      expect(spacing?.frontAccordionEventCount ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(20)
      const backwardRate =
        (motion?.sampleCount ?? 0) > 0
          ? (motion?.backwardCorrectionCount ?? 0) / (motion?.sampleCount ?? 1)
          : Number.POSITIVE_INFINITY
      expect(backwardRate).toBeLessThanOrEqual(0.05)
      expect(presentation?.bodyMicroReversalRate ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(0.2)
      expect(segmentParity?.frontWindowP95Deg ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(1.2)
      expect(segmentParity?.frontMismatchMs ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(150)
      expect(prediction?.correctionHardCount ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(14)
      const softOverSix = diagnostics.predictionEvents.filter(
        (event) => event.type === 'reconcile_soft' && (event.magnitudeDeg ?? 0) > 6,
      )
      expect(softOverSix.length).toBeLessThanOrEqual(3)
    })
  })
})
