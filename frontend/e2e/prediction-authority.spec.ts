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
  prediction: 'spherical_snake_prediction',
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

type PredictionDiagnostics = {
  predictionInfo: PredictionInfo | null
  predictionReport: unknown
  predictionEvents: PredictionEvent[]
  netInfo: NetInfo | null
  motionInfo: MotionInfo | null
  rafInfo: RafInfo | null
  renderPerfInfo: unknown
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
        localStorage.setItem(keys.prediction, '1')
        localStorage.setItem(keys.perturb, '0')
      },
      { keys: STORAGE_KEYS, roomName: room },
    )
  })

  test('baseline_visual_latency_webgl @prediction', async ({ page }, testInfo) => {
    await page.goto('/?renderer=webgl&rafPerf=1&prediction=1')
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

    await runDeterministicPredictionPath(page, {
      durationMs: 5_000,
      stepMs: 100,
      boostWindows: [
        { startMs: 900, endMs: 1_700 },
        { startMs: 2_800, endMs: 3_500 },
      ],
    })

    const diagnostics = await collectDiagnostics(page)
    await saveArtifacts(page, testInfo, 'baseline_visual_latency_webgl', diagnostics)

    assertWithFailureDump(diagnostics, () => {
      const info = diagnostics.predictionInfo
      const motion = diagnostics.motionInfo
      const raf = diagnostics.rafInfo
      expect(info).not.toBeNull()
      expect(info?.enabled).toBeTruthy()
      expect(info?.predictedHeadErrorDeg.p95Deg ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(6)
      expect(info?.correctionHardCount ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(8)
      expect(motion).not.toBeNull()
      const backwardRate =
        motion && motion.sampleCount > 0
          ? motion.backwardCorrectionCount / motion.sampleCount
          : Number.POSITIVE_INFINITY
      expect(backwardRate).toBeLessThanOrEqual(0.02)
      expect(motion?.minHeadDot ?? 0).toBeGreaterThanOrEqual(0.995)
      if (raf) {
        expect(raf.slowFrameCount).toBeLessThanOrEqual(Math.max(24, Math.floor(raf.frameCount * 0.2)))
      }
    })
  })

  test('correction_under_jitter_webgl @prediction', async ({ page }, testInfo) => {
    await page.goto('/?renderer=webgl&rafPerf=1&prediction=1&predictionPerturb=1')
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

    await runDeterministicPredictionPath(page, {
      durationMs: 7_000,
      stepMs: 100,
      boostWindows: [{ startMs: 2_000, endMs: 2_900 }],
    })

    const diagnostics = await collectDiagnostics(page)
    await saveArtifacts(page, testInfo, 'correction_under_jitter_webgl', diagnostics)

    assertWithFailureDump(diagnostics, () => {
      const info = diagnostics.predictionInfo
      expect(info).not.toBeNull()
      const correctionCount = (info?.correctionSoftCount ?? 0) + (info?.correctionHardCount ?? 0)
      expect(correctionCount).toBeGreaterThan(0)
      expect(info?.correctionHardCount ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(14)
      expect(info?.pendingInputCount ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(60)
      expect(info?.predictedHeadErrorDeg.p95Deg ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(6)
    })
  })

  test('ack_monotonicity_and_queue_bounds @prediction', async ({ page }, testInfo) => {
    await page.goto('/?renderer=webgl&prediction=1')
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
