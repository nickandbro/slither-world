export type RenderConfig = {
  width: number
  height: number
  centerX: number
  centerY: number
}

export function drawHud(
  ctx: CanvasRenderingContext2D,
  config: RenderConfig,
  pointerAngle: number | null,
  origin: { x: number; y: number } | null,
  pointerDistance: number | null,
  maxRange: number | null,
) {
  ctx.clearRect(0, 0, config.width, config.height)
  if (pointerAngle === null || pointerDistance === null || maxRange === null) return

  const originX = origin?.x ?? config.centerX
  const originY = origin?.y ?? config.centerY
  if (!Number.isFinite(pointerDistance) || !Number.isFinite(maxRange) || maxRange <= 0) return
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
