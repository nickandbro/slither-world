import * as THREE from 'three'
import {
  BOOST_DRAFT_TEXTURE_HEIGHT,
  BOOST_DRAFT_TEXTURE_WIDTH,
  INTAKE_CONE_TEXTURE_HEIGHT,
  INTAKE_CONE_TEXTURE_WIDTH,
  NAMEPLATE_BG_COLOR,
  NAMEPLATE_BORDER_COLOR,
  NAMEPLATE_BORDER_WIDTH,
  NAMEPLATE_CANVAS_HEIGHT,
  NAMEPLATE_CANVAS_WIDTH,
  NAMEPLATE_CORNER_RADIUS,
  NAMEPLATE_FONT,
  NAMEPLATE_HORIZONTAL_PADDING,
  NAMEPLATE_TEXT_BASELINE_NUDGE,
  NAMEPLATE_TEXT_COLOR,
  NAMEPLATE_TEXT_MAX_WIDTH,
  NAMEPLATE_TEXT_SHADOW_BLUR,
  NAMEPLATE_TEXT_SHADOW_COLOR,
  NAMEPLATE_VERTICAL_PADDING,
  SNAKE_SKIN_TEXTURE_HEIGHT,
  SNAKE_SKIN_TEXTURE_WIDTH,
  SNAKE_STRIPE_DARK,
  SNAKE_STRIPE_EDGE,
  SNAKE_STRIPE_REPEAT,
} from '../constants'
import { clamp, smoothstep } from './math'
import { colorToCss, normalizeHexColor, parseHexColor } from './color'

export type SkyGradientTexture = {
  canvas: HTMLCanvasElement
  ctx: CanvasRenderingContext2D
  texture: THREE.CanvasTexture
}

export type NameplateTexture = {
  canvas: HTMLCanvasElement
  ctx: CanvasRenderingContext2D
  texture: THREE.CanvasTexture
}

export const createPelletRadialTexture = (
  size: number,
  stops: Array<{ offset: number; color: string }>,
) => {
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  const center = size * 0.5
  const gradient = ctx.createRadialGradient(center, center, 0, center, center, center)
  for (const stop of stops) {
    gradient.addColorStop(stop.offset, stop.color)
  }
  ctx.clearRect(0, 0, size, size)
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, size, size)
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.needsUpdate = true
  return texture
}

export const createPelletShadowTexture = () => {
  const size = 128
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  const center = size * 0.5
  const radius = size * 0.29

  ctx.clearRect(0, 0, size, size)
  ctx.save()
  ctx.shadowBlur = size * 0.18
  ctx.shadowOffsetY = size * 0.09
  ctx.shadowColor = 'rgba(0,0,0,1)'
  ctx.fillStyle = 'rgba(0,0,0,1)'
  ctx.beginPath()
  ctx.arc(center, center - size * 0.07, radius, 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()

  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.needsUpdate = true
  return texture
}

export const createPelletCoreTexture = () => {
  return createPelletRadialTexture(96, [
    { offset: 0, color: 'rgba(255,255,255,1)' },
    { offset: 0.99, color: 'rgba(255,255,255,0.2)' },
    { offset: 1, color: 'rgba(255,255,255,0)' },
  ])
}

export const createPelletInnerGlowTexture = () => {
  return createPelletRadialTexture(96, [
    { offset: 0, color: 'rgba(255,255,255,1)' },
    { offset: 1, color: 'rgba(255,255,255,0)' },
  ])
}

export const createPelletGlowTexture = () => {
  return createPelletRadialTexture(128, [
    { offset: 0, color: 'rgba(255,255,255,1)' },
    { offset: 1, color: 'rgba(255,255,255,0)' },
  ])
}

export const createBoostDraftTexture = () => {
  const canvas = document.createElement('canvas')
  canvas.width = BOOST_DRAFT_TEXTURE_WIDTH
  canvas.height = BOOST_DRAFT_TEXTURE_HEIGHT
  const ctx = canvas.getContext('2d')
  if (!ctx) return null

  const width = canvas.width
  const height = canvas.height
  const imageData = ctx.createImageData(width, height)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const u = width > 1 ? x / (width - 1) : 0
      const v = height > 1 ? y / (height - 1) : 0
      // Keep U-frequency integral so u=0 and u=1 match and do not create a seam.
      const swirlA = Math.sin((u * 8 + v * 4) * Math.PI * 2) * 0.5 + 0.5
      const swirlB = Math.sin((u * 12 - v * 3) * Math.PI * 2) * 0.5 + 0.5
      const noise = 0.84 + 0.16 * (swirlA * 0.6 + swirlB * 0.4)
      const equatorFade = 1 - smoothstep(0.72, 1, v)
      const alpha = clamp(noise * equatorFade, 0, 1)
      const alphaByte = Math.round(alpha * 255)
      const offset = (y * width + x) * 4
      imageData.data[offset] = 255
      imageData.data[offset + 1] = 255
      imageData.data[offset + 2] = 255
      imageData.data[offset + 3] = alphaByte
    }
  }

  ctx.putImageData(imageData, 0, 0)
  const texture = new THREE.CanvasTexture(canvas)
  texture.wrapS = THREE.ClampToEdgeWrapping
  texture.wrapT = THREE.ClampToEdgeWrapping
  texture.magFilter = THREE.LinearFilter
  texture.minFilter = THREE.LinearFilter
  texture.colorSpace = THREE.NoColorSpace
  texture.needsUpdate = true
  return texture
}

