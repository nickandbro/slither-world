#!/usr/bin/env node

import { promises as fs } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..')

const parseArgs = () => {
  const args = process.argv.slice(2)
  const parsed = {
    appUrl: 'http://localhost:8818',
    durationSecs: 90,
    pollMs: 200,
    outputJson: path.join(REPO_ROOT, 'output/lag-tests/report.json'),
    screenshotPath: '',
    scenarioName: 'harsh',
    headless: true,
    tuningOverridesJson: '',
    requirePass: false,
  }

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    const next = () => {
      i += 1
      if (i >= args.length) {
        throw new Error(`missing value for ${arg}`)
      }
      return args[i]
    }

    switch (arg) {
      case '--app-url':
        parsed.appUrl = next()
        break
      case '--duration-secs':
        parsed.durationSecs = Number.parseFloat(next())
        break
      case '--poll-ms':
        parsed.pollMs = Number.parseFloat(next())
        break
      case '--output-json':
        parsed.outputJson = next()
        break
      case '--screenshot':
        parsed.screenshotPath = next()
        break
      case '--scenario-name':
        parsed.scenarioName = next()
        break
      case '--tuning-overrides-json':
        parsed.tuningOverridesJson = next()
        break
      case '--headed':
        parsed.headless = false
        break
      case '--headless':
        parsed.headless = true
        break
      case '--require-pass':
        parsed.requirePass = true
        break
      default:
        throw new Error(`unknown argument: ${arg}`)
    }
  }

  if (!Number.isFinite(parsed.durationSecs) || parsed.durationSecs <= 0) {
    throw new Error('--duration-secs must be > 0')
  }
  if (!Number.isFinite(parsed.pollMs) || parsed.pollMs < 40) {
    throw new Error('--poll-ms must be >= 40')
  }
  return parsed
}

const ensureDir = async (filePath) => {
  const dir = path.dirname(filePath)
  await fs.mkdir(dir, { recursive: true })
}

const quantile = (values, percentile) => {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const rank = (sorted.length - 1) * percentile
  const lower = Math.floor(rank)
  const upper = Math.ceil(rank)
  if (lower === upper) return sorted[lower]
  const weight = rank - lower
  return sorted[lower] * (1 - weight) + sorted[upper] * weight
}

