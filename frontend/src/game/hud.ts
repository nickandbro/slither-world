export type RenderConfig = {
  width: number
  height: number
  centerX: number
  centerY: number
}

export type OxygenHudConfig = {
  pct: number | null
  low: boolean
  anchor: { x: number; y: number } | null
}

export type ScoreRadialHudConfig = {
  active: boolean
  score: number | null
  intervalPct: number | null
  blocked: boolean
  opacity: number
  anchor: { x: number; y: number } | null
}

function roundedRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
) {
  const r = Math.max(0, Math.min(radius, width * 0.5, height * 0.5))
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.lineTo(x + width - r, y)
  ctx.quadraticCurveTo(x + width, y, x + width, y + r)
  ctx.lineTo(x + width, y + height - r)
  ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height)
  ctx.lineTo(x + r, y + height)
  ctx.quadraticCurveTo(x, y + height, x, y + height - r)
  ctx.lineTo(x, y + r)
  ctx.quadraticCurveTo(x, y, x + r, y)
  ctx.closePath()
}

function isMeterActive(pct: number | null, anchor: { x: number; y: number } | null) {
  if (pct === null || !anchor) return false
  if (!Number.isFinite(anchor.x) || !Number.isFinite(anchor.y)) return false
  const clampedPct = Math.max(0, Math.min(100, pct))
  return clampedPct < 99.9
}

function drawCompactMeter(
  ctx: CanvasRenderingContext2D,
  config: RenderConfig,
  pct: number,
  anchor: { x: number; y: number },
  fillColor: string,
  stackLevel: number,
) {
  const clampedPct = Math.max(0, Math.min(100, pct))
  const barWidth = Math.max(36, Math.min(62, Math.round(config.width * 0.09)))
  const barHeight = Math.max(3, Math.min(5, Math.round(config.width * 0.0055)))
  const margin = 6
  const yOffset = Math.max(18, barHeight + 12) + stackLevel * (barHeight + 5)
  let barX = anchor.x - barWidth * 0.5
  let barY = anchor.y - yOffset
  barX = Math.min(config.width - barWidth - margin, Math.max(margin, barX))
  barY = Math.min(config.height - barHeight - margin, Math.max(margin, barY))
  const fillWidth = (barWidth * clampedPct) / 100

  ctx.save()
  roundedRectPath(ctx, barX, barY, barWidth, barHeight, barHeight * 0.5)
  ctx.fillStyle = 'rgba(233, 246, 255, 0.26)'
  ctx.fill()

  if (fillWidth > 0) {
    roundedRectPath(ctx, barX, barY, fillWidth, barHeight, barHeight * 0.5)
    ctx.fillStyle = fillColor
    ctx.fill()
  }
  ctx.restore()
}