export const createIntakeConeTexture = () => {
  const canvas = document.createElement('canvas')
  canvas.width = INTAKE_CONE_TEXTURE_WIDTH
  canvas.height = INTAKE_CONE_TEXTURE_HEIGHT
  const ctx = canvas.getContext('2d')
  if (!ctx) return null

  const width = canvas.width
  const height = canvas.height
  const imageData = ctx.createImageData(width, height)
  for (let y = 0; y < height; y += 1) {
    const v = 1 - (height > 1 ? y / (height - 1) : 0)
    const coneHalfWidth = Math.max(0.04, v * 0.98)
    const edgeSoftness = Math.max(0.03, coneHalfWidth * 0.18)
    const startFade = smoothstep(0.01, 0.16, v)
    const tipFade = 1 - smoothstep(0.7, 1, v)
    const axialFade = Math.pow(1 - v, 0.34) * startFade * tipFade
    for (let x = 0; x < width; x += 1) {
      const u = (width > 1 ? x / (width - 1) : 0) * 2 - 1
      const absU = Math.abs(u)
      const edgeFade = 1 - smoothstep(coneHalfWidth - edgeSoftness, coneHalfWidth, absU)
      const alpha = clamp(edgeFade * axialFade, 0, 1)
      const alphaByte = Math.round(alpha * 255)
      const offset = (y * width + x) * 4
      imageData.data[offset] = 255
      imageData.data[offset + 1] = 255
      imageData.data[offset + 2] = 255
      imageData.data[offset + 3] = alphaByte
    }
  }

  ctx.putImageData(imageData, 0, 0)
  const texture = new THREE.CanvasTexture(canvas)
  texture.wrapS = THREE.ClampToEdgeWrapping
  texture.wrapT = THREE.ClampToEdgeWrapping
  texture.magFilter = THREE.LinearFilter
  texture.minFilter = THREE.LinearFilter
  texture.colorSpace = THREE.NoColorSpace
  texture.needsUpdate = true
  return texture
}


export const resolveSkinSlots = (colors: string[]) => {
  const normalized = colors
    .map((c) => normalizeHexColor(c))
    .filter((c): c is string => !!c)
  const source = normalized.length > 0 ? normalized : ['#ffffff']
  const out = new Array<string>(8)
  for (let i = 0; i < 8; i += 1) {
    out[i] = source[i % source.length] ?? '#ffffff'
  }
  return out
}