const average = (values) => {
  if (values.length === 0) return null
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

const maxSpikeStartsRollingWindow = (events, windowMs) => {
  const starts = events
    .filter((event) => event && event.type === 'spike_start' && Number.isFinite(event.tMs))
    .map((event) => Number(event.tMs))
    .sort((a, b) => a - b)

  let maxInWindow = 0
  let left = 0
  for (let right = 0; right < starts.length; right += 1) {
    while (starts[right] - starts[left] > windowMs) {
      left += 1
    }
    const count = right - left + 1
    if (count > maxInWindow) {
      maxInWindow = count
    }
  }
  return maxInWindow
}

const maxImpairmentMismatchMs = (samples) => {
  if (samples.length === 0) return 0
  let maxMs = 0
  let mismatchStart = null

  for (const sample of samples) {
    const net = sample.net
    const hasMismatch =
      !!net &&
      net.lagSpikeActive === false &&
      Number.isFinite(net.impairmentMsRemaining) &&
      net.impairmentMsRemaining > 0

    if (hasMismatch) {
      if (mismatchStart === null) mismatchStart = sample.tMs
    } else if (mismatchStart !== null) {
      maxMs = Math.max(maxMs, sample.tMs - mismatchStart)
      mismatchStart = null
    }
  }

  if (mismatchStart !== null) {
    const lastTs = samples[samples.length - 1].tMs
    maxMs = Math.max(maxMs, lastTs - mismatchStart)
  }

  return maxMs
}

const computeVerdict = (samples, events, finalMotion) => {
  const netSamples = samples.map((sample) => sample.net).filter(Boolean)
  const spikeDelays = netSamples
    .filter((net) => net.lagSpikeActive)
    .map((net) => net.playoutDelayMs)
    .filter(Number.isFinite)
  const nonSpikeDelays = netSamples
    .filter((net) => !net.lagSpikeActive)
    .map((net) => net.playoutDelayMs)
    .filter(Number.isFinite)

  const overallDelays = netSamples.map((net) => net.playoutDelayMs).filter(Number.isFinite)
  const overallJitter = netSamples.map((net) => net.jitterMs).filter(Number.isFinite)

  const backwardCorrectionCount =
    finalMotion && Number.isFinite(finalMotion.backwardCorrectionCount)
      ? Number(finalMotion.backwardCorrectionCount)
      : 0
  const sampleCount =
    finalMotion && Number.isFinite(finalMotion.sampleCount)
      ? Math.max(1, Number(finalMotion.sampleCount))
      : 1
  const backwardCorrectionRate = backwardCorrectionCount / sampleCount
  const minHeadDot =
    finalMotion && Number.isFinite(finalMotion.minHeadDot) ? Number(finalMotion.minHeadDot) : 1

  const p95NonSpikeDelay = quantile(nonSpikeDelays, 0.95)
  const p95SpikeDelay = quantile(spikeDelays, 0.95)
  const p95Delay = quantile(overallDelays, 0.95)
  const p95Jitter = quantile(overallJitter, 0.95)

  const maxStartsIn5s = maxSpikeStartsRollingWindow(events, 5000)
  const mismatchMaxMs = maxImpairmentMismatchMs(samples)

  const checks = [
    {
      id: 'backward_correction_rate',
      pass: backwardCorrectionRate <= 0.002,
      value: backwardCorrectionRate,
      target: '<= 0.002',
    },
    {
      id: 'min_head_dot',
      pass: minHeadDot >= 0.995,
      value: minHeadDot,
      target: '>= 0.995',
    },
    {
      id: 'non_spike_p95_delay_ms',
      pass: p95NonSpikeDelay !== null ? p95NonSpikeDelay <= 170 : true,
      value: p95NonSpikeDelay,
      target: '<= 170',
    },
    {
      id: 'spike_p95_delay_ms',
      pass: p95SpikeDelay !== null ? p95SpikeDelay <= 240 : true,
      value: p95SpikeDelay,
      target: '<= 240',
    },
    {
      id: 'max_spike_starts_5s',
      pass: maxStartsIn5s <= 3,
      value: maxStartsIn5s,
      target: '<= 3',
    },
    {
      id: 'impairment_mismatch_ms',
      pass: mismatchMaxMs <= 350,
      value: mismatchMaxMs,
      target: '<= 350',
    },
  ]

  const failedChecks = checks.filter((check) => !check.pass)
  const pass = failedChecks.length === 0

  const score =
    (p95NonSpikeDelay ?? 0) +
    (p95SpikeDelay ?? 0) * 0.75 +
    maxStartsIn5s * 20 +
    mismatchMaxMs * 0.05 +
    backwardCorrectionRate * 100000 +
    Math.max(0, 0.995 - minHeadDot) * 200000

  return {
    pass,
    score,
    checks,
    failedChecks,
    aggregates: {
      sampleCount: samples.length,
      eventCount: events.length,
      p50DelayMs: quantile(overallDelays, 0.5),
      p95DelayMs: p95Delay,
      p99DelayMs: quantile(overallDelays, 0.99),
      p95JitterMs: p95Jitter,
      p95NonSpikeDelayMs: p95NonSpikeDelay,
      p95SpikeDelayMs: p95SpikeDelay,
      spikeStartCount: events.filter((event) => event.type === 'spike_start').length,
      spikeEndCount: events.filter((event) => event.type === 'spike_end').length,
      maxSpikeStartsIn5s: maxStartsIn5s,
      mismatchMaxMs,
      averageDelayMs: average(overallDelays),
      averageJitterMs: average(overallJitter),
    },
    motion: {
      backwardCorrectionCount,
      sampleCount: sampleCount === 1 ? 0 : sampleCount,
      backwardCorrectionRate,
      minHeadDot,
    },
  }
}

const loadPlaywright = async () => {
  const modulePath = path.resolve(REPO_ROOT, 'frontend/node_modules/playwright/index.mjs')
  try {
    await fs.access(modulePath)
  } catch {
    throw new Error(
      `playwright module not found at ${modulePath}. Run 'cd frontend && npm install' first.`,
    )
  }
  const moduleUrl = pathToFileURL(modulePath).href
  return import(moduleUrl)
}

const parseTuningOverrides = (json) => {
  if (!json) return {}
  try {
    const parsed = JSON.parse(json)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('must be a JSON object')
    }
    return parsed
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`invalid --tuning-overrides-json: ${message}`)
  }
}