function drawScoreRadial(
  ctx: CanvasRenderingContext2D,
  config: RenderConfig,
  score: number,
  intervalPct: number,
  blocked: boolean,
  opacity: number,
  anchor: { x: number; y: number },
  stackLevel: number,
) {
  const interpolateColor = (
    from: readonly [number, number, number],
    to: readonly [number, number, number],
    t: number,
  ) => {
    const blend = Math.max(0, Math.min(1, t))
    return [
      Math.round(from[0] + (to[0] - from[0]) * blend),
      Math.round(from[1] + (to[1] - from[1]) * blend),
      Math.round(from[2] + (to[2] - from[2]) * blend),
    ] as const
  }
  const radialColor = (pct: number) => {
    const green: readonly [number, number, number] = [34, 197, 94]
    const yellow: readonly [number, number, number] = [250, 204, 21]
    const red: readonly [number, number, number] = [239, 68, 68]
    const ratio = Math.max(0, Math.min(1, pct / 100))
    const rgb =
      ratio >= 0.5
        ? interpolateColor(yellow, green, (ratio - 0.5) * 2)
        : interpolateColor(red, yellow, ratio * 2)
    return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, 0.98)`
  }
  const drawBlockedOverlay = (
    centerX: number,
    centerY: number,
    drawRadius: number,
    strokeWidth: number,
  ) => {
    const ringRadius = Math.max(1, drawRadius - strokeWidth * 0.08)
    const slashRadius = Math.max(1, ringRadius - strokeWidth * 0.7)
    const slashDx = Math.cos(Math.PI * 0.25) * slashRadius
    const slashDy = Math.sin(Math.PI * 0.25) * slashRadius
    const edgeWidth = Math.max(2, strokeWidth + 1.6)
    const coreWidth = Math.max(1, strokeWidth - 0.4)

    ctx.beginPath()
    ctx.arc(centerX, centerY, ringRadius, 0, Math.PI * 2)
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.8)'
    ctx.lineWidth = edgeWidth
    ctx.lineCap = 'round'
    ctx.stroke()

    ctx.beginPath()
    ctx.arc(centerX, centerY, ringRadius, 0, Math.PI * 2)
    ctx.strokeStyle = 'rgba(239, 68, 68, 0.8)'
    ctx.lineWidth = coreWidth
    ctx.lineCap = 'round'
    ctx.stroke()

    ctx.beginPath()
    ctx.moveTo(centerX - slashDx, centerY - slashDy)
    ctx.lineTo(centerX + slashDx, centerY + slashDy)
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.82)'
    ctx.lineWidth = edgeWidth
    ctx.lineCap = 'round'
    ctx.stroke()

    ctx.beginPath()
    ctx.moveTo(centerX - slashDx, centerY - slashDy)
    ctx.lineTo(centerX + slashDx, centerY + slashDy)
    ctx.strokeStyle = 'rgba(239, 68, 68, 0.8)'
    ctx.lineWidth = coreWidth
    ctx.lineCap = 'round'
    ctx.stroke()
  }

  const clampedInterval = Math.max(0, Math.min(100, intervalPct))
  const radius = Math.max(19, Math.min(28, Math.round(config.width * 0.028)))
  const lineWidth = Math.max(4, Math.min(7, Math.round(radius * 0.24)))
  const margin = 8
  const oxygenNudge = stackLevel > 0 ? 2 : 0
  const yOffset = Math.max(22, radius + 10) + oxygenNudge
  let centerX = anchor.x
  let centerY = anchor.y - yOffset
  centerX = Math.min(config.width - radius - margin, Math.max(radius + margin, centerX))
  centerY = Math.min(config.height - radius - margin, Math.max(radius + margin, centerY))
  const innerRadius = Math.max(1, radius - lineWidth - 1)
  const startAngle = -Math.PI * 0.5
  const angleSweep = (Math.PI * 2 * clampedInterval) / 100
  const activeColor = radialColor(clampedInterval)

  ctx.save()
  ctx.globalAlpha = Math.max(0, Math.min(1, opacity))

  if (!blocked) {
    ctx.beginPath()
    ctx.arc(centerX, centerY, radius, 0, Math.PI * 2)
    ctx.strokeStyle = 'rgba(221, 230, 245, 0.44)'
    ctx.lineWidth = lineWidth
    ctx.lineCap = 'round'
    ctx.stroke()

    if (clampedInterval > 0) {
      ctx.beginPath()
      ctx.arc(centerX, centerY, radius, startAngle, startAngle + angleSweep, false)
      ctx.strokeStyle = activeColor
      ctx.lineWidth = lineWidth
      ctx.lineCap = 'round'
      ctx.stroke()
    }

    ctx.beginPath()
    ctx.arc(centerX, centerY, innerRadius, 0, Math.PI * 2)
    ctx.fillStyle = 'rgba(231, 237, 247, 0.97)'
    ctx.fill()

    ctx.fillStyle = activeColor
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.font = `${Math.max(10, Math.min(15, Math.round(radius * 0.62)))}px "Space Mono", monospace`
    ctx.fillText(String(Math.max(0, Math.floor(score))), centerX, centerY)
  } else {
    drawBlockedOverlay(centerX, centerY, radius, lineWidth)
  }

  ctx.restore()
}

function drawStatusMeters(
  ctx: CanvasRenderingContext2D,
  config: RenderConfig,
  oxygen: OxygenHudConfig,
  scoreRadial: ScoreRadialHudConfig,
) {
  const oxygenActive = isMeterActive(oxygen.pct, oxygen.anchor)
  const scoreActive =
    scoreRadial.active &&
    scoreRadial.opacity > 0.001 &&
    scoreRadial.score !== null &&
    (scoreRadial.blocked || scoreRadial.intervalPct !== null) &&
    !!scoreRadial.anchor &&
    Number.isFinite(scoreRadial.anchor.x) &&
    Number.isFinite(scoreRadial.anchor.y)

  if (!oxygenActive && !scoreActive) return

  if (oxygenActive && oxygen.anchor && oxygen.pct !== null) {
    const oxygenStackLevel = scoreActive ? -1.25 : 0
    drawCompactMeter(
      ctx,
      config,
      oxygen.pct,
      oxygen.anchor,
      oxygen.low ? 'rgba(239, 68, 68, 0.96)' : 'rgba(56, 189, 248, 0.96)',
      oxygenStackLevel,
    )
  }

  if (
    scoreActive &&
    scoreRadial.anchor &&
    scoreRadial.score !== null &&
    (scoreRadial.blocked || scoreRadial.intervalPct !== null)
  ) {
    drawScoreRadial(
      ctx,
      config,
      scoreRadial.score,
      scoreRadial.intervalPct ?? 0,
      scoreRadial.blocked,
      scoreRadial.opacity,
      scoreRadial.anchor,
      oxygenActive ? 1 : 0,
    )
  }
}

export function drawHud(
  ctx: CanvasRenderingContext2D,
  config: RenderConfig,
  pointerAngle: number | null,
  origin: { x: number; y: number } | null,
  pointerDistance: number | null,
  maxRange: number | null,
  oxygen: OxygenHudConfig,
  scoreRadial: ScoreRadialHudConfig,
) {
  ctx.clearRect(0, 0, config.width, config.height)
  if (pointerAngle !== null && pointerDistance !== null && maxRange !== null) {
    const originX = origin?.x ?? config.centerX
    const originY = origin?.y ?? config.centerY
    if (Number.isFinite(pointerDistance) && Number.isFinite(maxRange) && maxRange > 0) {
      const radius = Math.max(6, Math.min(pointerDistance, maxRange))
      ctx.beginPath()
      ctx.moveTo(originX, originY)
      ctx.lineTo(
        originX + Math.cos(pointerAngle) * radius,
        originY + Math.sin(pointerAngle) * radius,
      )
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)'
      ctx.lineWidth = Math.max(2, config.width * 0.004)
      ctx.lineCap = 'round'
      ctx.stroke()

      ctx.beginPath()
      ctx.fillStyle = 'rgba(255, 255, 255, 0.7)'
      ctx.arc(originX, originY, Math.max(2, config.width * 0.006), 0, Math.PI * 2)
      ctx.fill()
    }
  }
  drawStatusMeters(ctx, config, oxygen, scoreRadial)
}
