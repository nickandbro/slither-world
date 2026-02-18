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
    pollMs: 120,
    outputDir: path.join(REPO_ROOT, 'output/tail-growth-tests'),
    runLabel: '',
    headless: false,
    autoPlay: true,
    screenshotPath: '',
  }

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    const next = () => {
      i += 1
      if (i >= args.length) throw new Error(`missing value for ${arg}`)
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
      case '--output-dir':
        parsed.outputDir = next()
        break
      case '--run-label':
        parsed.runLabel = next()
        break
      case '--headless':
        parsed.headless = true
        break
      case '--headed':
        parsed.headless = false
        break
      case '--no-auto-play':
        parsed.autoPlay = false
        break
      case '--auto-play':
        parsed.autoPlay = true
        break
      case '--screenshot':
        parsed.screenshotPath = next()
        break
      case '--no-screenshot':
        parsed.screenshotPath = ''
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

const appendDebugQuery = (baseUrl) => {
  const url = new URL(baseUrl)
  url.searchParams.set('tailDebug', '1')
  url.searchParams.set('netDebug', '1')
  url.searchParams.set('rafPerf', '1')
  return url.toString()
}

const normalizeLabel = (value) => {
  const trimmed = (value ?? '').trim()
  if (trimmed.length <= 0) return ''
  return trimmed.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80)
}

const toFiniteOrNull = (value) => {
  const num = Number(value)
  return Number.isFinite(num) ? num : null
}

const effectiveSnakeLen = (event) => {
  const snakeLen = toFiniteOrNull(event?.snakeLen)
  if (snakeLen !== null) return snakeLen
  const snakeTotalLen = toFiniteOrNull(event?.snakeTotalLen)
  return snakeTotalLen
}

const isLiveSnakeSample = (event) =>
  event?.alive === true && (effectiveSnakeLen(event) ?? 0) > 0

const isLikelyBotName = (name) => {
  if (typeof name !== 'string') return false
  return /^bot-\d+$/i.test(name.trim())
}

const extractJumps = (events, stream) => {
  const jumps = []
  let prev = null

  for (const event of events) {
    const tMs = toFiniteOrNull(event?.tMs)
    const lenUnits = toFiniteOrNull(event?.lenUnits)
    if (tMs === null || lenUnits === null) continue

    if (
      prev &&
      tMs > prev.tMs &&
      isLiveSnakeSample(prev.raw) &&
      isLiveSnakeSample(event)
    ) {
      const dtMs = tMs - prev.tMs
      const deltaLenUnits = lenUnits - prev.lenUnits
      const absDeltaLenUnits = Math.abs(deltaLenUnits)
      const threshold = dtMs <= 190 ? 0.55 : dtMs <= 320 ? 0.85 : 1.1

      if (absDeltaLenUnits >= threshold) {
        jumps.push({
          stream,
          fromId: prev.id,
          toId: event?.id ?? null,
          fromSeq: prev.seq,
          toSeq: event?.seq ?? null,
          fromNow: prev.now,
          toNow: event?.now ?? null,
          fromKind: prev.kind,
          toKind: event?.kind ?? null,
          tMs,
          dtMs,
          deltaLenUnits,
          absDeltaLenUnits,
          fromTailEndLen: prev.tailEndLen,
          toTailEndLen: toFiniteOrNull(event?.tailEndLen),
        })
      }
    }

    prev = {
      id: event?.id ?? null,
      seq: event?.seq ?? null,
      now: event?.now ?? null,
      kind: event?.kind ?? null,
      tMs,
      lenUnits,
      tailEndLen: toFiniteOrNull(event?.tailEndLen),
      raw: event,
    }
  }

  return jumps
}