const computePointerTarget = (bounds, elapsedMs) => {
  const centerX = bounds.x + bounds.width / 2
  const centerY = bounds.y + bounds.height / 2
  const radius = Math.min(bounds.width, bounds.height) * 0.17
  const t = elapsedMs / 1000
  const phase = Math.floor(t / 8) % 4

  if (phase === 0) {
    const angle = t * 1.9
    return {
      x: centerX + Math.cos(angle) * radius,
      y: centerY + Math.sin(angle) * radius,
    }
  }

  if (phase === 1) {
    const angle = -t * 2.1
    return {
      x: centerX + Math.cos(angle) * radius * 0.9,
      y: centerY + Math.sin(angle) * radius * 0.9,
    }
  }

  if (phase === 2) {
    return {
      x: centerX + Math.sin(t * 2.4) * radius * 0.95,
      y: centerY + Math.sin(t * 4.8) * radius * 0.6,
    }
  }

  const saw = ((t * 1.5) % 2) < 1 ? 1 : -1
  return {
    x: centerX + saw * radius * 0.85,
    y: centerY + Math.sin(t * 3.3) * radius * 0.7,
  }
}

const shouldBoostAt = (elapsedMs) => {
  const cycleA = elapsedMs % 2600
  const cycleB = elapsedMs % 9100
  const burstA = cycleA >= 620 && cycleA < 1220
  const burstB = cycleA >= 1720 && cycleA < 2160
  const longDrift = cycleB >= 5200 && cycleB < 6400
  return burstA || burstB || longDrift
}

