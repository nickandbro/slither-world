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
const ARTIFACT_DIR = path.resolve(__dirname, '../../output/playwright/prediction')

type PredictionInfo = {
  enabled: boolean
  latestInputSeq: number | null
  latestAckSeq: number | null
  pendingInputCount: number
  replayedInputCountLastFrame: number
  predictedHeadErrorDeg: { lastDeg: number; p95Deg: number; maxDeg: number }
  correctionSoftCount: number
  correctionHardCount: number
  lastCorrectionMagnitudeDeg: number
  predictionDisabledReason: 'none' | 'spike' | 'dead' | 'not-ready'
}

type PredictionEvent = {
  type: string
  ackSeq: number | null
  seq: number | null
  message: string
}

type MotionInfo = {
  backwardCorrectionCount: number
  sampleCount: number
  minHeadDot: number
}

type RafInfo = {
  frameCount: number
  slowFrameCount: number
}

type NetInfo = {
  lagSpikeCause: string
}

type HeadRotationStats = {
  sampleCount: number
  stepP95Deg: number
  stepMaxDeg: number
  reversalCount: number
  reversalRate: number
}

type PredictionDiagnostics = {
  predictionInfo: PredictionInfo | null
  predictionReport: unknown
  predictionEvents: PredictionEvent[]
  netInfo: NetInfo | null
  motionInfo: MotionInfo | null
  rafInfo: RafInfo | null
  renderPerfInfo: unknown
  headRotationStats: HeadRotationStats | null
}

async function collectDiagnostics(page: Page): Promise<PredictionDiagnostics> {
  return page.evaluate(() => {
    const debugApi = (
      window as Window & {
        __SNAKE_DEBUG__?: {
          getPredictionInfo?: () => PredictionInfo
          getPredictionReport?: () => unknown
          getPredictionEvents?: () => PredictionEvent[]
          getMotionStabilityInfo?: () => MotionInfo
          getNetSmoothingInfo?: () => NetInfo
          getRafPerfInfo?: () => RafInfo
          getRenderPerfInfo?: () => unknown
          setNetTuningOverrides?: (overrides: Record<string, number>) => unknown
        }
      }
    ).__SNAKE_DEBUG__
    return {
      predictionInfo: debugApi?.getPredictionInfo?.() ?? null,
      predictionReport: debugApi?.getPredictionReport?.() ?? null,
      predictionEvents: debugApi?.getPredictionEvents?.() ?? [],
      netInfo: debugApi?.getNetSmoothingInfo?.() ?? null,
      motionInfo: debugApi?.getMotionStabilityInfo?.() ?? null,
      rafInfo: debugApi?.getRafPerfInfo?.() ?? null,
      renderPerfInfo: debugApi?.getRenderPerfInfo?.() ?? null,
      headRotationStats: null,
    }
  })
}

async function startHeadRotationSampler(page: Page): Promise<void> {
  await page.evaluate(() => {
    type Vec3 = { x: number; y: number; z: number }
    const globalWindow = window as Window & {
      __SNAKE_DEBUG__?: {
        getLocalHeadForward?: () => Vec3 | null
        getLocalHeadNormal?: () => Vec3 | null
      }
      __PREDICTION_HEAD_ROTATION_SAMPLER__?: {
        timer: number
        samples: Array<{ tMs: number; forward: Vec3; normal: Vec3 }>
      }
    }

    const existing = globalWindow.__PREDICTION_HEAD_ROTATION_SAMPLER__
    if (existing) {
      clearInterval(existing.timer)
    }
    const samples: Array<{ tMs: number; forward: Vec3; normal: Vec3 }> = []
    const normalize = (v: Vec3): Vec3 | null => {
      const lenSq = v.x * v.x + v.y * v.y + v.z * v.z
      if (!(lenSq > 1e-10) || !Number.isFinite(lenSq)) return null
      const invLen = 1 / Math.sqrt(lenSq)
      return { x: v.x * invLen, y: v.y * invLen, z: v.z * invLen }
    }

    const timer = window.setInterval(() => {
      const debugApi = globalWindow.__SNAKE_DEBUG__
      const forward = debugApi?.getLocalHeadForward?.()
      const normal = debugApi?.getLocalHeadNormal?.()
      if (!forward || !normal) return
      const forwardNorm = normalize(forward)
      const normalNorm = normalize(normal)
      if (!forwardNorm || !normalNorm) return
      samples.push({
        tMs: performance.now(),
        forward: forwardNorm,
        normal: normalNorm,
      })
      if (samples.length > 4_000) {
        samples.splice(0, samples.length - 4_000)
      }
    }, 16)

    globalWindow.__PREDICTION_HEAD_ROTATION_SAMPLER__ = { timer, samples }
  })
}

