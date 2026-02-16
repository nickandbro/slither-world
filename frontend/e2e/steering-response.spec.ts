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
const ARTIFACT_DIR = path.resolve(__dirname, '../../output/playwright/steering-response')

type PredictionInfo = {
  enabled: boolean
  pendingInputCount: number
  correctionHardCount: number
  replayedInputCountLastFrame: number
  replayedTickCountLastFrame: number
  commandsDroppedByCoalescingLastFrame: number
  commandsCoalescedPerTickP95LastFrame: number
}

type PredictionPresentationInfo = {
  headLagDeg: { lastDeg: number; p95Deg: number; maxDeg: number }
  bodyLagDeg: { lastDeg: number; p95Deg: number; maxDeg: number }
  bodyMicroReversalRate: number
  sampleCount: number
  microSampleCount: number
  reversalCount: number
}

type MotionInfo = {
  backwardCorrectionCount: number
  minHeadDot: number
  sampleCount: number
}

type CameraRotationStats = {
  sampleCount: number
  stepP95Deg: number
  stepMaxDeg: number
  reversalCount: number
  reversalRate: number
}

type SegmentParityStats = {
  sampleCount: number
  frontWindowP95Deg: number
  frontWindowMaxDeg: number
  fullBodyP95Deg: number
  fullBodyMaxDeg: number
  frontMismatchMs: number
  frontMismatchActive: boolean
}

type PredictionEvent = {
  type: string
  message: string
}

type SteeringResponseDiagnostics = {
  prediction: PredictionInfo | null
  predictionPresentation: PredictionPresentationInfo | null
  motion: MotionInfo | null
  cameraRotation: CameraRotationStats | null
  segmentParity: SegmentParityStats | null
  predictionEvents: PredictionEvent[]
}

async function collectDiagnostics(page: Page): Promise<SteeringResponseDiagnostics> {
  return page.evaluate(() => {
    const debugApi = (
      window as Window & {
        __SNAKE_DEBUG__?: {
          getPredictionInfo?: () => PredictionInfo
          getPredictionPresentationInfo?: () => PredictionPresentationInfo
          getMotionStabilityInfo?: () => MotionInfo
          getCameraRotationStats?: () => CameraRotationStats
          getSegmentParityStats?: () => SegmentParityStats
          getPredictionEvents?: () => PredictionEvent[]
        }
      }
    ).__SNAKE_DEBUG__
    return {
      prediction: debugApi?.getPredictionInfo?.() ?? null,
      predictionPresentation: debugApi?.getPredictionPresentationInfo?.() ?? null,
      motion: debugApi?.getMotionStabilityInfo?.() ?? null,
      cameraRotation: debugApi?.getCameraRotationStats?.() ?? null,
      segmentParity: debugApi?.getSegmentParityStats?.() ?? null,
      predictionEvents: debugApi?.getPredictionEvents?.() ?? [],
    }
  })
}