const run = async () => {
  const options = parseArgs()
  const tuningOverrides = parseTuningOverrides(options.tuningOverridesJson)
  await ensureDir(options.outputJson)
  if (options.screenshotPath) {
    await ensureDir(options.screenshotPath)
  }

  const { chromium } = await loadPlaywright()
  const browser = await chromium.launch({ headless: options.headless })
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()

  let report = null
  try {
    await page.goto(options.appUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 })

    const playButton = page.getByRole('button', { name: /Play/ })
    await playButton.waitFor({ state: 'visible', timeout: 30_000 })

    await page.waitForFunction(() => {
      const debugApi = window.__SNAKE_DEBUG__
      return !!debugApi
    })

    await page.waitForFunction(() => {
      const debugApi = window.__SNAKE_DEBUG__
      return typeof debugApi?.clearNetLagEvents === 'function'
    })

    const tuningResult = await page.evaluate((incomingOverrides) => {
      const debugApi = window.__SNAKE_DEBUG__
      if (!debugApi || typeof debugApi.setNetTuningOverrides !== 'function') {
        throw new Error('setNetTuningOverrides debug method is unavailable')
      }
      const applied = debugApi.setNetTuningOverrides(incomingOverrides)
      if (typeof debugApi.clearNetLagEvents === 'function') {
        debugApi.clearNetLagEvents()
      }
      return {
        applied,
        current: typeof debugApi.getNetTuningOverrides === 'function'
          ? debugApi.getNetTuningOverrides()
          : null,
      }
    }, tuningOverrides)

    await playButton.click()

    try {
      await page.waitForFunction(() => {
        const debugApi = window.__SNAKE_DEBUG__
        const info = debugApi?.getMenuFlowInfo?.()
        return info?.phase === 'playing' && info?.hasSpawned === true
      }, { timeout: 35_000 })
    } catch {
      const playAgain = page.getByRole('button', { name: /Play/ })
      if (await playAgain.isVisible().catch(() => false)) {
        await playAgain.click()
      }
      await page.waitForFunction(() => {
        const debugApi = window.__SNAKE_DEBUG__
        const info = debugApi?.getMenuFlowInfo?.()
        return info?.phase === 'playing' && info?.hasSpawned === true
      }, { timeout: 35_000 })
    }

    await page.locator('.player-stats-card').waitFor({ state: 'visible', timeout: 20_000 })
    await page.locator('.control-panel').waitFor({ state: 'visible', timeout: 15_000 })

    const canvas = page.locator('.game-canvas')
    await canvas.waitFor({ state: 'visible', timeout: 15_000 })

    let bounds = await canvas.boundingBox()
    if (!bounds) {
      throw new Error('failed to resolve game canvas bounds')
    }

    const centerX = bounds.x + bounds.width / 2
    const centerY = bounds.y + bounds.height / 2
    await page.mouse.click(centerX, centerY)

    const samples = []
    const startedAtPerf = await page.evaluate(() => performance.now())
    const startedAtIso = new Date().toISOString()
    const durationMs = options.durationSecs * 1000
    let nextSampleAt = 0
    let boostDown = false

    while (true) {
      const nowPerf = await page.evaluate(() => performance.now())
      const elapsedMs = nowPerf - startedAtPerf
      if (elapsedMs >= durationMs) break

      const refreshedBounds = await canvas.boundingBox()
      if (refreshedBounds) {
        bounds = refreshedBounds
      }

      const target = computePointerTarget(bounds, elapsedMs)
      await page.mouse.move(target.x, target.y)

      const boostWanted = shouldBoostAt(elapsedMs)
      if (boostWanted !== boostDown) {
        if (boostWanted) {
          await page.keyboard.down('Space')
        } else {
          await page.keyboard.up('Space')
        }
        boostDown = boostWanted
      }

      if (elapsedMs >= nextSampleAt) {
        const sample = await page.evaluate(() => {
          const debugApi = window.__SNAKE_DEBUG__
          if (!debugApi) return null
          const net = typeof debugApi.getNetSmoothingInfo === 'function'
            ? debugApi.getNetSmoothingInfo()
            : null
          const motion = typeof debugApi.getMotionStabilityInfo === 'function'
            ? debugApi.getMotionStabilityInfo()
            : null
          return {
            tMs: performance.now(),
            net,
            motion,
          }
        })
        if (sample) {
          samples.push(sample)
        }
        nextSampleAt += options.pollMs
      }

      await page.waitForTimeout(50)
    }

    if (boostDown) {
      await page.keyboard.up('Space')
      boostDown = false
    }

    const finalDebug = await page.evaluate(() => {
      const debugApi = window.__SNAKE_DEBUG__
      if (!debugApi) {
        throw new Error('__SNAKE_DEBUG__ unavailable after run')
      }
      return {
        net: typeof debugApi.getNetSmoothingInfo === 'function'
          ? debugApi.getNetSmoothingInfo()
          : null,
        motion: typeof debugApi.getMotionStabilityInfo === 'function'
          ? debugApi.getMotionStabilityInfo()
          : null,
        events: typeof debugApi.getNetLagEvents === 'function'
          ? debugApi.getNetLagEvents()
          : [],
        report: typeof debugApi.getNetLagReport === 'function'
          ? debugApi.getNetLagReport()
          : null,
      }
    })

    const verdict = computeVerdict(samples, finalDebug.events, finalDebug.motion)

    report = {
      generatedAtIso: new Date().toISOString(),
      startedAtIso,
      scenario: {
        name: options.scenarioName,
        appUrl: options.appUrl,
        durationSecs: options.durationSecs,
        pollMs: options.pollMs,
      },
      tuning: {
        requestedOverrides: tuningOverrides,
        applied: tuningResult.applied ?? null,
        currentOverrides: tuningResult.current,
      },
      final: {
        net: finalDebug.net,
        motion: finalDebug.motion,
      },
      aggregates: verdict.aggregates,
      motion: verdict.motion,
      checks: verdict.checks,
      verdict: {
        pass: verdict.pass,
        score: verdict.score,
        failedChecks: verdict.failedChecks,
      },
      samples,
      events: finalDebug.events,
      debugReport: finalDebug.report,
    }

    if (options.screenshotPath) {
      await page.screenshot({ path: options.screenshotPath })
    }

    await fs.writeFile(options.outputJson, `${JSON.stringify(report, null, 2)}\n`, 'utf8')

    const summary = {
      pass: report.verdict.pass,
      score: Number(report.verdict.score.toFixed(3)),
      p95DelayMs: report.aggregates.p95DelayMs,
      p95NonSpikeDelayMs: report.aggregates.p95NonSpikeDelayMs,
      p95SpikeDelayMs: report.aggregates.p95SpikeDelayMs,
      maxSpikeStartsIn5s: report.aggregates.maxSpikeStartsIn5s,
      mismatchMaxMs: report.aggregates.mismatchMaxMs,
      backwardCorrectionRate: report.motion.backwardCorrectionRate,
      minHeadDot: report.motion.minHeadDot,
      outputJson: options.outputJson,
    }

    console.log(JSON.stringify(summary, null, 2))

    if (options.requirePass && !report.verdict.pass) {
      process.exitCode = 2
    }
  } finally {
    await context.close().catch(() => {})
    await browser.close().catch(() => {})
  }
}

run().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error)
  console.error(`[lag-bot-runner] ${message}`)
  process.exit(1)
})