export const createSnakeSkinTexture = (colors: string[]) => {
  const width = Math.max(8, Math.floor(SNAKE_SKIN_TEXTURE_WIDTH))
  const height = Math.max(1, Math.floor(SNAKE_SKIN_TEXTURE_HEIGHT))
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) return null

  const dark = clamp(SNAKE_STRIPE_DARK, 0, 1)
  const edge = clamp(SNAKE_STRIPE_EDGE, 0.001, 0.49)
  const imageData = ctx.createImageData(width, height)

  const slots = resolveSkinSlots(colors)
  const stripeRepeat = Math.max(1, Math.floor(SNAKE_STRIPE_REPEAT))

  for (let x = 0; x < width; x += 1) {
    // Keep u in [0, 1) so RepeatWrapping has no seam at u=1.
    const u = width > 0 ? x / width : 0
    const slot = clamp(Math.floor(u * 8), 0, 7)
    const base = slots[slot] ?? '#ffffff'
    const rgb = parseHexColor(base) ?? { r: 255, g: 255, b: 255 }

    const wave = Math.cos(u * Math.PI * 2 * stripeRepeat)
    const t = smoothstep(-edge, edge, wave)
    const value = dark + (1 - dark) * t
    const rf = Math.round(clamp((rgb.r / 255) * value, 0, 1) * 255)
    const gf = Math.round(clamp((rgb.g / 255) * value, 0, 1) * 255)
    const bf = Math.round(clamp((rgb.b / 255) * value, 0, 1) * 255)

    for (let y = 0; y < height; y += 1) {
      const offset = (y * width + x) * 4
      imageData.data[offset] = rf
      imageData.data[offset + 1] = gf
      imageData.data[offset + 2] = bf
      imageData.data[offset + 3] = 255
    }
  }

  ctx.putImageData(imageData, 0, 0)
  const texture = new THREE.CanvasTexture(canvas)
  texture.wrapS = THREE.RepeatWrapping
  texture.wrapT = THREE.RepeatWrapping
  texture.magFilter = THREE.LinearFilter
  texture.minFilter = THREE.LinearMipmapLinearFilter
  texture.colorSpace = THREE.SRGBColorSpace
  texture.needsUpdate = true
  return texture
}

export const createHorizonScatteringTexture = () => {
  return createPelletRadialTexture(256, [
    { offset: 0, color: 'rgba(255,255,255,0)' },
    { offset: 0.52, color: 'rgba(255,255,255,0)' },
    { offset: 0.74, color: 'rgba(255,255,255,0.18)' },
    { offset: 0.9, color: 'rgba(255,255,255,0.11)' },
    { offset: 1, color: 'rgba(255,255,255,0)' },
  ])
}

export const createSkyGradientTexture = (size: number) => {
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.magFilter = THREE.LinearFilter
  texture.minFilter = THREE.LinearFilter
  texture.wrapS = THREE.ClampToEdgeWrapping
  texture.wrapT = THREE.ClampToEdgeWrapping
  texture.needsUpdate = true
  return { canvas, ctx, texture } satisfies SkyGradientTexture
}

export const loadImage = (url: string) => {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error(`Failed to load image: ${url}`))
    image.src = url
  })
}

export const createCircularMaskedTextureFromImage = (
  image: HTMLImageElement,
  size: number,
  featherFraction: number,
) => {
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  if (!ctx) return null

  const sourceWidth = Math.max(1, image.naturalWidth)
  const sourceHeight = Math.max(1, image.naturalHeight)
  const sourceSize = Math.max(1, Math.min(sourceWidth, sourceHeight))
  const sourceX = Math.max(0, (sourceWidth - sourceSize) * 0.5)
  const sourceY = Math.max(0, (sourceHeight - sourceSize) * 0.5)
  ctx.clearRect(0, 0, size, size)
  ctx.drawImage(
    image,
    sourceX,
    sourceY,
    sourceSize,
    sourceSize,
    0,
    0,
    size,
    size,
  )

  const radius = size * 0.5
  const feather = clamp(featherFraction, 0, 0.45)
  const featherStart = radius * Math.max(0, 1 - feather)
  const alphaMask = ctx.createRadialGradient(
    radius,
    radius,
    featherStart,
    radius,
    radius,
    radius,
  )
  alphaMask.addColorStop(0, 'rgba(255,255,255,1)')
  alphaMask.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.globalCompositeOperation = 'destination-in'
  ctx.fillStyle = alphaMask
  ctx.fillRect(0, 0, size, size)
  ctx.globalCompositeOperation = 'source-over'

  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.magFilter = THREE.LinearFilter
  texture.minFilter = THREE.LinearFilter
  texture.wrapS = THREE.ClampToEdgeWrapping
  texture.wrapT = THREE.ClampToEdgeWrapping
  texture.needsUpdate = true
  return texture
}

export const createMoonTextureFromAsset = async (
  url: string,
  size: number,
  featherFraction: number,
) => {
  try {
    const image = await loadImage(url)
    return createCircularMaskedTextureFromImage(image, size, featherFraction)
  } catch {
    return null
  }
}