const extractTailEndJumps = (events, stream) => {
  const jumps = []
  let prev = null

  for (const event of events) {
    const tMs = toFiniteOrNull(event?.tMs)
    const endLen = toFiniteOrNull(event?.tailEndLen)
    const refLen = toFiniteOrNull(event?.tailRefLen)
    if (tMs === null || endLen === null) continue

    if (
      prev &&
      tMs > prev.tMs &&
      isLiveSnakeSample(prev.raw) &&
      isLiveSnakeSample(event)
    ) {
      const dtMs = tMs - prev.tMs
      const deltaTailEndLen = endLen - prev.endLen
      const absDeltaTailEndLen = Math.abs(deltaTailEndLen)
      const dynamicThreshold = Math.max(0.012, (refLen ?? prev.refLen ?? 0) * 0.7)
      const threshold = dtMs <= 200 ? dynamicThreshold : dynamicThreshold * 1.35
      if (absDeltaTailEndLen >= threshold) {
        jumps.push({
          stream,
          fromId: prev.id,
          toId: event?.id ?? null,
          fromSeq: prev.seq,
          toSeq: event?.seq ?? null,
          fromNow: prev.now,
          toNow: event?.now ?? null,
          tMs,
          dtMs,
          deltaTailEndLen,
          absDeltaTailEndLen,
          fromTailEndLen: prev.endLen,
          toTailEndLen: endLen,
          threshold,
        })
      }
    }

    prev = {
      id: event?.id ?? null,
      seq: event?.seq ?? null,
      now: event?.now ?? null,
      tMs,
      endLen,
      refLen,
      raw: event,
    }
  }

  return jumps
}

const extractPredictionLengthMismatches = (events) => {
  const mismatches = []
  for (const event of events) {
    const snakeLen = toFiniteOrNull(event?.snakeLen)
    const rawSnakeLen = toFiniteOrNull(event?.rawSnakeLen)
    if (snakeLen === null || rawSnakeLen === null) continue
    if (snakeLen === rawSnakeLen) continue
    mismatches.push({
      stream: 'render_prediction_length',
      id: event?.id ?? null,
      seq: event?.seq ?? null,
      now: event?.now ?? null,
      tMs: toFiniteOrNull(event?.tMs),
      snakeLen,
      rawSnakeLen,
      snakeTotalLen: toFiniteOrNull(event?.snakeTotalLen),
      rawSnakeTotalLen: toFiniteOrNull(event?.rawSnakeTotalLen),
      deltaSnakeLen: snakeLen - rawSnakeLen,
      tailExtension: toFiniteOrNull(event?.tailExtension),
      rawTailExtension: toFiniteOrNull(event?.rawTailExtension),
      tailEndLen: toFiniteOrNull(event?.tailEndLen),
      rawTailEndLen: toFiniteOrNull(event?.rawTailEndLen),
    })
  }
  return mismatches
}

const classifyJumpSources = (rxJumps, renderJumps) => {
  const incidents = []
  const matchedRx = new Set()

  for (const renderJump of renderJumps) {
    let matchIndex = -1
    for (let index = 0; index < rxJumps.length; index += 1) {
      if (matchedRx.has(index)) continue
      const rxJump = rxJumps[index]
      const sameDirection =
        Math.sign(renderJump.deltaLenUnits || 0) === Math.sign(rxJump.deltaLenUnits || 0)
      const closeInTime = Math.abs((renderJump.tMs ?? 0) - (rxJump.tMs ?? 0)) <= 220
      if (sameDirection && closeInTime) {
        matchIndex = index
        break
      }
    }

    if (matchIndex >= 0) {
      matchedRx.add(matchIndex)
      incidents.push({
        source: 'rx_jump',
        render: renderJump,
        rx: rxJumps[matchIndex],
      })
    } else {
      incidents.push({
        source: 'render_jump',
        render: renderJump,
        rx: null,
      })
    }
  }

  for (let index = 0; index < rxJumps.length; index += 1) {
    if (matchedRx.has(index)) continue
    incidents.push({
      source: 'rx_jump',
      render: null,
      rx: rxJumps[index],
    })
  }

  incidents.sort((a, b) => {
    const aMag = Math.max(
      Math.abs(a.render?.deltaLenUnits ?? 0),
      Math.abs(a.rx?.deltaLenUnits ?? 0),
    )
    const bMag = Math.max(
      Math.abs(b.render?.deltaLenUnits ?? 0),
      Math.abs(b.rx?.deltaLenUnits ?? 0),
    )
    return bMag - aMag
  })

  const rxJumpCount = incidents.filter((incident) => incident.source === 'rx_jump').length
  const renderJumpCount = incidents.filter((incident) => incident.source === 'render_jump').length

  let rootCause = 'none'
  if (rxJumpCount > 0 && renderJumpCount === 0) {
    rootCause = 'server'
  } else if (renderJumpCount > 0 && rxJumpCount === 0) {
    rootCause = 'client'
  } else if (renderJumpCount > 0 && rxJumpCount > 0) {
    rootCause = 'mixed'
  }

  return {
    rootCause,
    rxJumpCount,
    renderJumpCount,
    incidents,
  }
}