async function saveArtifacts(
  page: Page,
  testInfo: TestInfo,
  label: string,
  diagnostics: SteeringResponseDiagnostics,
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

function assertWithFailureDump(
  diagnostics: SteeringResponseDiagnostics,
  assertions: () => void,
): void {
  try {
    assertions()
  } catch (error) {
    console.error('prediction info', diagnostics.prediction ?? null)
    console.error('prediction presentation info', diagnostics.predictionPresentation ?? null)
    console.error('motion info', diagnostics.motion ?? null)
    console.error('camera rotation info', diagnostics.cameraRotation ?? null)
    console.error('segment parity info', diagnostics.segmentParity ?? null)
    console.error('last prediction events', diagnostics.predictionEvents.slice(-20))
    throw error
  }
}

test.describe('@steering-response local steering response', () => {
  test.describe.configure({ timeout: 120_000 })

  test.beforeEach(async ({ page }, testInfo) => {
    const room = `e2e-steering-response-${Date.now()}-${testInfo.retry}-${testInfo.parallelIndex}`
    await page.addInitScript(
      ({ keys, roomName }) => {
        localStorage.setItem(keys.name, 'E2E Steering Response')
        localStorage.setItem(keys.best, '0')
        localStorage.setItem(keys.room, roomName)
        localStorage.setItem(keys.perturb, '0')
      },
      { keys: STORAGE_KEYS, roomName: room },
    )
  })

  test('head_response_and_body_stability_webgl @steering-response', async ({ page }, testInfo) => {
    await page.goto('/?renderer=webgl&rafPerf=1')
    await enterGame(page)

    await page.waitForFunction(() => {
      const api = (
        window as Window & {
          __SNAKE_DEBUG__?: {
            getPredictionPresentationInfo?: () => unknown
          }
        }
      ).__SNAKE_DEBUG__
      return !!api?.getPredictionPresentationInfo?.()
    })

    await runDeterministicPredictionPath(page, {
      durationMs: 4_200,
      stepMs: 64,
      boostWindows: [],
    })

    const diagnostics = await collectDiagnostics(page)
    await saveArtifacts(page, testInfo, 'head_response_and_body_stability_webgl', diagnostics)

    assertWithFailureDump(diagnostics, () => {
      const prediction = diagnostics.prediction
      const presentation = diagnostics.predictionPresentation
      const motion = diagnostics.motion
      const segmentParity = diagnostics.segmentParity
      expect(prediction).not.toBeNull()
      expect(presentation).not.toBeNull()
      expect(motion).not.toBeNull()
      expect(segmentParity).not.toBeNull()
      expect(presentation?.sampleCount ?? 0).toBeGreaterThanOrEqual(20)
      expect(presentation?.headLagDeg.p95Deg ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(2.8)
      expect(presentation?.bodyMicroReversalRate ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(0.09)
      expect(presentation?.bodyLagDeg.p95Deg ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(4.8)
      expect(motion?.minHeadDot ?? 0).toBeGreaterThanOrEqual(0.992)
      expect(segmentParity?.frontWindowP95Deg ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(0.8)
      expect(segmentParity?.frontWindowMaxDeg ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(3)
      expect(segmentParity?.fullBodyP95Deg ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(2)
      expect(segmentParity?.frontMismatchMs ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(150)
      expect(prediction?.correctionHardCount ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(6)
      expect(prediction?.pendingInputCount ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(45)
    })
  })

  test('stability_under_prediction_perturbation_webgl @steering-response', async ({ page }, testInfo) => {
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

    await runDeterministicPredictionPath(page, {
      durationMs: 6_500,
      stepMs: 100,
      boostWindows: [{ startMs: 2_000, endMs: 2_900 }],
    })

    const diagnostics = await collectDiagnostics(page)
    await saveArtifacts(page, testInfo, 'stability_under_prediction_perturbation_webgl', diagnostics)

    assertWithFailureDump(diagnostics, () => {
      const prediction = diagnostics.prediction
      const presentation = diagnostics.predictionPresentation
      const segmentParity = diagnostics.segmentParity
      expect(prediction).not.toBeNull()
      expect(presentation).not.toBeNull()
      expect(segmentParity).not.toBeNull()
      expect(presentation?.sampleCount ?? 0).toBeGreaterThanOrEqual(24)
      expect(presentation?.headLagDeg.p95Deg ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(4.2)
      expect(presentation?.bodyMicroReversalRate ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(0.16)
      expect(presentation?.bodyLagDeg.p95Deg ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(6.5)
      expect(segmentParity?.frontWindowP95Deg ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(1.2)
      expect(segmentParity?.frontWindowMaxDeg ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(3)
      expect(segmentParity?.fullBodyP95Deg ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(3)
      expect(segmentParity?.frontMismatchMs ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(150)
      expect(prediction?.correctionHardCount ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(14)
      expect(prediction?.pendingInputCount ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(70)
      const overflowEvents = diagnostics.predictionEvents.filter(
        (event) => event.type === 'queue_prune' && event.message.includes('overflow'),
      )
      expect(overflowEvents.length).toBe(0)
    })
  })
})