async function stopHeadRotationSampler(page: Page): Promise<HeadRotationStats | null> {
  return page.evaluate(() => {
    type Vec3 = { x: number; y: number; z: number }
    const globalWindow = window as Window & {
      __PREDICTION_HEAD_ROTATION_SAMPLER__?: {
        timer: number
        samples: Array<{ tMs: number; forward: Vec3; normal: Vec3 }>
      }
    }
    const holder = globalWindow.__PREDICTION_HEAD_ROTATION_SAMPLER__
    if (!holder) return null
    clearInterval(holder.timer)
    delete globalWindow.__PREDICTION_HEAD_ROTATION_SAMPLER__

    const samples = holder.samples
    if (samples.length < 3) {
      return {
        sampleCount: samples.length,
        stepP95Deg: 0,
        stepMaxDeg: 0,
        reversalCount: 0,
        reversalRate: 0,
      }
    }

    const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v))
    const toDeg = (rad: number) => (rad * 180) / Math.PI
    const stepsDeg: number[] = []
    let reversalCount = 0
    let previousSign = 0
    let previousSignedStepAbsDeg = 0

    for (let i = 1; i < samples.length; i += 1) {
      const prev = samples[i - 1]!
      const current = samples[i]!
      const dotValue = clamp(
        prev.forward.x * current.forward.x +
          prev.forward.y * current.forward.y +
          prev.forward.z * current.forward.z,
        -1,
        1,
      )
      const stepDeg = toDeg(Math.acos(dotValue))
      if (!Number.isFinite(stepDeg)) continue
      stepsDeg.push(stepDeg)

      if (stepDeg < 0.45) continue
      const crossX = prev.forward.y * current.forward.z - prev.forward.z * current.forward.y
      const crossY = prev.forward.z * current.forward.x - prev.forward.x * current.forward.z
      const crossZ = prev.forward.x * current.forward.y - prev.forward.y * current.forward.x
      const turnSignDot =
        crossX * current.normal.x + crossY * current.normal.y + crossZ * current.normal.z
      const sign = turnSignDot > 1e-8 ? 1 : turnSignDot < -1e-8 ? -1 : 0
      if (
        sign !== 0 &&
        previousSign !== 0 &&
        sign !== previousSign &&
        previousSignedStepAbsDeg >= 0.45
      ) {
        reversalCount += 1
      }
      if (sign !== 0) {
        previousSign = sign
        previousSignedStepAbsDeg = stepDeg
      }
    }

    if (stepsDeg.length === 0) {
      return {
        sampleCount: samples.length,
        stepP95Deg: 0,
        stepMaxDeg: 0,
        reversalCount: 0,
        reversalRate: 0,
      }
    }
    const sorted = stepsDeg.slice().sort((a, b) => a - b)
    const p95Index = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))
    const stepP95Deg = sorted[p95Index] ?? 0
    const stepMaxDeg = sorted[sorted.length - 1] ?? 0
    return {
      sampleCount: samples.length,
      stepP95Deg,
      stepMaxDeg,
      reversalCount,
      reversalRate: reversalCount / Math.max(1, stepsDeg.length),
    }
  })
}