const classifyTailRootCause = ({
  lenUnitSummary,
  renderTailEndJumps,
  shrinkEvents,
  stretchEvents,
  segmentSpacingJumps,
  allPlayerJumps,
  predictionLengthMismatches,
}) => {
  const renderSignalCount =
    lenUnitSummary.renderJumpCount +
    renderTailEndJumps.length +
    shrinkEvents.length +
    stretchEvents.length +
    segmentSpacingJumps.length +
    allPlayerJumps.length +
    predictionLengthMismatches.length
  const rxSignalCount = lenUnitSummary.rxJumpCount

  let rootCause = 'none'
  if (renderSignalCount > 0 && rxSignalCount === 0) {
    rootCause = 'client'
  } else if (renderSignalCount === 0 && rxSignalCount > 0) {
    rootCause = 'server'
  } else if (renderSignalCount > 0 && rxSignalCount > 0) {
    rootCause = 'mixed'
  }

  const incidents = []
  for (const incident of lenUnitSummary.incidents) {
    incidents.push({
      source: incident.source,
      kind: 'len_units',
      render: incident.render,
      rx: incident.rx,
    })
  }
  for (const jump of renderTailEndJumps) {
    incidents.push({
      source: 'client_tail_end_jump',
      kind: 'tail_end',
      render: jump,
      rx: null,
    })
  }
  for (const event of shrinkEvents) {
    incidents.push({
      source: 'client_shrink',
      kind: 'tail_event',
      render: event,
      rx: null,
    })
  }
  for (const event of stretchEvents) {
    incidents.push({
      source: 'client_stretch',
      kind: 'tail_event',
      render: event,
      rx: null,
    })
  }
  for (const jump of segmentSpacingJumps) {
    incidents.push({
      source: 'client_segment_spacing_jump',
      kind: 'segment_spacing',
      render: jump,
      rx: null,
    })
  }
  for (const jump of allPlayerJumps) {
    incidents.push({
      source: 'all_player_snapshot_jump',
      kind: 'all_player',
      render: jump,
      rx: null,
    })
  }
  for (const mismatch of predictionLengthMismatches) {
    incidents.push({
      source: 'client_prediction_length_mismatch',
      kind: 'prediction_length',
      render: mismatch,
      rx: null,
    })
  }

  incidents.sort((a, b) => {
    const aMag = Math.max(
      Math.abs(a.render?.deltaLenUnits ?? 0),
      Math.abs(a.render?.deltaTailEndLen ?? 0),
      Math.abs(a.render?.deltaTailSegMean ?? 0),
      Math.abs(a.rx?.deltaLenUnits ?? 0),
      Math.abs(a.render?.tailEndLen ?? 0),
    )
    const bMag = Math.max(
      Math.abs(b.render?.deltaLenUnits ?? 0),
      Math.abs(b.render?.deltaTailEndLen ?? 0),
      Math.abs(b.render?.deltaTailSegMean ?? 0),
      Math.abs(b.rx?.deltaLenUnits ?? 0),
      Math.abs(b.render?.tailEndLen ?? 0),
    )
    return bMag - aMag
  })

  return {
    rootCause,
    rxJumpCount: lenUnitSummary.rxJumpCount,
    renderJumpCount: lenUnitSummary.renderJumpCount,
    renderTailEndJumpCount: renderTailEndJumps.length,
    shrinkCount: shrinkEvents.length,
    stretchCount: stretchEvents.length,
    segmentSpacingJumpCount: segmentSpacingJumps.length,
    allPlayerJumpCount: allPlayerJumps.length,
    predictionLenMismatchCount: predictionLengthMismatches.length,
    incidents,
  }
}