export const createNameplateTexture = (text: string): NameplateTexture | null => {
  const canvas = document.createElement('canvas')
  canvas.width = NAMEPLATE_CANVAS_WIDTH
  canvas.height = NAMEPLATE_CANVAS_HEIGHT
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.magFilter = THREE.LinearFilter
  texture.minFilter = THREE.LinearFilter
  texture.generateMipmaps = false
  texture.wrapS = THREE.ClampToEdgeWrapping
  texture.wrapT = THREE.ClampToEdgeWrapping
  paintNameplateTexture({ canvas, ctx, texture }, text)
  return { canvas, ctx, texture } satisfies NameplateTexture
}

export const truncateNameplateText = (
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
) => {
  if (ctx.measureText(text).width <= maxWidth) return text
  const glyphs = Array.from(text)
  if (glyphs.length === 0) return ''
  const ellipsis = '...'
  const ellipsisWidth = ctx.measureText(ellipsis).width
  if (ellipsisWidth >= maxWidth) return ellipsis

  let low = 0
  let high = glyphs.length
  while (low < high) {
    const mid = Math.ceil((low + high) * 0.5)
    const candidate = glyphs.slice(0, mid).join('')
    if (ctx.measureText(candidate).width + ellipsisWidth <= maxWidth) {
      low = mid
    } else {
      high = mid - 1
    }
  }
  return `${glyphs.slice(0, low).join('')}${ellipsis}`
}

export const drawRoundedRectPath = (
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
) => {
  const clampedRadius = Math.min(radius, width * 0.5, height * 0.5)
  ctx.beginPath()
  ctx.moveTo(x + clampedRadius, y)
  ctx.lineTo(x + width - clampedRadius, y)
  ctx.quadraticCurveTo(x + width, y, x + width, y + clampedRadius)
  ctx.lineTo(x + width, y + height - clampedRadius)
  ctx.quadraticCurveTo(x + width, y + height, x + width - clampedRadius, y + height)
  ctx.lineTo(x + clampedRadius, y + height)
  ctx.quadraticCurveTo(x, y + height, x, y + height - clampedRadius)
  ctx.lineTo(x, y + clampedRadius)
  ctx.quadraticCurveTo(x, y, x + clampedRadius, y)
  ctx.closePath()
}

export const paintNameplateTexture = (target: NameplateTexture, text: string) => {
  const { canvas, ctx, texture } = target
  const centerX = canvas.width * 0.5
  const centerY = canvas.height * 0.5
  const boxX = NAMEPLATE_HORIZONTAL_PADDING
  const boxY = NAMEPLATE_VERTICAL_PADDING
  const boxWidth = canvas.width - NAMEPLATE_HORIZONTAL_PADDING * 2
  const boxHeight = canvas.height - NAMEPLATE_VERTICAL_PADDING * 2

  ctx.clearRect(0, 0, canvas.width, canvas.height)
  ctx.font = NAMEPLATE_FONT
  const displayText = truncateNameplateText(ctx, text, NAMEPLATE_TEXT_MAX_WIDTH)

  drawRoundedRectPath(
    ctx,
    boxX,
    boxY,
    boxWidth,
    boxHeight,
    NAMEPLATE_CORNER_RADIUS,
  )
  ctx.fillStyle = NAMEPLATE_BG_COLOR
  ctx.fill()
  ctx.strokeStyle = NAMEPLATE_BORDER_COLOR
  ctx.lineWidth = NAMEPLATE_BORDER_WIDTH
  ctx.stroke()

  ctx.shadowColor = NAMEPLATE_TEXT_SHADOW_COLOR
  ctx.shadowBlur = NAMEPLATE_TEXT_SHADOW_BLUR
  ctx.shadowOffsetX = 0
  ctx.shadowOffsetY = 1
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillStyle = NAMEPLATE_TEXT_COLOR
  ctx.fillText(displayText, centerX, centerY + NAMEPLATE_TEXT_BASELINE_NUDGE)
  ctx.shadowColor = 'transparent'
  ctx.shadowBlur = 0
  ctx.shadowOffsetX = 0
  ctx.shadowOffsetY = 0

  texture.needsUpdate = true
}


export const paintSkyGradientTexture = (
  target: SkyGradientTexture,
  topColor: THREE.Color,
  horizonColor: THREE.Color,
  bottomColor: THREE.Color,
) => {
  const { canvas, ctx, texture } = target
  const gradient = ctx.createLinearGradient(0, 0, 0, canvas.height)
  gradient.addColorStop(0, colorToCss(topColor))
  gradient.addColorStop(0.48, colorToCss(horizonColor))
  gradient.addColorStop(1, colorToCss(bottomColor))
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  texture.needsUpdate = true
}