async function saveArtifacts(
  page: Page,
  testInfo: TestInfo,
  label: string,
  diagnostics: PredictionDiagnostics,
) {
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

function isSeqNewer(candidate: number, baseline: number): boolean {
  const diff = (candidate - baseline + 0x1_0000) % 0x1_0000
  return diff > 0 && diff < 0x8000
}

function assertWithFailureDump(diagnostics: PredictionDiagnostics, assertions: () => void): void {
  try {
    assertions()
  } catch (error) {
    const events = diagnostics.predictionEvents ?? []
    console.error('prediction report summary', diagnostics.predictionInfo ?? null)
    console.error('latest net lag summary', diagnostics.netInfo)
    console.error('raf/render perf summary', {
      raf: diagnostics.rafInfo,
      render: diagnostics.renderPerfInfo,
    })
    console.error('last prediction events', events.slice(-20))
    throw error
  }
}

test.describe('@prediction prediction authority', () => {
  test.describe.configure({ timeout: 120_000 })

  test.beforeEach(async ({ page }, testInfo) => {
    const room = `e2e-pred-${Date.now()}-${testInfo.retry}-${testInfo.parallelIndex}`
    await page.addInitScript(
      ({ keys, roomName }) => {
        localStorage.setItem(keys.name, 'E2E Prediction')
        localStorage.setItem(keys.best, '0')
        localStorage.setItem(keys.room, roomName)
        localStorage.setItem(keys.perturb, '0')
      },
      { keys: STORAGE_KEYS, roomName: room },
    )
  })

  test('baseline_visual_latency_webgl @prediction', async ({ page }, testInfo) => {
    await page.goto('/?renderer=webgl&rafPerf=1')
    await enterGame(page)

    await page.waitForFunction(() => {
      const api = (
        window as Window & {
          __SNAKE_DEBUG__?: {
            getPredictionInfo?: () => PredictionInfo
          }
        }
      ).__SNAKE_DEBUG__
      return !!api?.getPredictionInfo?.()
    })

    await startHeadRotationSampler(page)
    await runDeterministicPredictionPath(page, {
      durationMs: 5_000,
      stepMs: 100,
      boostWindows: [
        { startMs: 900, endMs: 1_700 },
        { startMs: 2_800, endMs: 3_500 },
      ],
    })

    const diagnostics = await collectDiagnostics(page)
    diagnostics.headRotationStats = await stopHeadRotationSampler(page)
    await saveArtifacts(page, testInfo, 'baseline_visual_latency_webgl', diagnostics)

    assertWithFailureDump(diagnostics, () => {
      const info = diagnostics.predictionInfo
      const motion = diagnostics.motionInfo
      const raf = diagnostics.rafInfo
      const headRotation = diagnostics.headRotationStats
      const net = diagnostics.netInfo
      expect(info).not.toBeNull()
      expect(info?.enabled).toBeTruthy()
      expect(info?.predictedHeadErrorDeg.p95Deg ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(6)
      expect(info?.correctionHardCount ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(8)
      expect(motion).not.toBeNull()
      const backwardRate =
        motion && motion.sampleCount > 0
          ? motion.backwardCorrectionCount / motion.sampleCount
          : Number.POSITIVE_INFINITY
      const highJitter = (net?.lagSpikeCause ?? 'none') !== 'none'
      const backwardRateBudget = highJitter ? 0.05 : 0.02
      const minHeadDotBudget = highJitter ? 0.97 : 0.995
      expect(backwardRate).toBeLessThanOrEqual(backwardRateBudget)
      expect(motion?.minHeadDot ?? 0).toBeGreaterThanOrEqual(minHeadDotBudget)
      expect(headRotation).not.toBeNull()
      const headSampleCount = headRotation?.sampleCount ?? 0
      expect(headSampleCount).toBeGreaterThanOrEqual(12)
      if (headSampleCount >= 40) {
        expect(headRotation?.reversalRate ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(0.12)
        expect(headRotation?.reversalCount ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(14)
      }
      if (raf) {
        expect(raf.slowFrameCount).toBeLessThanOrEqual(Math.max(24, Math.floor(raf.frameCount * 0.2)))
      }
    })
  })

  test('correction_under_jitter_webgl @prediction', async ({ page }, testInfo) => {
    await page.goto('/?renderer=webgl&rafPerf=1&predictionPerturb=1')
    await enterGame(page)

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

    await startHeadRotationSampler(page)
    await runDeterministicPredictionPath(page, {
      durationMs: 7_000,
      stepMs: 100,
      boostWindows: [{ startMs: 2_000, endMs: 2_900 }],
    })

    const diagnostics = await collectDiagnostics(page)
    diagnostics.headRotationStats = await stopHeadRotationSampler(page)
    await saveArtifacts(page, testInfo, 'correction_under_jitter_webgl', diagnostics)

    assertWithFailureDump(diagnostics, () => {
      const info = diagnostics.predictionInfo
      const headRotation = diagnostics.headRotationStats
      expect(info).not.toBeNull()
      const correctionCount = (info?.correctionSoftCount ?? 0) + (info?.correctionHardCount ?? 0)
      const p95Error = info?.predictedHeadErrorDeg.p95Deg ?? Number.POSITIVE_INFINITY
      expect(info?.correctionHardCount ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(14)
      expect(info?.pendingInputCount ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(60)
      const deadAtCapture = info?.predictionDisabledReason === 'dead'
      expect(p95Error).toBeLessThanOrEqual(deadAtCapture ? 10 : 6)
      expect(headRotation).not.toBeNull()
      expect(headRotation?.reversalRate ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(0.2)
      expect(headRotation?.reversalCount ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(20)
      if (correctionCount === 0) {
        // If no correction was needed, hold a tighter error budget so the run still proves stability.
        expect(p95Error).toBeLessThanOrEqual(2.5)
      }
    })
  })

  test('ack_monotonicity_and_queue_bounds @prediction', async ({ page }, testInfo) => {
    await page.goto('/?renderer=webgl')
    await enterGame(page)

    await runDeterministicPredictionPath(page, {
      durationMs: 3_500,
      stepMs: 90,
      boostWindows: [],
    })

    const diagnostics = await collectDiagnostics(page)
    await saveArtifacts(page, testInfo, 'ack_monotonicity_and_queue_bounds', diagnostics)

    assertWithFailureDump(diagnostics, () => {
      const info = diagnostics.predictionInfo
      const ackEvents = diagnostics.predictionEvents.filter(
        (event) => event.type === 'ack_advanced' && typeof event.ackSeq === 'number',
      )
      let previousAck: number | null = null
      for (const event of ackEvents) {
        const ackSeq = event.ackSeq as number
        if (previousAck !== null) {
          expect(ackSeq === previousAck || isSeqNewer(ackSeq, previousAck)).toBeTruthy()
        }
        previousAck = ackSeq
      }
      const overflowEvents = diagnostics.predictionEvents.filter(
        (event) => event.type === 'queue_prune' && event.message.includes('overflow'),
      )
      expect(info).not.toBeNull()
      expect(info?.pendingInputCount ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(40)
      expect(overflowEvents.length).toBe(0)
    })
  })
})