const extractSegmentSpacingJumps = (samples) => {
  const jumps = []
  let prev = null
  for (const sample of samples) {
    const metrics = sample?.localSnakeMetrics
    const tMs = toFiniteOrNull(sample?.tMs)
    if (!metrics || tMs === null) {
      prev = sample
      continue
    }
    const pointCount = toFiniteOrNull(metrics.pointCount)
    const tailSegMean = toFiniteOrNull(metrics.tailSegMean)
    if (pointCount === null || tailSegMean === null) {
      prev = sample
      continue
    }
    if (
      prev &&
      prev.localSnakeMetrics &&
      Number.isFinite(prev.localSnakeMetrics.pointCount) &&
      Number.isFinite(prev.localSnakeMetrics.tailSegMean)
    ) {
      const prevMetrics = prev.localSnakeMetrics
      const dtMs = tMs - (toFiniteOrNull(prev.tMs) ?? tMs)
      const prevPointCount = prevMetrics.pointCount
      const prevTailSegMean = prevMetrics.tailSegMean
      if (dtMs > 0 && dtMs <= 220 && pointCount >= 4 && prevPointCount >= 4) {
        const stableCount = Math.min(pointCount, prevPointCount)
        if (stableCount >= 4) {
          const deltaTailSegMean = tailSegMean - prevTailSegMean
          const absDelta = Math.abs(deltaTailSegMean)
          const ref = Math.max(0.000001, prevTailSegMean, tailSegMean)
          const ratio = absDelta / ref
          if (ratio >= 0.42 && absDelta >= 0.0075) {
            jumps.push({
              stream: 'sample_segment_spacing',
              fromSampleIndex: prev._sampleIndex ?? null,
              toSampleIndex: sample._sampleIndex ?? null,
              tMs,
              dtMs,
              fromPointCount: prevPointCount,
              toPointCount: pointCount,
              fromTailSegMean: prevTailSegMean,
              toTailSegMean: tailSegMean,
              deltaTailSegMean,
              absDeltaTailSegMean: absDelta,
              ratio,
            })
          }
        }
      }
    }
    prev = sample
  }
  return jumps
}

const extractAllPlayerJumps = (events) => {
  const byPlayer = new Map()
  for (const event of events) {
    const id = event?.id
    if (typeof id !== 'string' || id.length <= 0) continue
    const arr = byPlayer.get(id)
    if (arr) {
      arr.push(event)
    } else {
      byPlayer.set(id, [event])
    }
  }

  const incidents = []
  for (const [playerId, playerEvents] of byPlayer.entries()) {
    playerEvents.sort((a, b) => (toFiniteOrNull(a.tMs) ?? 0) - (toFiniteOrNull(b.tMs) ?? 0))
    let prev = null
    for (const event of playerEvents) {
      const tMs = toFiniteOrNull(event?.tMs)
      const lenUnits = toFiniteOrNull(event?.lenUnits)
      const tailEndLen = toFiniteOrNull(event?.tailEndLen)
      const snakeLen = effectiveSnakeLen(event)
      if (tMs === null || lenUnits === null || snakeLen === null) {
        prev = {
          tMs,
          lenUnits,
          tailEndLen,
          snakeLen,
          alive: event?.alive === true,
          seq: event?.seq ?? null,
          now: event?.now ?? null,
          name: event?.name ?? null,
        }
        continue
      }
      if (
        prev &&
        Number.isFinite(prev.tMs) &&
        Number.isFinite(prev.lenUnits) &&
        Number.isFinite(prev.snakeLen) &&
        prev.alive === true &&
        event?.alive === true &&
        prev.snakeLen > 0 &&
        snakeLen > 0
      ) {
        const dtMs = tMs - prev.tMs
        if (dtMs > 0 && dtMs <= 220) {
          const deltaLenUnits = lenUnits - prev.lenUnits
          const absDeltaLenUnits = Math.abs(deltaLenUnits)
          const lenThreshold = dtMs <= 160 ? 0.42 : 0.58
          const deltaTailEndLen =
            tailEndLen !== null && Number.isFinite(prev.tailEndLen)
              ? tailEndLen - prev.tailEndLen
              : null
          const absDeltaTailEndLen =
            deltaTailEndLen === null ? 0 : Math.abs(deltaTailEndLen)
          const tailEndThreshold = 0.0115
          if (absDeltaLenUnits >= lenThreshold || absDeltaTailEndLen >= tailEndThreshold) {
            incidents.push({
              stream: 'all_player_snapshot',
              playerId,
              name: event?.name ?? prev?.name ?? null,
              fromSeq: prev.seq ?? null,
              toSeq: event?.seq ?? null,
              fromNow: prev.now ?? null,
              toNow: event?.now ?? null,
              tMs,
              dtMs,
              deltaLenUnits,
              absDeltaLenUnits,
              lenThreshold,
              deltaTailEndLen,
              absDeltaTailEndLen,
              tailEndThreshold,
            })
          }
        }
      }
      prev = {
        tMs,
        lenUnits,
        tailEndLen,
        snakeLen,
        alive: event?.alive === true,
        seq: event?.seq ?? null,
        now: event?.now ?? null,
        name: event?.name ?? null,
      }
    }
  }

  incidents.sort(
    (a, b) =>
      Math.max(Math.abs(b.deltaLenUnits ?? 0), Math.abs(b.deltaTailEndLen ?? 0)) -
      Math.max(Math.abs(a.deltaLenUnits ?? 0), Math.abs(a.deltaTailEndLen ?? 0)),
  )
  return incidents
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

const run = async () => {
  const options = parseArgs()

  const normalizedLabel = normalizeLabel(options.runLabel)
  const runLabel =
    normalizedLabel.length > 0
      ? normalizedLabel
      : `run-${new Date().toISOString().replace(/[:.]/g, '-').replace('T', 'T').replace('Z', 'Z')}`
  const runDir = path.join(options.outputDir, runLabel)

  const reportPath = path.join(runDir, 'report.json')
  const tailEventsPath = path.join(runDir, 'tail-events.json')
  const allPlayerEventsPath = path.join(runDir, 'all-player-events.json')
  const samplePath = path.join(runDir, 'samples.json')
  const violationPath = path.join(runDir, 'console-violations.json')
  const tailConsolePath = path.join(runDir, 'tail-console.json')

  await fs.mkdir(runDir, { recursive: true })
  await ensureDir(reportPath)
  if (options.screenshotPath) {
    await ensureDir(options.screenshotPath)
  }

  const debugUrl = appendDebugQuery(options.appUrl)

  const { chromium } = await loadPlaywright()
  const browser = await chromium.launch({ headless: options.headless })
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()

  const violations = []
  const tailConsole = []
  const samples = []
  const capturedTailEvents = []
  const allPlayerEvents = []
  let lastTailEventId = 0

  try {
    page.on('console', (msg) => {
      const text = msg.text?.() ?? ''
      const entry = {
        atIso: new Date().toISOString(),
        type: msg.type?.() ?? 'log',
        text,
        location: typeof msg.location === 'function' ? msg.location() : {},
      }
      if (text.includes('[Violation]')) {
        violations.push(entry)
      }
      if (text.includes('[tail]')) {
        tailConsole.push(entry)
      }
    })

    await page.goto(debugUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 })

    await page.waitForFunction(() => {
      const debugApi = window.__SNAKE_DEBUG__
      return (
        !!debugApi &&
        typeof debugApi.getTailGrowthEvents === 'function' &&
        typeof debugApi.getTailGrowthReport === 'function' &&
        typeof debugApi.getNetSmoothingInfo === 'function'
      )
    }, { timeout: 60_000 })

    await page.evaluate(() => {
      const debugApi = window.__SNAKE_DEBUG__
      debugApi?.clearTailGrowthEvents?.()
      debugApi?.clearNetLagEvents?.()
      debugApi?.clearPredictionEvents?.()
      debugApi?.clearPredictionPresentationMetrics?.()
      debugApi?.clearRafPerf?.()
    })

    if (options.autoPlay) {
      const playButton = page.getByRole('button', { name: /Play/i })
      if (await playButton.isVisible().catch(() => false)) {
        await playButton.click().catch(() => {})
      }
    }

    await page.waitForFunction(() => {
      const debugApi = window.__SNAKE_DEBUG__
      const info = debugApi?.getMenuFlowInfo?.()
      return info?.phase === 'playing' && info?.hasSpawned === true
    }, { timeout: 120_000 })

    const startedAtIso = new Date().toISOString()
    const startedAtPerf = await page.evaluate(() => performance.now())
    const durationMs = options.durationSecs * 1000

    while (true) {
      const sample = await page.evaluate(() => {
        const debugApi = window.__SNAKE_DEBUG__
        const tailEvents = debugApi?.getTailGrowthEvents?.() ?? []
        const latestTailEvent = tailEvents.length > 0 ? tailEvents[tailEvents.length - 1] : null
        const points = debugApi?.getLocalSnakePoints?.(128) ?? []
        let segCount = 0
        let segSum = 0
        let segMin = Number.POSITIVE_INFINITY
        let segMax = 0
        for (let i = 1; i < points.length; i += 1) {
          const a = points[i - 1]
          const b = points[i]
          const len = Math.hypot((b.x ?? 0) - (a.x ?? 0), (b.y ?? 0) - (a.y ?? 0), (b.z ?? 0) - (a.z ?? 0))
          if (!Number.isFinite(len)) continue
          segCount += 1
          segSum += len
          if (len < segMin) segMin = len
          if (len > segMax) segMax = len
        }
        const tailWindow = Math.min(6, segCount)
        let tailSegSum = 0
        let tailSegCount = 0
        let tailSegMin = Number.POSITIVE_INFINITY
        let tailSegMax = 0
        for (let k = 0; k < tailWindow; k += 1) {
          const i = points.length - 1 - k
          const j = i - 1
          if (j < 0) break
          const a = points[j]
          const b = points[i]
          const len = Math.hypot((b.x ?? 0) - (a.x ?? 0), (b.y ?? 0) - (a.y ?? 0), (b.z ?? 0) - (a.z ?? 0))
          if (!Number.isFinite(len)) continue
          tailSegCount += 1
          tailSegSum += len
          if (len < tailSegMin) tailSegMin = len
          if (len > tailSegMax) tailSegMax = len
        }
        return {
          tMs: performance.now(),
          menu: debugApi?.getMenuFlowInfo?.() ?? null,
          net: debugApi?.getNetSmoothingInfo?.() ?? null,
          prediction: debugApi?.getPredictionInfo?.() ?? null,
          segmentParity: debugApi?.getSegmentParityStats?.() ?? null,
          tailReport: debugApi?.getTailGrowthReport?.() ?? null,
          latestSnapshotState: debugApi?.getLatestSnapshotState?.() ?? null,
          tailEvents,
          latestTailEvent,
          localSnakeMetrics: {
            pointCount: points.length,
            segCount,
            segMean: segCount > 0 ? segSum / segCount : null,
            segMin: segCount > 0 ? segMin : null,
            segMax: segCount > 0 ? segMax : null,
            tailSegCount,
            tailSegMean: tailSegCount > 0 ? tailSegSum / tailSegCount : null,
            tailSegMin: tailSegCount > 0 ? tailSegMin : null,
            tailSegMax: tailSegCount > 0 ? tailSegMax : null,
          },
          rafPerf: debugApi?.getRafPerfInfo?.() ?? null,
          renderPerf: debugApi?.getRenderPerfInfo?.() ?? null,
        }
      })
      sample._sampleIndex = samples.length
      samples.push(sample)
      const sampleTailEvents = Array.isArray(sample?.tailEvents) ? sample.tailEvents : []
      for (const event of sampleTailEvents) {
        const id = Number(event?.id)
        if (!Number.isFinite(id)) continue
        if (id <= lastTailEventId) continue
        capturedTailEvents.push(event)
        lastTailEventId = id
      }
      const latestSnapshotState = sample?.latestSnapshotState
      const snapshotPlayers = Array.isArray(latestSnapshotState?.players)
        ? latestSnapshotState.players
        : []
      for (const player of snapshotPlayers) {
        if (isLikelyBotName(player?.name)) continue
        allPlayerEvents.push({
          tMs: sample?.tMs ?? null,
          seq: latestSnapshotState?.seq ?? null,
          now: latestSnapshotState?.now ?? null,
          id: player?.id ?? null,
          name: player?.name ?? null,
          alive: player?.alive ?? null,
          isBoosting: player?.isBoosting ?? null,
          score: player?.score ?? null,
          scoreFraction: player?.scoreFraction ?? null,
          snakeLen: player?.snakeLen ?? null,
          snakeTotalLen: player?.snakeTotalLen ?? null,
          tailExtension: player?.tailExtension ?? null,
          lenUnits: player?.lenUnits ?? null,
          tailSegLen: player?.tailSegLen ?? null,
          tailRefLen: player?.tailRefLen ?? null,
          tailExtDist: player?.tailExtDist ?? null,
          tailEndLen: player?.tailEndLen ?? null,
        })
      }

      const elapsedMs = Number(sample?.tMs ?? 0) - startedAtPerf
      if (elapsedMs >= durationMs) break
      await page.waitForTimeout(options.pollMs)
    }

    const final = await page.evaluate(() => {
      const debugApi = window.__SNAKE_DEBUG__
      return {
        tailEvents: debugApi?.getTailGrowthEvents?.() ?? [],
        tailReport: debugApi?.getTailGrowthReport?.() ?? null,
        net: debugApi?.getNetSmoothingInfo?.() ?? null,
        netEvents: debugApi?.getNetLagEvents?.() ?? [],
        netReport: debugApi?.getNetLagReport?.() ?? null,
        prediction: debugApi?.getPredictionInfo?.() ?? null,
        predictionReport: debugApi?.getPredictionReport?.() ?? null,
        segmentParity: debugApi?.getSegmentParityStats?.() ?? null,
        rafPerf: debugApi?.getRafPerfInfo?.() ?? null,
        renderPerf: debugApi?.getRenderPerfInfo?.() ?? null,
      }
    })

    const finalTailEvents = final.tailEvents ?? []
    for (const event of finalTailEvents) {
      const id = Number(event?.id)
      if (!Number.isFinite(id)) continue
      if (id <= lastTailEventId) continue
      capturedTailEvents.push(event)
      lastTailEventId = id
    }

    capturedTailEvents.sort((a, b) => (Number(a?.id) || 0) - (Number(b?.id) || 0))

    const rxEvents = capturedTailEvents.filter((event) => event?.kind === 'rx')
    const renderEvents = capturedTailEvents.filter((event) => event?.kind !== 'rx')
    const rxJumps = extractJumps(rxEvents, 'rx')
    const renderJumps = extractJumps(renderEvents, 'render')
    const lenUnitSummary = classifyJumpSources(rxJumps, renderJumps)
    const renderTailEndJumps = extractTailEndJumps(renderEvents, 'render_tail_end')
    const shrinkEvents = renderEvents.filter((event) => event?.kind === 'shrink')
    const stretchEvents = renderEvents.filter((event) => event?.kind === 'stretch')
    const segmentSpacingJumps = extractSegmentSpacingJumps(samples)
    const allPlayerJumps = extractAllPlayerJumps(allPlayerEvents)
    const predictionLengthMismatches = extractPredictionLengthMismatches(renderEvents)
    const jumpSummary = classifyTailRootCause({
      lenUnitSummary,
      renderTailEndJumps,
      shrinkEvents,
      stretchEvents,
      segmentSpacingJumps,
      allPlayerJumps,
      predictionLengthMismatches,
    })

    const largestIncident = jumpSummary.incidents[0] ?? null
    const maxAbsDeltaLenUnits = largestIncident
      ? Math.max(
          Math.abs(largestIncident.render?.deltaLenUnits ?? 0),
          Math.abs(largestIncident.render?.deltaTailEndLen ?? 0),
          Math.abs(largestIncident.rx?.deltaLenUnits ?? 0),
        )
      : 0

    const report = {
      generatedAtIso: new Date().toISOString(),
      startedAtIso,
      endedAtIso: new Date().toISOString(),
      scenario: {
        appUrl: options.appUrl,
        debugUrl,
        durationSecs: options.durationSecs,
        pollMs: options.pollMs,
        autoPlay: options.autoPlay,
        runDir,
      },
      diagnosis: {
        rootCause: jumpSummary.rootCause,
        incidentCount: jumpSummary.incidents.length,
        rxJumpCount: jumpSummary.rxJumpCount,
        renderJumpCount: jumpSummary.renderJumpCount,
        renderTailEndJumpCount: jumpSummary.renderTailEndJumpCount,
        shrinkCount: jumpSummary.shrinkCount,
        stretchCount: jumpSummary.stretchCount,
        segmentSpacingJumpCount: jumpSummary.segmentSpacingJumpCount,
        allPlayerJumpCount: jumpSummary.allPlayerJumpCount,
        predictionLenMismatchCount: jumpSummary.predictionLenMismatchCount,
        maxAbsDeltaLenUnits,
        topIncidents: jumpSummary.incidents.slice(0, 30),
      },
      aggregates: {
        sampleCount: samples.length,
        tailEventCount: capturedTailEvents.length,
        rxEventCount: rxEvents.length,
        renderEventCount: renderEvents.length,
        allPlayerEventCount: allPlayerEvents.length,
        allPlayerHumanCount: new Set(allPlayerEvents.map((event) => event.id).filter(Boolean)).size,
        consoleViolationCount: violations.length,
        tailConsoleCount: tailConsole.length,
      },
      final: {
        tailReport: final.tailReport,
        net: final.net,
        netReport: final.netReport,
        prediction: final.prediction,
        predictionReport: final.predictionReport,
        segmentParity: final.segmentParity,
        rafPerf: final.rafPerf,
        renderPerf: final.renderPerf,
      },
    }

    if (options.screenshotPath) {
      await page.screenshot({ path: options.screenshotPath })
    }

    await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
    await fs.writeFile(tailEventsPath, `${JSON.stringify(capturedTailEvents, null, 2)}\n`, 'utf8')
    await fs.writeFile(allPlayerEventsPath, `${JSON.stringify(allPlayerEvents, null, 2)}\n`, 'utf8')
    await fs.writeFile(samplePath, `${JSON.stringify(samples, null, 2)}\n`, 'utf8')
    await fs.writeFile(violationPath, `${JSON.stringify(violations, null, 2)}\n`, 'utf8')
    await fs.writeFile(tailConsolePath, `${JSON.stringify(tailConsole, null, 2)}\n`, 'utf8')

    const summary = {
      runDir,
      reportPath,
      tailEventsPath,
      allPlayerEventsPath,
      samplePath,
      diagnosis: report.diagnosis,
    }
    console.log(JSON.stringify(summary, null, 2))
  } finally {
    await context.close().catch(() => {})
    await browser.close().catch(() => {})
  }
}

run().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error)
  console.error(`[tail-growth-recorder] ${message}`)
  process.exit(1)
})
