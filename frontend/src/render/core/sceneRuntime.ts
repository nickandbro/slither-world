import * as THREE from 'three'
import { WebGPURenderer } from 'three/webgpu'
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils'
import type {
  Camera,
  DigestionSnapshot,
  Environment,
  GameStateSnapshot,
  PelletSnapshot,
  PlayerSnapshot,
  Point,
} from '../../game/types'

type SnakeVisual = {
  group: THREE.Group
  tube: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>
  selfOverlapGlow: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>
  selfOverlapGlowMaterial: THREE.MeshBasicMaterial
  head: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>
  tail: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>
  eyeLeft: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>
  eyeRight: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>
  pupilLeft: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>
  pupilRight: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>
  tongue: THREE.Group
  tongueBase: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>
  tongueForkLeft: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>
  tongueForkRight: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>
  bowl: THREE.Mesh<THREE.BufferGeometry, THREE.MeshPhysicalMaterial>
  bowlMaterial: THREE.MeshPhysicalMaterial
  bowlCrackUniform: { value: number }
  boostDraft: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>
  boostDraftMaterial: THREE.MeshBasicMaterial
  boostDraftPhase: number
  boostDraftIntensity: number
  nameplate: THREE.Sprite
  nameplateMaterial: THREE.SpriteMaterial
  nameplateTexture: THREE.CanvasTexture | null
  nameplateCanvas: HTMLCanvasElement | null
  nameplateCtx: CanvasRenderingContext2D | null
  nameplateText: string
  color: string
  skinKey: string
}

type TongueState = {
  length: number
  mode: 'idle' | 'extend' | 'retract'
  targetPosition: THREE.Vector3 | null
  carrying: boolean
}

type PelletOverride = {
  id: number
  position: THREE.Vector3
}

type DigestionVisual = {
  t: number
  strength: number
}

type TailFrameState = {
  normal: THREE.Vector3
  tangent: THREE.Vector3
}

type TrailSample = {
  point: THREE.Vector3
  normal: THREE.Vector3
  createdAt: number
}

type BoostTrailState = {
  mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>
  samples: TrailSample[]
  boosting: boolean
  retiring: boolean
  retireStartedAt: number
  retireInitialCount: number
  retireCut: number
  dirty: boolean
  // Allocation-light geometry rebuild scratch.
  curve: THREE.CatmullRomCurve3
  curvePoints: THREE.Vector3[]
  projectedPoints: THREE.Vector3[]
  positionAttr: THREE.BufferAttribute
  uvAttr: THREE.BufferAttribute
  trailProgressAttr: THREE.BufferAttribute | null
  indexAttr: THREE.BufferAttribute
}

type BoostTrailMaterialUserData = {
  retireCut: number
  retireCutUniform?: { value: number }
}

type BoostDraftMaterialUserData = {
  timeUniform?: { value: number }
  opacityUniform?: { value: number }
}

type PelletSpriteBucket = {
  shadowPoints: THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial>
  corePoints: THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial>
  innerGlowPoints: THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial>
  glowPoints: THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial>
  shadowMaterial: THREE.PointsMaterial
  coreMaterial: THREE.PointsMaterial
  innerGlowMaterial: THREE.PointsMaterial
  glowMaterial: THREE.PointsMaterial
  positionAttribute: THREE.BufferAttribute
  capacity: number
  baseShadowSize: number
  baseCoreSize: number
  baseInnerGlowSize: number
  baseGlowSize: number
  colorBucketIndex: number
  sizeTierIndex: number
}

type PelletMotionState = {
  gfrOffset: number
  gr: number
  wsp: number
}

type SkyGradientTexture = {
  canvas: HTMLCanvasElement
  ctx: CanvasRenderingContext2D
  texture: THREE.CanvasTexture
}

type NameplateTexture = {
  canvas: HTMLCanvasElement
  ctx: CanvasRenderingContext2D
  texture: THREE.CanvasTexture
}

const createPelletRadialTexture = (
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

const createPelletShadowTexture = () => {
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

const createPelletCoreTexture = () => {
  return createPelletRadialTexture(96, [
    { offset: 0, color: 'rgba(255,255,255,1)' },
    { offset: 0.99, color: 'rgba(255,255,255,0.2)' },
    { offset: 1, color: 'rgba(255,255,255,0)' },
  ])
}

const createPelletInnerGlowTexture = () => {
  return createPelletRadialTexture(96, [
    { offset: 0, color: 'rgba(255,255,255,1)' },
    { offset: 1, color: 'rgba(255,255,255,0)' },
  ])
}

const createPelletGlowTexture = () => {
  return createPelletRadialTexture(128, [
    { offset: 0, color: 'rgba(255,255,255,1)' },
    { offset: 1, color: 'rgba(255,255,255,0)' },
  ])
}

const createBoostDraftTexture = () => {
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

type Rgb8 = { r: number; g: number; b: number }

const parseHexColor = (value: string): Rgb8 | null => {
  const trimmed = value.trim().toLowerCase()
  const match = /^#([0-9a-f]{6})$/.exec(trimmed)
  if (!match) return null
  const hex = match[1]
  const r = Number.parseInt(hex.slice(0, 2), 16)
  const g = Number.parseInt(hex.slice(2, 4), 16)
  const b = Number.parseInt(hex.slice(4, 6), 16)
  if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) return null
  return { r, g, b }
}

const normalizeHexColor = (value: string) => {
  const rgb = parseHexColor(value)
  if (!rgb) return null
  const rr = rgb.r.toString(16).padStart(2, '0')
  const gg = rgb.g.toString(16).padStart(2, '0')
  const bb = rgb.b.toString(16).padStart(2, '0')
  return `#${rr}${gg}${bb}`
}

const resolveSkinSlots = (colors: string[]) => {
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

const createSnakeSkinTexture = (colors: string[]) => {
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

const createHorizonScatteringTexture = () => {
  return createPelletRadialTexture(256, [
    { offset: 0, color: 'rgba(255,255,255,0)' },
    { offset: 0.52, color: 'rgba(255,255,255,0)' },
    { offset: 0.74, color: 'rgba(255,255,255,0.18)' },
    { offset: 0.9, color: 'rgba(255,255,255,0.11)' },
    { offset: 1, color: 'rgba(255,255,255,0)' },
  ])
}

const createSkyGradientTexture = (size: number) => {
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

const loadImage = (url: string) => {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error(`Failed to load image: ${url}`))
    image.src = url
  })
}

const createCircularMaskedTextureFromImage = (
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

const createMoonTextureFromAsset = async (
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

const createNameplateTexture = (text: string): NameplateTexture | null => {
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

const truncateNameplateText = (
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

const drawRoundedRectPath = (
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

const paintNameplateTexture = (target: NameplateTexture, text: string) => {
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

const colorToCss = (color: THREE.Color) => {
  const r = Math.round(Math.min(1, Math.max(0, color.r)) * 255)
  const g = Math.round(Math.min(1, Math.max(0, color.g)) * 255)
  const b = Math.round(Math.min(1, Math.max(0, color.b)) * 255)
  return `rgb(${r}, ${g}, ${b})`
}

const paintSkyGradientTexture = (
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

type DeathState = {
  start: number
}

type Lake = {
  center: THREE.Vector3
  radius: number
  depth: number
  shelfDepth: number
  edgeFalloff: number
  noiseAmplitude: number
  noiseFrequency: number
  noiseFrequencyB: number
  noiseFrequencyC: number
  noisePhase: number
  noisePhaseB: number
  noisePhaseC: number
  warpAmplitude: number
  tangent: THREE.Vector3
  bitangent: THREE.Vector3
  surfaceInset: number
}

type LakeWaterUniforms = {
  time: { value: number }
}

type LakeMaterialUserData = {
  lakeWaterUniforms?: LakeWaterUniforms
}

type TreeInstance = {
  normal: THREE.Vector3
  widthScale: number
  heightScale: number
  twist: number
}

type MountainInstance = {
  normal: THREE.Vector3
  radius: number
  height: number
  variant: number
  twist: number
  outline: number[]
  tangent: THREE.Vector3
  bitangent: THREE.Vector3
}

type TerrainPatchInstance = {
  mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>
  center: THREE.Vector3
  angularExtent: number
  visible: boolean
}

type TreeCullEntry = {
  basePoint: THREE.Vector3
  topPoint: THREE.Vector3
  baseRadius: number
  topRadius: number
}

type CactusCullEntry = {
  basePoint: THREE.Vector3
  topPoint: THREE.Vector3
  leftArmTipPoint: THREE.Vector3
  rightArmTipPoint: THREE.Vector3
  baseRadius: number
  topRadius: number
  armRadius: number
}

type MountainCullEntry = {
  basePoint: THREE.Vector3
  peakPoint: THREE.Vector3
  baseRadius: number
  peakRadius: number
  variant: number
}

type PebbleCullEntry = {
  point: THREE.Vector3
  radius: number
}

type TerrainContactTriangle = {
  ax: number
  ay: number
  az: number
  e1x: number
  e1y: number
  e1z: number
  e2x: number
  e2y: number
  e2z: number
}

type TerrainContactSampler = {
  bands: number
  slices: number
  buckets: number[][]
  triangles: TerrainContactTriangle[]
}

type SnakeGroundingInfo = {
  minClearance: number
  maxPenetration: number
  maxAppliedLift: number
  sampleCount: number
}

type RenderPerfFrame = {
  tMs: number
  totalMs: number
  setupMs: number
  snakesMs: number
  pelletsMs: number
  visibilityMs: number
  waterMs: number
  passWorldMs: number
  passOccludersMs: number
  passPelletsMs: number
  passDepthRebuildMs: number
  passLakesMs: number
}

type RenderPerfInfo = {
  enabled: boolean
  thresholdMs: number
  frameCount: number
  slowFrameCount: number
  maxTotalMs: number
  lastFrame: RenderPerfFrame | null
  slowFrames: RenderPerfFrame[]
}

export type RendererPreference = 'auto' | 'webgl' | 'webgpu'
export type RendererBackend = 'webgl' | 'webgpu'
export type DayNightDebugMode = 'auto' | 'accelerated'

export type RenderScene = {
  resize: (width: number, height: number, dpr: number) => void
  render: (
    snapshot: GameStateSnapshot | null,
    camera: Camera,
    localPlayerId: string | null,
    cameraDistance: number,
    cameraVerticalOffset?: number,
  ) => { x: number; y: number } | null
  // Screen-space pointer input for mouse/touch aiming. `active` should be false when gameplay input
  // is disabled or the pointer leaves the canvas.
  setPointerScreen?: (x: number, y: number, active: boolean) => void
  // Returns a unit axis (local planet coordinates) representing the desired steering direction,
  // or null when the pointer is inactive/off-planet or the local head is unavailable.
  getPointerAxis?: () => Point | null
  setMenuPreviewVisible: (visible: boolean) => void
  setMenuPreviewSkin: (colors: string[] | null, previewLen?: number) => void
  setMenuPreviewOrbit: (yaw: number, pitch: number) => void
  setEnvironment: (environment: Environment) => void
  setDebugFlags: (flags: {
    mountainOutline?: boolean
    lakeCollider?: boolean
    treeCollider?: boolean
    terrainTessellation?: boolean
  }) => void
  setDayNightDebugMode: (mode: DayNightDebugMode) => void
  dispose: () => void
}

export type WebGLScene = RenderScene

export type CreateRenderSceneResult = {
  scene: RenderScene
  activeBackend: RendererBackend
  fallbackReason: string | null
}

const BASE_PLANET_RADIUS = 1
const PLANET_RADIUS = 3
const PLANET_SCALE = PLANET_RADIUS / BASE_PLANET_RADIUS
const PLANET_BASE_ICOSPHERE_DETAIL = 16
const PLANET_PATCH_ENABLED = true
const PLANET_PATCH_BANDS = 12
const PLANET_PATCH_SLICES = 24
const TERRAIN_CONTACT_BANDS = PLANET_PATCH_BANDS
const TERRAIN_CONTACT_SLICES = PLANET_PATCH_SLICES
const TERRAIN_CONTACT_EPS = 1e-6
const PLANET_PATCH_VIEW_MARGIN = 0.18
const PLANET_PATCH_HIDE_EXTRA = 0.06
const PLANET_OBJECT_VIEW_MARGIN = 0.14
const PLANET_OBJECT_HIDE_EXTRA = 0.06
const PLANET_EDGE_PRELOAD_START_ANGLE = 0.45
const PLANET_EDGE_PRELOAD_END_ANGLE = 1.25
const TREE_EDGE_PRELOAD_MARGIN = 0.22
const TREE_EDGE_PRELOAD_HIDE_EXTRA = 0.14
const TREE_EDGE_PRELOAD_OCCLUSION_LEAD = 1.9
const ROCK_EDGE_PRELOAD_MARGIN = 0.2
const ROCK_EDGE_PRELOAD_HIDE_EXTRA = 0.12
const ROCK_EDGE_PRELOAD_OCCLUSION_LEAD = 1.55
const PEBBLE_EDGE_PRELOAD_MARGIN = 0.16
const PEBBLE_EDGE_PRELOAD_HIDE_EXTRA = 0.1
const PEBBLE_EDGE_PRELOAD_OCCLUSION_LEAD = 1.4
const PLANET_PATCH_OUTER_MIN = 0.22
const PLANET_PATCH_OUTER_MAX = 1.4
const LAKE_SURFACE_ICOSPHERE_DETAIL = 18
const LAKE_SURFACE_SEGMENTS = 96
const LAKE_SURFACE_RINGS = 64
const LAKE_COUNT = 2
const LAKE_MIN_ANGLE = 0.9 / PLANET_SCALE
const LAKE_MAX_ANGLE = 1.3 / PLANET_SCALE
const LAKE_MIN_DEPTH = BASE_PLANET_RADIUS * 0.1
const LAKE_MAX_DEPTH = BASE_PLANET_RADIUS * 0.17
// Wider and softer shoreline transition to reduce visible faceting pop at patch updates.
const LAKE_EDGE_FALLOFF = 0.08 * 2.5
const LAKE_EDGE_SHARPNESS = 1.8 / 2.4
const LAKE_NOISE_AMPLITUDE = 0.55
const LAKE_NOISE_FREQ_MIN = 3
const LAKE_NOISE_FREQ_MAX = 6
const LAKE_SHELF_DEPTH_RATIO = 0.45
const LAKE_SHELF_CORE = 0.55
const LAKE_CENTER_PIT_START = 0.72
const LAKE_CENTER_PIT_RATIO = 0.5
const LAKE_SURFACE_INSET_RATIO = 0.5
const LAKE_SURFACE_EXTRA_INSET = BASE_PLANET_RADIUS * 0.01
const LAKE_SURFACE_DEPTH_EPS = BASE_PLANET_RADIUS * 0.0015
const LAKE_DEBUG_SEGMENTS = 128
const LAKE_DEBUG_OFFSET = 0.02
const TREE_DEBUG_SEGMENTS = 64
const TREE_DEBUG_OFFSET = 0.02
const DEATH_FADE_DURATION = 3
const DEATH_START_OPACITY = 0.9
const DEATH_VISIBILITY_CUTOFF = 0.02

const WORLD_UP = new THREE.Vector3(0, 1, 0)
const WORLD_RIGHT = new THREE.Vector3(1, 0, 0)
const LAKE_WATER_OVERDRAW = BASE_PLANET_RADIUS * 0.01
const LAKE_WATER_SURFACE_LIFT = LAKE_WATER_OVERDRAW * 1.4
const LAKE_WATER_EDGE_EXPAND_ANGLE = 0.045
const LAKE_WATER_EDGE_EXPAND_BOUNDARY = 0.12
const LAKE_VISIBILITY_EXTRA_RADIUS = 0.1
const LAKE_VISIBILITY_MARGIN = 0.32
const LAKE_VISIBILITY_HIDE_EXTRA = 0.18
const LAKE_TERRAIN_CLAMP_EPS = BASE_PLANET_RADIUS * 0.0012
const LAKE_VISUAL_DEPTH_MULT = 1.75
const LAKE_SHORE_DROP_BLEND_START = 0.05
const LAKE_SHORE_DROP_BLEND_END = 0.85
const LAKE_SHORE_DROP_EXP = 1.2
const LAKE_SHORE_DROP_EXTRA_MAX = BASE_PLANET_RADIUS * 0.045
const LAKE_WATER_OPACITY = 0.65
const LAKE_WATER_WAVE_SPEED = 0.65
const LAKE_WATER_WAVE_SCALE = 22
const LAKE_WATER_WAVE_STRENGTH = 0.18
const LAKE_WATER_FRESNEL_STRENGTH = 0.35
const LAKE_WATER_ALPHA_PULSE = 0.1
const LAKE_WATER_EMISSIVE_BASE = 0.38
const LAKE_WATER_EMISSIVE_PULSE = 0.08
const LAKE_WATER_MASK_THRESHOLD = 0
const LAKE_GRID_MASK_THRESHOLD = LAKE_WATER_MASK_THRESHOLD
const LAKE_EXCLUSION_THRESHOLD = 0.18
const GRID_LINE_COLOR = '#6fc85f'
const GRID_LINE_OPACITY = 0.16
const SHORELINE_LINE_OPACITY = 0.24
const SHORE_SAND_COLOR = '#d8c48a'
const SNAKE_RADIUS = 0.045
const SNAKE_GIRTH_SCALE_MIN = 1
const SNAKE_GIRTH_SCALE_MAX = 2
const SNAKE_TUBE_RADIAL_SEGMENTS = 16
const SNAKE_SKIN_TEXTURE_WIDTH = 256
const SNAKE_SKIN_TEXTURE_HEIGHT = 32
const SNAKE_STRIPE_REPEAT = 12
const SNAKE_STRIPE_DARK = 0.55
const SNAKE_STRIPE_EDGE = 0.12
const SNAKE_TAIL_CAP_U_SPAN = 0.09
const HEAD_RADIUS = SNAKE_RADIUS * 1.35
const NAMEPLATE_CANVAS_WIDTH = 256
const NAMEPLATE_CANVAS_HEIGHT = 92
const NAMEPLATE_HORIZONTAL_PADDING = 14
const NAMEPLATE_VERTICAL_PADDING = 16
const NAMEPLATE_CORNER_RADIUS = 18
const NAMEPLATE_BORDER_WIDTH = 2
const NAMEPLATE_BG_COLOR = 'rgba(8, 17, 28, 0.48)'
const NAMEPLATE_BORDER_COLOR = 'rgba(216, 231, 247, 0.2)'
const NAMEPLATE_TEXT_COLOR = 'rgba(235, 243, 252, 0.9)'
const NAMEPLATE_TEXT_SHADOW_COLOR = 'rgba(0, 0, 0, 0.4)'
const NAMEPLATE_TEXT_SHADOW_BLUR = 6
const NAMEPLATE_TEXT_BASELINE_NUDGE = 1
const NAMEPLATE_FONT = '600 28px system-ui, sans-serif'
const NAMEPLATE_TEXT_MAX_WIDTH = NAMEPLATE_CANVAS_WIDTH - NAMEPLATE_HORIZONTAL_PADDING * 2 - 14
const NAMEPLATE_WORLD_WIDTH = HEAD_RADIUS * 5.7
const NAMEPLATE_WORLD_ASPECT = NAMEPLATE_CANVAS_WIDTH / NAMEPLATE_CANVAS_HEIGHT
const NAMEPLATE_WORLD_OFFSET = HEAD_RADIUS * 2.05
const NAMEPLATE_FADE_NEAR_DISTANCE = 5.8
const NAMEPLATE_FADE_FAR_DISTANCE = 11.4
const SNAKE_LIFT_FACTOR = 0.85
const SNAKE_UNDERWATER_CLEARANCE = SNAKE_RADIUS * 0.18
const SNAKE_MIN_TERRAIN_CLEARANCE = SNAKE_RADIUS * 0.1
const SNAKE_CONTACT_CLEARANCE = SNAKE_RADIUS * 0.04
const SNAKE_SELF_OVERLAP_GLOW_ENABLED = true
const SNAKE_SELF_OVERLAP_MIN_POINTS = 18
const SNAKE_SELF_OVERLAP_GRID_CELLS = 16
const SNAKE_SELF_OVERLAP_MIN_ARC_MULT = 7.5
const SNAKE_SELF_OVERLAP_DIST_FULL_MULT = 2.15
const SNAKE_SELF_OVERLAP_DIST_START_MULT = 3.6
const SNAKE_SELF_OVERLAP_BLUR_RADIUS = 2
const SNAKE_SELF_OVERLAP_BLUR_PASSES = 1
const SNAKE_SELF_OVERLAP_GLOW_OPACITY = 0.52
const SNAKE_SELF_OVERLAP_GLOW_VISIBILITY_THRESHOLD = 0.06
const SNAKE_CONTACT_ARC_SAMPLES = 7
const SNAKE_CONTACT_LIFT_ITERATIONS = 2
const SNAKE_CONTACT_LIFT_EPS = 1e-5
const SNAKE_WATERLINE_BLEND_START = 0.08
const SNAKE_WATERLINE_BLEND_END = 0.55
const SNAKE_SLOPE_INSERT_RADIUS_DELTA = SNAKE_RADIUS * 0.4
const EYE_RADIUS = SNAKE_RADIUS * 0.62
const PUPIL_RADIUS = EYE_RADIUS * 0.4
const PUPIL_OFFSET = EYE_RADIUS - PUPIL_RADIUS * 0.6
const PELLET_RADIUS = SNAKE_RADIUS * 0.34
const PELLET_SURFACE_CLEARANCE = SNAKE_RADIUS * 0.08
const PELLET_SIZE_MIN = 0.55
const PELLET_SIZE_MAX = 2.85
const PELLET_GROUND_CACHE_NORMAL_EPS = 0.0000005
const PELLET_COLORS = [
  '#ff5f6d',
  '#ffc857',
  '#5cff8d',
  '#5dc9ff',
  '#9f7bff',
  '#ff7bcb',
  '#ffd86b',
  '#6bffea',
  '#8be15b',
  '#ff9642',
  '#6f8bff',
  '#f9ff6b',
]
const PELLET_SIZE_TIER_MULTIPLIERS = [0.9, 1.45, 2.8]
const PELLET_SIZE_TIER_MEDIUM_MIN = 1.05
const PELLET_SIZE_TIER_LARGE_MIN = 1.6
const PELLET_WOBBLE_DISTANCE = PELLET_RADIUS * 0.45
const PELLET_WOBBLE_GFR_RATE = 1000 / 8
const PELLET_WOBBLE_WSP_RANGE = 0.0225
const PELLET_WOBBLE_DISABLE_VISIBLE_THRESHOLD = 1800
const PELLET_GLOW_PULSE_SPEED = 9.2
const PELLET_SHADOW_OPACITY_BASE = 0.9
const PELLET_SHADOW_OPACITY_RANGE = 0.008
const PELLET_CORE_OPACITY_BASE = 0.54
const PELLET_CORE_OPACITY_RANGE = 0.46
const PELLET_CORE_SIZE_RANGE = 0.015
const PELLET_INNER_GLOW_OPACITY_BASE = 0.018
const PELLET_INNER_GLOW_OPACITY_RANGE = 0.048
const PELLET_INNER_GLOW_SIZE_RANGE = 0.05
const PELLET_GLOW_OPACITY_BASE = 0.01
const PELLET_GLOW_OPACITY_RANGE = 0.034
const PELLET_GLOW_SIZE_RANGE = 0.065
const PELLET_GLOW_PHASE_STEP = 0.73
const PELLET_GLOW_HORIZON_MARGIN = 0.1
const TONGUE_MAX_LENGTH = HEAD_RADIUS * 2.8
const TONGUE_MAX_RANGE = HEAD_RADIUS * 3.1
const TONGUE_NEAR_RANGE = HEAD_RADIUS * 2.4
const TONGUE_RADIUS = SNAKE_RADIUS * 0.2
const TONGUE_FORK_LENGTH = HEAD_RADIUS * 0.45
const TONGUE_FORK_SPREAD = 0.55
const TONGUE_MOUTH_FORWARD = HEAD_RADIUS * 0.6
const TONGUE_MOUTH_OUT = HEAD_RADIUS * 0.1
const TONGUE_ANGLE_LIMIT = Math.PI / 6
const TONGUE_EXTEND_RATE = 10
const TONGUE_RETRACT_RATE = 14
const TONGUE_HIDE_THRESHOLD = HEAD_RADIUS * 0.12
const TONGUE_GRAB_EPS = HEAD_RADIUS * 0.12
const TONGUE_PELLET_MATCH = HEAD_RADIUS * 1.6
const TONGUE_ENABLED = false
const TAIL_CAP_SEGMENTS = 5
const TAIL_DIR_MIN_RATIO = 0.35
const BOOST_TRAIL_FADE_SECONDS = 4.5
const BOOST_TRAIL_SURFACE_OFFSET = 0.00006
const BOOST_TRAIL_MIN_SAMPLE_DISTANCE = SNAKE_RADIUS * 0.38
const BOOST_TRAIL_MAX_SAMPLES = 280
const BOOST_TRAIL_MAX_ARC_ANGLE = 0.055
const BOOST_TRAIL_CURVE_SEGMENTS_PER_POINT = 10
const BOOST_TRAIL_MAX_CURVE_SEGMENTS = 512
const BOOST_TRAIL_MAX_CENTER_POINTS = BOOST_TRAIL_MAX_CURVE_SEGMENTS + 1
const BOOST_TRAIL_MAX_VERTEX_COUNT = BOOST_TRAIL_MAX_CENTER_POINTS * 2
const BOOST_TRAIL_MAX_INDEX_COUNT = (BOOST_TRAIL_MAX_CENTER_POINTS - 1) * 6
const BOOST_TRAIL_POOL_MAX = 48
const BOOST_TRAIL_WIDTH = SNAKE_RADIUS * 0.42
const BOOST_TRAIL_EDGE_FADE_CAP = 0.22
const BOOST_TRAIL_SIDE_FADE_CAP = 0.28
const BOOST_TRAIL_RETIRE_FEATHER = 0.14
const BOOST_TRAIL_OPACITY = 0.55
const BOOST_TRAIL_ALPHA_TEXTURE_WIDTH = 256
const BOOST_TRAIL_ALPHA_TEXTURE_HEIGHT = 64
const BOOST_TRAIL_COLOR = '#3a3129'
const BOOST_DRAFT_TEXTURE_WIDTH = 192
const BOOST_DRAFT_TEXTURE_HEIGHT = 64
const BOOST_DRAFT_BASE_RADIUS = HEAD_RADIUS * 1.28
const BOOST_DRAFT_FRONT_OFFSET = HEAD_RADIUS * 0.34
const BOOST_DRAFT_LIFT = HEAD_RADIUS * 0.08
const BOOST_DRAFT_PULSE_SPEED = 8.4
const BOOST_DRAFT_OPACITY = 0.51
const BOOST_DRAFT_EDGE_FADE_START = 0.8
const BOOST_DRAFT_EDGE_FADE_END = 1.0
const BOOST_DRAFT_COLOR_A = new THREE.Color('#56d9ff')
const BOOST_DRAFT_COLOR_B = new THREE.Color('#ffffff')
const BOOST_DRAFT_COLOR_SHIFT_SPEED = 3.8
const BOOST_DRAFT_FADE_IN_RATE = 8
const BOOST_DRAFT_FADE_OUT_RATE = 5.5
const BOOST_DRAFT_MIN_ACTIVE_OPACITY = 0.01
const BOOST_DRAFT_LOCAL_FORWARD_AXIS = new THREE.Vector3(0, 1, 0)
const DIGESTION_BULGE_MIN = 0.22
const DIGESTION_BULGE_MAX = 0.54
const DIGESTION_BULGE_GIRTH_MIN_SCALE = 0.25
const DIGESTION_BULGE_GIRTH_CURVE = 2.6
const DIGESTION_BULGE_RADIUS_CURVE = 1.4
const DIGESTION_WIDTH_MIN = 1.6
const DIGESTION_WIDTH_MAX = 2.9
const DIGESTION_MAX_BULGE_MIN = 0.55
const DIGESTION_MAX_BULGE_MAX = 0.82
const DIGESTION_START_NODE_INDEX = 1
const DIGESTION_TRAVEL_EASE = 1
const TREE_COUNT = 36
const TREE_BASE_OFFSET = 0.004
const TREE_HEIGHT = BASE_PLANET_RADIUS * 0.3
const TREE_TRUNK_HEIGHT = TREE_HEIGHT / 3
const TREE_TRUNK_RADIUS = TREE_HEIGHT * 0.12
const TREE_TIER_HEIGHT_FACTORS = [0.4, 0.33, 0.27, 0.21]
const TREE_TIER_RADIUS_FACTORS = [0.5, 0.44, 0.36, 0.28]
const TREE_TIER_OVERLAP = 0.55
const TREE_MIN_SCALE = 0.9
const TREE_MAX_SCALE = 1.15
const TREE_MIN_ANGLE = 0.42
const TREE_MIN_HEIGHT = SNAKE_RADIUS * 9.5
const TREE_MAX_HEIGHT = TREE_MIN_HEIGHT * 1.5
const DESERT_CACTUS_COUNT = 8
const DESERT_BIOME_ANGLE = 0.86
const DESERT_BIOME_BLEND = 0.12
const DESERT_DUNE_PRIMARY = BASE_PLANET_RADIUS * 0.065
const DESERT_DUNE_SECONDARY = BASE_PLANET_RADIUS * 0.03
const DESERT_DUNE_TERTIARY = BASE_PLANET_RADIUS * 0.018
const DESERT_GROUND_COLOR = new THREE.Color('#d8bf78')
const FOREST_GROUND_COLOR = new THREE.Color('#6ea95a')
const DESERT_BIOME_CENTER = new THREE.Vector3(
  -0.19391259652276868,
  0.9788150619715452,
  0.06571894222701674,
).normalize()
const DESERT_BIOME_MIN_DOT = Math.cos(DESERT_BIOME_ANGLE)
const CACTUS_TRUNK_HEIGHT = TREE_HEIGHT * 0.96
const CACTUS_TRUNK_RADIUS = TREE_TRUNK_RADIUS * 0.88
const CACTUS_LEFT_ARM_BASE_HEIGHT = CACTUS_TRUNK_HEIGHT * 0.36
const CACTUS_RIGHT_ARM_BASE_HEIGHT = CACTUS_TRUNK_HEIGHT * 0.57
const CACTUS_LEFT_ARM_RADIUS = CACTUS_TRUNK_RADIUS * 0.58
const CACTUS_RIGHT_ARM_RADIUS = CACTUS_TRUNK_RADIUS * 0.5
const CACTUS_TRUNK_TUBE_SEGMENTS = 18
const CACTUS_ARM_TUBE_SEGMENTS = 14
const CACTUS_TUBE_RADIAL_SEGMENTS = 8
const CACTUS_UNIFORM_SCALE_MULTIPLIER = 1.0
const CACTUS_MIN_UNIFORM_SCALE = 0.98
const CACTUS_MAX_UNIFORM_SCALE = 1.2
// Match tree grounding so cactus bases clip slightly into the surface.
const CACTUS_BASE_SINK = CACTUS_TRUNK_HEIGHT * 0.12
const MOUNTAIN_COUNT = 8
const MOUNTAIN_VARIANTS = 3
const MOUNTAIN_OUTLINE_SAMPLES = 64
const MOUNTAIN_RADIUS_MIN = BASE_PLANET_RADIUS * 0.12
const MOUNTAIN_RADIUS_MAX = BASE_PLANET_RADIUS * 0.22
const MOUNTAIN_HEIGHT_MIN = BASE_PLANET_RADIUS * 0.12
const MOUNTAIN_HEIGHT_MAX = BASE_PLANET_RADIUS * 0.26
const MOUNTAIN_BASE_SINK = 0.015
const MOUNTAIN_MIN_ANGLE = 0.55
const PEBBLE_COUNT = 220
const PEBBLE_RADIUS_MIN = BASE_PLANET_RADIUS * 0.0045
const PEBBLE_RADIUS_MAX = BASE_PLANET_RADIUS * 0.014
const PEBBLE_OFFSET = 0.0015
const PEBBLE_RADIUS_VARIANCE = 0.8
const DAY_NIGHT_CYCLE_MS = 8 * 60 * 1000
const DAY_NIGHT_CYCLE_ACCELERATED_MS = 30 * 1000
const DAY_NIGHT_SKY_TEXTURE_SIZE = 256
const DAY_NIGHT_SKY_RADIUS = 18
const DAY_NIGHT_CELESTIAL_ORBIT_X = 3.7
const DAY_NIGHT_CELESTIAL_ORBIT_Y = 2.7
const DAY_NIGHT_CELESTIAL_ORBIT_BASE_Y = 0.45
const DAY_NIGHT_CELESTIAL_ORBIT_Z = -14.4
const DAY_NIGHT_SUN_SIZE = 1.25
const DAY_NIGHT_SUN_GLOW_SIZE = 2.2
const DAY_NIGHT_MOON_SIZE = 0.95
const DAY_NIGHT_MOON_GLOW_SIZE = 1.75
const DAY_NIGHT_MOON_TEXTURE_URL = '/images/moon-texture.png'
const DAY_NIGHT_MOON_TEXTURE_SIZE = 512
const DAY_NIGHT_MOON_TEXTURE_EDGE_FEATHER = 0.085
const DAY_NIGHT_CELESTIAL_BLEND_START = 0.38
const DAY_NIGHT_CELESTIAL_BLEND_END = 0.62
const DAY_NIGHT_CELESTIAL_RIM_OFFSET_PX = 32
const DAY_NIGHT_CELESTIAL_SAFE_MARGIN_PX = 36
const DAY_NIGHT_HORIZON_SCALE = 1.17
const DAY_NIGHT_HORIZON_MAX_OPACITY = 0.24
const DAY_NIGHT_HORIZON_MIN_OPACITY = 0
const DAY_NIGHT_HORIZON_DEPTH = 13.8
const DAY_NIGHT_STAR_COUNT = 760
const DAY_NIGHT_STAR_RADIUS = 17.2
const DAY_NIGHT_STAR_SIZE = 0.17
const DAY_NIGHT_STAR_TWINKLE_SPEED = 1.65
const DAY_NIGHT_TAU = Math.PI * 2
const DAY_NIGHT_DAY_EDGE_START = 0.38
const DAY_NIGHT_DAY_EDGE_END = 0.7
const DAY_NIGHT_STAR_EDGE_START = 0.08
const DAY_NIGHT_STAR_EDGE_END = 0.46
const DAY_NIGHT_EXPOSURE_DAY = 1.07
const DAY_NIGHT_EXPOSURE_NIGHT = 0.9
const SKY_DAY_TOP_COLOR = new THREE.Color('#4caef2')
const SKY_DAY_HORIZON_COLOR = new THREE.Color('#93dbff')
const SKY_DAY_BOTTOM_COLOR = new THREE.Color('#d4f2ff')
const SKY_NIGHT_TOP_COLOR = new THREE.Color('#081025')
const SKY_NIGHT_HORIZON_COLOR = new THREE.Color('#1a2741')
const SKY_NIGHT_BOTTOM_COLOR = new THREE.Color('#060c1d')
const DAY_LIGHT_COLOR = new THREE.Color('#fff6df')
const NIGHT_LIGHT_COLOR = new THREE.Color('#aec3ff')
const DAY_RIM_COLOR = new THREE.Color('#a5dfff')
const NIGHT_RIM_COLOR = new THREE.Color('#607eb8')
const SUN_CORE_COLOR = new THREE.Color('#ffeeb0')
const SUN_GLOW_COLOR = new THREE.Color('#fff2c2')
const MOON_CORE_COLOR = new THREE.Color('#ffffff')
const MOON_GLOW_COLOR = new THREE.Color('#bacfff')
const HORIZON_DAY_COLOR = new THREE.Color('#a8e5ff')
const HORIZON_NIGHT_COLOR = new THREE.Color('#2f4e7f')

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))
const lerp = (a: number, b: number, t: number) => a + (b - a) * t
const smoothstep = (edge0: number, edge1: number, x: number) => {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1)
  return t * t * (3 - 2 * t)
}
const smoothValue = (current: number, target: number, deltaSeconds: number, rateUp: number, rateDown: number) => {
  const rate = target >= current ? rateUp : rateDown
  const alpha = 1 - Math.exp(-rate * Math.max(0, deltaSeconds))
  return current + (target - current) * alpha
}

const surfaceAngleFromRay = (cameraDistance: number, halfFov: number) => {
  const clampedDistance = Math.max(cameraDistance, PLANET_RADIUS + 1e-3)
  const sinHalf = Math.sin(halfFov)
  const cosHalf = Math.cos(halfFov)
  const under = PLANET_RADIUS * PLANET_RADIUS - clampedDistance * clampedDistance * sinHalf * sinHalf
  if (under <= 0) {
    return Math.acos(clamp(PLANET_RADIUS / clampedDistance, -1, 1))
  }
  const rayDistance = clampedDistance * cosHalf - Math.sqrt(under)
  const hitZ = clampedDistance - rayDistance * cosHalf
  return Math.acos(clamp(hitZ / PLANET_RADIUS, -1, 1))
}

const computeVisibleSurfaceAngle = (cameraDistance: number, aspect: number) => {
  const halfY = (40 * Math.PI) / 360
  const safeAspect = Number.isFinite(aspect) && aspect > 0 ? aspect : 1
  const halfX = Math.atan(Math.tan(halfY) * safeAspect)
  const halfDiag = Math.min(Math.PI * 0.499, Math.hypot(halfX, halfY))
  const base = surfaceAngleFromRay(cameraDistance, halfDiag)
  return clamp(base, PLANET_PATCH_OUTER_MIN, PLANET_PATCH_OUTER_MAX)
}
const createMountainGeometry = (seed: number) => {
  const rand = createSeededRandom(seed)
  const baseGeometry = new THREE.DodecahedronGeometry(1, 0)
  const geometry = mergeVertices(baseGeometry, 1e-3)
  const positions = geometry.attributes.position
  const temp = new THREE.Vector3()
  const variance = 0.18 + rand() * 0.06
  const hash3 = (x: number, y: number, z: number) => {
    let h = seed ^ 0x9e3779b9
    h = Math.imul(h ^ x, 0x85ebca6b)
    h = Math.imul(h ^ y, 0xc2b2ae35)
    h = Math.imul(h ^ z, 0x27d4eb2f)
    h ^= h >>> 16
    return (h >>> 0) / 4294967296
  }
  for (let i = 0; i < positions.count; i += 1) {
    temp.set(positions.getX(i), positions.getY(i), positions.getZ(i))
    if (temp.lengthSq() < 1e-6) continue
    temp.normalize()
    const qx = Math.round(temp.x * 1024)
    const qy = Math.round(temp.y * 1024)
    const qz = Math.round(temp.z * 1024)
    const jitter = hash3(qx, qy, qz) * 2 - 1
    const scale = 1 + jitter * variance
    temp.multiplyScalar(scale)
    positions.setXYZ(i, temp.x, temp.y, temp.z)
  }
  positions.needsUpdate = true
  geometry.computeVertexNormals()
  geometry.computeBoundingSphere()
  return geometry
}
const createSeededRandom = (seed: number) => {
  let state = seed >>> 0
  return () => {
    state += 0x6d2b79f5
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const createIcosphereGeometry = (radius: number, detail: number) => {
  const clampedDetail = Math.max(0, Math.floor(detail))
  const geometry = new THREE.IcosahedronGeometry(radius, clampedDetail)
  geometry.computeVertexNormals()
  geometry.computeBoundingSphere()
  return geometry
}

const bucketIndexFromDirection = (
  normal: THREE.Vector3,
  bands: number,
  slices: number,
) => {
  const latitude = Math.asin(clamp(normal.y, -1, 1))
  const longitude = Math.atan2(normal.z, normal.x)
  const band = clamp(
    Math.floor(((latitude + Math.PI * 0.5) / Math.PI) * bands),
    0,
    bands - 1,
  )
  const slice = clamp(
    Math.floor(((longitude + Math.PI) / (Math.PI * 2)) * slices),
    0,
    slices - 1,
  )
  return { band, slice }
}

const createTerrainContactSampler = (
  geometry: THREE.BufferGeometry,
  bands: number,
  slices: number,
): TerrainContactSampler | null => {
  const positionAttr = geometry.getAttribute('position')
  if (!(positionAttr instanceof THREE.BufferAttribute)) return null
  const indexAttr = geometry.getIndex()
  const triCount = indexAttr
    ? Math.floor(indexAttr.count / 3)
    : Math.floor(positionAttr.count / 3)
  if (triCount <= 0) return null

  const buckets = Array.from({ length: bands * slices }, () => [] as number[])
  const triangles: TerrainContactTriangle[] = []
  const a = new THREE.Vector3()
  const b = new THREE.Vector3()
  const c = new THREE.Vector3()
  const edge1 = new THREE.Vector3()
  const edge2 = new THREE.Vector3()
  const cross = new THREE.Vector3()
  const centroid = new THREE.Vector3()

  const readVertex = (index: number, out: THREE.Vector3) => {
    out.set(positionAttr.getX(index), positionAttr.getY(index), positionAttr.getZ(index))
  }

  for (let tri = 0; tri < triCount; tri += 1) {
    const i0 = indexAttr ? indexAttr.getX(tri * 3) : tri * 3
    const i1 = indexAttr ? indexAttr.getX(tri * 3 + 1) : tri * 3 + 1
    const i2 = indexAttr ? indexAttr.getX(tri * 3 + 2) : tri * 3 + 2
    readVertex(i0, a)
    readVertex(i1, b)
    readVertex(i2, c)

    edge1.copy(b).sub(a)
    edge2.copy(c).sub(a)
    cross.copy(edge1).cross(edge2)
    if (cross.lengthSq() <= TERRAIN_CONTACT_EPS) continue

    centroid.copy(a).add(b).add(c).multiplyScalar(1 / 3)
    if (centroid.lengthSq() <= TERRAIN_CONTACT_EPS) continue
    centroid.normalize()
    const { band, slice } = bucketIndexFromDirection(centroid, bands, slices)
    const triIndex = triangles.length
    triangles.push({
      ax: a.x,
      ay: a.y,
      az: a.z,
      e1x: edge1.x,
      e1y: edge1.y,
      e1z: edge1.z,
      e2x: edge2.x,
      e2y: edge2.y,
      e2z: edge2.z,
    })
    buckets[band * slices + slice].push(triIndex)
  }

  if (triangles.length === 0) return null
  return { bands, slices, buckets, triangles }
}

const sampleTerrainContactRadius = (
  sampler: TerrainContactSampler,
  direction: THREE.Vector3,
): number | null => {
  if (direction.lengthSq() <= TERRAIN_CONTACT_EPS) return null
  const { band, slice } = bucketIndexFromDirection(
    direction,
    sampler.bands,
    sampler.slices,
  )
  let bestT = Number.POSITIVE_INFINITY

  for (let bandOffset = -1; bandOffset <= 1; bandOffset += 1) {
    const sampleBand = band + bandOffset
    if (sampleBand < 0 || sampleBand >= sampler.bands) continue
    for (let sliceOffset = -1; sliceOffset <= 1; sliceOffset += 1) {
      let sampleSlice = slice + sliceOffset
      if (sampleSlice < 0) sampleSlice += sampler.slices
      if (sampleSlice >= sampler.slices) sampleSlice -= sampler.slices
      const bucket = sampler.buckets[sampleBand * sampler.slices + sampleSlice]
      if (!bucket || bucket.length === 0) continue

      for (let i = 0; i < bucket.length; i += 1) {
        const triangle = sampler.triangles[bucket[i]]
        if (!triangle) continue

        const hx = direction.y * triangle.e2z - direction.z * triangle.e2y
        const hy = direction.z * triangle.e2x - direction.x * triangle.e2z
        const hz = direction.x * triangle.e2y - direction.y * triangle.e2x
        const det = triangle.e1x * hx + triangle.e1y * hy + triangle.e1z * hz
        if (Math.abs(det) <= TERRAIN_CONTACT_EPS) continue
        const invDet = 1 / det

        const sx = -triangle.ax
        const sy = -triangle.ay
        const sz = -triangle.az
        const u = (sx * hx + sy * hy + sz * hz) * invDet
        if (u < 0 || u > 1) continue

        const qx = sy * triangle.e1z - sz * triangle.e1y
        const qy = sz * triangle.e1x - sx * triangle.e1z
        const qz = sx * triangle.e1y - sy * triangle.e1x
        const v = (direction.x * qx + direction.y * qy + direction.z * qz) * invDet
        if (v < 0 || u + v > 1) continue

        const t = (triangle.e2x * qx + triangle.e2y * qy + triangle.e2z * qz) * invDet
        if (t > TERRAIN_CONTACT_EPS && t < bestT) {
          bestT = t
        }
      }
    }
  }

  if (!Number.isFinite(bestT)) return null
  return bestT
}

const createLakes = (seed: number, count: number) => {
  const rng = createSeededRandom(seed)
  const lakes: Lake[] = []
  const randRange = (min: number, max: number) => min + (max - min) * rng()
  const pickCenter = (radius: number, out: THREE.Vector3) => {
    for (let attempt = 0; attempt < 80; attempt += 1) {
      randomOnSphere(rng, out)
      if (isDesertBiome(out)) {
        continue
      }
      let ok = true
      for (const lake of lakes) {
        const minSeparation = (radius + lake.radius) * 0.75
        if (out.dot(lake.center) > Math.cos(minSeparation)) {
          ok = false
          break
        }
      }
      if (ok) return out
    }
    for (let attempt = 0; attempt < 120; attempt += 1) {
      randomOnSphere(rng, out)
      if (!isDesertBiome(out)) return out
    }
    return randomOnSphere(rng, out)
  }
  for (let i = 0; i < count; i += 1) {
    const radius = randRange(LAKE_MIN_ANGLE, LAKE_MAX_ANGLE)
    const depth = randRange(LAKE_MIN_DEPTH, LAKE_MAX_DEPTH)
    const shelfDepth = depth * LAKE_SHELF_DEPTH_RATIO
    const center = new THREE.Vector3()
    pickCenter(radius, center)
    const up = Math.abs(center.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0)
    const tangent = new THREE.Vector3().crossVectors(up, center).normalize()
    const bitangent = new THREE.Vector3().crossVectors(center, tangent).normalize()
    const noiseFrequency = randRange(LAKE_NOISE_FREQ_MIN, LAKE_NOISE_FREQ_MAX)
    const noiseFrequencyB = noiseFrequency * randRange(0.55, 0.95)
    const noiseFrequencyC = noiseFrequency * randRange(1.1, 1.7)
    const noisePhase = rng() * Math.PI * 2
    const noisePhaseB = rng() * Math.PI * 2
    const noisePhaseC = rng() * Math.PI * 2
    const warpAmplitude = randRange(0.08, 0.18)
    lakes.push({
      center,
      radius,
      depth,
      shelfDepth,
      edgeFalloff: LAKE_EDGE_FALLOFF,
      noiseAmplitude: LAKE_NOISE_AMPLITUDE,
      noiseFrequency,
      noiseFrequencyB,
      noiseFrequencyC,
      noisePhase,
      noisePhaseB,
      noisePhaseC,
      warpAmplitude,
      tangent,
      bitangent,
      surfaceInset: shelfDepth * LAKE_SURFACE_INSET_RATIO + LAKE_SURFACE_EXTRA_INSET,
    })
  }
  return lakes
}
const buildTangentBasis = (
  normal: THREE.Vector3,
  tangent: THREE.Vector3,
  bitangent: THREE.Vector3,
) => {
  const up = Math.abs(normal.y) < 0.9 ? WORLD_UP : WORLD_RIGHT
  tangent.copy(up).cross(normal).normalize()
  bitangent.copy(normal).cross(tangent).normalize()
}

const buildLakeFromData = (data: Environment['lakes'][number]) => {
  const center = new THREE.Vector3(data.center.x, data.center.y, data.center.z).normalize()
  const tangent = new THREE.Vector3()
  const bitangent = new THREE.Vector3()
  buildTangentBasis(center, tangent, bitangent)
  return {
    center,
    radius: data.radius,
    depth: data.depth,
    shelfDepth: data.shelfDepth,
    edgeFalloff: data.edgeFalloff,
    noiseAmplitude: data.noiseAmplitude,
    noiseFrequency: data.noiseFrequency,
    noiseFrequencyB: data.noiseFrequencyB,
    noiseFrequencyC: data.noiseFrequencyC,
    noisePhase: data.noisePhase,
    noisePhaseB: data.noisePhaseB,
    noisePhaseC: data.noisePhaseC,
    warpAmplitude: data.warpAmplitude,
    surfaceInset: data.surfaceInset,
    tangent,
    bitangent,
  }
}

const buildTreeFromData = (data: Environment['trees'][number]): TreeInstance => ({
  normal: new THREE.Vector3(data.normal.x, data.normal.y, data.normal.z).normalize(),
  widthScale: data.widthScale,
  heightScale: data.heightScale,
  twist: data.twist,
})

const buildMountainFromData = (data: Environment['mountains'][number]): MountainInstance => {
  const normal = new THREE.Vector3(data.normal.x, data.normal.y, data.normal.z).normalize()
  const tangent = new THREE.Vector3()
  const bitangent = new THREE.Vector3()
  buildTangentBasis(normal, tangent, bitangent)
  return {
    normal,
    radius: data.radius,
    height: data.height,
    variant: data.variant,
    twist: data.twist,
    outline: [...data.outline],
    tangent,
    bitangent,
  }
}
const sampleLakes = (normal: THREE.Vector3, lakes: Lake[], temp: THREE.Vector3) => {
  let maxBoundary = 0
  let maxDepth = 0
  let boundaryLake: Lake | null = null
  for (const lake of lakes) {
    const dot = clamp(lake.center.dot(normal), -1, 1)
    const angle = Math.acos(dot)
    if (angle >= lake.radius + lake.edgeFalloff) continue

    temp.copy(normal).addScaledVector(lake.center, -dot)
    const x = temp.dot(lake.tangent)
    const y = temp.dot(lake.bitangent)
    const warp = Math.sin((x + y) * lake.noiseFrequencyC + lake.noisePhaseC) * lake.warpAmplitude
    const u = x * lake.noiseFrequency + lake.noisePhase + warp
    const v = y * lake.noiseFrequencyB + lake.noisePhaseB - warp
    const w = (x - y) * lake.noiseFrequencyC + lake.noisePhaseC * 0.7
    const noise =
      Math.sin(u) +
      Math.sin(v) +
      0.6 * Math.sin(2 * u + v * 0.6) +
      0.45 * Math.sin(2.3 * v - 0.7 * u) +
      0.35 * Math.sin(w)
    const noiseNormalized = noise / 3.15
    const edgeRadius = clamp(
      lake.radius * (1 + lake.noiseAmplitude * noiseNormalized),
      lake.radius * 0.65,
      lake.radius * 1.35,
    )
    if (angle >= edgeRadius) continue

    const shelfRadius = Math.max(1e-3, edgeRadius - lake.edgeFalloff)
    const edgeT = clamp((edgeRadius - angle) / lake.edgeFalloff, 0, 1)
    const edgeBlend = Math.pow(edgeT, LAKE_EDGE_SHARPNESS)
    const core = clamp(1 - angle / shelfRadius, 0, 1)
    const basinFactor = smoothstep(LAKE_SHELF_CORE, 1, core)
    const pitFactor = smoothstep(LAKE_CENTER_PIT_START, 1, core)
    const pitDepth = pitFactor * pitFactor * lake.depth * LAKE_CENTER_PIT_RATIO
    const depth =
      edgeBlend *
      (lake.shelfDepth + basinFactor * (lake.depth - lake.shelfDepth) + pitDepth)

    if (edgeBlend > maxBoundary) {
      maxBoundary = edgeBlend
      boundaryLake = lake
    }
    if (depth > maxDepth) maxDepth = depth
  }
  return { boundary: maxBoundary, depth: maxDepth, lake: boundaryLake }
}

const getLakeTerrainDepth = (sample: ReturnType<typeof sampleLakes>) => {
  if (!sample.lake || sample.boundary <= LAKE_WATER_MASK_THRESHOLD) return 0
  // Keep beds below water so moving actors follow the same terrain shape as the planet mesh.
  return Math.max(sample.depth, sample.lake.surfaceInset + LAKE_TERRAIN_CLAMP_EPS)
}

const getVisualLakeTerrainDepth = (sample: ReturnType<typeof sampleLakes>) => {
  const baseDepth = getLakeTerrainDepth(sample)
  if (!sample.lake || baseDepth <= 0) return 0
  const boundary = clamp(sample.boundary, 0, 1)
  const shoreBlendRaw =
    1 - smoothstep(LAKE_SHORE_DROP_BLEND_START, LAKE_SHORE_DROP_BLEND_END, boundary)
  const shoreBlend = Math.pow(shoreBlendRaw, LAKE_SHORE_DROP_EXP)
  const deepened = baseDepth * LAKE_VISUAL_DEPTH_MULT + shoreBlend * LAKE_SHORE_DROP_EXTRA_MAX
  return Math.max(deepened, sample.lake.surfaceInset + LAKE_TERRAIN_CLAMP_EPS)
}

const isDesertBiome = (normal: THREE.Vector3) => normal.dot(DESERT_BIOME_CENTER) >= DESERT_BIOME_MIN_DOT

const sampleDesertBlend = (normal: THREE.Vector3) => {
  const angle = Math.acos(clamp(normal.dot(DESERT_BIOME_CENTER), -1, 1))
  const start = Math.max(0, DESERT_BIOME_ANGLE - DESERT_BIOME_BLEND)
  const end = DESERT_BIOME_ANGLE + DESERT_BIOME_BLEND
  return 1 - smoothstep(start, end, angle)
}

const sampleDuneOffset = (normal: THREE.Vector3) => {
  const lon = Math.atan2(normal.z, normal.x)
  const lat = Math.asin(clamp(normal.y, -1, 1))
  const waveA = Math.sin(lon * 3.1 + lat * 1.7)
  const waveB = Math.sin(lon * 5.8 - lat * 2.6 + 1.2)
  const waveC = Math.cos((normal.x * 2.9 + normal.z * 2.15) * Math.PI + lat * 0.75)
  return waveA * DESERT_DUNE_PRIMARY + waveB * DESERT_DUNE_SECONDARY + waveC * DESERT_DUNE_TERTIARY
}

const applyLakeDepressions = (geometry: THREE.BufferGeometry, lakes: Lake[]) => {
  const positions = geometry.attributes.position
  const normal = new THREE.Vector3()
  const temp = new THREE.Vector3()
  const colors = new Float32Array(positions.count * 3)
  const deltaR = DESERT_GROUND_COLOR.r - FOREST_GROUND_COLOR.r
  const deltaG = DESERT_GROUND_COLOR.g - FOREST_GROUND_COLOR.g
  const deltaB = DESERT_GROUND_COLOR.b - FOREST_GROUND_COLOR.b
  for (let i = 0; i < positions.count; i += 1) {
    normal.set(positions.getX(i), positions.getY(i), positions.getZ(i)).normalize()
    const sample = sampleLakes(normal, lakes, temp)
    const depth = getVisualLakeTerrainDepth(sample)
    const desertBlend = sampleDesertBlend(normal)
    const duneOffset = sampleDuneOffset(normal) * desertBlend
    const radius = PLANET_RADIUS + duneOffset - depth
    positions.setXYZ(i, normal.x * radius, normal.y * radius, normal.z * radius)
    const colorIndex = i * 3
    colors[colorIndex] = FOREST_GROUND_COLOR.r + deltaR * desertBlend
    colors[colorIndex + 1] = FOREST_GROUND_COLOR.g + deltaG * desertBlend
    colors[colorIndex + 2] = FOREST_GROUND_COLOR.b + deltaB * desertBlend
  }
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))
  positions.needsUpdate = true
  geometry.computeVertexNormals()
  geometry.computeBoundingSphere()
}
const createLakeSurfaceGeometry = (sampleGeometry: THREE.BufferGeometry, lakes: Lake[]) => {
  const basePositions = sampleGeometry.attributes.position
  const lakePositions: number[] = []
  const lakeNormals: number[] = []
  const a = new THREE.Vector3()
  const b = new THREE.Vector3()
  const c = new THREE.Vector3()
  const ab = new THREE.Vector3()
  const bc = new THREE.Vector3()
  const ca = new THREE.Vector3()
  const centroid = new THREE.Vector3()
  const normal = new THREE.Vector3()
  const temp = new THREE.Vector3()
  const debug = isLakeDebugEnabled()
  const stats = debug
    ? {
        total: 0,
        included: 0,
        excludedNoLake: 0,
        excludedShallow: 0,
        boundary: 0,
        includedByDepth: 0,
        includedByBoundary: 0,
        maxBoundary: 0,
        minBoundary: Number.POSITIVE_INFINITY,
        minDepth: Number.POSITIVE_INFINITY,
        maxDepth: 0,
        minWaterLevel: Number.POSITIVE_INFINITY,
        maxWaterLevel: 0,
      }
    : null
  const samples: Array<{ sample: ReturnType<typeof sampleLakes>; depth: number }> = []
  const pushSample = (point: THREE.Vector3) => {
    normal.copy(point).normalize()
    const sample = sampleLakes(normal, lakes, temp)
    samples.push({ sample, depth: getVisualLakeTerrainDepth(sample) })
  }
  for (let i = 0; i < basePositions.count; i += 3) {
    if (stats) stats.total += 1
    a.set(basePositions.getX(i), basePositions.getY(i), basePositions.getZ(i))
    b.set(basePositions.getX(i + 1), basePositions.getY(i + 1), basePositions.getZ(i + 1))
    c.set(basePositions.getX(i + 2), basePositions.getY(i + 2), basePositions.getZ(i + 2))
    samples.length = 0

    pushSample(a)
    pushSample(b)
    pushSample(c)

    ab.copy(a).lerp(b, 0.5)
    pushSample(ab)
    bc.copy(b).lerp(c, 0.5)
    pushSample(bc)
    ca.copy(c).lerp(a, 0.5)
    pushSample(ca)

    ab.copy(a).lerp(b, 1 / 3)
    pushSample(ab)
    ab.copy(a).lerp(b, 2 / 3)
    pushSample(ab)
    bc.copy(b).lerp(c, 1 / 3)
    pushSample(bc)
    bc.copy(b).lerp(c, 2 / 3)
    pushSample(bc)
    ca.copy(c).lerp(a, 1 / 3)
    pushSample(ca)
    ca.copy(c).lerp(a, 2 / 3)
    pushSample(ca)

    centroid.copy(a).add(b).add(c).multiplyScalar(1 / 3)
    pushSample(centroid)

    let bestSample = samples[0]
    let maxDepth = samples[0].depth
    let maxBoundary = samples[0].sample.boundary
    for (let s = 1; s < samples.length; s += 1) {
      if (samples[s].depth > maxDepth) maxDepth = samples[s].depth
      if (samples[s].sample.boundary > maxBoundary) {
        maxBoundary = samples[s].sample.boundary
        bestSample = samples[s]
      }
    }

    if (!bestSample.sample.lake) {
      if (stats) stats.excludedNoLake += 1
      continue
    }

    let minDepth = samples[0].depth
    let minBoundary = samples[0].sample.boundary
    let minWaterLevel = Number.POSITIVE_INFINITY
    let maxWaterLevel = 0
    let includedByDepth = false
    let includedByBoundary = false
    for (let s = 1; s < samples.length; s += 1) {
      if (samples[s].depth < minDepth) minDepth = samples[s].depth
      if (samples[s].sample.boundary < minBoundary) minBoundary = samples[s].sample.boundary
    }
    for (let s = 0; s < samples.length; s += 1) {
      const lake = samples[s].sample.lake
      if (lake) {
        const waterLevel = lake.surfaceInset + LAKE_SURFACE_DEPTH_EPS - LAKE_WATER_OVERDRAW
        minWaterLevel = Math.min(minWaterLevel, waterLevel)
        maxWaterLevel = Math.max(maxWaterLevel, waterLevel)
        if (samples[s].depth > waterLevel) includedByDepth = true
      }
      if (samples[s].sample.boundary > LAKE_WATER_MASK_THRESHOLD - LAKE_WATER_EDGE_EXPAND_BOUNDARY) {
        includedByBoundary = true
      }
    }
    const waterLevel =
      bestSample.sample.lake.surfaceInset + LAKE_SURFACE_DEPTH_EPS - LAKE_WATER_OVERDRAW
    if (stats) {
      stats.minDepth = Math.min(stats.minDepth, minDepth)
      stats.maxDepth = Math.max(stats.maxDepth, maxDepth)
      stats.minBoundary = Math.min(stats.minBoundary, minBoundary)
      stats.maxBoundary = Math.max(stats.maxBoundary, maxBoundary)
      stats.minWaterLevel = Math.min(stats.minWaterLevel, minWaterLevel)
      stats.maxWaterLevel = Math.max(stats.maxWaterLevel, maxWaterLevel)
      if (minDepth < waterLevel && maxDepth > waterLevel) {
        stats.boundary += 1
      }
    }
    if (!includedByDepth && !includedByBoundary) {
      if (stats) stats.excludedShallow += 1
      continue
    }
    if (stats) {
      stats.included += 1
      if (includedByDepth) stats.includedByDepth += 1
      if (includedByBoundary) stats.includedByBoundary += 1
    }

    const surfaceRadius =
      PLANET_RADIUS - bestSample.sample.lake.surfaceInset + LAKE_WATER_SURFACE_LIFT
    normal.copy(a).normalize()
    lakePositions.push(normal.x * surfaceRadius, normal.y * surfaceRadius, normal.z * surfaceRadius)
    lakeNormals.push(normal.x, normal.y, normal.z)
    normal.copy(b).normalize()
    lakePositions.push(normal.x * surfaceRadius, normal.y * surfaceRadius, normal.z * surfaceRadius)
    lakeNormals.push(normal.x, normal.y, normal.z)
    normal.copy(c).normalize()
    lakePositions.push(normal.x * surfaceRadius, normal.y * surfaceRadius, normal.z * surfaceRadius)
    lakeNormals.push(normal.x, normal.y, normal.z)
  }

  const geometry = new THREE.BufferGeometry()
  if (lakePositions.length > 0) {
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(lakePositions, 3))
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(lakeNormals, 3))
    geometry.computeBoundingSphere()
  }
  if (stats) {
    console.info('[LakeDebug]', stats)
    dumpLakeGeometry(geometry)
  }
  return geometry
}

const createLakeMaskMaterial = (lake: Lake) => {
  const material = new THREE.MeshStandardMaterial({
    color: '#2aa9ff',
    roughness: 0.18,
    metalness: 0.05,
    emissive: '#0a386b',
    emissiveIntensity: LAKE_WATER_EMISSIVE_BASE,
    transparent: true,
    opacity: LAKE_WATER_OPACITY,
  })
  material.depthWrite = true
  material.depthTest = true
  material.polygonOffset = true
  material.polygonOffsetFactor = -1
  material.polygonOffsetUnits = -1
  const extensions =
    (material as THREE.Material & { extensions?: { derivatives?: boolean } }).extensions ?? {}
  extensions.derivatives = true
  ;(material as THREE.Material & { extensions?: { derivatives?: boolean } }).extensions = extensions
  material.onBeforeCompile = (shader) => {
    const timeUniform = { value: 0 }
    shader.uniforms.lakeTime = timeUniform
    shader.uniforms.lakeCenter = { value: lake.center }
    shader.uniforms.lakeTangent = { value: lake.tangent }
    shader.uniforms.lakeBitangent = { value: lake.bitangent }
    shader.uniforms.lakeRadius = { value: lake.radius }
    shader.uniforms.lakeEdgeFalloff = { value: lake.edgeFalloff }
    shader.uniforms.lakeEdgeExpand = { value: LAKE_WATER_EDGE_EXPAND_ANGLE }
    shader.uniforms.lakeEdgeSharpness = { value: LAKE_EDGE_SHARPNESS }
    shader.uniforms.lakeNoiseAmplitude = { value: lake.noiseAmplitude }
    shader.uniforms.lakeNoiseFrequency = { value: lake.noiseFrequency }
    shader.uniforms.lakeNoiseFrequencyB = { value: lake.noiseFrequencyB }
    shader.uniforms.lakeNoiseFrequencyC = { value: lake.noiseFrequencyC }
    shader.uniforms.lakeNoisePhase = { value: lake.noisePhase }
    shader.uniforms.lakeNoisePhaseB = { value: lake.noisePhaseB }
    shader.uniforms.lakeNoisePhaseC = { value: lake.noisePhaseC }
    shader.uniforms.lakeWarpAmplitude = { value: lake.warpAmplitude }
    shader.uniforms.lakeWaveScale = { value: LAKE_WATER_WAVE_SCALE }
    shader.uniforms.lakeWaveSpeed = { value: LAKE_WATER_WAVE_SPEED }
    shader.uniforms.lakeWaveStrength = { value: LAKE_WATER_WAVE_STRENGTH }
    shader.uniforms.lakeFresnelStrength = { value: LAKE_WATER_FRESNEL_STRENGTH }
    shader.uniforms.lakeAlphaPulse = { value: LAKE_WATER_ALPHA_PULSE }
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n varying vec3 vLakeLocalPosition;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n vLakeLocalPosition = position;')
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
varying vec3 vLakeLocalPosition;
uniform vec3 lakeCenter;
uniform vec3 lakeTangent;
uniform vec3 lakeBitangent;
uniform float lakeRadius;
uniform float lakeEdgeFalloff;
uniform float lakeEdgeExpand;
uniform float lakeEdgeSharpness;
uniform float lakeNoiseAmplitude;
uniform float lakeNoiseFrequency;
uniform float lakeNoiseFrequencyB;
uniform float lakeNoiseFrequencyC;
uniform float lakeNoisePhase;
uniform float lakeNoisePhaseB;
uniform float lakeNoisePhaseC;
uniform float lakeWarpAmplitude;
uniform float lakeTime;
uniform float lakeWaveScale;
uniform float lakeWaveSpeed;
uniform float lakeWaveStrength;
uniform float lakeFresnelStrength;
uniform float lakeAlphaPulse;

float lakeWavePattern(vec3 normal, float time) {
  float dotValue = dot(lakeCenter, normal);
  vec3 temp = normal - lakeCenter * dotValue;
  float x = dot(temp, lakeTangent);
  float y = dot(temp, lakeBitangent);
  float phaseA = (x + y * 0.35) * lakeWaveScale + time * lakeWaveSpeed;
  float phaseB = (y - x * 0.28) * (lakeWaveScale * 1.35) - time * lakeWaveSpeed * 1.27;
  float wave = sin(phaseA) * 0.6 + sin(phaseB) * 0.4;
  return wave * 0.5 + 0.5;
}

float lakeEdgeBlend(vec3 normal) {
  float dotValue = clamp(dot(lakeCenter, normal), -1.0, 1.0);
  float angle = acos(dotValue);
  if (angle >= lakeRadius + lakeEdgeFalloff + lakeEdgeExpand) return 0.0;
  vec3 temp = normal - lakeCenter * dotValue;
  float x = dot(temp, lakeTangent);
  float y = dot(temp, lakeBitangent);
  float warp = sin((x + y) * lakeNoiseFrequencyC + lakeNoisePhaseC) * lakeWarpAmplitude;
  float u = x * lakeNoiseFrequency + lakeNoisePhase + warp;
  float v = y * lakeNoiseFrequencyB + lakeNoisePhaseB - warp;
  float w = (x - y) * lakeNoiseFrequencyC + lakeNoisePhaseC * 0.7;
  float noise = sin(u) + sin(v) + 0.6 * sin(2.0 * u + v * 0.6)
    + 0.45 * sin(2.3 * v - 0.7 * u) + 0.35 * sin(w);
  float noiseNormalized = noise / 3.15;
  float edgeRadius = clamp(
    lakeRadius * (1.0 + lakeNoiseAmplitude * noiseNormalized),
    lakeRadius * 0.65,
    lakeRadius * 1.35
  ) + lakeEdgeExpand;
  if (angle >= edgeRadius) return 0.0;
  float shelfRadius = max(1e-3, edgeRadius - lakeEdgeFalloff);
  float edgeT = clamp((edgeRadius - angle) / lakeEdgeFalloff, 0.0, 1.0);
  return pow(edgeT, lakeEdgeSharpness);
}
`,
      )
      .replace(
        '#include <dithering_fragment>',
        `
float lakeEdge = lakeEdgeBlend(normalize(vLakeLocalPosition));
if (lakeEdge <= 0.0) discard;
float lakeAa = fwidth(lakeEdge) * 1.5;
float lakeMask = smoothstep(0.0, lakeAa, lakeEdge);
float lakeWave = lakeWavePattern(normalize(vLakeLocalPosition), lakeTime);
float lakeFresnel = pow(1.0 - clamp(dot(normalize(geometryNormal), normalize(geometryViewDir)), 0.0, 1.0), 2.2);
float waveMix = lakeWave * lakeWaveStrength;
diffuseColor.rgb += vec3(0.03, 0.08, 0.12) * (waveMix + lakeFresnel * lakeFresnelStrength);
totalEmissiveRadiance += vec3(0.02, 0.05, 0.08) * (waveMix * 0.9 + lakeFresnel * lakeFresnelStrength);
float alphaPulse = 1.0 + (lakeWave - 0.5) * lakeAlphaPulse;
diffuseColor.a *= lakeMask * alphaPulse;
#include <dithering_fragment>`,
      )
    ;(material.userData as LakeMaterialUserData).lakeWaterUniforms = {
      time: timeUniform,
    }
  }
  return material
}

const createLakeMaterial = () => {
  const material = new THREE.MeshStandardMaterial({
    color: '#2aa9ff',
    roughness: 0.2,
    metalness: 0.04,
    emissive: '#0b426f',
    emissiveIntensity: LAKE_WATER_EMISSIVE_BASE,
    transparent: true,
    opacity: LAKE_WATER_OPACITY,
  })
  material.depthWrite = true
  material.depthTest = true
  material.polygonOffset = true
  material.polygonOffsetFactor = -1
  material.polygonOffsetUnits = -1
  return material
}

const createShorelineFillGeometry = (planetGeometry: THREE.BufferGeometry, lakes: Lake[]) => {
  const positions = planetGeometry.attributes.position
  const shoreline: number[] = []
  const a = new THREE.Vector3()
  const b = new THREE.Vector3()
  const c = new THREE.Vector3()
  const ab = new THREE.Vector3()
  const bc = new THREE.Vector3()
  const ca = new THREE.Vector3()
  const centroid = new THREE.Vector3()
  const normal = new THREE.Vector3()
  const temp = new THREE.Vector3()
  const isInsideLake = (point: THREE.Vector3) => {
    if (point.lengthSq() < 1e-8) return false
    normal.copy(point).normalize()
    const sample = sampleLakes(normal, lakes, temp)
    if (!sample.lake) return false
    return sample.boundary > LAKE_WATER_MASK_THRESHOLD
  }
  for (let i = 0; i < positions.count; i += 3) {
    a.set(positions.getX(i), positions.getY(i), positions.getZ(i))
    b.set(positions.getX(i + 1), positions.getY(i + 1), positions.getZ(i + 1))
    c.set(positions.getX(i + 2), positions.getY(i + 2), positions.getZ(i + 2))
    let hasInside = false
    let hasOutside = false
    const mark = (point: THREE.Vector3) => {
      if (isInsideLake(point)) {
        hasInside = true
      } else {
        hasOutside = true
      }
    }
    mark(a)
    mark(b)
    mark(c)
    if (!(hasInside && hasOutside)) {
      ab.copy(a).lerp(b, 0.5)
      mark(ab)
    }
    if (!(hasInside && hasOutside)) {
      bc.copy(b).lerp(c, 0.5)
      mark(bc)
    }
    if (!(hasInside && hasOutside)) {
      ca.copy(c).lerp(a, 0.5)
      mark(ca)
    }
    if (!(hasInside && hasOutside)) {
      centroid.copy(a).add(b).add(c).multiplyScalar(1 / 3)
      mark(centroid)
    }
    if (!(hasInside && hasOutside)) continue
    shoreline.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z)
  }
  const geometry = new THREE.BufferGeometry()
  if (shoreline.length > 0) {
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(shoreline, 3))
    geometry.computeVertexNormals()
    geometry.computeBoundingSphere()
  }
  return geometry
}
const createFilteredGridGeometry = (gridGeometry: THREE.BufferGeometry, lakes: Lake[]) => {
  const positions = gridGeometry.attributes.position
  const filtered: number[] = []
  const a = new THREE.Vector3()
  const b = new THREE.Vector3()
  const samplePoint = new THREE.Vector3()
  const normal = new THREE.Vector3()
  const temp = new THREE.Vector3()
  const shouldHide = (point: THREE.Vector3) => {
    if (point.lengthSq() < 1e-8) return false
    normal.copy(point).normalize()
    const sample = sampleLakes(normal, lakes, temp)
    if (!sample.lake) return false
    return true
  }
  for (let i = 0; i < positions.count; i += 2) {
    a.set(positions.getX(i), positions.getY(i), positions.getZ(i))
    b.set(positions.getX(i + 1), positions.getY(i + 1), positions.getZ(i + 1))
    let hide = shouldHide(a) || shouldHide(b)
    if (!hide) {
      samplePoint.copy(a).lerp(b, 0.25)
      hide = shouldHide(samplePoint)
    }
    if (!hide) {
      samplePoint.copy(a).lerp(b, 0.5)
      hide = shouldHide(samplePoint)
    }
    if (!hide) {
      samplePoint.copy(a).lerp(b, 0.75)
      hide = shouldHide(samplePoint)
    }
    if (hide) continue
    filtered.push(a.x, a.y, a.z, b.x, b.y, b.z)
  }
  const geometry = new THREE.BufferGeometry()
  if (filtered.length > 0) {
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(filtered, 3))
    geometry.computeBoundingSphere()
  }
  return geometry
}
const createShorelineGeometry = (gridGeometry: THREE.BufferGeometry, lakes: Lake[]) => {
  const positions = gridGeometry.attributes.position
  const shoreline: number[] = []
  const a = new THREE.Vector3()
  const b = new THREE.Vector3()
  const samplePoint = new THREE.Vector3()
  const normal = new THREE.Vector3()
  const temp = new THREE.Vector3()
  const isInsideLake = (point: THREE.Vector3) => {
    if (point.lengthSq() < 1e-8) return false
    normal.copy(point).normalize()
    const sample = sampleLakes(normal, lakes, temp)
    if (!sample.lake) return false
    return sample.boundary > LAKE_GRID_MASK_THRESHOLD
  }
  for (let i = 0; i < positions.count; i += 2) {
    a.set(positions.getX(i), positions.getY(i), positions.getZ(i))
    b.set(positions.getX(i + 1), positions.getY(i + 1), positions.getZ(i + 1))
    const insideA = isInsideLake(a)
    const insideB = isInsideLake(b)
    let crosses = insideA !== insideB
    if (!crosses) {
      samplePoint.copy(a).lerp(b, 0.25)
      const insideQuarter = isInsideLake(samplePoint)
      samplePoint.copy(a).lerp(b, 0.5)
      const insideMid = isInsideLake(samplePoint)
      samplePoint.copy(a).lerp(b, 0.75)
      const insideThreeQuarter = isInsideLake(samplePoint)
      crosses =
        insideQuarter !== insideA ||
        insideMid !== insideA ||
        insideThreeQuarter !== insideA
    }
    if (!crosses) continue
    shoreline.push(a.x, a.y, a.z, b.x, b.y, b.z)
  }
  const geometry = new THREE.BufferGeometry()
  if (shoreline.length > 0) {
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(shoreline, 3))
    geometry.computeBoundingSphere()
  }
  return geometry
}
const randomOnSphere = (rand: () => number, target = new THREE.Vector3()) => {
  const theta = rand() * Math.PI * 2
  const z = rand() * 2 - 1
  const r = Math.sqrt(Math.max(0, 1 - z * z))
  target.set(r * Math.cos(theta), z, r * Math.sin(theta))
  return target
}
const isLakeDebugEnabled = () => {
  if (typeof window === 'undefined') return false
  try {
    if ((window as { __LAKE_DEBUG__?: boolean }).__LAKE_DEBUG__ === true) return true
    return window.localStorage.getItem('spherical_snake_lake_debug') === '1'
  } catch {
    return false
  }
}
const dumpLakeGeometry = (geometry: THREE.BufferGeometry) => {
  if (typeof window === 'undefined') return
  const positionAttr = geometry.getAttribute('position') as THREE.BufferAttribute | undefined
  const normalAttr = geometry.getAttribute('normal') as THREE.BufferAttribute | undefined
  if (!positionAttr || !normalAttr) return
  const positions = Array.from(positionAttr.array as Iterable<number>)
  const normals = Array.from(normalAttr.array as Iterable<number>)
  const payload = {
    vertexCount: positionAttr.count,
    positions,
    normals,
  }
  ;(window as { __LAKE_GEOMETRY__?: typeof payload }).__LAKE_GEOMETRY__ = payload
  console.info('[LakeGeometry]', payload)
}

const createRenderer = async (
  canvas: HTMLCanvasElement,
  backend: RendererBackend,
): Promise<THREE.WebGLRenderer | WebGPURenderer> => {
  if (backend === 'webgpu') {
    const renderer = new WebGPURenderer({
      canvas,
      antialias: true,
      alpha: true,
    })
    renderer.outputColorSpace = THREE.SRGBColorSpace
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.toneMappingExposure = 1.05
    renderer.setClearColor(0x000000, 0)
    await renderer.init()
    return renderer
  }

  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: true,
  })
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 1.05
  renderer.setClearColor(0x000000, 0)
  return renderer
}

export const createScene = async (
  canvas: HTMLCanvasElement,
  requestedBackend: RendererPreference,
  activeBackend: RendererBackend,
  fallbackReason: string | null,
): Promise<RenderScene> => {
  const renderer = await createRenderer(canvas, activeBackend)
  const webglShaderHooksEnabled = activeBackend === 'webgl'

  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 20)
  camera.position.set(0, 0, 3)
  scene.add(camera)

  const world = new THREE.Group()
  scene.add(world)

  const ambient = new THREE.AmbientLight(0xffffff, 0.65)
  const keyLight = new THREE.DirectionalLight(0xffffff, 0.9)
  keyLight.position.set(2, 3, 4)
  const rimLight = new THREE.DirectionalLight(0x9bd7ff, 0.35)
  rimLight.position.set(-2, -1, 2)
  camera.add(ambient)
  camera.add(keyLight)
  camera.add(rimLight)

  let dayNightDebugMode: DayNightDebugMode = 'auto'
  let dayNightPhase = 0
  let dayNightFactor = 1
  let dayNightCycleMs = DAY_NIGHT_CYCLE_MS
  let dayNightSourceNowMs: number | null = null
  let lastSkyGradientFactor = Number.NaN
  const skyTopTemp = new THREE.Color()
  const skyHorizonTemp = new THREE.Color()
  const skyBottomTemp = new THREE.Color()
  const horizonColorTemp = new THREE.Color()
  let lastPlanetScreenCenterX = 0.5
  let lastPlanetScreenCenterY = 0.5
  let lastPlanetScreenRadiusPx = 240

  const skyGroup = new THREE.Group()
  skyGroup.renderOrder = -50
  camera.add(skyGroup)

  const skyGradient = createSkyGradientTexture(DAY_NIGHT_SKY_TEXTURE_SIZE)
  const skyDomeGeometry = new THREE.SphereGeometry(DAY_NIGHT_SKY_RADIUS, 48, 32)
  const skyDomeMaterial = new THREE.MeshBasicMaterial({
    map: skyGradient?.texture ?? null,
    color: '#ffffff',
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
    fog: false,
  })
  const skyDome = new THREE.Mesh(skyDomeGeometry, skyDomeMaterial)
  skyDome.renderOrder = -50
  skyDome.frustumCulled = false
  skyGroup.add(skyDome)

  const horizonTexture = createHorizonScatteringTexture()
  const horizonMaterial = new THREE.SpriteMaterial({
    map: horizonTexture ?? null,
    color: HORIZON_DAY_COLOR.clone(),
    transparent: true,
    opacity: 0,
    depthWrite: false,
    depthTest: false,
    fog: false,
  })
  const horizonSprite = new THREE.Sprite(horizonMaterial)
  horizonSprite.renderOrder = -49
  horizonSprite.frustumCulled = false
  skyGroup.add(horizonSprite)

  const starsGeometry = new THREE.BufferGeometry()
  const starPositions = new Float32Array(DAY_NIGHT_STAR_COUNT * 3)
  const starRandom = createSeededRandom(0x4f23d19a)
  for (let i = 0; i < DAY_NIGHT_STAR_COUNT; i += 1) {
    const z = starRandom() * 2 - 1
    const theta = starRandom() * DAY_NIGHT_TAU
    const radial = Math.sqrt(Math.max(0, 1 - z * z))
    const radius = DAY_NIGHT_STAR_RADIUS * (0.95 + starRandom() * 0.08)
    const offset = i * 3
    starPositions[offset] = Math.cos(theta) * radial * radius
    starPositions[offset + 1] = z * radius
    starPositions[offset + 2] = Math.sin(theta) * radial * radius
  }
  starsGeometry.setAttribute('position', new THREE.BufferAttribute(starPositions, 3))
  const starTexture = createPelletRadialTexture(96, [
    { offset: 0, color: 'rgba(255,255,255,1)' },
    { offset: 0.75, color: 'rgba(255,255,255,0.4)' },
    { offset: 1, color: 'rgba(255,255,255,0)' },
  ])
  const starsMaterial = new THREE.PointsMaterial({
    color: '#f3f8ff',
    size: DAY_NIGHT_STAR_SIZE,
    transparent: true,
    opacity: 0,
    map: starTexture ?? null,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: true,
    sizeAttenuation: true,
  })
  const starsMesh = new THREE.Points(starsGeometry, starsMaterial)
  starsMesh.frustumCulled = false
  starsMesh.renderOrder = -49
  skyGroup.add(starsMesh)

  const sunTexture = createPelletRadialTexture(192, [
    { offset: 0, color: 'rgba(255,255,255,1)' },
    { offset: 0.5, color: 'rgba(255,244,185,0.96)' },
    { offset: 1, color: 'rgba(255,244,185,0)' },
  ])
  const sunGlowTexture = createPelletRadialTexture(224, [
    { offset: 0, color: 'rgba(255,245,188,0.95)' },
    { offset: 0.62, color: 'rgba(255,245,188,0.42)' },
    { offset: 1, color: 'rgba(255,245,188,0)' },
  ])
  const moonTexture =
    (await createMoonTextureFromAsset(
      DAY_NIGHT_MOON_TEXTURE_URL,
      DAY_NIGHT_MOON_TEXTURE_SIZE,
      DAY_NIGHT_MOON_TEXTURE_EDGE_FEATHER,
    )) ??
    createPelletRadialTexture(192, [
      { offset: 0, color: 'rgba(255,255,255,0.95)' },
      { offset: 0.54, color: 'rgba(216,227,255,0.84)' },
      { offset: 1, color: 'rgba(216,227,255,0)' },
    ])
  const moonGlowTexture = createPelletRadialTexture(192, [
    { offset: 0, color: 'rgba(196,214,255,0.78)' },
    { offset: 0.7, color: 'rgba(196,214,255,0.28)' },
    { offset: 1, color: 'rgba(196,214,255,0)' },
  ])

  const sunCoreMaterial = new THREE.SpriteMaterial({
    map: sunTexture ?? null,
    color: SUN_CORE_COLOR.clone(),
    transparent: true,
    opacity: 1,
    depthWrite: false,
    depthTest: true,
    fog: false,
  })
  const sunGlowMaterial = new THREE.SpriteMaterial({
    map: sunGlowTexture ?? null,
    color: SUN_GLOW_COLOR.clone(),
    transparent: true,
    opacity: 0.55,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: true,
    fog: false,
  })
  const moonCoreMaterial = new THREE.SpriteMaterial({
    map: moonTexture ?? null,
    color: MOON_CORE_COLOR.clone(),
    transparent: true,
    opacity: 0,
    depthWrite: false,
    depthTest: true,
    fog: false,
  })
  const moonGlowMaterial = new THREE.SpriteMaterial({
    map: moonGlowTexture ?? null,
    color: MOON_GLOW_COLOR.clone(),
    transparent: true,
    opacity: 0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: true,
    fog: false,
  })

  const sunGroup = new THREE.Group()
  const moonGroup = new THREE.Group()
  sunGroup.renderOrder = -48
  moonGroup.renderOrder = -48
  sunGroup.frustumCulled = false
  moonGroup.frustumCulled = false

  const sunGlow = new THREE.Sprite(sunGlowMaterial)
  const sunCore = new THREE.Sprite(sunCoreMaterial)
  sunGlow.scale.set(DAY_NIGHT_SUN_GLOW_SIZE, DAY_NIGHT_SUN_GLOW_SIZE, 1)
  sunCore.scale.set(DAY_NIGHT_SUN_SIZE, DAY_NIGHT_SUN_SIZE, 1)
  sunGlow.frustumCulled = false
  sunCore.frustumCulled = false
  sunGlow.renderOrder = -48
  sunCore.renderOrder = -47
  sunGroup.add(sunGlow)
  sunGroup.add(sunCore)

  const moonGlow = new THREE.Sprite(moonGlowMaterial)
  const moonCore = new THREE.Sprite(moonCoreMaterial)
  moonGlow.scale.set(DAY_NIGHT_MOON_GLOW_SIZE, DAY_NIGHT_MOON_GLOW_SIZE, 1)
  moonCore.scale.set(DAY_NIGHT_MOON_SIZE, DAY_NIGHT_MOON_SIZE, 1)
  moonGlow.frustumCulled = false
  moonCore.frustumCulled = false
  moonGlow.renderOrder = -48
  moonCore.renderOrder = -47
  moonGroup.add(moonGlow)
  moonGroup.add(moonCore)
  skyGroup.add(sunGroup)
  skyGroup.add(moonGroup)

  let lakes: Lake[] = []
  let trees: TreeInstance[] = []
  let mountains: MountainInstance[] = []
  let planetMesh: THREE.Mesh | null = null
  let planetPatches: TerrainPatchInstance[] = []
  let planetPatchMaterial: THREE.MeshStandardMaterial | null = null
  let visiblePlanetPatchCount = 0
  let gridMesh: THREE.LineSegments | null = null
  let shorelineLineMesh: THREE.LineSegments | null = null
  let shorelineFillMesh: THREE.Mesh | null = null
  let lakeSurfaceGeometry: THREE.BufferGeometry | null = null
  let lakeMeshes: THREE.Mesh[] = []
  let lakeMaterials: THREE.MeshStandardMaterial[] = []
  let mountainDebugGroup: THREE.Group | null = null
  let mountainDebugMaterial: THREE.LineBasicMaterial | null = null
  let mountainDebugEnabled = false
  let lakeDebugGroup: THREE.Group | null = null
  let lakeDebugMaterial: THREE.LineBasicMaterial | null = null
  let lakeDebugEnabled = false
  let treeDebugGroup: THREE.Group | null = null
  let treeDebugMaterial: THREE.LineBasicMaterial | null = null
  let treeDebugEnabled = false
  let terrainTessellationDebugEnabled = false

  const environmentGroup = new THREE.Group()
  world.add(environmentGroup)

  const boostTrailsGroup = new THREE.Group()
  const snakesGroup = new THREE.Group()
  const pelletsGroup = new THREE.Group()
  world.add(boostTrailsGroup)
  world.add(snakesGroup)
  world.add(pelletsGroup)

  const headGeometry = new THREE.SphereGeometry(HEAD_RADIUS, 18, 18)
  const bowlGeometry = new THREE.SphereGeometry(HEAD_RADIUS * 1.55, 20, 20)
  const tailGeometry = new THREE.SphereGeometry(1, 18, 12, 0, Math.PI * 2, 0, Math.PI / 2)
  const eyeGeometry = new THREE.SphereGeometry(EYE_RADIUS, 12, 12)
  const pupilGeometry = new THREE.SphereGeometry(PUPIL_RADIUS, 10, 10)
  const eyeMaterial = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.2 })
  const pupilMaterial = new THREE.MeshStandardMaterial({ color: '#1b1b1b', roughness: 0.4 })
  const tongueBaseGeometry = new THREE.CylinderGeometry(
    TONGUE_RADIUS,
    TONGUE_RADIUS * 0.9,
    1,
    10,
    1,
    true,
  )
  tongueBaseGeometry.translate(0, 0.5, 0)
  const tongueForkGeometry = new THREE.CylinderGeometry(
    TONGUE_RADIUS * 0.7,
    TONGUE_RADIUS * 0.25,
    1,
    8,
    1,
    true,
  )
  tongueForkGeometry.translate(0, 0.5, 0)
  const tongueMaterial = new THREE.MeshStandardMaterial({
    color: '#ff6f9f',
    roughness: 0.25,
    metalness: 0.05,
    emissive: '#ff4f8a',
    emissiveIntensity: 0.3,
  })
  const boostDraftGeometry = new THREE.SphereGeometry(1, 24, 16, 0, Math.PI * 2, 0, Math.PI * 0.5)
  const boostDraftTexture = createBoostDraftTexture()
  const snakeSkinTextureCache = new Map<string, THREE.CanvasTexture>()
  const maxAnisotropy =
    renderer instanceof THREE.WebGLRenderer ? renderer.capabilities.getMaxAnisotropy() : 1
  const getSnakeSkinTexture = (primaryColor: string, skinColors?: string[] | null) => {
    const base = (skinColors && skinColors.length > 0 ? skinColors : [primaryColor]).map(
      (c) => normalizeHexColor(c) ?? normalizeHexColor(primaryColor) ?? '#ffffff',
    )
    const slots = resolveSkinSlots(base)
    const key = slots.join('|')
    let texture = snakeSkinTextureCache.get(key) ?? null
    if (!texture) {
      texture = createSnakeSkinTexture(slots)
      if (!texture) {
        const fallbackCanvas = document.createElement('canvas')
        fallbackCanvas.width = 1
        fallbackCanvas.height = 1
        const fallbackCtx = fallbackCanvas.getContext('2d')
        if (fallbackCtx) {
          fallbackCtx.fillStyle = slots[0] ?? '#ffffff'
          fallbackCtx.fillRect(0, 0, 1, 1)
        }
        texture = new THREE.CanvasTexture(fallbackCanvas)
        texture.wrapS = THREE.RepeatWrapping
        texture.wrapT = THREE.RepeatWrapping
        texture.magFilter = THREE.LinearFilter
        texture.minFilter = THREE.LinearFilter
        texture.colorSpace = THREE.SRGBColorSpace
        texture.needsUpdate = true
      }
      texture.anisotropy = maxAnisotropy
      snakeSkinTextureCache.set(key, texture)
    }
    return { key, texture, primary: slots[0] ?? (normalizeHexColor(primaryColor) ?? '#ffffff'), slots }
  }

  // Menu skin preview (rendered as an overlay pass to avoid contaminating depth/occluder passes).
  const menuPreviewScene = new THREE.Scene()
  const menuPreviewCamera = new THREE.PerspectiveCamera(40, 1, 0.1, 20)
  menuPreviewCamera.position.set(0, 0, 2.65)
  menuPreviewScene.add(menuPreviewCamera)
  const menuPreviewAmbient = new THREE.AmbientLight(0xffffff, 0.85)
  const menuPreviewKeyLight = new THREE.DirectionalLight(0xffffff, 0.92)
  menuPreviewKeyLight.position.set(2, 3, 4)
  const menuPreviewRimLight = new THREE.DirectionalLight(0x9bd7ff, 0.35)
  menuPreviewRimLight.position.set(-2, -1, 2)
  menuPreviewCamera.add(menuPreviewAmbient)
  menuPreviewCamera.add(menuPreviewKeyLight)
  menuPreviewCamera.add(menuPreviewRimLight)

  const menuPreviewGroup = new THREE.Group()
  menuPreviewScene.add(menuPreviewGroup)
  menuPreviewGroup.visible = false
  menuPreviewGroup.position.set(0, 0.1, 0)

  const menuPreviewMaterial = new THREE.MeshStandardMaterial({
    color: '#ffffff',
    roughness: 0.35,
    metalness: 0.1,
    flatShading: false,
    transparent: true,
    opacity: 1,
  })
  menuPreviewMaterial.emissive = new THREE.Color('#ffffff')
  menuPreviewMaterial.emissiveIntensity = 0.22
  const menuPreviewSeedSkin = getSnakeSkinTexture('#ffffff', ['#ffffff'])
  menuPreviewMaterial.map = menuPreviewSeedSkin.texture
  menuPreviewMaterial.emissiveMap = menuPreviewSeedSkin.texture

  const menuPreviewTube = new THREE.Mesh(new THREE.BufferGeometry(), menuPreviewMaterial)
  const menuPreviewTail = new THREE.Mesh(new THREE.BufferGeometry(), menuPreviewMaterial)
  const menuPreviewHeadMaterial = new THREE.MeshStandardMaterial({
    color: menuPreviewSeedSkin.primary,
    roughness: 0.25,
    metalness: 0.1,
    transparent: true,
    opacity: 1,
  })
  menuPreviewHeadMaterial.emissive = new THREE.Color(menuPreviewSeedSkin.primary)
  menuPreviewHeadMaterial.emissiveIntensity = 0.12
  const menuPreviewHead = new THREE.Mesh(headGeometry, menuPreviewHeadMaterial)
  menuPreviewGroup.add(menuPreviewTube)
  menuPreviewGroup.add(menuPreviewTail)
  menuPreviewGroup.add(menuPreviewHead)

  let menuPreviewVisible = false
  let menuPreviewSkinKey = menuPreviewSeedSkin.key
  let menuPreviewLen = 8
  let menuPreviewGeometryReady = false
  let menuPreviewYaw = -0.35
  let menuPreviewPitch = 0.08

	  // Pointer aiming overlay (3D curved arrow rendered above everything).
	  const POINTER_ARROW_SEGMENTS = 16
	  const POINTER_ARROW_ARC_RADIANS = 0.09
	  const POINTER_ARROW_LIFT = SNAKE_RADIUS * 0.25
	  const POINTER_ARROW_HALF_WIDTH = SNAKE_RADIUS * 0.65
	  const POINTER_ARROW_HEAD_HALF_WIDTH = SNAKE_RADIUS * 1.7
	  const POINTER_ARROW_THICKNESS = SNAKE_RADIUS * 0.55
	  const POINTER_ARROW_HEAD_LENGTH = SNAKE_RADIUS * 3.2
	  const POINTER_ARROW_TIP_HALF_WIDTH = POINTER_ARROW_HALF_WIDTH * 0.04

  let pointerScreenX = Number.NaN
  let pointerScreenY = Number.NaN
  let pointerActive = false

  const pointerAxisValue: Point = { x: 0, y: 0, z: 0 }
  let pointerAxisActive = false

	  const pointerOverlayScene = new THREE.Scene()
	  const pointerOverlayRoot = new THREE.Group()
	  pointerOverlayRoot.visible = false
	  pointerOverlayScene.add(pointerOverlayRoot)

	  // Keep contrast so faces read as low-poly shaded instead of flat white.
	  const pointerOverlayAmbient = new THREE.AmbientLight(0xffffff, 0.34)
	  const pointerOverlayKeyLight = new THREE.DirectionalLight(0xffffff, 1.08)
	  pointerOverlayKeyLight.position.set(2.2, 3.1, 3.4)
	  const pointerOverlayRimLight = new THREE.DirectionalLight(0x9bd7ff, 0.34)
	  pointerOverlayRimLight.position.set(-3.2, -1.4, -2.6)
	  pointerOverlayScene.add(pointerOverlayAmbient)
	  pointerOverlayScene.add(pointerOverlayKeyLight)
	  pointerOverlayScene.add(pointerOverlayRimLight)
	  pointerOverlayScene.add(pointerOverlayKeyLight.target)
	  pointerOverlayScene.add(pointerOverlayRimLight.target)

	  const pointerArrowMaterial = new THREE.MeshStandardMaterial({
	    color: 0xe7e7e7,
	    roughness: 0.5,
	    metalness: 0.04,
	    flatShading: true,
	    // Overlay pass clears depth before rendering, so we can keep depth testing enabled for correct
	    // self-occlusion (prevents weird diagonal artifacts from backfaces drawing over frontfaces).
	    side: THREE.DoubleSide,
	    depthTest: true,
	    depthWrite: true,
	    fog: false,
	  })
	  pointerArrowMaterial.depthTest = true
	  pointerArrowMaterial.depthWrite = true

	  const pointerArrowRingCount = POINTER_ARROW_SEGMENTS + 1
	  // Each ring has 4 vertices (bottomLeft, bottomRight, topLeft, topRight) plus 2 tip vertices.
	  const pointerArrowVertexCount = pointerArrowRingCount * 4 + 2
	  const pointerArrowPositions = new Float32Array(pointerArrowVertexCount * 3)
	  const pointerArrowPositionAttr = new THREE.BufferAttribute(pointerArrowPositions, 3)
	  // 24 indices per segment (top/bottom/left/right), plus 6 for the tail cap, plus 18 for the tip wedge.
	  const pointerArrowIndexCount = POINTER_ARROW_SEGMENTS * 24 + 6 + 18
	  const pointerArrowIndices = new Uint16Array(pointerArrowIndexCount)
	  let pointerArrowIndexOffset = 0
	  for (let i = 0; i < POINTER_ARROW_SEGMENTS; i += 1) {
	    const base0 = i * 4
    const base1 = (i + 1) * 4
    const bl0 = base0
    const br0 = base0 + 1
    const tl0 = base0 + 2
    const tr0 = base0 + 3
    const bl1 = base1
    const br1 = base1 + 1
    const tl1 = base1 + 2
    const tr1 = base1 + 3

    // Top surface (+normal).
    pointerArrowIndices[pointerArrowIndexOffset++] = tl0
    pointerArrowIndices[pointerArrowIndexOffset++] = tr0
    pointerArrowIndices[pointerArrowIndexOffset++] = tl1
    pointerArrowIndices[pointerArrowIndexOffset++] = tr0
    pointerArrowIndices[pointerArrowIndexOffset++] = tr1
    pointerArrowIndices[pointerArrowIndexOffset++] = tl1

    // Bottom surface (-normal).
    pointerArrowIndices[pointerArrowIndexOffset++] = bl0
    pointerArrowIndices[pointerArrowIndexOffset++] = bl1
    pointerArrowIndices[pointerArrowIndexOffset++] = br0
    pointerArrowIndices[pointerArrowIndexOffset++] = br0
    pointerArrowIndices[pointerArrowIndexOffset++] = bl1
    pointerArrowIndices[pointerArrowIndexOffset++] = br1

    // Left side (+side).
    pointerArrowIndices[pointerArrowIndexOffset++] = bl0
    pointerArrowIndices[pointerArrowIndexOffset++] = tl0
    pointerArrowIndices[pointerArrowIndexOffset++] = bl1
    pointerArrowIndices[pointerArrowIndexOffset++] = tl0
    pointerArrowIndices[pointerArrowIndexOffset++] = tl1
    pointerArrowIndices[pointerArrowIndexOffset++] = bl1

    // Right side (-side).
    pointerArrowIndices[pointerArrowIndexOffset++] = br0
    pointerArrowIndices[pointerArrowIndexOffset++] = br1
    pointerArrowIndices[pointerArrowIndexOffset++] = tr0
    pointerArrowIndices[pointerArrowIndexOffset++] = tr0
    pointerArrowIndices[pointerArrowIndexOffset++] = br1
    pointerArrowIndices[pointerArrowIndexOffset++] = tr1
  }
	  // Tail cap.
	  pointerArrowIndices[pointerArrowIndexOffset++] = 0
	  pointerArrowIndices[pointerArrowIndexOffset++] = 1
	  pointerArrowIndices[pointerArrowIndexOffset++] = 2
	  pointerArrowIndices[pointerArrowIndexOffset++] = 1
	  pointerArrowIndices[pointerArrowIndexOffset++] = 3
	  pointerArrowIndices[pointerArrowIndexOffset++] = 2
	  // Tip wedge (connect the final ring to the tip edge). This keeps the arrowhead and tail as one
	  // seamless low-poly mesh and avoids the tail clipping through a separate head mesh.
	  const pointerArrowLastBase = POINTER_ARROW_SEGMENTS * 4
	  const pointerArrowTipBottomIndex = pointerArrowRingCount * 4
	  const pointerArrowTipTopIndex = pointerArrowTipBottomIndex + 1
	  pointerArrowIndices[pointerArrowIndexOffset++] = pointerArrowLastBase + 2
	  pointerArrowIndices[pointerArrowIndexOffset++] = pointerArrowLastBase + 3
	  pointerArrowIndices[pointerArrowIndexOffset++] = pointerArrowTipTopIndex
	  pointerArrowIndices[pointerArrowIndexOffset++] = pointerArrowLastBase + 0
	  pointerArrowIndices[pointerArrowIndexOffset++] = pointerArrowTipBottomIndex
	  pointerArrowIndices[pointerArrowIndexOffset++] = pointerArrowLastBase + 1
	  pointerArrowIndices[pointerArrowIndexOffset++] = pointerArrowLastBase + 0
	  pointerArrowIndices[pointerArrowIndexOffset++] = pointerArrowLastBase + 2
	  pointerArrowIndices[pointerArrowIndexOffset++] = pointerArrowTipBottomIndex
	  pointerArrowIndices[pointerArrowIndexOffset++] = pointerArrowLastBase + 2
	  pointerArrowIndices[pointerArrowIndexOffset++] = pointerArrowTipTopIndex
	  pointerArrowIndices[pointerArrowIndexOffset++] = pointerArrowTipBottomIndex
	  pointerArrowIndices[pointerArrowIndexOffset++] = pointerArrowLastBase + 1
	  pointerArrowIndices[pointerArrowIndexOffset++] = pointerArrowTipBottomIndex
	  pointerArrowIndices[pointerArrowIndexOffset++] = pointerArrowLastBase + 3
	  pointerArrowIndices[pointerArrowIndexOffset++] = pointerArrowLastBase + 3
	  pointerArrowIndices[pointerArrowIndexOffset++] = pointerArrowTipBottomIndex
	  pointerArrowIndices[pointerArrowIndexOffset++] = pointerArrowTipTopIndex

	  const pointerArrowGeometry = new THREE.BufferGeometry()
	  pointerArrowGeometry.setAttribute('position', pointerArrowPositionAttr)
	  pointerArrowGeometry.setIndex(new THREE.BufferAttribute(pointerArrowIndices, 1))
	  const pointerArrowMesh = new THREE.Mesh(pointerArrowGeometry, pointerArrowMaterial)
	  pointerArrowMesh.frustumCulled = false
	  pointerArrowMesh.renderOrder = 10_000
	  pointerOverlayRoot.add(pointerArrowMesh)

	  const pointerRaycaster = new THREE.Raycaster()
	  const pointerNdcTemp = new THREE.Vector2()
	  const pointerRayLocal = new THREE.Ray(new THREE.Vector3(), new THREE.Vector3(0, 0, -1))
	  const pointerSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), PLANET_RADIUS)
  const pointerOriginLocalTemp = new THREE.Vector3()
  const pointerDirLocalTemp = new THREE.Vector3()
  const pointerHitLocalTemp = new THREE.Vector3()
  const pointerTargetNormalTemp = new THREE.Vector3(0, 0, 1)
  const pointerLocalHeadNormalTemp = new THREE.Vector3(0, 0, 1)
	  const pointerAxisVectorTemp = new THREE.Vector3()
	  const pointerArrowTipPointTemp = new THREE.Vector3()
	  const pointerArrowDirs = Array.from({ length: POINTER_ARROW_SEGMENTS + 1 }, () => new THREE.Vector3())
	  const pointerArrowPoints = Array.from({ length: POINTER_ARROW_SEGMENTS + 1 }, () => new THREE.Vector3())
	  const pointerArrowTangentTemp = new THREE.Vector3()
	  const pointerArrowSideTemp = new THREE.Vector3()

  const setPointerScreen = (x: number, y: number, active: boolean) => {
    pointerScreenX = x
    pointerScreenY = y
    pointerActive = active
  }

  const getPointerAxis = () => (pointerAxisActive ? pointerAxisValue : null)

		  const rebuildMenuPreviewGeometry = (nextLen: number) => {
		    const len = clamp(Math.floor(nextLen), 1, 8)
		    const pointCount = Math.max(2, len)
	    const points: THREE.Vector3[] = []
    const spacing = 0.21
    const half = (pointCount - 1) * 0.5
    for (let i = 0; i < pointCount; i += 1) {
      const t = pointCount > 1 ? i / (pointCount - 1) : 0
      const x = (i - half) * spacing
      const y = Math.sin(i * 0.85) * 0.07
      const z = Math.cos(t * Math.PI * 1.1) * 0.06
      points.push(new THREE.Vector3(x, y, z))
    }
    const curve = new THREE.CatmullRomCurve3(points, false, 'centripetal')
    const tubularSegments = Math.max(32, pointCount * 22)
    const radius = SNAKE_RADIUS * 1.25
    const tubeGeometry = new THREE.TubeGeometry(curve, tubularSegments, radius, SNAKE_TUBE_RADIAL_SEGMENTS, false)

    // Preview uses the same UV encoding as gameplay snakes so patterns behave the same way.
    applySnakeSkinUVs(tubeGeometry, 0, len)

    const prevPoint = points[points.length - 2] ?? points[0]
    const tailPoint = points[points.length - 1] ?? points[0]
    const tailDir = tailPoint.clone().sub(prevPoint)
    if (tailDir.lengthSq() > 1e-8) tailDir.normalize()
    const capGeometry = buildTailCapGeometry(tubeGeometry, tailDir) ?? null

    const oldTube = menuPreviewTube.geometry
    const oldTail = menuPreviewTail.geometry
    menuPreviewTube.geometry = tubeGeometry
    if (capGeometry) {
      menuPreviewTail.geometry = capGeometry
    } else {
      menuPreviewTail.geometry = new THREE.BufferGeometry()
    }
    const headPoint = points[0] ?? null
    if (headPoint) {
      menuPreviewHead.position.copy(headPoint)
    } else {
      menuPreviewHead.position.set(0, 0, 0)
    }
    oldTube.dispose()
    oldTail.dispose()
    menuPreviewGeometryReady = true
  }

  const setMenuPreviewVisible = (visible: boolean) => {
    menuPreviewVisible = visible
    menuPreviewGroup.visible = visible
  }

  const setMenuPreviewSkin = (colors: string[] | null, previewLen?: number) => {
    const safeLen = typeof previewLen === 'number' ? previewLen : menuPreviewLen
    const list = colors && colors.length ? colors : ['#ffffff']
    const primary = list[0] ?? '#ffffff'
    const skin = getSnakeSkinTexture(primary, list)
    if (skin.key !== menuPreviewSkinKey) {
      menuPreviewSkinKey = skin.key
      menuPreviewMaterial.map = skin.texture
      menuPreviewMaterial.emissiveMap = skin.texture
      menuPreviewMaterial.needsUpdate = true
    }
    menuPreviewHeadMaterial.color.set(skin.primary)
    menuPreviewHeadMaterial.emissive.set(skin.primary)
    const clampedLen = clamp(Math.floor(safeLen), 1, 8)
    if (!menuPreviewGeometryReady || clampedLen !== menuPreviewLen) {
      menuPreviewLen = clampedLen
      rebuildMenuPreviewGeometry(menuPreviewLen)
    }
  }

  const setMenuPreviewOrbit = (yaw: number, pitch: number) => {
    if (!Number.isFinite(yaw) || !Number.isFinite(pitch)) return
    menuPreviewYaw = yaw
    menuPreviewPitch = clamp(pitch, -1.25, 1.25)
  }

  const PELLET_COLOR_BUCKET_COUNT = PELLET_COLORS.length
  const PELLET_BUCKET_COUNT = PELLET_COLOR_BUCKET_COUNT * PELLET_SIZE_TIER_MULTIPLIERS.length
  const PELLET_SHADOW_POINT_SIZE = PELLET_RADIUS * 9.4
  const PELLET_CORE_POINT_SIZE = PELLET_RADIUS * 5
  const PELLET_INNER_GLOW_POINT_SIZE = PELLET_RADIUS * 14
  const PELLET_GLOW_POINT_SIZE = PELLET_RADIUS * 23
  const pelletShadowTexture = createPelletShadowTexture()
  const pelletCoreTexture = createPelletCoreTexture()
  const pelletInnerGlowTexture = createPelletInnerGlowTexture()
  const pelletGlowTexture = createPelletGlowTexture()
  const occluderDepthMaterial = new THREE.MeshDepthMaterial({
    depthPacking: THREE.BasicDepthPacking,
  })
  occluderDepthMaterial.depthTest = true
  occluderDepthMaterial.depthWrite = true
  occluderDepthMaterial.colorWrite = false
  const RENDER_PASS_WORLD_NO_PELLETS_LAKES = 0
  const RENDER_PASS_PELLET_OCCLUDERS = 1
  const RENDER_PASS_PELLETS_ONLY = 2
  const RENDER_PASS_LAKES_ONLY = 3
  const worldChildVisibilityScratch: boolean[] = []
  const hiddenSnakeDepthObjects: THREE.Object3D[] = []
  let treeTierGeometries: THREE.BufferGeometry[] = []
  let treeTierMeshes: THREE.InstancedMesh[] = []
  let treeTrunkGeometry: THREE.BufferGeometry | null = null
  let treeTrunkMesh: THREE.InstancedMesh | null = null
  let treeLeafMaterial: THREE.MeshStandardMaterial | null = null
  let treeTrunkMaterial: THREE.MeshStandardMaterial | null = null
  let cactusPartGeometries: THREE.BufferGeometry[] = []
  let cactusPartMeshes: THREE.InstancedMesh[] = []
  let cactusTrunkGeometry: THREE.BufferGeometry | null = null
  let cactusTrunkMesh: THREE.InstancedMesh | null = null
  let cactusMaterial: THREE.MeshStandardMaterial | null = null
  let cactusArmMaterial: THREE.MeshStandardMaterial | null = null
  let mountainGeometries: THREE.BufferGeometry[] = []
  let mountainMeshes: THREE.InstancedMesh[] = []
  let mountainMaterial: THREE.MeshStandardMaterial | null = null
  let pebbleGeometry: THREE.BufferGeometry | null = null
  let pebbleMaterial: THREE.MeshStandardMaterial | null = null
  let pebbleMesh: THREE.InstancedMesh | null = null
  let treeTrunkSourceMatrices: THREE.Matrix4[] = []
  let treeTierSourceMatrices: THREE.Matrix4[][] = []
  let treeCullEntries: TreeCullEntry[] = []
  let treeVisibilityState: boolean[] = []
  let treeVisibleIndices: number[] = []
  let cactusTrunkSourceMatrices: THREE.Matrix4[] = []
  let cactusPartSourceMatrices: THREE.Matrix4[][] = []
  let cactusCullEntries: CactusCullEntry[] = []
  let cactusVisibilityState: boolean[] = []
  let cactusVisibleIndices: number[] = []
  let visibleTreeCount = 0
  let visibleCactusCount = 0
  let mountainSourceMatricesByVariant: THREE.Matrix4[][] = []
  let mountainCullEntriesByVariant: MountainCullEntry[][] = []
  let mountainVisibilityStateByVariant: boolean[][] = []
  let mountainVisibleIndicesByVariant: number[][] = []
  let visibleMountainCount = 0
  let pebbleSourceMatrices: THREE.Matrix4[] = []
  let pebbleCullEntries: PebbleCullEntry[] = []
  let pebbleVisibilityState: boolean[] = []
  let pebbleVisibleIndices: number[] = []
  let visiblePebbleCount = 0
  let visibleLakeCount = 0
  let terrainContactSampler: TerrainContactSampler | null = null
  let localGroundingInfo: SnakeGroundingInfo | null = null
  const pelletBuckets: Array<PelletSpriteBucket | null> = new Array(PELLET_BUCKET_COUNT).fill(null)
  const pelletBucketCounts = new Array<number>(PELLET_BUCKET_COUNT).fill(0)
  const pelletBucketOffsets = new Array<number>(PELLET_BUCKET_COUNT).fill(0)
  const pelletBucketPositionArrays: Array<Float32Array | null> = new Array(PELLET_BUCKET_COUNT).fill(null)
  const pelletGroundCache = new Map<number, { x: number; y: number; z: number; radius: number }>()
  const pelletMotionStates = new Map<number, PelletMotionState>()
  const pelletIdsSeen = new Set<number>()
  let viewportWidth = 1
  let viewportHeight = 1
  let lastFrameTime = performance.now()

  const snakes = new Map<string, SnakeVisual>()
  const boostTrails = new Map<string, BoostTrailState[]>()
  const boostTrailPool: BoostTrailState[] = []
  const deathStates = new Map<string, DeathState>()
  const lastAliveStates = new Map<string, boolean>()
  const lastHeadPositions = new Map<string, THREE.Vector3>()
  const lastForwardDirections = new Map<string, THREE.Vector3>()
  const lastTailDirections = new Map<string, THREE.Vector3>()
  const lastTailContactNormals = new Map<string, THREE.Vector3>()
  const tailFrameStates = new Map<string, TailFrameState>()
  const lastSnakeStarts = new Map<string, number>()
  const tongueStates = new Map<string, TongueState>()
  const snakeSelfOverlapBucketPool = new Map<number, number[]>()
  const snakeSelfOverlapUsedBuckets: number[] = []
  let snakeSelfOverlapCellX = new Int16Array(0)
  let snakeSelfOverlapCellY = new Int16Array(0)
  let snakeSelfOverlapCellZ = new Int16Array(0)
  let snakeSelfOverlapIntensityA = new Float32Array(0)
  let snakeSelfOverlapIntensityB = new Float32Array(0)
  const tempVector = new THREE.Vector3()
  const tempVectorB = new THREE.Vector3()
  const tempVectorC = new THREE.Vector3()
  const tempVectorD = new THREE.Vector3()
  const tempVectorE = new THREE.Vector3()
  const tempVectorF = new THREE.Vector3()
  const tempVectorG = new THREE.Vector3()
  const tempVectorH = new THREE.Vector3()
  const pelletWobbleTangentTemp = new THREE.Vector3()
  const pelletWobbleBitangentTemp = new THREE.Vector3()
  const patchCenterQuat = new THREE.Quaternion()
  const lakeSampleTemp = new THREE.Vector3()
  const tempQuat = new THREE.Quaternion()
  const cameraLocalPosTemp = new THREE.Vector3()
  const cameraLocalDirTemp = new THREE.Vector3()
  const directionTemp = new THREE.Vector3()
  const rayDirTemp = new THREE.Vector3()
  const occlusionPointTemp = new THREE.Vector3()
  const snakeContactCenterTemp = new THREE.Vector3()
  const snakeContactTangentTemp = new THREE.Vector3()
  const snakeContactBitangentTemp = new THREE.Vector3()
  const snakeContactOffsetTemp = new THREE.Vector3()
  const snakeContactPointTemp = new THREE.Vector3()
  const snakeContactNormalTemp = new THREE.Vector3()
  const snakeContactFallbackTemp = new THREE.Vector3()
  const trailSamplePointTemp = new THREE.Vector3()
  const trailSlerpNormalTemp = new THREE.Vector3()
  const trailReprojectNormalTemp = new THREE.Vector3()
  const trailReprojectPointTemp = new THREE.Vector3()
  const trailTangentTemp = new THREE.Vector3()
  const trailSideTemp = new THREE.Vector3()
  const trailOffsetTemp = new THREE.Vector3()
  const tongueUp = new THREE.Vector3(0, 1, 0)
  const debugEnabled = import.meta.env.DEV || import.meta.env.VITE_E2E_DEBUG === '1'
  const perfDebugEnabled = (() => {
    if (typeof window === 'undefined') return false
    try {
      const url = new URL(window.location.href)
      return url.searchParams.get('rafPerf') === '1'
    } catch {
      return false
    }
  })()
  const renderPerfSlowFramesMax = 24
  const renderPerfInfo: RenderPerfInfo = {
    enabled: perfDebugEnabled,
    thresholdMs: 50,
    frameCount: 0,
    slowFrameCount: 0,
    maxTotalMs: 0,
    lastFrame: null,
    slowFrames: [],
  }
  let debugApi:
    | {
        getSnakeOpacity: (id: string) => number | null
        getSnakeHeadPosition: (id: string) => { x: number; y: number; z: number } | null
        isSnakeVisible: (id: string) => boolean | null
        getRendererInfo: () => {
          requestedBackend: RendererPreference
          activeBackend: RendererBackend
          fallbackReason: string | null
          webglShaderHooksEnabled: boolean
        }
        getRenderPerfInfo: () => RenderPerfInfo
        getTerrainPatchInfo: () => {
          totalPatches: number
          visiblePatches: number
          patchBands: number
          patchSlices: number
          dynamicRebuilds: boolean
          wireframeEnabled: boolean
        }
        getEnvironmentCullInfo: () => {
          totalTrees: number
          visibleTrees: number
          totalCactuses: number
          visibleCactuses: number
          totalMountains: number
          visibleMountains: number
          totalPebbles: number
          visiblePebbles: number
          totalLakes: number
          visibleLakes: number
        }
        getSnakeGroundingInfo: () => SnakeGroundingInfo | null
        getSnakeIds: () => string[]
        getBoostTrailInfo: (id: string) => {
          sampleCount: number
          boosting: boolean
          retiring: boolean
          oldestAgeMs: number
          newestAgeMs: number
        } | null
        getBoostDraftInfo: (id: string) => {
          visible: boolean
          opacity: number
          planeCount: number
        } | null
        getDayNightInfo: () => {
          mode: DayNightDebugMode
          phase: number
          dayFactor: number
          cycleMs: number
          sourceNowMs: number | null
        }
      }
    | null = null

  const attachDebugApi = () => {
    if ((!debugEnabled && !perfDebugEnabled) || typeof window === 'undefined') return
    const debugWindow = window as Window & {
      __SNAKE_DEBUG__?: {
        getSnakeOpacity: (id: string) => number | null
        getSnakeHeadPosition: (id: string) => { x: number; y: number; z: number } | null
        isSnakeVisible: (id: string) => boolean | null
        getRendererInfo: () => {
          requestedBackend: RendererPreference
          activeBackend: RendererBackend
          fallbackReason: string | null
          webglShaderHooksEnabled: boolean
        }
        getTerrainPatchInfo: () => {
          totalPatches: number
          visiblePatches: number
          patchBands: number
          patchSlices: number
          dynamicRebuilds: boolean
          wireframeEnabled: boolean
        }
        getEnvironmentCullInfo: () => {
          totalTrees: number
          visibleTrees: number
          totalCactuses: number
          visibleCactuses: number
          totalMountains: number
          visibleMountains: number
          totalPebbles: number
          visiblePebbles: number
          totalLakes: number
          visibleLakes: number
        }
        getSnakeGroundingInfo: () => SnakeGroundingInfo | null
        getSnakeIds: () => string[]
        getBoostTrailInfo: (id: string) => {
          sampleCount: number
          boosting: boolean
          retiring: boolean
          oldestAgeMs: number
          newestAgeMs: number
        } | null
        getBoostDraftInfo: (id: string) => {
          visible: boolean
          opacity: number
          planeCount: number
        } | null
        getDayNightInfo: () => {
          mode: DayNightDebugMode
          phase: number
          dayFactor: number
          cycleMs: number
          sourceNowMs: number | null
        }
      }
    }
    debugApi = {
      getSnakeOpacity: (id: string) => {
        const visual = snakes.get(id)
        return visual ? visual.tube.material.opacity : null
      },
      getSnakeHeadPosition: (id: string) => {
        const visual = snakes.get(id)
        if (!visual) return null
        const pos = visual.head.position
        return { x: pos.x, y: pos.y, z: pos.z }
      },
      isSnakeVisible: (id: string) => {
        const visual = snakes.get(id)
        return visual ? visual.group.visible : null
      },
      getRendererInfo: () => ({
        requestedBackend,
        activeBackend,
        fallbackReason,
        webglShaderHooksEnabled,
      }),
      getRenderPerfInfo: () => ({
        ...renderPerfInfo,
        lastFrame: renderPerfInfo.lastFrame ? { ...renderPerfInfo.lastFrame } : null,
        slowFrames: renderPerfInfo.slowFrames.map((frame) => ({ ...frame })),
      }),
      getTerrainPatchInfo: () => ({
        totalPatches: planetPatches.length,
        visiblePatches: visiblePlanetPatchCount,
        patchBands: PLANET_PATCH_BANDS,
        patchSlices: PLANET_PATCH_SLICES,
        dynamicRebuilds: false,
        wireframeEnabled: terrainTessellationDebugEnabled,
      }),
      getEnvironmentCullInfo: () => ({
        totalTrees: treeCullEntries.length,
        visibleTrees: visibleTreeCount,
        totalCactuses: cactusTrunkSourceMatrices.length,
        visibleCactuses: visibleCactusCount,
        totalMountains: mountains.length,
        visibleMountains: visibleMountainCount,
        totalPebbles: pebbleCullEntries.length,
        visiblePebbles: visiblePebbleCount,
        totalLakes: lakes.length,
        visibleLakes: visibleLakeCount,
      }),
      getSnakeGroundingInfo: () =>
        localGroundingInfo
          ? {
              minClearance: localGroundingInfo.minClearance,
              maxPenetration: localGroundingInfo.maxPenetration,
              maxAppliedLift: localGroundingInfo.maxAppliedLift,
              sampleCount: localGroundingInfo.sampleCount,
            }
          : null,
      getSnakeIds: () => Array.from(snakes.keys()),
      getBoostTrailInfo: (id: string) => {
        const trails = boostTrails.get(id)
        if (!trails || trails.length === 0) return null
        const nowMs = performance.now()
        let sampleCount = 0
        let boosting = false
        let retiring = false
        let oldestCreatedAt = Number.POSITIVE_INFINITY
        let newestCreatedAt = 0
        for (const trail of trails) {
          const visibleRatio = trail.retiring ? Math.max(0, 1 - trail.retireCut) : 1
          sampleCount += Math.ceil(trail.samples.length * visibleRatio)
          boosting = boosting || trail.boosting
          retiring = retiring || trail.retiring
          const oldest = trail.samples[0]
          const newest = trail.samples[trail.samples.length - 1]
          if (oldest && oldest.createdAt < oldestCreatedAt) {
            oldestCreatedAt = oldest.createdAt
          }
          if (newest && newest.createdAt > newestCreatedAt) {
            newestCreatedAt = newest.createdAt
          }
        }
        const hasSamples = sampleCount > 0
        return {
          sampleCount,
          boosting,
          retiring,
          oldestAgeMs: hasSamples ? Math.max(0, nowMs - oldestCreatedAt) : 0,
          newestAgeMs: hasSamples ? Math.max(0, nowMs - newestCreatedAt) : 0,
        }
      },
      getBoostDraftInfo: (id: string) => {
        const visual = snakes.get(id)
        if (!visual) return null
        const visible =
          visual.boostDraft.visible &&
          visual.boostDraftMaterial.opacity > BOOST_DRAFT_MIN_ACTIVE_OPACITY
        const opacity = visual.boostDraftMaterial.opacity
        return {
          visible,
          opacity,
          planeCount: 1,
        }
      },
      getDayNightInfo: () => ({
        mode: dayNightDebugMode,
        phase: dayNightPhase,
        dayFactor: dayNightFactor,
        cycleMs: dayNightCycleMs,
        sourceNowMs: dayNightSourceNowMs,
      }),
    }
    debugWindow.__SNAKE_DEBUG__ = debugApi
  }

  attachDebugApi()

  const resetSnakeTransientState = (id: string) => {
    lastHeadPositions.delete(id)
    lastForwardDirections.delete(id)
    lastTailDirections.delete(id)
    lastTailContactNormals.delete(id)
    tailFrameStates.delete(id)
    tongueStates.delete(id)
  }

  const disposeMaterial = (material: THREE.Material | THREE.Material[] | null) => {
    if (!material) return
    if (Array.isArray(material)) {
      for (const mat of material) {
        mat.dispose()
      }
    } else {
      material.dispose()
    }
  }

  const disposeEnvironment = () => {
    visiblePlanetPatchCount = 0
    terrainContactSampler = null
    pelletGroundCache.clear()
    pelletMotionStates.clear()
    if (planetMesh) {
      world.remove(planetMesh)
      planetMesh.geometry.dispose()
      disposeMaterial(planetMesh.material)
      planetMesh = null
    }
    for (const patch of planetPatches) {
      world.remove(patch.mesh)
      patch.mesh.geometry.dispose()
    }
    planetPatches = []
    if (planetPatchMaterial) {
      planetPatchMaterial.dispose()
      planetPatchMaterial = null
    }
    if (gridMesh) {
      world.remove(gridMesh)
      gridMesh.geometry.dispose()
      disposeMaterial(gridMesh.material)
      gridMesh = null
    }
    if (shorelineLineMesh) {
      world.remove(shorelineLineMesh)
      shorelineLineMesh.geometry.dispose()
      disposeMaterial(shorelineLineMesh.material)
      shorelineLineMesh = null
    }
    if (shorelineFillMesh) {
      world.remove(shorelineFillMesh)
      shorelineFillMesh.geometry.dispose()
      disposeMaterial(shorelineFillMesh.material)
      shorelineFillMesh = null
    }
    for (const mesh of lakeMeshes) {
      world.remove(mesh)
    }
    for (const material of lakeMaterials) {
      material.dispose()
    }
    lakeMeshes = []
    lakeMaterials = []
    if (lakeSurfaceGeometry) {
      lakeSurfaceGeometry.dispose()
      lakeSurfaceGeometry = null
    }
    if (mountainDebugGroup) {
      world.remove(mountainDebugGroup)
      mountainDebugGroup.traverse((child) => {
        if (child instanceof THREE.LineLoop) {
          child.geometry.dispose()
        }
      })
      mountainDebugGroup = null
    }
    if (mountainDebugMaterial) {
      mountainDebugMaterial.dispose()
      mountainDebugMaterial = null
    }
    if (lakeDebugGroup) {
      world.remove(lakeDebugGroup)
      lakeDebugGroup.traverse((child) => {
        if (child instanceof THREE.LineLoop) {
          child.geometry.dispose()
        }
      })
      lakeDebugGroup = null
    }
    if (lakeDebugMaterial) {
      lakeDebugMaterial.dispose()
      lakeDebugMaterial = null
    }
    if (treeDebugGroup) {
      world.remove(treeDebugGroup)
      treeDebugGroup.traverse((child) => {
        if (child instanceof THREE.LineLoop) {
          child.geometry.dispose()
        }
      })
      treeDebugGroup = null
    }
    if (treeDebugMaterial) {
      treeDebugMaterial.dispose()
      treeDebugMaterial = null
    }

    for (const mesh of treeTierMeshes) {
      environmentGroup.remove(mesh)
    }
    if (treeTrunkMesh) {
      environmentGroup.remove(treeTrunkMesh)
    }
    for (const mesh of cactusPartMeshes) {
      environmentGroup.remove(mesh)
    }
    if (cactusTrunkMesh) {
      environmentGroup.remove(cactusTrunkMesh)
    }
    for (const mesh of mountainMeshes) {
      environmentGroup.remove(mesh)
    }
    if (pebbleMesh) {
      environmentGroup.remove(pebbleMesh)
    }

    for (const geometry of treeTierGeometries) {
      geometry.dispose()
    }
    treeTierGeometries = []
    treeTierMeshes = []
    if (treeTrunkGeometry) {
      treeTrunkGeometry.dispose()
      treeTrunkGeometry = null
    }
    if (treeLeafMaterial) {
      treeLeafMaterial.dispose()
      treeLeafMaterial = null
    }
    if (treeTrunkMaterial) {
      treeTrunkMaterial.dispose()
      treeTrunkMaterial = null
    }
    for (const geometry of cactusPartGeometries) {
      geometry.dispose()
    }
    cactusPartGeometries = []
    cactusPartMeshes = []
    if (cactusTrunkGeometry) {
      cactusTrunkGeometry.dispose()
      cactusTrunkGeometry = null
    }
    if (cactusMaterial) {
      cactusMaterial.dispose()
      cactusMaterial = null
    }
    if (cactusArmMaterial) {
      cactusArmMaterial.dispose()
      cactusArmMaterial = null
    }

    for (const geometry of mountainGeometries) {
      geometry.dispose()
    }
    mountainGeometries = []
    mountainMeshes = []
    if (mountainMaterial) {
      mountainMaterial.dispose()
      mountainMaterial = null
    }

    if (pebbleGeometry) {
      pebbleGeometry.dispose()
      pebbleGeometry = null
    }
    if (pebbleMaterial) {
      pebbleMaterial.dispose()
      pebbleMaterial = null
    }
    pebbleMesh = null
    treeTrunkSourceMatrices = []
    treeTierSourceMatrices = []
    cactusTrunkSourceMatrices = []
    cactusPartSourceMatrices = []
    treeCullEntries = []
    treeVisibilityState = []
    treeVisibleIndices = []
    cactusCullEntries = []
    cactusVisibilityState = []
    cactusVisibleIndices = []
    visibleTreeCount = 0
    visibleCactusCount = 0
    mountainSourceMatricesByVariant = []
    mountainCullEntriesByVariant = []
    mountainVisibilityStateByVariant = []
    mountainVisibleIndicesByVariant = []
    visibleMountainCount = 0
    pebbleSourceMatrices = []
    pebbleCullEntries = []
    pebbleVisibilityState = []
    pebbleVisibleIndices = []
    visiblePebbleCount = 0
    visibleLakeCount = 0

    lakes = []
    trees = []
    mountains = []
  }

  const rebuildMountainDebug = () => {
    if (mountainDebugGroup) {
      world.remove(mountainDebugGroup)
      mountainDebugGroup.traverse((child) => {
        if (child instanceof THREE.LineLoop) {
          child.geometry.dispose()
        }
      })
      mountainDebugGroup = null
    }
    if (mountainDebugMaterial) {
      mountainDebugMaterial.dispose()
      mountainDebugMaterial = null
    }
    if (mountains.length === 0) return

    const material = new THREE.LineBasicMaterial({
      color: '#f97316',
      transparent: true,
      opacity: 0.75,
    })
    material.depthWrite = false
    material.depthTest = false
    mountainDebugMaterial = material
    const group = new THREE.Group()
    const offset = 0.01

    for (const mountain of mountains) {
      const outline = mountain.outline
      if (outline.length < 3) continue
      const positions: number[] = []
      for (let i = 0; i < outline.length; i += 1) {
        const theta = (i / outline.length) * Math.PI * 2
        const dir = tempVector
          .copy(mountain.tangent)
          .multiplyScalar(Math.cos(theta))
          .addScaledVector(mountain.bitangent, Math.sin(theta))
          .normalize()
        const angle = outline[i]
        const point = tempVectorB
          .copy(mountain.normal)
          .multiplyScalar(Math.cos(angle))
          .addScaledVector(dir, Math.sin(angle))
          .normalize()
          .multiplyScalar(PLANET_RADIUS + offset)
        positions.push(point.x, point.y, point.z)
      }
      const geometry = new THREE.BufferGeometry()
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
      geometry.computeBoundingSphere()
      const line = new THREE.LineLoop(geometry, material)
      line.renderOrder = 4
      group.add(line)
    }

    group.visible = mountainDebugEnabled
    world.add(group)
    mountainDebugGroup = group
  }

  const computeLakeEdgeRadius = (lake: Lake, theta: number) => {
    let angle = lake.radius
    for (let i = 0; i < 2; i += 1) {
      const sinAngle = Math.sin(angle)
      const x = Math.cos(theta) * sinAngle
      const y = Math.sin(theta) * sinAngle
      const warp =
        Math.sin((x + y) * lake.noiseFrequencyC + lake.noisePhaseC) * lake.warpAmplitude
      const u = x * lake.noiseFrequency + lake.noisePhase + warp
      const v = y * lake.noiseFrequencyB + lake.noisePhaseB - warp
      const w = (x - y) * lake.noiseFrequencyC + lake.noisePhaseC * 0.7
      const noise =
        Math.sin(u) +
        Math.sin(v) +
        0.6 * Math.sin(2 * u + v * 0.6) +
        0.45 * Math.sin(2.3 * v - 0.7 * u) +
        0.35 * Math.sin(w)
      const noiseNormalized = noise / 3.15
      angle = clamp(
        lake.radius * (1 + lake.noiseAmplitude * noiseNormalized),
        lake.radius * 0.65,
        lake.radius * 1.35,
      )
    }
    return angle
  }

  const rebuildLakeDebug = () => {
    if (lakeDebugGroup) {
      world.remove(lakeDebugGroup)
      lakeDebugGroup.traverse((child) => {
        if (child instanceof THREE.LineLoop) {
          child.geometry.dispose()
        }
      })
      lakeDebugGroup = null
    }
    if (lakeDebugMaterial) {
      lakeDebugMaterial.dispose()
      lakeDebugMaterial = null
    }
    if (lakes.length === 0) return

    const material = new THREE.LineBasicMaterial({
      color: '#38bdf8',
      transparent: true,
      opacity: 0.75,
    })
    material.depthWrite = false
    material.depthTest = false
    lakeDebugMaterial = material

    const group = new THREE.Group()
    const dir = new THREE.Vector3()
    const point = new THREE.Vector3()
    for (const lake of lakes) {
      const positions: number[] = []
      for (let i = 0; i < LAKE_DEBUG_SEGMENTS; i += 1) {
        const theta = (i / LAKE_DEBUG_SEGMENTS) * Math.PI * 2
        const angle = computeLakeEdgeRadius(lake, theta)
        dir
          .copy(lake.tangent)
          .multiplyScalar(Math.cos(theta))
          .addScaledVector(lake.bitangent, Math.sin(theta))
          .normalize()
        point
          .copy(lake.center)
          .multiplyScalar(Math.cos(angle))
          .addScaledVector(dir, Math.sin(angle))
          .normalize()
          .multiplyScalar(PLANET_RADIUS + LAKE_DEBUG_OFFSET)
        positions.push(point.x, point.y, point.z)
      }
      const geometry = new THREE.BufferGeometry()
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
      geometry.computeBoundingSphere()
      const line = new THREE.LineLoop(geometry, material)
      line.renderOrder = 4
      group.add(line)
    }

    group.visible = lakeDebugEnabled
    world.add(group)
    lakeDebugGroup = group
  }

  const rebuildTreeDebug = () => {
    if (treeDebugGroup) {
      world.remove(treeDebugGroup)
      treeDebugGroup.traverse((child) => {
        if (child instanceof THREE.LineLoop) {
          child.geometry.dispose()
        }
      })
      treeDebugGroup = null
    }
    if (treeDebugMaterial) {
      treeDebugMaterial.dispose()
      treeDebugMaterial = null
    }
    if (trees.length === 0) return

    const material = new THREE.LineBasicMaterial({
      color: '#facc15',
      transparent: true,
      opacity: 0.75,
    })
    material.depthWrite = false
    material.depthTest = false
    treeDebugMaterial = material

    const group = new THREE.Group()
    const tangent = new THREE.Vector3()
    const bitangent = new THREE.Vector3()
    const dir = new THREE.Vector3()
    const point = new THREE.Vector3()

    for (const tree of trees) {
      if (tree.widthScale >= 0) continue
      const angle = (TREE_TRUNK_RADIUS * Math.abs(tree.widthScale)) / PLANET_RADIUS
      if (!Number.isFinite(angle) || angle <= 0) continue
      buildTangentBasis(tree.normal, tangent, bitangent)
      const positions: number[] = []
      for (let i = 0; i < TREE_DEBUG_SEGMENTS; i += 1) {
        const theta = (i / TREE_DEBUG_SEGMENTS) * Math.PI * 2
        dir
          .copy(tangent)
          .multiplyScalar(Math.cos(theta))
          .addScaledVector(bitangent, Math.sin(theta))
          .normalize()
        point
          .copy(tree.normal)
          .multiplyScalar(Math.cos(angle))
          .addScaledVector(dir, Math.sin(angle))
          .normalize()
          .multiplyScalar(PLANET_RADIUS + TREE_DEBUG_OFFSET)
        positions.push(point.x, point.y, point.z)
      }
      const geometry = new THREE.BufferGeometry()
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
      geometry.computeBoundingSphere()
      const line = new THREE.LineLoop(geometry, material)
      line.renderOrder = 4
      group.add(line)
    }

    group.visible = treeDebugEnabled
    world.add(group)
    treeDebugGroup = group
  }

  const arraysEqual = (a: number[], b: number[]) => {
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i += 1) {
      if (a[i] !== b[i]) return false
    }
    return true
  }

  const isAngularVisible = (
    directionDot: number,
    viewAngle: number,
    angularRadius: number,
    wasVisible: boolean,
    margin: number,
    hideExtra: number,
  ) => {
    const limit = Math.min(
      Math.PI - 1e-4,
      viewAngle + angularRadius + margin + (wasVisible ? hideExtra : 0),
    )
    return directionDot >= Math.cos(limit)
  }

  const isPelletNearSide = (
    pellet: PelletSnapshot,
    cameraLocalDir: THREE.Vector3,
    minDirectionDot: number,
  ) => {
    const lengthSq = pellet.x * pellet.x + pellet.y * pellet.y + pellet.z * pellet.z
    if (!Number.isFinite(lengthSq) || lengthSq <= 1e-8) return true
    const invLength = 1 / Math.sqrt(lengthSq)
    const directionDot =
      pellet.x * invLength * cameraLocalDir.x +
      pellet.y * invLength * cameraLocalDir.y +
      pellet.z * invLength * cameraLocalDir.z
    return directionDot >= minDirectionDot
  }

  const isOccludedByPlanet = (point: THREE.Vector3, cameraLocalPos: THREE.Vector3) => {
    rayDirTemp.copy(point).sub(cameraLocalPos)
    const segmentLength = rayDirTemp.length()
    if (!Number.isFinite(segmentLength) || segmentLength <= 1e-6) return false
    rayDirTemp.multiplyScalar(1 / segmentLength)

    const tca = -cameraLocalPos.dot(rayDirTemp)
    const occluderRadius = PLANET_RADIUS - 1e-4
    const d2 = cameraLocalPos.lengthSq() - tca * tca
    const radiusSq = occluderRadius * occluderRadius
    if (d2 >= radiusSq) return false

    const thc = Math.sqrt(radiusSq - d2)
    const t0 = tca - thc
    const t1 = tca + thc
    const maxT = segmentLength - 1e-4
    return (t0 > 1e-4 && t0 < maxT) || (t1 > 1e-4 && t1 < maxT)
  }

  const isPointVisible = (
    point: THREE.Vector3,
    pointRadius: number,
    cameraLocalPos: THREE.Vector3,
    cameraLocalDir: THREE.Vector3,
    viewAngle: number,
    wasVisible: boolean,
    margin = PLANET_OBJECT_VIEW_MARGIN,
    hideExtra = PLANET_OBJECT_HIDE_EXTRA,
    occlusionLead = 1,
  ) => {
    const radiusFromCenter = point.length()
    if (!Number.isFinite(radiusFromCenter) || radiusFromCenter <= 1e-6) return false
    directionTemp.copy(point).multiplyScalar(1 / radiusFromCenter)
    const directionDot = directionTemp.dot(cameraLocalDir)
    const angularRadius =
      pointRadius > 0 ? Math.asin(clamp(pointRadius / radiusFromCenter, 0, 1)) : 0
    if (
      !isAngularVisible(
        directionDot,
        viewAngle,
        angularRadius,
        wasVisible,
        margin,
        hideExtra,
      )
    ) {
      return false
    }
    if (pointRadius > 1e-6 && occlusionLead > 0) {
      occlusionPointTemp
        .copy(directionTemp)
        .multiplyScalar(pointRadius * occlusionLead)
        .add(point)
      return !isOccludedByPlanet(occlusionPointTemp, cameraLocalPos)
    }
    return !isOccludedByPlanet(point, cameraLocalPos)
  }

  const buildPlanetPatchAtlas = (
    planetGeometry: THREE.BufferGeometry,
    material: THREE.MeshStandardMaterial,
  ) => {
    const positionAttr = planetGeometry.getAttribute('position')
    if (!(positionAttr instanceof THREE.BufferAttribute)) return
    const colorRaw = planetGeometry.getAttribute('color')
    const colorAttr = colorRaw instanceof THREE.BufferAttribute ? colorRaw : null
    const normalRaw = planetGeometry.getAttribute('normal')
    const normalAttr = normalRaw instanceof THREE.BufferAttribute ? normalRaw : null
    const indexAttr = planetGeometry.getIndex()
    const patchCount = PLANET_PATCH_BANDS * PLANET_PATCH_SLICES
    const buckets = Array.from({ length: patchCount }, () => ({
      positions: [] as number[],
      normals: [] as number[],
      colors: [] as number[],
    }))
    const triCount = indexAttr
      ? Math.floor(indexAttr.count / 3)
      : Math.floor(positionAttr.count / 3)
    const vertexA = new THREE.Vector3()
    const vertexB = new THREE.Vector3()
    const vertexC = new THREE.Vector3()
    const centroid = new THREE.Vector3()
    const normal = new THREE.Vector3()

    const readVertex = (index: number, out: THREE.Vector3) => {
      out.set(positionAttr.getX(index), positionAttr.getY(index), positionAttr.getZ(index))
    }
    const readNormal = (index: number, out: THREE.Vector3) => {
      if (normalAttr) {
        out.set(normalAttr.getX(index), normalAttr.getY(index), normalAttr.getZ(index))
      } else {
        out.set(positionAttr.getX(index), positionAttr.getY(index), positionAttr.getZ(index))
      }
      if (out.lengthSq() > 1e-8) {
        out.normalize()
      } else {
        out.set(0, 1, 0)
      }
    }
    const pushColor = (bucket: { colors: number[] }, index: number) => {
      if (!colorAttr) return
      bucket.colors.push(
        colorAttr.getX(index),
        colorAttr.getY(index),
        colorAttr.getZ(index),
      )
    }

    for (let tri = 0; tri < triCount; tri += 1) {
      const i0 = indexAttr ? indexAttr.getX(tri * 3) : tri * 3
      const i1 = indexAttr ? indexAttr.getX(tri * 3 + 1) : tri * 3 + 1
      const i2 = indexAttr ? indexAttr.getX(tri * 3 + 2) : tri * 3 + 2
      readVertex(i0, vertexA)
      readVertex(i1, vertexB)
      readVertex(i2, vertexC)
      centroid.copy(vertexA).add(vertexB).add(vertexC).multiplyScalar(1 / 3)
      if (centroid.lengthSq() <= 1e-10) continue
      centroid.normalize()
      const latitude = Math.asin(clamp(centroid.y, -1, 1))
      const longitude = Math.atan2(centroid.z, centroid.x)
      const band = clamp(
        Math.floor(((latitude + Math.PI * 0.5) / Math.PI) * PLANET_PATCH_BANDS),
        0,
        PLANET_PATCH_BANDS - 1,
      )
      const slice = clamp(
        Math.floor(((longitude + Math.PI) / (Math.PI * 2)) * PLANET_PATCH_SLICES),
        0,
        PLANET_PATCH_SLICES - 1,
      )
      const bucket = buckets[band * PLANET_PATCH_SLICES + slice]
      bucket.positions.push(
        vertexA.x,
        vertexA.y,
        vertexA.z,
        vertexB.x,
        vertexB.y,
        vertexB.z,
        vertexC.x,
        vertexC.y,
        vertexC.z,
      )
      readNormal(i0, normal)
      bucket.normals.push(normal.x, normal.y, normal.z)
      readNormal(i1, normal)
      bucket.normals.push(normal.x, normal.y, normal.z)
      readNormal(i2, normal)
      bucket.normals.push(normal.x, normal.y, normal.z)
      pushColor(bucket, i0)
      pushColor(bucket, i1)
      pushColor(bucket, i2)
    }

    for (const bucket of buckets) {
      if (bucket.positions.length < 9) continue
      const geometry = new THREE.BufferGeometry()
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(bucket.positions, 3))
      if (bucket.normals.length === bucket.positions.length) {
        geometry.setAttribute('normal', new THREE.Float32BufferAttribute(bucket.normals, 3))
      } else {
        geometry.computeVertexNormals()
      }
      if (bucket.colors.length === bucket.positions.length) {
        geometry.setAttribute('color', new THREE.Float32BufferAttribute(bucket.colors, 3))
      }
      geometry.computeBoundingSphere()

      const center = new THREE.Vector3()
      for (let i = 0; i < bucket.positions.length; i += 3) {
        directionTemp
          .set(bucket.positions[i], bucket.positions[i + 1], bucket.positions[i + 2])
          .normalize()
        center.add(directionTemp)
      }
      if (center.lengthSq() <= 1e-10) {
        geometry.dispose()
        continue
      }
      center.normalize()
      let angularExtent = 0
      for (let i = 0; i < bucket.positions.length; i += 3) {
        directionTemp
          .set(bucket.positions[i], bucket.positions[i + 1], bucket.positions[i + 2])
          .normalize()
        const angle = Math.acos(clamp(directionTemp.dot(center), -1, 1))
        if (angle > angularExtent) angularExtent = angle
      }

      const mesh = new THREE.Mesh(geometry, material)
      mesh.visible = false
      world.add(mesh)
      planetPatches.push({ mesh, center, angularExtent, visible: false })
    }
    visiblePlanetPatchCount = 0
  }

  const updatePlanetPatchVisibility = (cameraLocalDir: THREE.Vector3, viewAngle: number) => {
    let visibleCount = 0
    for (const patch of planetPatches) {
      const directionDot = patch.center.dot(cameraLocalDir)
      const visible = isAngularVisible(
        directionDot,
        viewAngle,
        patch.angularExtent,
        patch.visible,
        PLANET_PATCH_VIEW_MARGIN,
        PLANET_PATCH_HIDE_EXTRA,
      )
      patch.visible = visible
      patch.mesh.visible = visible
      if (visible) visibleCount += 1
    }
    visiblePlanetPatchCount = visibleCount
  }

  const updateLakeVisibility = (cameraLocalDir: THREE.Vector3, viewAngle: number) => {
    if (lakeMeshes.length === 0 || lakes.length === 0) {
      visibleLakeCount = 0
      return
    }

    if (webglShaderHooksEnabled) {
      let visible = 0
      for (let i = 0; i < lakeMeshes.length; i += 1) {
        const lake = lakes[i]
        const mesh = lakeMeshes[i]
        if (!lake || !mesh) continue
        const effectiveRadius = lake.radius + LAKE_VISIBILITY_EXTRA_RADIUS
        const inView = isAngularVisible(
          lake.center.dot(cameraLocalDir),
          viewAngle,
          effectiveRadius,
          mesh.visible,
          LAKE_VISIBILITY_MARGIN,
          LAKE_VISIBILITY_HIDE_EXTRA,
        )
        const visibleNow = inView
        mesh.visible = visibleNow
        if (visibleNow) visible += 1
      }
      visibleLakeCount = visible
      return
    }

    let anyVisible = false
    let visible = 0
    for (const lake of lakes) {
      const effectiveRadius = lake.radius + LAKE_VISIBILITY_EXTRA_RADIUS
      const visibleNow =
        isAngularVisible(
          lake.center.dot(cameraLocalDir),
          viewAngle,
          effectiveRadius,
          anyVisible,
          LAKE_VISIBILITY_MARGIN,
          LAKE_VISIBILITY_HIDE_EXTRA,
        )
      if (visibleNow) {
        anyVisible = true
        visible += 1
      }
    }
    for (const mesh of lakeMeshes) {
      mesh.visible = anyVisible
    }
    visibleLakeCount = visible
  }

  const updateEnvironmentVisibility = (
    cameraLocalPos: THREE.Vector3,
    cameraLocalDir: THREE.Vector3,
    viewAngle: number,
  ) => {
    const edgePreload = smoothstep(
      PLANET_EDGE_PRELOAD_START_ANGLE,
      PLANET_EDGE_PRELOAD_END_ANGLE,
      viewAngle,
    )
    const treeMargin = PLANET_OBJECT_VIEW_MARGIN + TREE_EDGE_PRELOAD_MARGIN * edgePreload
    const treeHideExtra = PLANET_OBJECT_HIDE_EXTRA + TREE_EDGE_PRELOAD_HIDE_EXTRA * edgePreload
    const treeOcclusionLead = 1 + TREE_EDGE_PRELOAD_OCCLUSION_LEAD * edgePreload
    const cactusMargin = treeMargin
    const cactusHideExtra = treeHideExtra
    const cactusOcclusionLead = treeOcclusionLead
    const rockMargin = PLANET_OBJECT_VIEW_MARGIN + ROCK_EDGE_PRELOAD_MARGIN * edgePreload
    const rockHideExtra = PLANET_OBJECT_HIDE_EXTRA + ROCK_EDGE_PRELOAD_HIDE_EXTRA * edgePreload
    const rockOcclusionLead = 1 + ROCK_EDGE_PRELOAD_OCCLUSION_LEAD * edgePreload
    const pebbleMargin = PLANET_OBJECT_VIEW_MARGIN + PEBBLE_EDGE_PRELOAD_MARGIN * edgePreload
    const pebbleHideExtra = PLANET_OBJECT_HIDE_EXTRA + PEBBLE_EDGE_PRELOAD_HIDE_EXTRA * edgePreload
    const pebbleOcclusionLead = 1 + PEBBLE_EDGE_PRELOAD_OCCLUSION_LEAD * edgePreload

    const nextTreeVisible: number[] = []
    for (let i = 0; i < treeCullEntries.length; i += 1) {
      const entry = treeCullEntries[i]
      const wasVisible = treeVisibilityState[i] ?? false
      const visible =
        isPointVisible(
          entry.basePoint,
          entry.baseRadius,
          cameraLocalPos,
          cameraLocalDir,
          viewAngle,
          wasVisible,
          treeMargin,
          treeHideExtra,
          treeOcclusionLead,
        ) ||
        isPointVisible(
          entry.topPoint,
          entry.topRadius,
          cameraLocalPos,
          cameraLocalDir,
          viewAngle,
          wasVisible,
          treeMargin,
          treeHideExtra,
          treeOcclusionLead,
        )
      treeVisibilityState[i] = visible
      if (visible) nextTreeVisible.push(i)
    }
    if (!arraysEqual(nextTreeVisible, treeVisibleIndices)) {
      treeVisibleIndices = nextTreeVisible
      if (treeTrunkMesh) {
        for (let write = 0; write < treeVisibleIndices.length; write += 1) {
          const source = treeTrunkSourceMatrices[treeVisibleIndices[write]]
          if (!source) continue
          treeTrunkMesh.setMatrixAt(write, source)
        }
        treeTrunkMesh.count = treeVisibleIndices.length
        treeTrunkMesh.instanceMatrix.needsUpdate = true
      }
      for (let tier = 0; tier < treeTierMeshes.length; tier += 1) {
        const mesh = treeTierMeshes[tier]
        const sourceMatrices = treeTierSourceMatrices[tier]
        if (!mesh || !sourceMatrices) continue
        for (let write = 0; write < treeVisibleIndices.length; write += 1) {
          const source = sourceMatrices[treeVisibleIndices[write]]
          if (!source) continue
          mesh.setMatrixAt(write, source)
        }
        mesh.count = treeVisibleIndices.length
        mesh.instanceMatrix.needsUpdate = true
      }
    }
    visibleTreeCount = treeVisibleIndices.length

    const nextCactusVisible: number[] = []
    for (let i = 0; i < cactusCullEntries.length; i += 1) {
      const entry = cactusCullEntries[i]
      const wasVisible = cactusVisibilityState[i] ?? false
      const visible =
        isPointVisible(
          entry.basePoint,
          entry.baseRadius,
          cameraLocalPos,
          cameraLocalDir,
          viewAngle,
          wasVisible,
          cactusMargin,
          cactusHideExtra,
          cactusOcclusionLead,
        ) ||
        isPointVisible(
          entry.topPoint,
          entry.topRadius,
          cameraLocalPos,
          cameraLocalDir,
          viewAngle,
          wasVisible,
          cactusMargin,
          cactusHideExtra,
          cactusOcclusionLead,
        ) ||
        isPointVisible(
          entry.leftArmTipPoint,
          entry.armRadius,
          cameraLocalPos,
          cameraLocalDir,
          viewAngle,
          wasVisible,
          cactusMargin,
          cactusHideExtra,
          cactusOcclusionLead,
        ) ||
        isPointVisible(
          entry.rightArmTipPoint,
          entry.armRadius,
          cameraLocalPos,
          cameraLocalDir,
          viewAngle,
          wasVisible,
          cactusMargin,
          cactusHideExtra,
          cactusOcclusionLead,
        )
      cactusVisibilityState[i] = visible
      if (visible) nextCactusVisible.push(i)
    }
    if (!arraysEqual(nextCactusVisible, cactusVisibleIndices)) {
      cactusVisibleIndices = nextCactusVisible
      if (cactusTrunkMesh) {
        for (let write = 0; write < cactusVisibleIndices.length; write += 1) {
          const source = cactusTrunkSourceMatrices[cactusVisibleIndices[write]]
          if (!source) continue
          cactusTrunkMesh.setMatrixAt(write, source)
        }
        cactusTrunkMesh.count = cactusVisibleIndices.length
        cactusTrunkMesh.instanceMatrix.needsUpdate = true
      }
      for (let p = 0; p < cactusPartMeshes.length; p += 1) {
        const mesh = cactusPartMeshes[p]
        const sourceMatrices = cactusPartSourceMatrices[p]
        if (!mesh || !sourceMatrices) continue
        for (let write = 0; write < cactusVisibleIndices.length; write += 1) {
          const source = sourceMatrices[cactusVisibleIndices[write]]
          if (!source) continue
          mesh.setMatrixAt(write, source)
        }
        mesh.count = cactusVisibleIndices.length
        mesh.instanceMatrix.needsUpdate = true
      }
    }
    visibleCactusCount = cactusVisibleIndices.length

    let mountainVisibleTotal = 0
    for (let variant = 0; variant < mountainMeshes.length; variant += 1) {
      const entries = mountainCullEntriesByVariant[variant] ?? []
      const state = mountainVisibilityStateByVariant[variant] ?? []
      const nextVariantVisible: number[] = []
      for (let i = 0; i < entries.length; i += 1) {
        const entry = entries[i]
        const wasVisible = state[i] ?? false
        const visible =
          isPointVisible(
            entry.basePoint,
            entry.baseRadius,
            cameraLocalPos,
            cameraLocalDir,
            viewAngle,
            wasVisible,
            rockMargin,
            rockHideExtra,
            rockOcclusionLead,
          ) ||
          isPointVisible(
            entry.peakPoint,
            entry.peakRadius,
            cameraLocalPos,
            cameraLocalDir,
            viewAngle,
            wasVisible,
            rockMargin,
            rockHideExtra,
            rockOcclusionLead,
          )
        state[i] = visible
        if (visible) nextVariantVisible.push(i)
      }
      mountainVisibilityStateByVariant[variant] = state
      const currentVisible = mountainVisibleIndicesByVariant[variant] ?? []
      if (!arraysEqual(nextVariantVisible, currentVisible)) {
        mountainVisibleIndicesByVariant[variant] = nextVariantVisible
        const mesh = mountainMeshes[variant]
        const sourceMatrices = mountainSourceMatricesByVariant[variant] ?? []
        if (mesh) {
          for (let write = 0; write < nextVariantVisible.length; write += 1) {
            const source = sourceMatrices[nextVariantVisible[write]]
            if (!source) continue
            mesh.setMatrixAt(write, source)
          }
          mesh.count = nextVariantVisible.length
          mesh.instanceMatrix.needsUpdate = true
        }
      }
      mountainVisibleTotal += (mountainVisibleIndicesByVariant[variant] ?? []).length
    }
    visibleMountainCount = mountainVisibleTotal

    const nextPebbleVisible: number[] = []
    for (let i = 0; i < pebbleCullEntries.length; i += 1) {
      const entry = pebbleCullEntries[i]
      const wasVisible = pebbleVisibilityState[i] ?? false
      const visible = isPointVisible(
        entry.point,
        entry.radius,
        cameraLocalPos,
        cameraLocalDir,
        viewAngle,
        wasVisible,
        pebbleMargin,
        pebbleHideExtra,
        pebbleOcclusionLead,
      )
      pebbleVisibilityState[i] = visible
      if (visible) nextPebbleVisible.push(i)
    }
    if (!arraysEqual(nextPebbleVisible, pebbleVisibleIndices)) {
      pebbleVisibleIndices = nextPebbleVisible
      if (pebbleMesh) {
        for (let write = 0; write < pebbleVisibleIndices.length; write += 1) {
          const source = pebbleSourceMatrices[pebbleVisibleIndices[write]]
          if (!source) continue
          pebbleMesh.setMatrixAt(write, source)
        }
        pebbleMesh.count = pebbleVisibleIndices.length
        pebbleMesh.instanceMatrix.needsUpdate = true
      }
    }
    visiblePebbleCount = pebbleVisibleIndices.length
  }

  const buildEnvironment = (data: Environment | null) => {
    disposeEnvironment()

    lakes = data?.lakes?.length ? data.lakes.map(buildLakeFromData) : createLakes(0x91fcae12, LAKE_COUNT)

    const planetMaterial = new THREE.MeshStandardMaterial({
      color: '#ffffff',
      roughness: 0.9,
      metalness: 0.05,
      side: THREE.FrontSide,
      vertexColors: true,
      wireframe: terrainTessellationDebugEnabled,
    })
    if (PLANET_PATCH_ENABLED) {
      const basePlanetGeometry = createIcosphereGeometry(PLANET_RADIUS, PLANET_BASE_ICOSPHERE_DETAIL)
      const planetGeometry = basePlanetGeometry.clone()
      applyLakeDepressions(planetGeometry, lakes)
      terrainContactSampler = createTerrainContactSampler(
        planetGeometry,
        TERRAIN_CONTACT_BANDS,
        TERRAIN_CONTACT_SLICES,
      )
      planetPatchMaterial = planetMaterial
      buildPlanetPatchAtlas(planetGeometry, planetMaterial)

      const rawShorelineGeometry = new THREE.WireframeGeometry(planetGeometry)
      const shorelineOnlyGeometry = createShorelineGeometry(rawShorelineGeometry, lakes)
      rawShorelineGeometry.dispose()
      if ((shorelineOnlyGeometry.attributes.position?.count ?? 0) > 0) {
        const shorelineLineMaterial = new THREE.LineBasicMaterial({
          color: GRID_LINE_COLOR,
          transparent: true,
          opacity: SHORELINE_LINE_OPACITY,
        })
        shorelineLineMaterial.depthWrite = false
        shorelineLineMesh = new THREE.LineSegments(shorelineOnlyGeometry, shorelineLineMaterial)
        shorelineLineMesh.scale.setScalar(1.002)
        world.add(shorelineLineMesh)
      } else {
        shorelineOnlyGeometry.dispose()
      }

      const shorelineFillGeometry = createShorelineFillGeometry(planetGeometry, lakes)
      if ((shorelineFillGeometry.attributes.position?.count ?? 0) > 0) {
        const shorelineFillMaterial = new THREE.MeshStandardMaterial({
          color: SHORE_SAND_COLOR,
          roughness: 0.92,
          metalness: 0.05,
          transparent: true,
        })
        shorelineFillMaterial.depthWrite = false
        shorelineFillMaterial.depthTest = true
        shorelineFillMaterial.polygonOffset = true
        shorelineFillMaterial.polygonOffsetFactor = -1
        shorelineFillMaterial.polygonOffsetUnits = -1
        shorelineFillMesh = new THREE.Mesh(shorelineFillGeometry, shorelineFillMaterial)
        shorelineFillMesh.renderOrder = 1
        shorelineFillMesh.scale.setScalar(1.001)
        world.add(shorelineFillMesh)
      } else {
        shorelineFillGeometry.dispose()
      }

      planetGeometry.dispose()
      basePlanetGeometry.dispose()
    } else {
      const basePlanetGeometry = createIcosphereGeometry(PLANET_RADIUS, PLANET_BASE_ICOSPHERE_DETAIL)
      const planetGeometry = basePlanetGeometry.clone()
      applyLakeDepressions(planetGeometry, lakes)
      terrainContactSampler = createTerrainContactSampler(
        planetGeometry,
        TERRAIN_CONTACT_BANDS,
        TERRAIN_CONTACT_SLICES,
      )
      planetMesh = new THREE.Mesh(planetGeometry, planetMaterial)
      world.add(planetMesh)

      const rawGridGeometry = new THREE.WireframeGeometry(planetGeometry)
      const gridGeometry = createFilteredGridGeometry(rawGridGeometry, lakes)
      const shorelineLineGeometry = createShorelineGeometry(rawGridGeometry, lakes)
      rawGridGeometry.dispose()
      const gridMaterial = new THREE.LineBasicMaterial({
        color: GRID_LINE_COLOR,
        transparent: true,
        opacity: GRID_LINE_OPACITY,
      })
      gridMaterial.depthWrite = false
      gridMesh = new THREE.LineSegments(gridGeometry, gridMaterial)
      gridMesh.scale.setScalar(1.002)
      world.add(gridMesh)
      const shorelineLineMaterial = new THREE.LineBasicMaterial({
        color: GRID_LINE_COLOR,
        transparent: true,
        opacity: SHORELINE_LINE_OPACITY,
      })
      shorelineLineMaterial.depthWrite = false
      shorelineLineMesh = new THREE.LineSegments(shorelineLineGeometry, shorelineLineMaterial)
      shorelineLineMesh.scale.setScalar(1.002)
      world.add(shorelineLineMesh)

      const shorelineFillGeometry = createShorelineFillGeometry(planetGeometry, lakes)
      const shorelineFillMaterial = new THREE.MeshStandardMaterial({
        color: SHORE_SAND_COLOR,
        roughness: 0.92,
        metalness: 0.05,
        transparent: true,
      })
      shorelineFillMaterial.depthWrite = false
      shorelineFillMaterial.depthTest = true
      shorelineFillMaterial.polygonOffset = true
      shorelineFillMaterial.polygonOffsetFactor = -1
      shorelineFillMaterial.polygonOffsetUnits = -1
      shorelineFillMesh = new THREE.Mesh(shorelineFillGeometry, shorelineFillMaterial)
      shorelineFillMesh.renderOrder = 1
      shorelineFillMesh.scale.setScalar(1.001)
      world.add(shorelineFillMesh)

      basePlanetGeometry.dispose()
    }

    if (webglShaderHooksEnabled) {
      lakeSurfaceGeometry = new THREE.SphereGeometry(1, LAKE_SURFACE_SEGMENTS, LAKE_SURFACE_RINGS)
      for (const lake of lakes) {
        const lakeMaterial = createLakeMaskMaterial(lake)
        const lakeMesh = new THREE.Mesh(lakeSurfaceGeometry, lakeMaterial)
        lakeMesh.scale.setScalar(PLANET_RADIUS - lake.surfaceInset + LAKE_WATER_SURFACE_LIFT)
        lakeMesh.renderOrder = 2
        world.add(lakeMesh)
        lakeMeshes.push(lakeMesh)
        lakeMaterials.push(lakeMaterial)
      }
    } else {
      const lakeBaseGeometry = createIcosphereGeometry(PLANET_RADIUS, LAKE_SURFACE_ICOSPHERE_DETAIL)
      lakeSurfaceGeometry = createLakeSurfaceGeometry(lakeBaseGeometry, lakes)
      lakeBaseGeometry.dispose()
      if ((lakeSurfaceGeometry.attributes.position?.count ?? 0) > 0) {
        const lakeMaterial = createLakeMaterial()
        const lakeMesh = new THREE.Mesh(lakeSurfaceGeometry, lakeMaterial)
        lakeMesh.renderOrder = 2
        world.add(lakeMesh)
        lakeMeshes.push(lakeMesh)
        lakeMaterials.push(lakeMaterial)
      }
    }
    if (isLakeDebugEnabled()) {
      const lakeBaseGeometry = createIcosphereGeometry(PLANET_RADIUS, LAKE_SURFACE_ICOSPHERE_DETAIL)
      const lakeGeometry = createLakeSurfaceGeometry(lakeBaseGeometry, lakes)
      lakeGeometry.dispose()
      lakeBaseGeometry.dispose()
    }
    const rng = createSeededRandom(0x6f35d2a1)
    const randRange = (min: number, max: number) => min + (max - min) * rng()
    const tierHeightSum = TREE_TIER_HEIGHT_FACTORS.reduce((sum, value) => sum + value, 0)
    const tierHeightScale =
      tierHeightSum > 0 ? (TREE_HEIGHT - TREE_TRUNK_HEIGHT) / tierHeightSum : 0
    const treeTierHeights = TREE_TIER_HEIGHT_FACTORS.map(
      (factor) => factor * tierHeightScale,
    )
    const treeTierRadii = TREE_TIER_RADIUS_FACTORS.map((factor) => factor * TREE_HEIGHT)
    const treeTierOffsets: number[] = []
    let tierBase = TREE_TRUNK_HEIGHT * 0.75
    for (let i = 0; i < treeTierHeights.length; i += 1) {
      const height = treeTierHeights[i]
      treeTierOffsets.push(tierBase - height * 0.08)
      tierBase += height * (1 - TREE_TIER_OVERLAP)
    }
    let baseTreeHeight = TREE_TRUNK_HEIGHT
    for (let i = 0; i < treeTierHeights.length; i += 1) {
      const top = treeTierOffsets[i] + treeTierHeights[i]
      if (top > baseTreeHeight) baseTreeHeight = top
    }

    const leafMaterial = new THREE.MeshStandardMaterial({
      color: '#7fb35a',
      roughness: 0.85,
      metalness: 0.05,
      flatShading: true,
    })
    const trunkMaterial = new THREE.MeshStandardMaterial({
      color: '#b8743c',
      roughness: 0.9,
      metalness: 0.05,
      flatShading: true,
    })
    const cactusBodyMaterial = new THREE.MeshStandardMaterial({
      color: '#228f44',
      roughness: 0.88,
      metalness: 0.03,
      flatShading: true,
    })
    const cactusArmMat = new THREE.MeshStandardMaterial({
      color: '#279a4b',
      roughness: 0.87,
      metalness: 0.03,
      flatShading: true,
    })
    treeLeafMaterial = leafMaterial
    treeTrunkMaterial = trunkMaterial
    cactusMaterial = cactusBodyMaterial
    cactusArmMaterial = cactusArmMat
    const treeInstanceCount = Math.max(0, TREE_COUNT - MOUNTAIN_COUNT)

    for (let i = 0; i < treeTierHeights.length; i += 1) {
      const height = treeTierHeights[i]
      const radius = treeTierRadii[i]
      const geometry = new THREE.ConeGeometry(radius, height, 6, 1)
      geometry.translate(0, height / 2, 0)
      treeTierGeometries.push(geometry)
      const mesh = new THREE.InstancedMesh(geometry, leafMaterial, TREE_COUNT)
      mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage)
      mesh.frustumCulled = false
      mesh.count = treeInstanceCount
      treeTierMeshes.push(mesh)
      environmentGroup.add(mesh)
    }

    treeTrunkGeometry = new THREE.CylinderGeometry(
      TREE_TRUNK_RADIUS * 0.7,
      TREE_TRUNK_RADIUS,
      TREE_TRUNK_HEIGHT,
      6,
      1,
    )
    treeTrunkGeometry.translate(0, TREE_TRUNK_HEIGHT / 2, 0)
    treeTrunkMesh = new THREE.InstancedMesh(treeTrunkGeometry, trunkMaterial, TREE_COUNT)
    treeTrunkMesh.instanceMatrix.setUsage(THREE.StaticDrawUsage)
    treeTrunkMesh.frustumCulled = false
    treeTrunkMesh.count = treeInstanceCount
    environmentGroup.add(treeTrunkMesh)

    const trunkSpinePoints = [
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(0, CACTUS_TRUNK_HEIGHT * 0.3, 0),
      new THREE.Vector3(0, CACTUS_TRUNK_HEIGHT * 0.68, 0),
      new THREE.Vector3(0, CACTUS_TRUNK_HEIGHT, 0),
    ]
    const leftArmSpinePoints = [
      new THREE.Vector3(-CACTUS_TRUNK_RADIUS * 0.5, CACTUS_LEFT_ARM_BASE_HEIGHT, 0),
      new THREE.Vector3(-CACTUS_TRUNK_RADIUS * 1.28, CACTUS_LEFT_ARM_BASE_HEIGHT + CACTUS_TRUNK_HEIGHT * 0.09, 0),
      new THREE.Vector3(-CACTUS_TRUNK_RADIUS * 1.72, CACTUS_LEFT_ARM_BASE_HEIGHT + CACTUS_TRUNK_HEIGHT * 0.26, 0),
      new THREE.Vector3(-CACTUS_TRUNK_RADIUS * 1.66, CACTUS_LEFT_ARM_BASE_HEIGHT + CACTUS_TRUNK_HEIGHT * 0.47, 0),
    ]
    const rightArmSpinePoints = [
      new THREE.Vector3(CACTUS_TRUNK_RADIUS * 0.48, CACTUS_RIGHT_ARM_BASE_HEIGHT, 0),
      new THREE.Vector3(CACTUS_TRUNK_RADIUS * 1.1, CACTUS_RIGHT_ARM_BASE_HEIGHT + CACTUS_TRUNK_HEIGHT * 0.07, 0),
      new THREE.Vector3(CACTUS_TRUNK_RADIUS * 1.42, CACTUS_RIGHT_ARM_BASE_HEIGHT + CACTUS_TRUNK_HEIGHT * 0.21, 0),
      new THREE.Vector3(CACTUS_TRUNK_RADIUS * 1.32, CACTUS_RIGHT_ARM_BASE_HEIGHT + CACTUS_TRUNK_HEIGHT * 0.37, 0),
    ]

    const trunkCurve = new THREE.CatmullRomCurve3(trunkSpinePoints, false, 'centripetal', 0.25)
    cactusTrunkGeometry = new THREE.TubeGeometry(
      trunkCurve,
      CACTUS_TRUNK_TUBE_SEGMENTS,
      CACTUS_TRUNK_RADIUS,
      CACTUS_TUBE_RADIAL_SEGMENTS,
      false,
    )
    cactusTrunkMesh = new THREE.InstancedMesh(cactusTrunkGeometry, cactusBodyMaterial, TREE_COUNT)
    cactusTrunkMesh.instanceMatrix.setUsage(THREE.StaticDrawUsage)
    cactusTrunkMesh.frustumCulled = false
    cactusTrunkMesh.count = 0
    environmentGroup.add(cactusTrunkMesh)

    const cactusArmSpecs: Array<{
      points: THREE.Vector3[]
      radius: number
    }> = [
      { points: leftArmSpinePoints, radius: CACTUS_LEFT_ARM_RADIUS },
      { points: rightArmSpinePoints, radius: CACTUS_RIGHT_ARM_RADIUS },
    ]
    for (const spec of cactusArmSpecs) {
      const curve = new THREE.CatmullRomCurve3(spec.points, false, 'centripetal', 0.25)
      const geometry = new THREE.TubeGeometry(
        curve,
        CACTUS_ARM_TUBE_SEGMENTS,
        spec.radius,
        CACTUS_TUBE_RADIAL_SEGMENTS,
        false,
      )
      cactusPartGeometries.push(geometry)
      const mesh = new THREE.InstancedMesh(geometry, cactusArmMat, TREE_COUNT)
      mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage)
      mesh.frustumCulled = false
      mesh.count = 0
      cactusPartMeshes.push(mesh)
      environmentGroup.add(mesh)
    }

    const cactusSphereSpecs: Array<{
      point: THREE.Vector3
      radius: number
      material: THREE.Material
    }> = [
      {
        point: trunkSpinePoints[0].clone(),
        radius: CACTUS_TRUNK_RADIUS * 1.05,
        material: cactusBodyMaterial,
      },
      {
        point: trunkSpinePoints[trunkSpinePoints.length - 1].clone(),
        radius: CACTUS_TRUNK_RADIUS * 1.05,
        material: cactusBodyMaterial,
      },
      {
        point: leftArmSpinePoints[0].clone(),
        radius: CACTUS_LEFT_ARM_RADIUS * 1.05,
        material: cactusBodyMaterial,
      },
      {
        point: leftArmSpinePoints[leftArmSpinePoints.length - 1].clone(),
        radius: CACTUS_LEFT_ARM_RADIUS * 1.03,
        material: cactusArmMat,
      },
      {
        point: rightArmSpinePoints[0].clone(),
        radius: CACTUS_RIGHT_ARM_RADIUS * 1.05,
        material: cactusBodyMaterial,
      },
      {
        point: rightArmSpinePoints[rightArmSpinePoints.length - 1].clone(),
        radius: CACTUS_RIGHT_ARM_RADIUS * 1.03,
        material: cactusArmMat,
      },
    ]
    for (const spec of cactusSphereSpecs) {
      const geometry = new THREE.SphereGeometry(spec.radius, 8, 6)
      geometry.translate(spec.point.x, spec.point.y, spec.point.z)
      cactusPartGeometries.push(geometry)
      const mesh = new THREE.InstancedMesh(geometry, spec.material, TREE_COUNT)
      mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage)
      mesh.frustumCulled = false
      mesh.count = 0
      cactusPartMeshes.push(mesh)
      environmentGroup.add(mesh)
    }

    mountainMaterial = new THREE.MeshStandardMaterial({
      color: '#8f8f8f',
      roughness: 0.95,
      metalness: 0.02,
      flatShading: true,
    })
    for (let i = 0; i < MOUNTAIN_VARIANTS; i += 1) {
      const geometry = createMountainGeometry(0x3f2a9b1 + i * 57)
      mountainGeometries.push(geometry)
      const mesh = new THREE.InstancedMesh(geometry, mountainMaterial, MOUNTAIN_COUNT)
      mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage)
      mesh.frustumCulled = false
      mesh.count = 0
      mountainMeshes.push(mesh)
      environmentGroup.add(mesh)
    }

    pebbleGeometry = new THREE.IcosahedronGeometry(1, 0)
    const rockMaterial = new THREE.MeshStandardMaterial({
      color: '#808080',
      roughness: 0.95,
      metalness: 0.05,
      flatShading: true,
    })
    pebbleMaterial = rockMaterial
    pebbleMesh = new THREE.InstancedMesh(pebbleGeometry, rockMaterial, PEBBLE_COUNT)
    pebbleMesh.instanceMatrix.setUsage(THREE.StaticDrawUsage)
    pebbleMesh.frustumCulled = false
    environmentGroup.add(pebbleMesh)

    const up = new THREE.Vector3(0, 1, 0)
    const normal = new THREE.Vector3()
    const position = new THREE.Vector3()
    const baseQuat = new THREE.Quaternion()
    const twistQuat = new THREE.Quaternion()
    const baseScale = new THREE.Vector3()
    const baseMatrix = new THREE.Matrix4()
    const localMatrix = new THREE.Matrix4()
    const worldMatrix = new THREE.Matrix4()

    const minDot = Math.cos(TREE_MIN_ANGLE)
    const minHeightScale = TREE_MIN_HEIGHT / baseTreeHeight
    const maxHeightScale = Math.max(minHeightScale, TREE_MAX_HEIGHT / baseTreeHeight)
    const lakeSampleTemp = new THREE.Vector3()
    const isInLake = (candidate: THREE.Vector3) =>
      sampleLakes(candidate, lakes, lakeSampleTemp).boundary > LAKE_EXCLUSION_THRESHOLD
    treeTrunkSourceMatrices = []
    treeTierSourceMatrices = treeTierMeshes.map(() => [])
    cactusTrunkSourceMatrices = []
    cactusPartSourceMatrices = cactusPartMeshes.map(() => [])
    treeCullEntries = []
    treeVisibilityState = []
    treeVisibleIndices = []
    cactusCullEntries = []
    cactusVisibilityState = []
    cactusVisibleIndices = []
    visibleTreeCount = 0
    visibleCactusCount = 0
    mountainSourceMatricesByVariant = mountainMeshes.map(() => [])
    mountainCullEntriesByVariant = mountainMeshes.map(() => [])
    mountainVisibilityStateByVariant = mountainMeshes.map(() => [])
    mountainVisibleIndicesByVariant = mountainMeshes.map(() => [])
    visibleMountainCount = 0
    pebbleSourceMatrices = []
    pebbleCullEntries = []
    pebbleVisibilityState = []
    pebbleVisibleIndices = []
    visiblePebbleCount = 0

    if (data?.trees?.length) {
      trees = data.trees.map(buildTreeFromData)
    } else {
      const forestNormals: THREE.Vector3[] = []
      const cactusNormals: THREE.Vector3[] = []
      const treeScales: THREE.Vector3[] = []
      const cactusScales: THREE.Vector3[] = []
      const pickSparseNormal = (
        out: THREE.Vector3,
        existing: THREE.Vector3[],
        minDot: number,
        predicate: (candidate: THREE.Vector3) => boolean,
      ) => {
        for (let attempt = 0; attempt < 60; attempt += 1) {
          randomOnSphere(rng, out)
          if (predicate(out)) continue
          let ok = true
          for (const sample of existing) {
            if (sample.dot(out) > minDot) {
              ok = false
              break
            }
          }
          if (ok) return out
        }
        for (let attempt = 0; attempt < 40; attempt += 1) {
          randomOnSphere(rng, out)
          if (!predicate(out)) return out
        }
        return out
      }

      const cactusCount = Math.min(DESERT_CACTUS_COUNT, treeInstanceCount)
      const forestCount = Math.max(0, treeInstanceCount - cactusCount)
      const cactusMinDot = Math.cos(0.34)
      for (let i = 0; i < forestCount; i += 1) {
        const candidate = new THREE.Vector3()
        pickSparseNormal(
          candidate,
          forestNormals,
          minDot,
          (out) => isInLake(out) || isDesertBiome(out),
        )
        const widthScale = randRange(TREE_MIN_SCALE, TREE_MAX_SCALE)
        const heightScale = randRange(minHeightScale, maxHeightScale)
        forestNormals.push(candidate)
        treeScales.push(new THREE.Vector3(widthScale, heightScale, widthScale))
      }
      for (let i = 0; i < cactusCount; i += 1) {
        const candidate = new THREE.Vector3()
        pickSparseNormal(
          candidate,
          cactusNormals,
          cactusMinDot,
          (out) => isInLake(out) || !isDesertBiome(out),
        )
        const widthScale = randRange(TREE_MIN_SCALE, TREE_MAX_SCALE)
        const heightScale = randRange(minHeightScale, maxHeightScale)
        cactusNormals.push(candidate)
        cactusScales.push(new THREE.Vector3(widthScale, heightScale, widthScale))
      }

      const generatedForest = forestNormals.map((treeNormal, index) => ({
        normal: treeNormal,
        widthScale: treeScales[index]?.x ?? 1,
        heightScale: treeScales[index]?.y ?? 1,
        twist: randRange(0, Math.PI * 2),
      }))
      const generatedCactus = cactusNormals.map((treeNormal, index) => ({
        normal: treeNormal,
        widthScale: -(cactusScales[index]?.x ?? 1),
        heightScale: cactusScales[index]?.y ?? 1,
        twist: randRange(0, Math.PI * 2),
      }))
      trees = [...generatedForest, ...generatedCactus]
    }

    const forestTrees = trees.filter((tree) => tree.widthScale >= 0)
    const cactusTrees = trees.filter((tree) => tree.widthScale < 0)
    const appliedTreeCount = Math.min(treeInstanceCount, forestTrees.length)
    const treeBaseRadius = PLANET_RADIUS + TREE_BASE_OFFSET - TREE_TRUNK_HEIGHT * 0.12
    const treeCanopyRadius = treeTierRadii.reduce((max, radius) => Math.max(max, radius), 0)
    for (let i = 0; i < appliedTreeCount; i += 1) {
      const tree = forestTrees[i]
      normal.copy(tree.normal)
      baseQuat.setFromUnitVectors(up, normal)
      twistQuat.setFromAxisAngle(up, tree.twist)
      baseQuat.multiply(twistQuat)
      baseScale.set(tree.widthScale, tree.heightScale, tree.widthScale)
      position.copy(normal).multiplyScalar(treeBaseRadius)
      baseMatrix.compose(position, baseQuat, baseScale)
      treeTrunkSourceMatrices.push(baseMatrix.clone())

      for (let t = 0; t < treeTierMeshes.length; t += 1) {
        localMatrix.makeTranslation(0, treeTierOffsets[t], 0)
        worldMatrix.copy(baseMatrix).multiply(localMatrix)
        treeTierSourceMatrices[t]?.push(worldMatrix.clone())
      }
      treeCullEntries.push({
        basePoint: normal.clone().multiplyScalar(treeBaseRadius),
        topPoint: normal
          .clone()
          .multiplyScalar(treeBaseRadius + baseTreeHeight * tree.heightScale),
        baseRadius: TREE_TRUNK_RADIUS * tree.widthScale,
        topRadius: Math.max(TREE_TRUNK_RADIUS, treeCanopyRadius) * tree.widthScale,
      })
      treeVisibilityState.push(false)
    }
    cactusTrunkSourceMatrices = []
    cactusPartSourceMatrices = cactusPartMeshes.map(() => [])
    cactusCullEntries = []
    cactusVisibilityState = []
    cactusVisibleIndices = []
    const cactusBaseRadius = PLANET_RADIUS + TREE_BASE_OFFSET - CACTUS_BASE_SINK
    const appliedCactusCount = Math.min(treeInstanceCount, cactusTrees.length)
    const cactusTopLocalPoint = trunkSpinePoints[trunkSpinePoints.length - 1] ?? new THREE.Vector3(0, CACTUS_TRUNK_HEIGHT, 0)
    const cactusLeftTipLocalPoint =
      leftArmSpinePoints[leftArmSpinePoints.length - 1] ??
      new THREE.Vector3(-CACTUS_TRUNK_RADIUS * 1.66, CACTUS_LEFT_ARM_BASE_HEIGHT + CACTUS_TRUNK_HEIGHT * 0.47, 0)
    const cactusRightTipLocalPoint =
      rightArmSpinePoints[rightArmSpinePoints.length - 1] ??
      new THREE.Vector3(CACTUS_TRUNK_RADIUS * 1.32, CACTUS_RIGHT_ARM_BASE_HEIGHT + CACTUS_TRUNK_HEIGHT * 0.37, 0)
    for (let i = 0; i < appliedCactusCount; i += 1) {
      const cactus = cactusTrees[i]
      const widthScale = Math.abs(cactus.widthScale)
      normal.copy(cactus.normal)
      baseQuat.setFromUnitVectors(up, normal)
      twistQuat.setFromAxisAngle(up, cactus.twist)
      baseQuat.multiply(twistQuat)
      const cactusScale = clamp(
        widthScale * CACTUS_UNIFORM_SCALE_MULTIPLIER,
        CACTUS_MIN_UNIFORM_SCALE,
        CACTUS_MAX_UNIFORM_SCALE,
      )
      baseScale.set(cactusScale, cactusScale, cactusScale)
      position.copy(normal).multiplyScalar(cactusBaseRadius)
      baseMatrix.compose(position, baseQuat, baseScale)
      cactusTrunkSourceMatrices.push(baseMatrix.clone())
      for (let p = 0; p < cactusPartMeshes.length; p += 1) {
        cactusPartSourceMatrices[p]?.push(baseMatrix.clone())
      }
      const basePoint = new THREE.Vector3(0, 0, 0).applyMatrix4(baseMatrix)
      const topPoint = cactusTopLocalPoint.clone().applyMatrix4(baseMatrix)
      const leftArmTipPoint = cactusLeftTipLocalPoint.clone().applyMatrix4(baseMatrix)
      const rightArmTipPoint = cactusRightTipLocalPoint.clone().applyMatrix4(baseMatrix)
      const baseRadius = CACTUS_TRUNK_RADIUS * cactusScale
      const armRadius = Math.max(CACTUS_LEFT_ARM_RADIUS, CACTUS_RIGHT_ARM_RADIUS) * cactusScale
      cactusCullEntries.push({
        basePoint,
        topPoint,
        leftArmTipPoint,
        rightArmTipPoint,
        baseRadius,
        topRadius: baseRadius * 0.96,
        armRadius,
      })
      cactusVisibilityState.push(false)
    }

    if (treeTrunkMesh) {
      treeTrunkMesh.count = 0
      treeTrunkMesh.instanceMatrix.needsUpdate = true
    }
    for (const mesh of treeTierMeshes) {
      mesh.count = 0
      mesh.instanceMatrix.needsUpdate = true
    }
    if (cactusTrunkMesh) {
      cactusTrunkMesh.count = 0
      cactusTrunkMesh.instanceMatrix.needsUpdate = true
    }
    for (let p = 0; p < cactusPartMeshes.length; p += 1) {
      const mesh = cactusPartMeshes[p]
      mesh.count = 0
      mesh.instanceMatrix.needsUpdate = true
    }
    visibleCactusCount = 0

    if (data?.mountains?.length) {
      mountains = data.mountains.map(buildMountainFromData)
    } else {
      const mountainNormals: THREE.Vector3[] = []
      const mountainMinDot = Math.cos(MOUNTAIN_MIN_ANGLE)
      const pickMountainNormal = (out: THREE.Vector3) => {
        for (let attempt = 0; attempt < 60; attempt += 1) {
          randomOnSphere(rng, out)
          if (isInLake(out) || isDesertBiome(out)) continue
          let ok = true
          for (const existing of mountainNormals) {
            if (existing.dot(out) > mountainMinDot) {
              ok = false
              break
            }
          }
          if (ok) return out
        }
        for (let attempt = 0; attempt < 40; attempt += 1) {
          randomOnSphere(rng, out)
          if (!isInLake(out) && !isDesertBiome(out)) return out
        }
        return out
      }
      for (let i = 0; i < MOUNTAIN_COUNT; i += 1) {
        const candidate = new THREE.Vector3()
        pickMountainNormal(candidate)
        const radius = randRange(MOUNTAIN_RADIUS_MIN, MOUNTAIN_RADIUS_MAX)
        const height = randRange(MOUNTAIN_HEIGHT_MIN, MOUNTAIN_HEIGHT_MAX)
        const variant = Math.floor(rng() * MOUNTAIN_VARIANTS)
        const twist = randRange(0, Math.PI * 2)
        const outline = new Array(MOUNTAIN_OUTLINE_SAMPLES).fill(radius / PLANET_RADIUS)
        const upVector = Math.abs(candidate.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0)
        const tangent = new THREE.Vector3().crossVectors(upVector, candidate).normalize()
        const bitangent = new THREE.Vector3().crossVectors(candidate, tangent).normalize()
        mountainNormals.push(candidate)
        mountains.push({
          normal: candidate,
          radius,
          height,
          variant,
          twist,
          outline,
          tangent,
          bitangent,
        })
      }
    }

    if (mountainMeshes.length > 0) {
      for (const mountain of mountains) {
        const variantIndex = Math.min(mountainMeshes.length - 1, Math.max(0, Math.floor(mountain.variant)))
        if (variantIndex < 0) continue
        normal.copy(mountain.normal)
        baseQuat.setFromUnitVectors(up, normal)
        twistQuat.setFromAxisAngle(up, mountain.twist)
        baseQuat.multiply(twistQuat)
        baseScale.set(mountain.radius, mountain.height, mountain.radius)
        position.copy(normal).multiplyScalar(PLANET_RADIUS - MOUNTAIN_BASE_SINK)
        baseMatrix.compose(position, baseQuat, baseScale)
        mountainSourceMatricesByVariant[variantIndex]?.push(baseMatrix.clone())
        mountainCullEntriesByVariant[variantIndex]?.push({
          basePoint: normal.clone().multiplyScalar(PLANET_RADIUS - MOUNTAIN_BASE_SINK),
          peakPoint: normal
            .clone()
            .multiplyScalar(PLANET_RADIUS - MOUNTAIN_BASE_SINK + mountain.height * 0.92),
          baseRadius: mountain.radius,
          peakRadius: mountain.radius * 0.58,
          variant: variantIndex,
        })
        mountainVisibilityStateByVariant[variantIndex]?.push(false)
      }
      for (let i = 0; i < mountainMeshes.length; i += 1) {
        const mesh = mountainMeshes[i]
        mesh.count = 0
        mesh.instanceMatrix.needsUpdate = true
      }
    }

    if (pebbleMesh) {
      const pebbleQuat = new THREE.Quaternion()
      const pebbleScale = new THREE.Vector3()
      const scaleMin = 1 - PEBBLE_RADIUS_VARIANCE * 0.45
      const scaleMax = 1 + PEBBLE_RADIUS_VARIANCE * 0.55
      let placed = 0
      let attempts = 0
      const maxAttempts = PEBBLE_COUNT * 10
      while (placed < PEBBLE_COUNT && attempts < maxAttempts) {
        attempts += 1
        randomOnSphere(rng, normal)
        if (isInLake(normal) || isDesertBiome(normal)) continue
        pebbleQuat.setFromUnitVectors(up, normal)
        twistQuat.setFromAxisAngle(up, randRange(0, Math.PI * 2))
        pebbleQuat.multiply(twistQuat)
        const radiusBlend = Math.pow(rng(), 0.8)
        const radius =
          PEBBLE_RADIUS_MIN +
          (PEBBLE_RADIUS_MAX - PEBBLE_RADIUS_MIN) * radiusBlend
        pebbleScale.set(
          radius * randRange(scaleMin, scaleMax),
          radius * randRange(scaleMin * 0.9, scaleMax * 0.9),
          radius * randRange(scaleMin, scaleMax),
        )
        position
          .copy(normal)
          .multiplyScalar(PLANET_RADIUS + PEBBLE_OFFSET - radius * 0.25)
        worldMatrix.compose(position, pebbleQuat, pebbleScale)
        pebbleSourceMatrices.push(worldMatrix.clone())
        pebbleCullEntries.push({
          point: position.clone(),
          radius: radius * 1.2,
        })
        pebbleVisibilityState.push(false)
        placed += 1
      }
      pebbleMesh.count = 0
      pebbleMesh.instanceMatrix.needsUpdate = true
    }

    patchCenterQuat.copy(world.quaternion).invert()
    cameraLocalPosTemp.copy(camera.position).applyQuaternion(patchCenterQuat)
    cameraLocalDirTemp.copy(cameraLocalPosTemp).normalize()
    const aspect = viewportHeight > 0 ? viewportWidth / viewportHeight : 1
    const viewAngle = computeVisibleSurfaceAngle(camera.position.z, aspect)
    updatePlanetPatchVisibility(cameraLocalDirTemp, viewAngle)
    updateLakeVisibility(cameraLocalDirTemp, viewAngle)
    updateEnvironmentVisibility(cameraLocalPosTemp, cameraLocalDirTemp, viewAngle)

    rebuildMountainDebug()
    rebuildLakeDebug()
    rebuildTreeDebug()
  }

  buildEnvironment(null)

  const createBoostDraftMaterial = () => {
    const materialParams: THREE.MeshBasicMaterialParameters = {
      color: BOOST_DRAFT_COLOR_A,
      transparent: true,
      opacity: 0,
      side: THREE.FrontSide,
      blending: THREE.NormalBlending,
    }
    if (!webglShaderHooksEnabled && boostDraftTexture) {
      materialParams.alphaMap = boostDraftTexture
    }
    const material = new THREE.MeshBasicMaterial(materialParams)
    material.depthWrite = false
    material.depthTest = true
    material.alphaTest = 0
    const materialUserData = material.userData as BoostDraftMaterialUserData
    if (webglShaderHooksEnabled) {
      material.onBeforeCompile = (shader) => {
        const timeUniform = { value: 0 }
        const opacityUniform = { value: 0 }
        materialUserData.timeUniform = timeUniform
        materialUserData.opacityUniform = opacityUniform
        shader.uniforms.boostDraftTime = timeUniform
        shader.uniforms.boostDraftOpacity = opacityUniform
        shader.vertexShader = shader.vertexShader
          .replace(
            '#include <common>',
            '#include <common>\nvarying vec3 vBoostDraftLocalPos;',
          )
          .replace(
            '#include <begin_vertex>',
            '#include <begin_vertex>\n  vBoostDraftLocalPos = position;',
          )
        shader.fragmentShader = shader.fragmentShader
          .replace(
            '#include <common>',
            '#include <common>\nvarying vec3 vBoostDraftLocalPos;\nuniform float boostDraftTime;\nuniform float boostDraftOpacity;',
          )
          .replace(
            '#include <color_fragment>',
            `#include <color_fragment>
vec3 boostLocal = normalize(vBoostDraftLocalPos);
float boostRim = length(boostLocal.xz);
float boostEdgeFade =
  1.0 - smoothstep(${BOOST_DRAFT_EDGE_FADE_START.toFixed(3)}, ${BOOST_DRAFT_EDGE_FADE_END.toFixed(3)}, boostRim);
float boostNoiseA = sin((boostLocal.x * 9.5) + (boostLocal.z * 8.2) + boostDraftTime * 3.7) * 0.5 + 0.5;
float boostNoiseB = sin((boostLocal.z * 11.3) - (boostLocal.x * 7.6) - boostDraftTime * 2.9) * 0.5 + 0.5;
float boostColorMix = clamp(0.28 + 0.72 * (boostNoiseA * 0.58 + boostNoiseB * 0.42), 0.0, 1.0);
vec3 boostColor = mix(vec3(0.337, 0.851, 1.0), vec3(1.0), boostColorMix);
diffuseColor.rgb = boostColor;
diffuseColor.a *= boostDraftOpacity * boostEdgeFade;`,
          )
      }
    }
    return material
  }

  const createSnakeVisual = (
    primaryColor: string,
    skinKey: string,
    skinTexture: THREE.CanvasTexture,
  ): SnakeVisual => {
    const group = new THREE.Group()

    const tubeMaterial = new THREE.MeshStandardMaterial({
      color: '#ffffff',
      roughness: 0.35,
      metalness: 0.1,
      flatShading: false,
    })
    tubeMaterial.map = skinTexture
    tubeMaterial.emissiveMap = skinTexture
    tubeMaterial.emissive = new THREE.Color('#ffffff')
    const tube = new THREE.Mesh(new THREE.BufferGeometry(), tubeMaterial)
    group.add(tube)

    const selfOverlapGlowMaterial = new THREE.MeshBasicMaterial({
      color: primaryColor,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      vertexColors: true,
    })
    selfOverlapGlowMaterial.depthWrite = false
    selfOverlapGlowMaterial.depthTest = true
    const selfOverlapGlow = new THREE.Mesh(new THREE.BufferGeometry(), selfOverlapGlowMaterial)
    selfOverlapGlow.visible = false
    selfOverlapGlow.renderOrder = 1
    group.add(selfOverlapGlow)

    const headMaterial = new THREE.MeshStandardMaterial({
      color: primaryColor,
      roughness: 0.25,
      metalness: 0.1,
    })
    const head = new THREE.Mesh(headGeometry, headMaterial)
    group.add(head)

    const bowlCrackUniform = { value: 0 }
    const bowlMaterial = new THREE.MeshPhysicalMaterial({
      color: '#cfefff',
      roughness: 0.08,
      metalness: 0.0,
      transmission: 0.7,
      thickness: 0.35,
      clearcoat: 1,
      clearcoatRoughness: 0.1,
      transparent: true,
      opacity: 0.45,
    })
    bowlMaterial.depthWrite = false
    if (webglShaderHooksEnabled) {
      bowlMaterial.onBeforeCompile = (shader) => {
        shader.uniforms.crackAmount = bowlCrackUniform
        shader.fragmentShader = `uniform float crackAmount;\n${shader.fragmentShader}`
        shader.fragmentShader = shader.fragmentShader.replace(
          '#include <dithering_fragment>',
          `
          float crackMask = 0.0;
          vec3 crackPos = normalize(vNormal);
          float lineA = abs(sin(crackPos.x * 24.0) * sin(crackPos.y * 21.0));
          float lineB = abs(sin(crackPos.y * 17.0 + crackPos.z * 11.0));
          float lineC = abs(sin(crackPos.z * 19.0 - crackPos.x * 13.0));
          float lines = max(lineA, max(lineB, lineC));
          crackMask = smoothstep(0.92, 0.985, lines) * crackAmount;
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.1, 0.16, 0.2), crackMask);
          diffuseColor.a = max(diffuseColor.a, crackMask * 0.6);
          #include <dithering_fragment>
          `,
        )
      }
    }
    const bowl = new THREE.Mesh(bowlGeometry, bowlMaterial)
    bowl.renderOrder = 3
    bowl.visible = false
    group.add(bowl)

    const tail = new THREE.Mesh(tailGeometry, tubeMaterial)
    group.add(tail)

    const eyeMaterialLocal = eyeMaterial.clone()
    const pupilMaterialLocal = pupilMaterial.clone()
    const tongueMaterialLocal = tongueMaterial.clone()
    const eyeLeft = new THREE.Mesh(eyeGeometry, eyeMaterialLocal)
    const eyeRight = new THREE.Mesh(eyeGeometry, eyeMaterialLocal)
    const pupilLeft = new THREE.Mesh(pupilGeometry, pupilMaterialLocal)
    const pupilRight = new THREE.Mesh(pupilGeometry, pupilMaterialLocal)
    const tongue = new THREE.Group()
    const tongueBase = new THREE.Mesh(tongueBaseGeometry, tongueMaterialLocal)
    const tongueForkLeft = new THREE.Mesh(tongueForkGeometry, tongueMaterialLocal)
    const tongueForkRight = new THREE.Mesh(tongueForkGeometry, tongueMaterialLocal)
    tongueForkLeft.rotation.z = TONGUE_FORK_SPREAD
    tongueForkRight.rotation.z = -TONGUE_FORK_SPREAD
    tongue.add(tongueBase)
    tongue.add(tongueForkLeft)
    tongue.add(tongueForkRight)
    tongue.visible = false
    group.add(eyeLeft)
    group.add(eyeRight)
    group.add(pupilLeft)
    group.add(pupilRight)
    group.add(tongue)

    const boostDraftMaterial = createBoostDraftMaterial()
    const boostDraft = new THREE.Mesh(boostDraftGeometry, boostDraftMaterial)
    boostDraft.visible = false
    boostDraft.renderOrder = 2
    group.add(boostDraft)

    const nameplateTarget = createNameplateTexture('Player')
    const nameplateMaterial = new THREE.SpriteMaterial({
      map: nameplateTarget?.texture ?? null,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      depthTest: true,
      fog: false,
    })
    const nameplate = new THREE.Sprite(nameplateMaterial)
    nameplate.visible = false
    nameplate.renderOrder = 4
    nameplate.scale.set(NAMEPLATE_WORLD_WIDTH, NAMEPLATE_WORLD_WIDTH / NAMEPLATE_WORLD_ASPECT, 1)
    group.add(nameplate)

    return {
      group,
      tube,
      selfOverlapGlow,
      selfOverlapGlowMaterial,
      head,
      tail,
      eyeLeft,
      eyeRight,
      pupilLeft,
      pupilRight,
      tongue,
      tongueBase,
      tongueForkLeft,
      tongueForkRight,
      bowl,
      bowlMaterial,
      bowlCrackUniform,
      boostDraft,
      boostDraftMaterial,
      boostDraftPhase: 0,
      boostDraftIntensity: 0,
      nameplate,
      nameplateMaterial,
      nameplateTexture: nameplateTarget?.texture ?? null,
      nameplateCanvas: nameplateTarget?.canvas ?? null,
      nameplateCtx: nameplateTarget?.ctx ?? null,
      nameplateText: '',
      color: primaryColor,
      skinKey,
    }
  }

  const updateSnakeMaterial = (
    material: THREE.MeshStandardMaterial,
    color: string,
    isLocal: boolean,
    opacity: number,
    emissiveIntensity?: number,
  ) => {
    const base = new THREE.Color(color)
    if (material.map) {
      material.color.set('#ffffff')
      material.emissive.set('#ffffff')
    } else {
      material.color.copy(base)
      material.emissive.copy(base)
    }
    material.emissiveIntensity = emissiveIntensity ?? (isLocal ? 0.3 : 0.12)
    material.opacity = opacity
    const shouldBeTransparent = opacity < 0.999
    if (material.transparent !== shouldBeTransparent) {
      material.transparent = shouldBeTransparent
      material.needsUpdate = true
    }
    material.depthWrite = !shouldBeTransparent
  }

  const hideBoostDraft = (visual: SnakeVisual) => {
    visual.boostDraft.visible = false
    visual.boostDraftMaterial.opacity = 0
    visual.boostDraftIntensity = 0
    const userData = visual.boostDraftMaterial.userData as BoostDraftMaterialUserData
    if (userData.timeUniform) {
      userData.timeUniform.value = 0
    }
    if (userData.opacityUniform) {
      userData.opacityUniform.value = 0
    }
  }

  const hideNameplate = (visual: SnakeVisual) => {
    visual.nameplate.visible = false
    visual.nameplateMaterial.opacity = 0
  }

  const updateNameplateText = (visual: SnakeVisual, name: string) => {
    const sanitized = name.trim() || 'Player'
    if (visual.nameplateText === sanitized) return
    visual.nameplateText = sanitized
    if (!visual.nameplateCanvas || !visual.nameplateCtx || !visual.nameplateTexture) return
    paintNameplateTexture(
      {
        canvas: visual.nameplateCanvas,
        ctx: visual.nameplateCtx,
        texture: visual.nameplateTexture,
      },
      visual.nameplateText,
    )
  }

  const updateBoostDraft = (
    visual: SnakeVisual,
    player: PlayerSnapshot,
    headPosition: THREE.Vector3,
    headNormal: THREE.Vector3,
    forward: THREE.Vector3,
    headRadius: number,
    snakeOpacity: number,
    deltaSeconds: number,
  ) => {
    const active = player.alive && player.isBoosting && snakeOpacity > BOOST_DRAFT_MIN_ACTIVE_OPACITY
    const safeDelta = Math.max(0, deltaSeconds)
    visual.boostDraftPhase = (visual.boostDraftPhase + safeDelta * BOOST_DRAFT_PULSE_SPEED) % (Math.PI * 2)
    const targetIntensity = active ? 1 : 0
    visual.boostDraftIntensity = smoothValue(
      visual.boostDraftIntensity,
      targetIntensity,
      safeDelta,
      BOOST_DRAFT_FADE_IN_RATE,
      BOOST_DRAFT_FADE_OUT_RATE,
    )
    const intensity = clamp(visual.boostDraftIntensity, 0, 1)
    if (intensity <= BOOST_DRAFT_MIN_ACTIVE_OPACITY) {
      hideBoostDraft(visual)
      return
    }

    const radius = BOOST_DRAFT_BASE_RADIUS * (headRadius / HEAD_RADIUS)
    visual.boostDraft.position
      .copy(headPosition)
      .addScaledVector(forward, BOOST_DRAFT_FRONT_OFFSET + radius * 0.58)
      .addScaledVector(headNormal, BOOST_DRAFT_LIFT)
    visual.boostDraft.scale.setScalar(radius)
    tempQuat.setFromUnitVectors(BOOST_DRAFT_LOCAL_FORWARD_AXIS, forward)
    visual.boostDraft.quaternion.copy(tempQuat)
    visual.boostDraft.visible = true

    const colorT =
      0.5 +
      0.5 *
        Math.sin(visual.boostDraftPhase * (BOOST_DRAFT_COLOR_SHIFT_SPEED / BOOST_DRAFT_PULSE_SPEED))
    visual.boostDraftMaterial.color.copy(BOOST_DRAFT_COLOR_A).lerp(BOOST_DRAFT_COLOR_B, colorT)
    const opacity = BOOST_DRAFT_OPACITY * snakeOpacity * intensity
    visual.boostDraftMaterial.opacity = opacity
    const userData = visual.boostDraftMaterial.userData as BoostDraftMaterialUserData
    if (userData.timeUniform) {
      userData.timeUniform.value = visual.boostDraftPhase
    }
    if (userData.opacityUniform) {
      userData.opacityUniform.value = opacity
    }
  }

  const createGroundingInfo = (): SnakeGroundingInfo => ({
    minClearance: Number.POSITIVE_INFINITY,
    maxPenetration: 0,
    maxAppliedLift: 0,
    sampleCount: 0,
  })

  const finalizeGroundingInfo = (
    info: SnakeGroundingInfo | null,
  ): SnakeGroundingInfo | null => {
    if (!info || info.sampleCount <= 0) return null
    return {
      minClearance: Number.isFinite(info.minClearance) ? info.minClearance : 0,
      maxPenetration: info.maxPenetration,
      maxAppliedLift: info.maxAppliedLift,
      sampleCount: info.sampleCount,
    }
  }

  const getAnalyticTerrainRadius = (
    normal: THREE.Vector3,
    sample?: ReturnType<typeof sampleLakes>,
  ) => {
    const lakeSample = sample ?? sampleLakes(normal, lakes, lakeSampleTemp)
    const depth = getVisualLakeTerrainDepth(lakeSample)
    const duneOffset = sampleDuneOffset(normal) * sampleDesertBlend(normal)
    return PLANET_RADIUS + duneOffset - depth
  }

  const getTerrainRadius = (
    normal: THREE.Vector3,
    sample?: ReturnType<typeof sampleLakes>,
  ) => {
    if (terrainContactSampler) {
      const sampled = sampleTerrainContactRadius(terrainContactSampler, normal)
      if (sampled !== null) return sampled
    }
    return getAnalyticTerrainRadius(normal, sample)
  }

  const createBoostTrailAlphaTexture = () => {
    const canvas = document.createElement('canvas')
    canvas.width = BOOST_TRAIL_ALPHA_TEXTURE_WIDTH
    canvas.height = BOOST_TRAIL_ALPHA_TEXTURE_HEIGHT
    const ctx = canvas.getContext('2d')
    if (!ctx) return null

    const width = canvas.width
    const height = canvas.height
    const imageData = ctx.createImageData(width, height)
    const edgeCap = clamp(BOOST_TRAIL_EDGE_FADE_CAP, 0, 0.5)
    const sideCap = clamp(BOOST_TRAIL_SIDE_FADE_CAP, 0, 0.5)

    for (let y = 0; y < height; y += 1) {
      const v = height > 1 ? y / (height - 1) : 0
      const distanceToSide = Math.min(v, 1 - v)
      const sideFade =
        sideCap > 1e-4
          ? smoothstep(0, sideCap, distanceToSide)
          : 1
      for (let x = 0; x < width; x += 1) {
        const u = width > 1 ? x / (width - 1) : 0
        const headFade = edgeCap > 1e-4 ? smoothstep(0, edgeCap, u) : 1
        const tailFade = edgeCap > 1e-4 ? smoothstep(0, edgeCap, 1 - u) : 1
        const alpha = clamp(headFade * tailFade * sideFade, 0, 1)
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

  const boostTrailAlphaTexture = createBoostTrailAlphaTexture()

  const createBoostTrailMaterial = () => {
    const materialParams: THREE.MeshBasicMaterialParameters = {
      color: BOOST_TRAIL_COLOR,
      transparent: true,
      opacity: BOOST_TRAIL_OPACITY,
      side: THREE.DoubleSide,
    }
    if (boostTrailAlphaTexture) {
      materialParams.alphaMap = boostTrailAlphaTexture
    }
    const material = new THREE.MeshBasicMaterial(materialParams)
    material.depthWrite = false
    material.depthTest = true
    material.alphaTest = 0.001
    material.polygonOffset = true
    material.polygonOffsetFactor = -2
    material.polygonOffsetUnits = -2
    const materialUserData = material.userData as BoostTrailMaterialUserData
    materialUserData.retireCut = 0
    if (webglShaderHooksEnabled) {
      material.onBeforeCompile = (shader) => {
        const retireCutUniform = {
          value: clamp(materialUserData.retireCut ?? 0, 0, 1),
        }
        materialUserData.retireCutUniform = retireCutUniform
        shader.uniforms.boostTrailRetireCut = retireCutUniform
        shader.uniforms.boostTrailRetireFeather = {
          value: clamp(BOOST_TRAIL_RETIRE_FEATHER, 1e-4, 0.5),
        }
        shader.vertexShader = shader.vertexShader
          .replace(
            '#include <common>',
            '#include <common>\nattribute float trailProgress;\nvarying float vTrailProgress;',
          )
          .replace(
            '#include <begin_vertex>',
            '#include <begin_vertex>\n  vTrailProgress = trailProgress;',
          )
        shader.fragmentShader = shader.fragmentShader
          .replace(
            '#include <common>',
            '#include <common>\nvarying float vTrailProgress;\nuniform float boostTrailRetireCut;\nuniform float boostTrailRetireFeather;',
          )
          .replace(
            '#include <color_fragment>',
            `#include <color_fragment>
float retireEdge = smoothstep(
  boostTrailRetireCut,
  min(1.0, boostTrailRetireCut + boostTrailRetireFeather),
  vTrailProgress
);
diffuseColor.a *= retireEdge;`,
          )
      }
    }
    return material
  }

  // Warm up boost-related shader/pipeline compilation so the first boost activation doesn't stall
  // the main thread with shader compilation/pipeline creation.
  let boostWarmupGroup: THREE.Group | null = null
  let boostWarmupTrailGeometry: THREE.BufferGeometry | null = null
  let boostWarmupTrailMaterial: THREE.MeshBasicMaterial | null = null
  let boostWarmupDraftMaterial: THREE.MeshBasicMaterial | null = null
  const warmBoostPipelinesOnce = () => {
    if (boostWarmupGroup) return
    boostWarmupGroup = new THREE.Group()
    boostWarmupGroup.visible = true
    world.add(boostWarmupGroup)

    boostWarmupDraftMaterial = createBoostDraftMaterial()
    boostWarmupDraftMaterial.opacity = 0
    boostWarmupDraftMaterial.transparent = true
    const boostWarmupDraftMesh = new THREE.Mesh(boostDraftGeometry, boostWarmupDraftMaterial)
    boostWarmupDraftMesh.renderOrder = 2
    boostWarmupDraftMesh.scale.setScalar(0.01)
    boostWarmupDraftMesh.position.set(0, 0, 0)
    boostWarmupGroup.add(boostWarmupDraftMesh)

    boostWarmupTrailMaterial = createBoostTrailMaterial()
    boostWarmupTrailMaterial.opacity = 0
    boostWarmupTrailMaterial.transparent = true
    boostWarmupTrailGeometry = new THREE.BufferGeometry()
    const warmPositions = new Float32Array([
      -0.01, 0.0, 0.0,
      0.01, 0.0, 0.0,
      -0.01, 0.01, 0.0,
      0.01, 0.01, 0.0,
    ])
    const warmUvs = new Float32Array([0, 0, 1, 0, 0, 1, 1, 1])
    boostWarmupTrailGeometry.setAttribute('position', new THREE.BufferAttribute(warmPositions, 3))
    boostWarmupTrailGeometry.setAttribute('uv', new THREE.BufferAttribute(warmUvs, 2))
    if (webglShaderHooksEnabled) {
      const warmProgress = new Float32Array([0, 0, 1, 1])
      boostWarmupTrailGeometry.setAttribute('trailProgress', new THREE.BufferAttribute(warmProgress, 1))
    }
    boostWarmupTrailGeometry.setIndex([0, 2, 1, 1, 2, 3])
    const boostWarmupTrailMesh = new THREE.Mesh(boostWarmupTrailGeometry, boostWarmupTrailMaterial)
    boostWarmupTrailMesh.renderOrder = 1
    boostWarmupTrailMesh.scale.setScalar(0.01)
    boostWarmupTrailMesh.position.set(0, 0, 0)
    boostWarmupGroup.add(boostWarmupTrailMesh)

    try {
      renderer.render(scene, camera)
    } catch {
      // Ignore warm-up failures; gameplay will still render (possibly with a first-boost stutter).
    }

    boostWarmupGroup.visible = false
  }

  warmBoostPipelinesOnce()

  const createBoostTrail = (): BoostTrailState => {
    const pooled = boostTrailPool.pop() ?? null
    if (pooled) {
      pooled.mesh.visible = false
      pooled.mesh.geometry.setDrawRange(0, 0)
      pooled.samples.length = 0
      pooled.boosting = false
      pooled.retiring = false
      pooled.retireStartedAt = 0
      pooled.retireInitialCount = 0
      pooled.retireCut = 0
      pooled.dirty = false
      const materialUserData = pooled.mesh.material.userData as BoostTrailMaterialUserData
      materialUserData.retireCut = 0
      if (materialUserData.retireCutUniform) {
        materialUserData.retireCutUniform.value = 0
      }
      boostTrailsGroup.add(pooled.mesh)
      return pooled
    }

    const material = createBoostTrailMaterial()
    const geometry = new THREE.BufferGeometry()
    const positionArray = new Float32Array(BOOST_TRAIL_MAX_VERTEX_COUNT * 3)
    const uvArray = new Float32Array(BOOST_TRAIL_MAX_VERTEX_COUNT * 2)
    const trailProgressArray = webglShaderHooksEnabled ? new Float32Array(BOOST_TRAIL_MAX_VERTEX_COUNT) : null
    const indexArray = new Uint16Array(BOOST_TRAIL_MAX_INDEX_COUNT)

    const positionAttr = new THREE.BufferAttribute(positionArray, 3)
    positionAttr.setUsage(THREE.DynamicDrawUsage)
    const uvAttr = new THREE.BufferAttribute(uvArray, 2)
    uvAttr.setUsage(THREE.DynamicDrawUsage)
    geometry.setAttribute('position', positionAttr)
    geometry.setAttribute('uv', uvAttr)
    let trailProgressAttr: THREE.BufferAttribute | null = null
    if (webglShaderHooksEnabled && trailProgressArray) {
      trailProgressAttr = new THREE.BufferAttribute(trailProgressArray, 1)
      trailProgressAttr.setUsage(THREE.DynamicDrawUsage)
      geometry.setAttribute('trailProgress', trailProgressAttr)
    }
    const indexAttr = new THREE.BufferAttribute(indexArray, 1)
    indexAttr.setUsage(THREE.DynamicDrawUsage)
    geometry.setIndex(indexAttr)
    geometry.setDrawRange(0, 0)
    // Avoid recomputing bounds on every rebuild. Trails are always on the planet surface.
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), PLANET_RADIUS + 2)

    const mesh = new THREE.Mesh(geometry, material)
    mesh.visible = false
    mesh.renderOrder = 1
    boostTrailsGroup.add(mesh)
    const projectedPoints: THREE.Vector3[] = new Array(BOOST_TRAIL_MAX_CENTER_POINTS)
    for (let i = 0; i < projectedPoints.length; i += 1) {
      projectedPoints[i] = new THREE.Vector3()
    }
    const curvePoints: THREE.Vector3[] = []
    const curve = new THREE.CatmullRomCurve3(
      [new THREE.Vector3(), new THREE.Vector3()],
      false,
      'centripetal',
      0.25,
    )
    return {
      mesh,
      samples: [],
      boosting: false,
      retiring: false,
      retireStartedAt: 0,
      retireInitialCount: 0,
      retireCut: 0,
      dirty: false,
      curve,
      curvePoints,
      projectedPoints,
      positionAttr,
      uvAttr,
      trailProgressAttr,
      indexAttr,
    }
  }

  const disposeBoostTrail = (trail: BoostTrailState) => {
    boostTrailsGroup.remove(trail.mesh)
    trail.mesh.geometry.dispose()
    trail.mesh.material.dispose()
  }

  const recycleBoostTrail = (trail: BoostTrailState) => {
    boostTrailsGroup.remove(trail.mesh)
    trail.mesh.visible = false
    trail.mesh.geometry.setDrawRange(0, 0)
    trail.samples.length = 0
    trail.boosting = false
    trail.retiring = false
    trail.retireStartedAt = 0
    trail.retireInitialCount = 0
    trail.retireCut = 0
    trail.dirty = false
    const materialUserData = trail.mesh.material.userData as BoostTrailMaterialUserData
    materialUserData.retireCut = 0
    if (materialUserData.retireCutUniform) {
      materialUserData.retireCutUniform.value = 0
    }
    if (boostTrailPool.length >= BOOST_TRAIL_POOL_MAX) {
      disposeBoostTrail(trail)
      return
    }
    boostTrailPool.push(trail)
  }

  const setBoostTrailRetireCut = (trail: BoostTrailState) => {
    const retireCut = trail.retiring ? clamp(trail.retireCut, 0, 1) : 0
    const materialUserData = trail.mesh.material.userData as BoostTrailMaterialUserData
    materialUserData.retireCut = retireCut
    if (materialUserData.retireCutUniform) {
      materialUserData.retireCutUniform.value = retireCut
    }
  }

  const getTrailSurfacePointFromNormal = (
    normal: THREE.Vector3,
    out: THREE.Vector3,
  ) => {
    const radius = getTerrainRadius(normal)
    out.copy(normal).multiplyScalar(radius + BOOST_TRAIL_SURFACE_OFFSET)
    return out
  }

  const slerpNormals = (
    a: THREE.Vector3,
    b: THREE.Vector3,
    t: number,
    out: THREE.Vector3,
  ) => {
    const dotValue = clamp(a.dot(b), -1, 1)
    if (dotValue > 0.9995) {
      return out.copy(a).lerp(b, t).normalize()
    }
    const theta = Math.acos(dotValue)
    const sinTheta = Math.sin(theta)
    if (sinTheta <= 1e-5) {
      return out.copy(a).lerp(b, t).normalize()
    }
    const wA = Math.sin((1 - t) * theta) / sinTheta
    const wB = Math.sin(t * theta) / sinTheta
    out.set(
      a.x * wA + b.x * wB,
      a.y * wA + b.y * wB,
      a.z * wA + b.z * wB,
    )
    if (out.lengthSq() <= 1e-10) {
      return out.copy(a).normalize()
    }
    return out.normalize()
  }

  const markBoostTrailDirty = (trail: BoostTrailState) => {
    trail.dirty = true
  }

  const trimBoostTrailSamples = (trail: BoostTrailState) => {
    if (trail.samples.length <= BOOST_TRAIL_MAX_SAMPLES) return
    const excess = trail.samples.length - BOOST_TRAIL_MAX_SAMPLES
    trail.samples.splice(0, excess)
    if (trail.retiring) {
      trail.retireInitialCount = Math.max(1, trail.samples.length)
    }
  }

  const pushBoostTrailSample = (
    trail: BoostTrailState,
    normal: THREE.Vector3,
    nowMs: number,
  ) => {
    getTrailSurfacePointFromNormal(normal, trailSamplePointTemp)
    trail.samples.push({
      point: trailSamplePointTemp.clone(),
      normal: normal.clone(),
      createdAt: nowMs,
    })
    trimBoostTrailSamples(trail)
    markBoostTrailDirty(trail)
  }

  const appendBoostTrailSample = (
    trail: BoostTrailState,
    normal: THREE.Vector3,
    nowMs: number,
  ) => {
    if (!Number.isFinite(normal.x) || !Number.isFinite(normal.y) || !Number.isFinite(normal.z)) {
      return
    }
    const normalized = trailSlerpNormalTemp.copy(normal)
    if (normalized.lengthSq() <= 1e-10) return
    normalized.normalize()
    const last = trail.samples[trail.samples.length - 1]
    if (!last) {
      pushBoostTrailSample(trail, normalized, nowMs)
      return
    }

    getTrailSurfacePointFromNormal(normalized, trailSamplePointTemp)
    const minDistanceSq = BOOST_TRAIL_MIN_SAMPLE_DISTANCE * BOOST_TRAIL_MIN_SAMPLE_DISTANCE
    if (trailSamplePointTemp.distanceToSquared(last.point) < minDistanceSq) {
      return
    }

    const arcAngle = Math.acos(clamp(last.normal.dot(normalized), -1, 1))
    const subdivisions = Math.max(0, Math.ceil(arcAngle / BOOST_TRAIL_MAX_ARC_ANGLE) - 1)
    if (subdivisions > 0) {
      for (let step = 1; step <= subdivisions; step += 1) {
        const t = step / (subdivisions + 1)
        slerpNormals(last.normal, normalized, t, trailSlerpNormalTemp)
        pushBoostTrailSample(trail, trailSlerpNormalTemp, nowMs)
      }
    }
    pushBoostTrailSample(trail, normalized, nowMs)
  }

  const beginBoostTrailRetirement = (trail: BoostTrailState, nowMs: number) => {
    if (trail.samples.length === 0) {
      trail.retiring = false
      trail.retireInitialCount = 0
      trail.retireCut = 0
      return
    }
    trail.retiring = true
    trail.retireStartedAt = nowMs
    trail.retireInitialCount = trail.samples.length
    if (trail.retireCut !== 0) {
      trail.retireCut = 0
      if (!webglShaderHooksEnabled) {
        // WebGPU fallback encodes retire fade in UVs, so it needs a geometry rebuild.
        markBoostTrailDirty(trail)
      }
    }
  }

  const advanceBoostTrailRetirement = (trail: BoostTrailState, nowMs: number) => {
    if (!trail.retiring) return
    const durationMs = BOOST_TRAIL_FADE_SECONDS * 1000
    const elapsed = Math.max(0, nowMs - trail.retireStartedAt)
    const t = durationMs > 0 ? clamp(elapsed / durationMs, 0, 1) : 1
    if (Math.abs(trail.retireCut - t) > 1e-4) {
      trail.retireCut = t
      if (!webglShaderHooksEnabled) {
        // WebGPU fallback encodes retire fade in UVs, so it needs a geometry rebuild.
        markBoostTrailDirty(trail)
      }
    }
    if (t >= 1 || trail.samples.length === 0) {
      if (trail.samples.length > 0) {
        trail.samples.length = 0
      }
      trail.retiring = false
      trail.retireInitialCount = 0
      trail.retireCut = 0
    }
  }

  const rebuildBoostTrailGeometry = (trail: BoostTrailState) => {
    if (!trail.dirty) return
    trail.dirty = false
    const points = trail.samples
    if (points.length < 2) {
      trail.mesh.visible = false
      trail.mesh.geometry.setDrawRange(0, 0)
      return
    }

    const curvePoints = trail.curvePoints
    curvePoints.length = points.length
    for (let i = 0; i < points.length; i += 1) {
      curvePoints[i] = points[i].point
    }
    trail.curve.points = curvePoints
    const curveSegments = Math.max(
      8,
      Math.min(BOOST_TRAIL_MAX_CURVE_SEGMENTS, (curvePoints.length - 1) * BOOST_TRAIL_CURVE_SEGMENTS_PER_POINT),
    )
    const centerCount = curveSegments + 1
    const projectedPoints = trail.projectedPoints
    for (let i = 0; i < centerCount; i += 1) {
      const t = curveSegments > 0 ? i / curveSegments : 0
      trail.curve.getPoint(t, trailReprojectPointTemp)
      trailReprojectNormalTemp.copy(trailReprojectPointTemp)
      if (trailReprojectNormalTemp.lengthSq() <= 1e-10) {
        projectedPoints[i].copy(trailReprojectPointTemp)
        continue
      }
      trailReprojectNormalTemp.normalize()
      getTrailSurfacePointFromNormal(trailReprojectNormalTemp, projectedPoints[i])
    }

    const positionArray = trail.positionAttr.array as Float32Array
    const uvArray = trail.uvAttr.array as Float32Array
    const trailProgressArray = trail.trailProgressAttr
      ? (trail.trailProgressAttr.array as Float32Array)
      : null
    const indexArray = trail.indexAttr.array as Uint16Array
    const segmentCount = centerCount - 1
    const halfWidth = BOOST_TRAIL_WIDTH * 0.5
    const retireCut = trail.retiring ? clamp(trail.retireCut, 0, 0.9999) : 0
    const retireFadeEnd = trail.retiring
      ? clamp(retireCut + BOOST_TRAIL_RETIRE_FEATHER, retireCut + 1e-4, 1)
      : 0
    const edgeCap = clamp(BOOST_TRAIL_EDGE_FADE_CAP, 1e-4, 0.5)

    for (let i = 0; i < centerCount; i += 1) {
      const center = projectedPoints[i]
      const prev = i > 0 ? projectedPoints[i - 1] : null
      const next = i < centerCount - 1 ? projectedPoints[i + 1] : null
      if (!center) continue
      trailReprojectNormalTemp.copy(center)
      if (trailReprojectNormalTemp.lengthSq() <= 1e-10) {
        trailReprojectNormalTemp.set(0, 1, 0)
      } else {
        trailReprojectNormalTemp.normalize()
      }

      if (prev && next) {
        trailTangentTemp.copy(next).sub(prev)
      } else if (next) {
        trailTangentTemp.copy(next).sub(center)
      } else if (prev) {
        trailTangentTemp.copy(center).sub(prev)
      } else {
        trailTangentTemp.set(0, 0, 0)
      }
      trailTangentTemp.addScaledVector(
        trailReprojectNormalTemp,
        -trailTangentTemp.dot(trailReprojectNormalTemp),
      )
      if (trailTangentTemp.lengthSq() <= 1e-10) {
        buildTangentBasis(trailReprojectNormalTemp, trailTangentTemp, trailSideTemp)
      } else {
        trailTangentTemp.normalize()
        trailSideTemp.crossVectors(trailTangentTemp, trailReprojectNormalTemp)
        if (trailSideTemp.lengthSq() <= 1e-10) {
          buildTangentBasis(trailReprojectNormalTemp, trailTangentTemp, trailSideTemp)
        } else {
          trailSideTemp.normalize()
        }
      }

      const leftVertexIndex = i * 2
      const rightVertexIndex = leftVertexIndex + 1
      const baseU = centerCount > 1 ? i / (centerCount - 1) : 0
      let u = baseU
      if (!webglShaderHooksEnabled && trail.retiring) {
        if (baseU <= retireCut) {
          u = 0
        } else if (baseU < retireFadeEnd) {
          const fadeT = (baseU - retireCut) / Math.max(1e-4, retireFadeEnd - retireCut)
          u = smoothstep(0, 1, fadeT) * edgeCap
        } else {
          const remainT = (baseU - retireFadeEnd) / Math.max(1e-4, 1 - retireFadeEnd)
          u = edgeCap + clamp(remainT, 0, 1) * (1 - edgeCap)
        }
      }

      trailOffsetTemp.copy(center).addScaledVector(trailSideTemp, halfWidth)
      trailReprojectPointTemp.copy(trailOffsetTemp)
      if (trailReprojectPointTemp.lengthSq() > 1e-10) {
        trailReprojectPointTemp.normalize()
      } else {
        trailReprojectPointTemp.copy(trailReprojectNormalTemp)
      }
      getTrailSurfacePointFromNormal(trailReprojectPointTemp, trailOffsetTemp)
      positionArray[leftVertexIndex * 3] = trailOffsetTemp.x
      positionArray[leftVertexIndex * 3 + 1] = trailOffsetTemp.y
      positionArray[leftVertexIndex * 3 + 2] = trailOffsetTemp.z
      uvArray[leftVertexIndex * 2] = u
      uvArray[leftVertexIndex * 2 + 1] = 0
      if (trailProgressArray) {
        trailProgressArray[leftVertexIndex] = baseU
      }

      trailOffsetTemp.copy(center).addScaledVector(trailSideTemp, -halfWidth)
      trailReprojectPointTemp.copy(trailOffsetTemp)
      if (trailReprojectPointTemp.lengthSq() > 1e-10) {
        trailReprojectPointTemp.normalize()
      } else {
        trailReprojectPointTemp.copy(trailReprojectNormalTemp)
      }
      getTrailSurfacePointFromNormal(trailReprojectPointTemp, trailOffsetTemp)
      positionArray[rightVertexIndex * 3] = trailOffsetTemp.x
      positionArray[rightVertexIndex * 3 + 1] = trailOffsetTemp.y
      positionArray[rightVertexIndex * 3 + 2] = trailOffsetTemp.z
      uvArray[rightVertexIndex * 2] = u
      uvArray[rightVertexIndex * 2 + 1] = 1
      if (trailProgressArray) {
        trailProgressArray[rightVertexIndex] = baseU
      }
    }

    let indexOffset = 0
    for (let i = 0; i < segmentCount; i += 1) {
      const currentLeft = i * 2
      const currentRight = currentLeft + 1
      const nextLeft = currentLeft + 2
      const nextRight = currentLeft + 3
      indexArray[indexOffset] = currentLeft
      indexArray[indexOffset + 1] = nextLeft
      indexArray[indexOffset + 2] = currentRight
      indexArray[indexOffset + 3] = currentRight
      indexArray[indexOffset + 4] = nextLeft
      indexArray[indexOffset + 5] = nextRight
      indexOffset += 6
    }

    trail.mesh.geometry.setDrawRange(0, segmentCount * 6)
    trail.positionAttr.needsUpdate = true
    trail.uvAttr.needsUpdate = true
    if (trail.trailProgressAttr) {
      trail.trailProgressAttr.needsUpdate = true
    }
    trail.indexAttr.needsUpdate = true
    trail.mesh.visible = true
  }

  const tickBoostTrailSet = (playerId: string, trails: BoostTrailState[], nowMs: number) => {
    for (let i = trails.length - 1; i >= 0; i -= 1) {
      const trail = trails[i]
      advanceBoostTrailRetirement(trail, nowMs)
      setBoostTrailRetireCut(trail)
      rebuildBoostTrailGeometry(trail)
      if (!trail.boosting && !trail.retiring && trail.samples.length === 0) {
        recycleBoostTrail(trail)
        trails.splice(i, 1)
      }
    }
    if (trails.length === 0) {
      boostTrails.delete(playerId)
    }
  }

  const updateBoostTrailForPlayer = (
    player: PlayerSnapshot,
    tailContactNormal: THREE.Vector3 | null,
    nowMs: number,
  ) => {
    const hasSnake = player.alive && player.snakeDetail !== 'stub' && player.snake.length > 0
    const shouldBoost = hasSnake && player.isBoosting
    let trails = boostTrails.get(player.id)

    if (shouldBoost) {
      if (!trails) {
        trails = []
        boostTrails.set(player.id, trails)
      }
      let activeTrail = trails.find((trail) => trail.boosting) ?? null
      if (!activeTrail) {
        activeTrail = createBoostTrail()
        activeTrail.boosting = true
        trails.push(activeTrail)
      }
      for (const trail of trails) {
        if (trail === activeTrail || !trail.boosting) continue
        trail.boosting = false
        beginBoostTrailRetirement(trail, nowMs)
      }
      if (activeTrail.retiring) {
        activeTrail.retiring = false
        activeTrail.retireInitialCount = 0
        if (activeTrail.retireCut !== 0) {
          activeTrail.retireCut = 0
          if (!webglShaderHooksEnabled) {
            // WebGPU fallback encodes retire fade in UVs, so it needs a geometry rebuild.
            markBoostTrailDirty(activeTrail)
          }
        }
      }
      if (tailContactNormal) {
        trailSlerpNormalTemp.copy(tailContactNormal)
      } else {
        const tail = player.snake[player.snake.length - 1]
        trailSlerpNormalTemp.set(tail.x, tail.y, tail.z)
      }
      if (trailSlerpNormalTemp.lengthSq() > 1e-10) {
        appendBoostTrailSample(activeTrail, trailSlerpNormalTemp, nowMs)
      }
    } else {
      if (!trails) return
      for (const trail of trails) {
        if (!trail.boosting) continue
        trail.boosting = false
        beginBoostTrailRetirement(trail, nowMs)
      }
    }

    if (!trails) return
    tickBoostTrailSet(player.id, trails, nowMs)
  }

  const updateInactiveBoostTrails = (
    activeIds: Set<string>,
    nowMs: number,
  ) => {
    for (const [id, trails] of boostTrails) {
      if (activeIds.has(id)) continue
      for (const trail of trails) {
        if (!trail.boosting) continue
        trail.boosting = false
        beginBoostTrailRetirement(trail, nowMs)
      }
      tickBoostTrailSet(id, trails, nowMs)
    }
  }

  const sampleSnakeContactLift = (
    normal: THREE.Vector3,
    tangent: THREE.Vector3,
    centerlineRadius: number,
    supportRadius: number,
    clearance: number,
    stats: SnakeGroundingInfo | null,
  ) => {
    if (supportRadius <= 0) return 0
    snakeContactTangentTemp.copy(tangent)
    snakeContactTangentTemp.addScaledVector(normal, -snakeContactTangentTemp.dot(normal))
    if (snakeContactTangentTemp.lengthSq() <= 1e-8) {
      buildTangentBasis(normal, snakeContactTangentTemp, snakeContactBitangentTemp)
    } else {
      snakeContactTangentTemp.normalize()
      snakeContactBitangentTemp.crossVectors(normal, snakeContactTangentTemp)
      if (snakeContactBitangentTemp.lengthSq() <= 1e-8) {
        buildTangentBasis(normal, snakeContactTangentTemp, snakeContactBitangentTemp)
      } else {
        snakeContactBitangentTemp.normalize()
      }
    }

    snakeContactCenterTemp.copy(normal).multiplyScalar(centerlineRadius)
    let maxLift = 0
    const sampleCount = Math.max(3, SNAKE_CONTACT_ARC_SAMPLES)
    const denominator = sampleCount - 1
    for (let i = 0; i < sampleCount; i += 1) {
      const t = denominator > 0 ? i / denominator : 0.5
      const angle = -Math.PI * 0.5 + t * Math.PI
      const sin = Math.sin(angle)
      const cos = Math.cos(angle)
      snakeContactOffsetTemp.copy(snakeContactBitangentTemp).multiplyScalar(sin)
      snakeContactOffsetTemp.addScaledVector(normal, -cos)
      snakeContactPointTemp
        .copy(snakeContactCenterTemp)
        .addScaledVector(snakeContactOffsetTemp, supportRadius)
      const pointRadius = snakeContactPointTemp.length()
      if (!Number.isFinite(pointRadius) || pointRadius <= 1e-6) continue
      snakeContactNormalTemp.copy(snakeContactPointTemp).multiplyScalar(1 / pointRadius)
      const terrainRadius = getTerrainRadius(snakeContactNormalTemp)
      const requiredRadius = terrainRadius + clearance
      const clearanceValue = pointRadius - requiredRadius
      if (stats) {
        stats.sampleCount += 1
        stats.minClearance = Math.min(stats.minClearance, clearanceValue)
        if (clearanceValue < 0) {
          stats.maxPenetration = Math.max(stats.maxPenetration, -clearanceValue)
        }
      }
      if (clearanceValue >= 0) continue

      const pointDotNormal = snakeContactPointTemp.dot(normal)
      const requiredSq = requiredRadius * requiredRadius
      const pointSq = pointRadius * pointRadius
      const discriminant = Math.max(
        0,
        pointDotNormal * pointDotNormal + (requiredSq - pointSq),
      )
      let lift = -clearanceValue
      const solvedLift = -pointDotNormal + Math.sqrt(discriminant)
      if (Number.isFinite(solvedLift) && solvedLift > lift) {
        lift = solvedLift
      }
      if (lift > maxLift) maxLift = lift
    }

    return maxLift
  }

  const applySnakeContactLift = (
    normal: THREE.Vector3,
    tangent: THREE.Vector3,
    centerlineRadius: number,
    supportRadius: number,
    groundingInfo: SnakeGroundingInfo | null,
  ) => {
    let liftedRadius = centerlineRadius
    let totalLift = 0
    for (let iteration = 0; iteration < SNAKE_CONTACT_LIFT_ITERATIONS; iteration += 1) {
      const lift = sampleSnakeContactLift(
        normal,
        tangent,
        liftedRadius,
        supportRadius,
        SNAKE_CONTACT_CLEARANCE,
        null,
      )
      if (lift <= SNAKE_CONTACT_LIFT_EPS) break
      liftedRadius += lift
      totalLift += lift
    }
    if (groundingInfo) {
      sampleSnakeContactLift(
        normal,
        tangent,
        liftedRadius,
        supportRadius,
        SNAKE_CONTACT_CLEARANCE,
        groundingInfo,
      )
      groundingInfo.maxAppliedLift = Math.max(groundingInfo.maxAppliedLift, totalLift)
    }
    return totalLift
  }

  const getSnakeCenterlineRadius = (
    normal: THREE.Vector3,
    radiusOffset: number,
    snakeRadius: number,
  ) => {
    const sample = sampleLakes(normal, lakes, lakeSampleTemp)
    const terrainRadius = getTerrainRadius(normal, sample)
    let centerlineRadius = terrainRadius + radiusOffset
    if (!sample.lake || sample.boundary <= LAKE_WATER_MASK_THRESHOLD) {
      return centerlineRadius
    }

    const boundary = clamp(sample.boundary, 0, 1)
    const submergeBlend = smoothstep(
      SNAKE_WATERLINE_BLEND_START,
      SNAKE_WATERLINE_BLEND_END,
      boundary,
    )
    if (submergeBlend <= 0) return centerlineRadius

    const waterRadius = PLANET_RADIUS - sample.lake.surfaceInset
    const minCenterlineRadius = terrainRadius + SNAKE_MIN_TERRAIN_CLEARANCE
    const maxUnderwaterRadius = waterRadius - (snakeRadius + SNAKE_UNDERWATER_CLEARANCE)
    const submergedRadius = Math.max(
      minCenterlineRadius,
      Math.min(centerlineRadius, maxUnderwaterRadius),
    )
    centerlineRadius += (submergedRadius - centerlineRadius) * submergeBlend
    return centerlineRadius
  }

  const buildSnakeCurvePoints = (
    nodes: Point[],
    radiusOffset: number,
    snakeRadius: number,
    groundingInfo: SnakeGroundingInfo | null,
  ) => {
    const curvePoints: THREE.Vector3[] = []
    if (nodes.length === 0) return curvePoints

    const nodeNormals = new Array<THREE.Vector3>(nodes.length)
    for (let i = 0; i < nodes.length; i += 1) {
      const node = nodes[i]
      nodeNormals[i] = new THREE.Vector3(node.x, node.y, node.z).normalize()
    }

    const nodeTangents = new Array<THREE.Vector3>(nodes.length)
    for (let i = 0; i < nodeNormals.length; i += 1) {
      const normal = nodeNormals[i]
      snakeContactFallbackTemp.set(0, 0, 0)
      if (i + 1 < nodeNormals.length) {
        snakeContactFallbackTemp.add(nodeNormals[i + 1]).addScaledVector(normal, -1)
      }
      if (i > 0) {
        snakeContactFallbackTemp.add(normal).addScaledVector(nodeNormals[i - 1], -1)
      }
      snakeContactFallbackTemp.addScaledVector(normal, -snakeContactFallbackTemp.dot(normal))
      if (snakeContactFallbackTemp.lengthSq() <= 1e-8) {
        buildTangentBasis(normal, snakeContactFallbackTemp, snakeContactOffsetTemp)
      } else {
        snakeContactFallbackTemp.normalize()
      }
      nodeTangents[i] = snakeContactFallbackTemp.clone()
    }

    const nodeRadii = new Array<number>(nodes.length)
    for (let i = 0; i < nodeNormals.length; i += 1) {
      const normal = nodeNormals[i]
      const tangent = nodeTangents[i]
      let nodeRadius = getSnakeCenterlineRadius(normal, radiusOffset, snakeRadius)
      nodeRadius += applySnakeContactLift(
        normal,
        tangent,
        nodeRadius,
        snakeRadius,
        groundingInfo,
      )
      nodeRadii[i] = nodeRadius
    }

    let prevNormal: THREE.Vector3 | null = null
    let prevTangent: THREE.Vector3 | null = null
    let prevRadius = nodeRadii[0] ?? PLANET_RADIUS + radiusOffset

    for (let i = 0; i < nodes.length; i += 1) {
      const normal = nodeNormals[i]
      const tangent = nodeTangents[i]
      const nodeRadius = nodeRadii[i]
      if (
        prevNormal &&
        prevTangent &&
        i > 1 &&
        i < nodes.length - 1 &&
        Math.abs(nodeRadius - prevRadius) >= SNAKE_SLOPE_INSERT_RADIUS_DELTA
      ) {
        const midpointNormal = prevNormal.clone().add(normal)
        if (midpointNormal.lengthSq() > 1e-8) {
          midpointNormal.normalize()
        } else {
          midpointNormal.copy(normal)
        }
        snakeContactFallbackTemp.copy(prevTangent).add(tangent)
        snakeContactFallbackTemp.addScaledVector(
          midpointNormal,
          -snakeContactFallbackTemp.dot(midpointNormal),
        )
        if (snakeContactFallbackTemp.lengthSq() <= 1e-8) {
          buildTangentBasis(midpointNormal, snakeContactFallbackTemp, snakeContactOffsetTemp)
        } else {
          snakeContactFallbackTemp.normalize()
        }
        let midpointRadius = getSnakeCenterlineRadius(
          midpointNormal,
          radiusOffset,
          snakeRadius,
        )
        midpointRadius += applySnakeContactLift(
          midpointNormal,
          snakeContactFallbackTemp,
          midpointRadius,
          snakeRadius,
          groundingInfo,
        )
        curvePoints.push(midpointNormal.multiplyScalar(midpointRadius))
      }

      curvePoints.push(normal.clone().multiplyScalar(nodeRadius))
      prevNormal = normal
      prevTangent = tangent
      prevRadius = nodeRadius
    }

    return curvePoints
  }

  const buildTailCapGeometry = (
    tubeGeometry: THREE.TubeGeometry,
    tailDirection: THREE.Vector3,
  ): THREE.BufferGeometry | null => {
    const params = tubeGeometry.parameters as { radialSegments?: number; tubularSegments?: number }
    const radialSegments = params.radialSegments ?? 8
    const tubularSegments = params.tubularSegments ?? 1
    const ringVertexCount = radialSegments + 1
    const ringStart = tubularSegments * ringVertexCount
    const positions = tubeGeometry.attributes.position
    const uvs = tubeGeometry.attributes.uv
    if (!positions || positions.count < ringStart + radialSegments) return null

    const ringPoints: THREE.Vector3[] = []
    const ringVectors: THREE.Vector3[] = []
    const center = new THREE.Vector3()

    for (let i = 0; i < radialSegments; i += 1) {
      const index = ringStart + i
      const point = new THREE.Vector3(
        positions.getX(index),
        positions.getY(index),
        positions.getZ(index),
      )
      ringPoints.push(point)
      center.add(point)
    }

    if (ringPoints.length === 0) return null
    center.multiplyScalar(1 / ringPoints.length)

    let radius = 0
    for (const point of ringPoints) {
      const vector = point.clone().sub(center)
      ringVectors.push(vector)
      radius += vector.length()
    }
    radius = radius / ringVectors.length
    if (!Number.isFinite(radius) || radius <= 0) return null

    const ringNormal = ringVectors[1 % radialSegments].clone().cross(ringVectors[0])
    if (ringNormal.lengthSq() < 1e-8) return null
    ringNormal.normalize()
    const tailDirNorm = tailDirection.clone().normalize()
    const flip = ringNormal.dot(tailDirNorm) < 0
    const capDir = flip ? ringNormal.clone().negate() : ringNormal.clone()

    const rings = Math.max(2, TAIL_CAP_SEGMENTS)
    const vertexCount = rings * radialSegments + 1
    const capPositions = new Float32Array(vertexCount * 3)
    const capUvs = new Float32Array(vertexCount * 2)

    let baseU = 1
    if (uvs && uvs.count > ringStart) {
      const candidate = uvs.getX(ringStart)
      if (Number.isFinite(candidate)) baseU = candidate
    }
    const uSpan = Math.max(0, SNAKE_TAIL_CAP_U_SPAN)
    // Keep the cap within the current RepeatWrapping cycle so slot colors don't snap across the seam,
    // but still vary u so ring-band stripes flow down the cap instead of flattening out.
    const minU = Math.floor(baseU) + 0.0001
    const capSpan = Math.min(uSpan, Math.max(0, baseU - minU))
    const ringDenom = Math.max(1, rings - 1)

    for (let s = 0; s < rings; s += 1) {
      const theta = (s / rings) * (Math.PI / 2)
      const scale = Math.cos(theta)
      const offset = Math.sin(theta) * radius
      const u = baseU - (s / ringDenom) * capSpan
      for (let i = 0; i < radialSegments; i += 1) {
        const vector = ringVectors[i]
        const point = center
          .clone()
          .addScaledVector(vector, scale)
          .addScaledVector(capDir, offset)
        const index = (s * radialSegments + i) * 3
        capPositions[index] = point.x
        capPositions[index + 1] = point.y
        capPositions[index + 2] = point.z

        const uvIndex = (s * radialSegments + i) * 2
        capUvs[uvIndex] = u
        capUvs[uvIndex + 1] = radialSegments > 0 ? i / radialSegments : 0
      }
    }

    const tip = center.clone().addScaledVector(capDir, radius)
    const tipOffset = rings * radialSegments * 3
    capPositions[tipOffset] = tip.x
    capPositions[tipOffset + 1] = tip.y
    capPositions[tipOffset + 2] = tip.z
    const tipUvOffset = rings * radialSegments * 2
    capUvs[tipUvOffset] = baseU - capSpan
    capUvs[tipUvOffset + 1] = 0

    const indices: number[] = []
    const pushTri = (a: number, b: number, c: number) => {
      if (flip) {
        indices.push(a, c, b)
      } else {
        indices.push(a, b, c)
      }
    }

    for (let s = 0; s < rings - 1; s += 1) {
      for (let i = 0; i < radialSegments; i += 1) {
        const next = (i + 1) % radialSegments
        const a = s * radialSegments + i
        const b = s * radialSegments + next
        const c = (s + 1) * radialSegments + i
        const d = (s + 1) * radialSegments + next
        pushTri(a, c, b)
        pushTri(b, c, d)
      }
    }

    const tipIndex = rings * radialSegments
    const lastRingStart = (rings - 1) * radialSegments
    for (let i = 0; i < radialSegments; i += 1) {
      const next = (i + 1) % radialSegments
      const a = lastRingStart + i
      const b = lastRingStart + next
      pushTri(a, tipIndex, b)
    }

    const capGeometry = new THREE.BufferGeometry()
    capGeometry.setAttribute('position', new THREE.BufferAttribute(capPositions, 3))
    capGeometry.setAttribute('uv', new THREE.BufferAttribute(capUvs, 2))
    capGeometry.setIndex(indices)
    capGeometry.computeVertexNormals()
    capGeometry.computeBoundingSphere()
    return capGeometry
  }

  const computeDigestionStartOffset = (curvePoints: THREE.Vector3[]) => {
    if (curvePoints.length < 2) return 0
    const segmentCount = Math.max(1, curvePoints.length - 1)
    const startNode = Math.round(clamp(DIGESTION_START_NODE_INDEX, 0, segmentCount))
    return clamp(startNode / segmentCount, 0, 0.95)
  }

  const applyDigestionBulges = (
    tubeGeometry: THREE.TubeGeometry,
    digestions: DigestionVisual[],
    headStartOffset: number,
    bulgeScale: number,
  ) => {
    if (!digestions.length) return 0
    const params = tubeGeometry.parameters as { radialSegments?: number; tubularSegments?: number }
    const radialSegments = params.radialSegments ?? 8
    const tubularSegments = params.tubularSegments ?? 1
    const ringVertexCount = radialSegments + 1
    const ringCount = tubularSegments + 1
    const positions = tubeGeometry.attributes.position
    if (!positions) return 0

    const bulgeByRing = new Array<number>(ringCount).fill(0)
    const startOffset = clamp(headStartOffset, 0, 0.95)
    const headStartRing = Math.ceil(startOffset * Math.max(1, ringCount - 1))
    for (const digestion of digestions) {
      const strength = clamp(digestion.strength, 0, 1)
      if (strength <= 0) continue
      const influenceRadius = THREE.MathUtils.lerp(DIGESTION_WIDTH_MIN, DIGESTION_WIDTH_MAX, strength)
      const bulgeStrength =
        THREE.MathUtils.lerp(DIGESTION_BULGE_MIN, DIGESTION_BULGE_MAX, strength) * bulgeScale
      const t = clamp(digestion.t, 0, 1)
      const mapped = startOffset + t * Math.max(0, 1 - startOffset)
      const center = mapped * (ringCount - 1)
      const start = Math.max(0, Math.floor(center - influenceRadius))
      const end = Math.min(ringCount - 1, Math.ceil(center + influenceRadius))
      const sigma = Math.max(0.5, influenceRadius * 0.7)
      const tailFade = smoothstep(0, 0.016, 1 - mapped)
      const travelFade = tailFade
      if (travelFade <= 0) continue
      for (let ring = start; ring <= end; ring += 1) {
        if (ring < headStartRing) continue
        const dist = ring - center
        const normalized = dist / sigma
        const weight = Math.exp(-0.5 * normalized * normalized)
        bulgeByRing[ring] += weight * bulgeStrength * travelFade
      }
    }
    for (let pass = 0; pass < 2; pass += 1) {
      const source = bulgeByRing.slice()
      for (let ring = 0; ring < ringCount; ring += 1) {
        const prev = source[Math.max(0, ring - 1)]
        const current = source[ring]
        const next = source[Math.min(ringCount - 1, ring + 1)]
        bulgeByRing[ring] = prev * 0.22 + current * 0.56 + next * 0.22
      }
    }
    for (let ring = 0; ring < ringCount; ring += 1) {
      const distanceToEdge = Math.min(ring, ringCount - 1 - ring)
      const edgeClamp = smoothstep(0, 1.35, distanceToEdge)
      const maxRingBulge = THREE.MathUtils.lerp(
        DIGESTION_MAX_BULGE_MIN,
        DIGESTION_MAX_BULGE_MAX,
        edgeClamp,
      ) * bulgeScale
      const rawBulge = Math.max(0, bulgeByRing[ring])
      if (rawBulge <= 0) {
        bulgeByRing[ring] = 0
        continue
      }
      const saturated = maxRingBulge * (1 - Math.exp(-rawBulge / Math.max(maxRingBulge, 1e-4)))
      bulgeByRing[ring] = Math.min(maxRingBulge, saturated)
    }

    let maxAppliedBulge = 0
    const center = new THREE.Vector3()
    const vertex = new THREE.Vector3()
    for (let ring = 0; ring < ringCount; ring += 1) {
      const bulge = bulgeByRing[ring]
      if (bulge <= 0) continue
      if (bulge > maxAppliedBulge) maxAppliedBulge = bulge
      center.set(0, 0, 0)
      const ringStart = ring * ringVertexCount
      for (let i = 0; i < radialSegments; i += 1) {
        const index = ringStart + i
        center.x += positions.getX(index)
        center.y += positions.getY(index)
        center.z += positions.getZ(index)
      }
      center.multiplyScalar(1 / radialSegments)

      const scale = 1 + bulge
      for (let i = 0; i < ringVertexCount; i += 1) {
        const index = ringStart + i
        vertex.set(positions.getX(index), positions.getY(index), positions.getZ(index))
        vertex.sub(center).multiplyScalar(scale).add(center)
        positions.setXYZ(index, vertex.x, vertex.y, vertex.z)
      }
    }

    positions.needsUpdate = true
    tubeGeometry.computeVertexNormals()
    return maxAppliedBulge
  }

  const buildDigestionVisuals = (digestions: DigestionSnapshot[]) => {
    const visuals: DigestionVisual[] = []
    for (const digestion of digestions) {
      const progress = clamp(digestion.progress, 0, 2)
      const travelT = clamp(progress, 0, 1)
      const dissolve = progress > 1 ? 1 - clamp(progress - 1, 0, 1) : 1
      const travelBiased = Math.pow(travelT, DIGESTION_TRAVEL_EASE)
      const strength = clamp(digestion.strength, 0.05, 1) * dissolve
      if (strength <= 1e-4) continue
      visuals.push({ t: travelBiased, strength })
    }
    return visuals
  }


  const projectToTangentPlane = (direction: THREE.Vector3, normal: THREE.Vector3) => {
    const projected = direction.clone().addScaledVector(normal, -direction.dot(normal))
    if (projected.lengthSq() <= 1e-8) return null
    return projected.normalize()
  }

  const transportDirectionOnSphere = (
    direction: THREE.Vector3,
    fromNormal: THREE.Vector3,
    toNormal: THREE.Vector3,
  ) => {
    const from = fromNormal.clone().normalize()
    const to = toNormal.clone().normalize()
    const aligned = clamp(from.dot(to), -1, 1)
    const transported = direction.clone()

    if (aligned < 0.999_999) {
      const axis = from.clone().cross(to)
      if (axis.lengthSq() > 1e-10) {
        axis.normalize()
        transported.applyAxisAngle(axis, Math.acos(aligned))
      } else if (aligned < -0.999_999) {
        const fallbackAxis = new THREE.Vector3(1, 0, 0).cross(from)
        if (fallbackAxis.lengthSq() < 1e-8) {
          fallbackAxis.set(0, 1, 0).cross(from)
        }
        if (fallbackAxis.lengthSq() > 1e-8) {
          fallbackAxis.normalize()
          transported.applyAxisAngle(fallbackAxis, Math.PI)
        }
      }
    }

    return projectToTangentPlane(transported, to)
  }

  const computeTailDirectionFromRecentSegments = (
    curvePoints: THREE.Vector3[],
    tailNormal: THREE.Vector3,
    minSegmentLength: number,
  ) => {
    const segmentCount = curvePoints.length - 1
    if (segmentCount <= 0) return null
    const sampleCount = Math.min(5, segmentCount)
    const directionAccum = new THREE.Vector3()
    let totalWeight = 0
    const stableLength = Math.max(minSegmentLength, 1e-6)

    for (let sample = 0; sample < sampleCount; sample += 1) {
      const endIndex = curvePoints.length - 1 - sample
      const startIndex = endIndex - 1
      if (startIndex < 0) break
      const endPoint = curvePoints[endIndex]
      const startPoint = curvePoints[startIndex]
      const segment = endPoint.clone().sub(startPoint)
      const segmentLength = segment.length()
      if (segmentLength <= 1e-8) continue

      const endNormal = endPoint.clone().normalize()
      const localTangent = projectToTangentPlane(segment.multiplyScalar(1 / segmentLength), endNormal)
      if (!localTangent) continue

      const transported = transportDirectionOnSphere(localTangent, endNormal, tailNormal)
      if (!transported) continue

      const recencyWeight = 1 / (sample + 1)
      const lengthWeight = clamp(segmentLength / (stableLength * 1.8), 0.05, 1)
      const weight = recencyWeight * lengthWeight
      directionAccum.addScaledVector(transported, weight)
      totalWeight += weight
    }

    if (totalWeight <= 1e-8 || directionAccum.lengthSq() <= 1e-8) return null
    return directionAccum.normalize()
  }

  const computeTailExtendDirection = (
    curvePoints: THREE.Vector3[],
    minSegmentLength: number,
    previousDirection?: THREE.Vector3 | null,
    frameState?: TailFrameState | null,
  ) => {
    if (curvePoints.length < 2) return null
    const tailPos = curvePoints[curvePoints.length - 1]
    const prevPos = curvePoints[curvePoints.length - 2]
    const tailNormal = tailPos.clone().normalize()
    const stableLength = Math.max(minSegmentLength, 1e-6)

    const recentDirection = computeTailDirectionFromRecentSegments(
      curvePoints,
      tailNormal,
      stableLength,
    )
    const frameDirection =
      frameState && frameState.tangent.lengthSq() > 1e-8
        ? transportDirectionOnSphere(frameState.tangent, frameState.normal, tailNormal)
        : null
    const previousProjected =
      previousDirection && previousDirection.lengthSq() > 1e-8
        ? projectToTangentPlane(previousDirection, tailNormal)
        : null
    const alignReference = recentDirection ?? frameDirection ?? previousProjected
    const alignToReference = (direction: THREE.Vector3 | null) => {
      if (!direction || !alignReference) return direction
      if (direction.dot(alignReference) < 0) {
        direction.multiplyScalar(-1)
      }
      return direction
    }

    const recentAligned = alignToReference(recentDirection)
    const frameAligned = alignToReference(frameDirection)
    const previousAligned = alignToReference(previousProjected)

    let chosenDirection: THREE.Vector3 | null
    if (recentAligned && frameAligned) {
      const tailSegmentLength = tailPos.distanceTo(prevPos)
      const tailConfidence = clamp(tailSegmentLength / (stableLength * 1.6), 0, 1)
      const recentWeight = 0.6 + tailConfidence * 0.3
      chosenDirection = frameAligned
        .clone()
        .multiplyScalar(1 - recentWeight)
        .addScaledVector(recentAligned, recentWeight)
    } else {
      chosenDirection = recentAligned?.clone() ?? frameAligned?.clone() ?? previousAligned?.clone() ?? null
    }

    if (!chosenDirection || chosenDirection.lengthSq() <= 1e-8) {
      chosenDirection = projectToTangentPlane(tailPos.clone().sub(prevPos), tailNormal)
    }
    if (!chosenDirection || chosenDirection.lengthSq() <= 1e-8) {
      chosenDirection = previousAligned?.clone() ?? null
    }
    if (!chosenDirection || chosenDirection.lengthSq() <= 1e-8) {
      chosenDirection = tailNormal.clone().cross(new THREE.Vector3(0, 1, 0))
      if (chosenDirection.lengthSq() <= 1e-8) {
        chosenDirection.crossVectors(tailNormal, new THREE.Vector3(1, 0, 0))
      }
    }

    if (chosenDirection.lengthSq() <= 1e-8) return null
    return chosenDirection.normalize()
  }

  const storeTailFrameState = (
    playerId: string,
    tailNormal: THREE.Vector3,
    tailDirection: THREE.Vector3,
  ) => {
    const tangent = projectToTangentPlane(tailDirection, tailNormal)
    if (!tangent) {
      tailFrameStates.delete(playerId)
      return
    }
    const state = tailFrameStates.get(playerId)
    if (state) {
      state.normal.copy(tailNormal)
      state.tangent.copy(tangent)
    } else {
      tailFrameStates.set(playerId, {
        normal: tailNormal.clone(),
        tangent,
      })
    }
  }

  const computeExtendedTailPoint = (
    curvePoints: THREE.Vector3[],
    extendDistance: number,
    overrideDirection?: THREE.Vector3 | null,
  ) => {
    if (extendDistance <= 0 || curvePoints.length < 2) return null
    const tailPos = curvePoints[curvePoints.length - 1]
    const tailRadius = tailPos.length()
    if (!Number.isFinite(tailRadius) || tailRadius <= 1e-6) return null
    const tailNormal = tailPos.clone().normalize()
    const tailDir = overrideDirection ? projectToTangentPlane(overrideDirection, tailNormal) : null
    if (!tailDir) return null

    const axis = tailNormal.clone().cross(tailDir)
    const angle = extendDistance / tailRadius
    let extended: THREE.Vector3
    if (axis.lengthSq() < 1e-8 || !Number.isFinite(angle)) {
      extended = tailPos
        .clone()
        .addScaledVector(tailDir, extendDistance)
        .normalize()
        .multiplyScalar(tailRadius)
    } else {
      axis.normalize()
      extended = tailPos
        .clone()
        .applyAxisAngle(axis, angle)
        .normalize()
        .multiplyScalar(tailRadius)
    }
    return extended
  }

  const getPelletTerrainRadius = (pellet: PelletSnapshot) => {
    const nx = pellet.x
    const ny = pellet.y
    const nz = pellet.z
    const cached = pelletGroundCache.get(pellet.id)
    if (cached) {
      const dx = cached.x - nx
      const dy = cached.y - ny
      const dz = cached.z - nz
      if (dx * dx + dy * dy + dz * dz <= PELLET_GROUND_CACHE_NORMAL_EPS) {
        return cached.radius
      }
    }
    tempVectorE.set(nx, ny, nz)
    if (tempVectorE.lengthSq() <= 1e-8) {
      tempVectorE.set(0, 0, 1)
    } else {
      tempVectorE.normalize()
    }
    const radius = getTerrainRadius(tempVectorE)
    pelletGroundCache.set(pellet.id, {
      x: tempVectorE.x,
      y: tempVectorE.y,
      z: tempVectorE.z,
      radius,
    })
    return radius
  }

  const getPelletSurfacePosition = (pellet: PelletSnapshot, out: THREE.Vector3) => {
    const radius = getPelletTerrainRadius(pellet)
    const pelletScale = clamp(
      Number.isFinite(pellet.size) ? pellet.size : 1,
      PELLET_SIZE_MIN,
      PELLET_SIZE_MAX,
    )
    const surfaceLift = PELLET_RADIUS * pelletScale + PELLET_SURFACE_CLEARANCE
    out.set(pellet.x, pellet.y, pellet.z)
    if (out.lengthSq() <= 1e-8) {
      out.set(0, 0, 1)
    } else {
      out.normalize()
    }
    out.multiplyScalar(radius + surfaceLift)
    return out
  }

  const pelletSeedUnit = (id: number, salt: number) => {
    let x = (id ^ salt) >>> 0
    x = Math.imul(x ^ (x >>> 16), 0x7feb352d)
    x = Math.imul(x ^ (x >>> 15), 0x846ca68b)
    x ^= x >>> 16
    return (x >>> 0) / 0xffff_ffff
  }

  const getPelletMotionState = (pellet: PelletSnapshot) => {
    let state = pelletMotionStates.get(pellet.id)
    if (state) return state
    const size = Number.isFinite(pellet.size) ? pellet.size : 1
    const clampedSize = clamp(size, PELLET_SIZE_MIN, PELLET_SIZE_MAX)
    state = {
      // Mirror slither's per-food random phase, speed, and wobble frequency.
      gfrOffset: pelletSeedUnit(pellet.id, 0x9e3779b1) * 64,
      gr: 0.65 + 0.1 * clampedSize,
      wsp: (pelletSeedUnit(pellet.id, 0x85ebca77) * 2 - 1) * PELLET_WOBBLE_WSP_RANGE,
    }
    pelletMotionStates.set(pellet.id, state)
    return state
  }

  const applyPelletWobble = (pellet: PelletSnapshot, out: THREE.Vector3, timeSeconds: number) => {
    if (!Number.isFinite(timeSeconds)) return
    const state = getPelletMotionState(pellet)
    const gfr = state.gfrOffset + timeSeconds * PELLET_WOBBLE_GFR_RATE * state.gr
    const wobbleAngle = state.wsp * gfr
    const baseRadius = out.length()
    if (!Number.isFinite(baseRadius) || baseRadius <= 1e-8) return
    tempVectorE.copy(out).multiplyScalar(1 / baseRadius)
    buildTangentBasis(tempVectorE, pelletWobbleTangentTemp, pelletWobbleBitangentTemp)
    out
      .addScaledVector(pelletWobbleTangentTemp, Math.cos(wobbleAngle) * PELLET_WOBBLE_DISTANCE)
      .addScaledVector(pelletWobbleBitangentTemp, Math.sin(wobbleAngle) * PELLET_WOBBLE_DISTANCE)
      .normalize()
      .multiplyScalar(baseRadius)
  }

  const updateTongue = (
    playerId: string,
    visual: SnakeVisual,
    headPosition: THREE.Vector3,
    headNormal: THREE.Vector3,
    forward: THREE.Vector3,
    headScale: number,
    pellets: PelletSnapshot[] | null,
    deltaSeconds: number,
  ): PelletOverride | null => {
    if (!TONGUE_ENABLED) {
      visual.tongue.visible = false
      tongueStates.delete(playerId)
      return null
    }

    let state = tongueStates.get(playerId)
    if (!state) {
      state = { length: 0, mode: 'idle', targetPosition: null, carrying: false }
      tongueStates.set(playerId, state)
    }

    const mouthPosition = tempVectorD
      .copy(headPosition)
      .addScaledVector(forward, TONGUE_MOUTH_FORWARD * headScale)
      .addScaledVector(headNormal, TONGUE_MOUTH_OUT * headScale)
    const tongueMatchDistance = TONGUE_PELLET_MATCH * headScale
    const tongueNearRange = TONGUE_NEAR_RANGE * headScale
    const tongueMaxRange = TONGUE_MAX_RANGE * headScale
    const tongueMaxLength = TONGUE_MAX_LENGTH * headScale
    const tongueGrabEps = TONGUE_GRAB_EPS * headScale
    const tongueHideThreshold = TONGUE_HIDE_THRESHOLD * headScale
    const tongueForkLengthMax = TONGUE_FORK_LENGTH * headScale

    let desiredLength = 0
    let candidatePosition: THREE.Vector3 | null = null
    let candidateDistance = Infinity
    let hasCandidate = false
    let matchedPelletId: number | null = null
    let matchedPosition: THREE.Vector3 | null = null

    if (!pellets || pellets.length === 0) {
      if (state.mode !== 'idle') {
        state.mode = 'retract'
        state.carrying = false
        state.targetPosition = null
      }
    } else {
      if (state.targetPosition) {
        let bestDistanceSq = Infinity
        let bestPelletId: number | null = null
        let bestPosition: THREE.Vector3 | null = null
        for (let i = 0; i < pellets.length; i += 1) {
          const pellet = pellets[i]
          getPelletSurfacePosition(pellet, tempVectorE)
          const distSq = tempVectorE.distanceToSquared(state.targetPosition)
          if (distSq < bestDistanceSq) {
            bestDistanceSq = distSq
            bestPelletId = pellet.id
            bestPosition = tempVectorE.clone()
          }
        }
        const matchThresholdSq = tongueMatchDistance * tongueMatchDistance
        if (bestPelletId !== null && bestPosition && bestDistanceSq <= matchThresholdSq) {
          matchedPelletId = bestPelletId
          matchedPosition = bestPosition
          state.targetPosition.copy(bestPosition)
        } else if (state.mode === 'retract') {
          state.carrying = false
          state.targetPosition = null
        } else if (state.mode === 'extend') {
          state.mode = 'retract'
          state.carrying = false
          state.targetPosition = null
        }
      }

      if (state.mode === 'extend' && state.targetPosition) {
        tempVectorF.copy(state.targetPosition).sub(mouthPosition)
        const distance = tempVectorF.length()
        tempVectorG.copy(tempVectorF).addScaledVector(headNormal, -tempVectorF.dot(headNormal))
        const tangentLen = tempVectorG.length()
        if (tangentLen > 1e-6) {
          tempVectorG.multiplyScalar(1 / tangentLen)
        }
        const angle = tangentLen > 1e-6 ? Math.acos(clamp(forward.dot(tempVectorG), -1, 1)) : Math.PI
        if (distance <= tongueNearRange && angle <= TONGUE_ANGLE_LIMIT) {
          candidatePosition = state.targetPosition
          candidateDistance = distance
          desiredLength = Math.min(distance, tongueMaxLength)
          hasCandidate = true
        } else {
          state.mode = 'retract'
          state.carrying = false
          state.targetPosition = null
        }
      }

      if (!hasCandidate && state.mode === 'idle') {
        for (let i = 0; i < pellets.length; i += 1) {
          const pellet = pellets[i]
          getPelletSurfacePosition(pellet, tempVectorE)
          tempVectorF.copy(tempVectorE).sub(mouthPosition)
          const distance = tempVectorF.length()
          tempVectorG.copy(tempVectorF).addScaledVector(headNormal, -tempVectorF.dot(headNormal))
          const tangentLen = tempVectorG.length()
          if (tangentLen < 1e-6) continue
          tempVectorG.multiplyScalar(1 / tangentLen)
          const angle = Math.acos(clamp(forward.dot(tempVectorG), -1, 1))
          if (angle > TONGUE_ANGLE_LIMIT) continue
          if (distance > tongueMaxRange) continue
          if (distance > tongueNearRange) continue
          if (distance < candidateDistance) {
            candidateDistance = distance
            candidatePosition = tempVectorE.clone()
          }
        }
      }

      if (candidatePosition) {
        desiredLength = Math.min(candidateDistance, tongueMaxLength)
        state.targetPosition = candidatePosition
        state.mode = 'extend'
        state.carrying = false
        hasCandidate = true
      } else if (state.mode === 'extend') {
        state.mode = 'retract'
        state.carrying = false
      }
    }

    const targetLength = state.mode === 'extend' && hasCandidate ? desiredLength : 0
    state.length = smoothValue(
      state.length,
      targetLength,
      deltaSeconds,
      TONGUE_EXTEND_RATE,
      TONGUE_RETRACT_RATE,
    )

    if (state.mode === 'extend' && hasCandidate && state.length >= desiredLength - tongueGrabEps) {
      state.mode = 'retract'
      state.carrying = matchedPelletId !== null && matchedPosition !== null
      if (!state.carrying) {
        state.targetPosition = null
      }
    }

    if (state.mode === 'retract' && state.length <= tongueHideThreshold) {
      if (!state.carrying) {
        state.mode = 'idle'
        state.targetPosition = null
        state.carrying = false
      }
    }

    let override: PelletOverride | null = null
    let targetPosition = state.targetPosition

    if (state.mode === 'retract' && state.carrying && targetPosition && pellets && pellets.length > 0) {
      if (matchedPelletId !== null && matchedPosition) {
        if (state.targetPosition) {
          state.targetPosition.copy(matchedPosition)
        } else {
          state.targetPosition = matchedPosition
        }
        targetPosition = state.targetPosition
        tempVectorF.copy(targetPosition).sub(mouthPosition)
        if (tempVectorF.lengthSq() > 1e-6) {
          tempVectorF.normalize()
        } else {
          tempVectorF.copy(forward)
        }
        const grabbedPos = mouthPosition.clone().addScaledVector(tempVectorF, state.length)
        override = { id: matchedPelletId, position: grabbedPos }
      } else {
        state.carrying = false
        state.targetPosition = null
      }
    }

    const isVisible = state.length > tongueHideThreshold
    visual.tongue.visible = isVisible
    if (!isVisible) {
      return override
    }

    let tongueDir = forward
    if (targetPosition) {
      tempVectorF.copy(targetPosition).sub(mouthPosition)
      if (tempVectorF.lengthSq() > 1e-6) {
        tempVectorF.normalize()
        tongueDir = tempVectorF
      }
    }

    visual.tongue.position.copy(mouthPosition)
    tempQuat.setFromUnitVectors(tongueUp, tongueDir)
    visual.tongue.quaternion.copy(tempQuat)

    const tongueLength = Math.max(state.length, 0.001)
    visual.tongueBase.scale.set(headScale, tongueLength, headScale)
    const forkLength = Math.min(tongueForkLengthMax, tongueLength * 0.6)
    visual.tongueForkLeft.scale.set(headScale, forkLength, headScale)
    visual.tongueForkRight.scale.set(headScale, forkLength, headScale)
    visual.tongueForkLeft.position.set(0, tongueLength, 0)
    visual.tongueForkRight.position.set(0, tongueLength, 0)

    return override
  }

  const ensureSnakeSelfOverlapScratch = (pointCount: number) => {
    if (snakeSelfOverlapIntensityA.length >= pointCount) return
    const next = Math.max(64, pointCount, Math.ceil(snakeSelfOverlapIntensityA.length * 1.5))
    snakeSelfOverlapCellX = new Int16Array(next)
    snakeSelfOverlapCellY = new Int16Array(next)
    snakeSelfOverlapCellZ = new Int16Array(next)
    snakeSelfOverlapIntensityA = new Float32Array(next)
    snakeSelfOverlapIntensityB = new Float32Array(next)
  }

  const computeSnakeSelfOverlapPointIntensities = (
    curvePoints: THREE.Vector3[],
    radius: number,
  ): { intensities: Float32Array; maxIntensity: number } => {
    const pointCount = curvePoints.length
    ensureSnakeSelfOverlapScratch(pointCount)

    for (let i = 0; i < snakeSelfOverlapUsedBuckets.length; i += 1) {
      const key = snakeSelfOverlapUsedBuckets[i]
      const bucket = snakeSelfOverlapBucketPool.get(key)
      if (bucket) bucket.length = 0
    }
    snakeSelfOverlapUsedBuckets.length = 0

    if (!Number.isFinite(radius) || radius <= 1e-6 || pointCount < 3) {
      snakeSelfOverlapIntensityA.fill(0, 0, pointCount)
      return { intensities: snakeSelfOverlapIntensityA, maxIntensity: 0 }
    }

    let segmentSum = 0
    for (let i = 1; i < pointCount; i += 1) {
      segmentSum += curvePoints[i].distanceTo(curvePoints[i - 1])
    }
    const avgSegmentLen = segmentSum / Math.max(1, pointCount - 1)
    const minArc = radius * SNAKE_SELF_OVERLAP_MIN_ARC_MULT
    const minIndexGap = clamp(
      Math.ceil(minArc / Math.max(1e-6, avgSegmentLen)),
      4,
      Math.max(4, pointCount - 1),
    )

    const cellCount = SNAKE_SELF_OVERLAP_GRID_CELLS
    const distFull = radius * SNAKE_SELF_OVERLAP_DIST_FULL_MULT
    const distStart = radius * SNAKE_SELF_OVERLAP_DIST_START_MULT
    const distFullSq = distFull * distFull
    const distStartSq = distStart * distStart

    for (let i = 0; i < pointCount; i += 1) {
      const p = curvePoints[i]
      const lenSq = p.x * p.x + p.y * p.y + p.z * p.z
      let nx = 0
      let ny = 1
      let nz = 0
      if (lenSq > 1e-10) {
        const invLen = 1 / Math.sqrt(lenSq)
        nx = p.x * invLen
        ny = p.y * invLen
        nz = p.z * invLen
      }
      let ix = Math.floor((nx * 0.5 + 0.5) * cellCount)
      let iy = Math.floor((ny * 0.5 + 0.5) * cellCount)
      let iz = Math.floor((nz * 0.5 + 0.5) * cellCount)
      ix = clamp(ix, 0, cellCount - 1)
      iy = clamp(iy, 0, cellCount - 1)
      iz = clamp(iz, 0, cellCount - 1)
      snakeSelfOverlapCellX[i] = ix
      snakeSelfOverlapCellY[i] = iy
      snakeSelfOverlapCellZ[i] = iz
      const key = ix + cellCount * (iy + cellCount * iz)
      let bucket = snakeSelfOverlapBucketPool.get(key)
      if (!bucket) {
        bucket = []
        snakeSelfOverlapBucketPool.set(key, bucket)
      }
      if (bucket.length === 0) {
        snakeSelfOverlapUsedBuckets.push(key)
      }
      bucket.push(i)
    }

    const intensities = snakeSelfOverlapIntensityA
    for (let i = 0; i < pointCount; i += 1) {
      const ix = snakeSelfOverlapCellX[i]
      const iy = snakeSelfOverlapCellY[i]
      const iz = snakeSelfOverlapCellZ[i]
      const p = curvePoints[i]
      let minDistSq = Number.POSITIVE_INFINITY
      for (let dz = -1; dz <= 1; dz += 1) {
        const z = iz + dz
        if (z < 0 || z >= cellCount) continue
        for (let dy = -1; dy <= 1; dy += 1) {
          const y = iy + dy
          if (y < 0 || y >= cellCount) continue
          for (let dx = -1; dx <= 1; dx += 1) {
            const x = ix + dx
            if (x < 0 || x >= cellCount) continue
            const key = x + cellCount * (y + cellCount * z)
            const bucket = snakeSelfOverlapBucketPool.get(key)
            if (!bucket || bucket.length === 0) continue
            for (let k = 0; k < bucket.length; k += 1) {
              const j = bucket[k]
              const gap = Math.abs(i - j)
              if (gap <= minIndexGap) continue
              const q = curvePoints[j]
              const dx = p.x - q.x
              const dy = p.y - q.y
              const dz = p.z - q.z
              const distSq = dx * dx + dy * dy + dz * dz
              if (distSq < minDistSq) {
                minDistSq = distSq
                if (minDistSq <= distFullSq) break
              }
            }
            if (minDistSq <= distFullSq) break
          }
          if (minDistSq <= distFullSq) break
        }
        if (minDistSq <= distFullSq) break
      }

      let intensity = 0
      if (minDistSq < distStartSq) {
        intensity = 1 - smoothstep(distFullSq, distStartSq, minDistSq)
      }
      intensities[i] = intensity
    }

    let blurred = intensities
    if (SNAKE_SELF_OVERLAP_BLUR_PASSES > 0 && SNAKE_SELF_OVERLAP_BLUR_RADIUS > 0 && pointCount >= 3) {
      let a = intensities
      let b = snakeSelfOverlapIntensityB
      const radiusSamples = Math.floor(SNAKE_SELF_OVERLAP_BLUR_RADIUS)
      const passes = Math.floor(SNAKE_SELF_OVERLAP_BLUR_PASSES)
      for (let pass = 0; pass < passes; pass += 1) {
        for (let i = 0; i < pointCount; i += 1) {
          let sum = 0
          let weight = 0
          for (let offset = -radiusSamples; offset <= radiusSamples; offset += 1) {
            const j = i + offset
            if (j < 0 || j >= pointCount) continue
            const w = radiusSamples + 1 - Math.abs(offset)
            sum += a[j] * w
            weight += w
          }
          b[i] = weight > 0 ? sum / weight : 0
        }
        const tmp = a
        a = b
        b = tmp
      }
      blurred = a
    }

    let maxIntensity = 0
    for (let i = 0; i < pointCount; i += 1) {
      maxIntensity = Math.max(maxIntensity, blurred[i] ?? 0)
    }
    return { intensities: blurred, maxIntensity }
  }

  const applySnakeSelfOverlapColors = (
    geometry: THREE.TubeGeometry,
    intensities: Float32Array,
    pointCount: number,
  ) => {
    const positionAttr = geometry.getAttribute('position')
    if (!(positionAttr instanceof THREE.BufferAttribute)) {
      return
    }
    const params = geometry.parameters as { radialSegments?: number; tubularSegments?: number }
    const radialSegments = params.radialSegments ?? 8
    const tubularSegments = params.tubularSegments ?? 1
    const ringVertexCount = radialSegments + 1
    const ringCount = tubularSegments + 1
    const ringDenom = Math.max(1, ringCount - 1)

    const vertexCount = positionAttr.count
    const colors = new Float32Array(vertexCount * 3)
    const scale = pointCount > 1 ? pointCount - 1 : 0
    for (let v = 0; v < vertexCount; v += 1) {
      const ring = ringVertexCount > 0 ? Math.floor(v / ringVertexCount) : 0
      const t = ringDenom > 0 ? ring / ringDenom : 0
      const idx = clamp(Math.round(t * scale), 0, scale)
      const intensity = intensities[idx] ?? 0
      const out = v * 3
      colors[out] = intensity
      colors[out + 1] = intensity
      colors[out + 2] = intensity
    }
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  }

  const applySnakeSkinUVs = (
    geometry: THREE.TubeGeometry,
    snakeStart: number,
    snakeLen: number,
  ) => {
    const uvAttr = geometry.getAttribute('uv')
    if (!(uvAttr instanceof THREE.BufferAttribute)) return
    const params = geometry.parameters as { radialSegments?: number; tubularSegments?: number }
    const radialSegments = params.radialSegments ?? 8
    const tubularSegments = params.tubularSegments ?? 1
    const ringVertexCount = radialSegments + 1
    const ringCount = tubularSegments + 1
    const ringDenom = Math.max(1, ringCount - 1)
    const vDenom = Math.max(1, radialSegments)

    const safeStart = Number.isFinite(snakeStart) ? Math.max(0, snakeStart) : 0
    // snakeLen can be fractional (tail extension) so skin patterns advance smoothly as the tail grows.
    const safeLen = Number.isFinite(snakeLen) ? Math.max(0, snakeLen) : 0
    const span = Math.max(0, safeLen)
    for (let ring = 0; ring < ringCount; ring += 1) {
      const t = ring / ringDenom
      const globalIndex = safeStart + t * span
      let u = globalIndex / 8
      // Avoid an exact integer boundary at the tail so RepeatWrapping doesn't snap to u=0 at the seam.
      if (ring === ringCount - 1) {
        u = u - 0.0001
      }
      const ringOffset = ring * ringVertexCount
      for (let i = 0; i < ringVertexCount; i += 1) {
        const v = i / vDenom
        uvAttr.setXY(ringOffset + i, u, v)
      }
    }
    uvAttr.needsUpdate = true
  }


  const updateSnake = (
    player: PlayerSnapshot,
    isLocal: boolean,
    deltaSeconds: number,
    pellets: PelletSnapshot[] | null,
  ): PelletOverride | null => {
    const skin = getSnakeSkinTexture(player.color, player.skinColors)
    let visual = snakes.get(player.id)
    if (!visual) {
      visual = createSnakeVisual(skin.primary, skin.key, skin.texture)
      snakes.set(player.id, visual)
      snakesGroup.add(visual.group)
    } else {
      if (visual.skinKey !== skin.key) {
        visual.skinKey = skin.key
        visual.tube.material.map = skin.texture
        visual.tube.material.emissiveMap = skin.texture
        visual.tube.material.needsUpdate = true
      }
    }

    if (visual.color !== skin.primary) {
      visual.color = skin.primary
      visual.selfOverlapGlowMaterial.color.set(skin.primary)
    }
    const groundingInfo = isLocal ? createGroundingInfo() : null

    const wasAlive = lastAliveStates.get(player.id)
    if (wasAlive === undefined || wasAlive !== player.alive) {
      if (!player.alive) {
        deathStates.set(player.id, { start: performance.now() })
      } else {
        deathStates.delete(player.id)
        resetSnakeTransientState(player.id)
      }
      lastAliveStates.set(player.id, player.alive)
    }

    let opacity = 1
    if (!player.alive) {
      const deathState = deathStates.get(player.id)
      const start = deathState?.start ?? performance.now()
      const elapsed = (performance.now() - start) / 1000
      const t = clamp(elapsed / DEATH_FADE_DURATION, 0, 1)
      opacity = DEATH_START_OPACITY * (1 - t)
    }

    visual.group.visible = opacity > DEATH_VISIBILITY_CUTOFF

    updateSnakeMaterial(visual.tube.material, visual.color, isLocal, opacity)
    updateSnakeMaterial(visual.head.material, visual.color, isLocal, opacity)
    updateSnakeMaterial(visual.tail.material, visual.color, isLocal, opacity)
    updateSnakeMaterial(visual.eyeLeft.material, '#ffffff', false, opacity, 0)
    updateSnakeMaterial(visual.eyeRight.material, '#ffffff', false, opacity, 0)
    updateSnakeMaterial(visual.pupilLeft.material, '#1b1b1b', false, opacity, 0)
    updateSnakeMaterial(visual.pupilRight.material, '#1b1b1b', false, opacity, 0)
    updateSnakeMaterial(visual.tongueBase.material, '#ff6f9f', false, opacity, 0.3)
    updateSnakeMaterial(visual.tongueForkLeft.material, '#ff6f9f', false, opacity, 0.3)
    updateSnakeMaterial(visual.tongueForkRight.material, '#ff6f9f', false, opacity, 0.3)
    if (isLocal) {
      hideNameplate(visual)
    }

    const previousSnakeStart = lastSnakeStarts.get(player.id)
    if (previousSnakeStart !== undefined && previousSnakeStart !== player.snakeStart) {
      resetSnakeTransientState(player.id)
    }
    lastSnakeStarts.set(player.id, player.snakeStart)

    if (player.snakeDetail === 'stub') {
      if (isLocal) {
        localGroundingInfo = null
      }
      resetSnakeTransientState(player.id)
      lastTailContactNormals.delete(player.id)
      visual.tube.visible = false
      visual.selfOverlapGlow.visible = false
      visual.tail.visible = false
      visual.head.visible = false
      visual.eyeLeft.visible = false
      visual.eyeRight.visible = false
      visual.pupilLeft.visible = false
      visual.pupilRight.visible = false
      visual.tongue.visible = false
      visual.bowl.visible = false
      hideBoostDraft(visual)
      hideNameplate(visual)
      return null
    }

    const nodes = player.snake
    const lastTailDirection = lastTailDirections.get(player.id) ?? null
    const tailFrameState = tailFrameStates.get(player.id) ?? null
    const digestionVisuals = buildDigestionVisuals(player.digestions)
    const girthScale = clamp(player.girthScale, SNAKE_GIRTH_SCALE_MIN, SNAKE_GIRTH_SCALE_MAX)
    const girthT = clamp(
      (girthScale - SNAKE_GIRTH_SCALE_MIN) /
        Math.max(1e-6, SNAKE_GIRTH_SCALE_MAX - SNAKE_GIRTH_SCALE_MIN),
      0,
      1,
    )
    const girthNonLinearScale = THREE.MathUtils.lerp(
      1,
      DIGESTION_BULGE_GIRTH_MIN_SCALE,
      Math.pow(girthT, DIGESTION_BULGE_GIRTH_CURVE),
    )
    const radiusCompScale = Math.pow(1 / Math.max(girthScale, 1), DIGESTION_BULGE_RADIUS_CURVE)
    const digestionBulgeScale = girthNonLinearScale * radiusCompScale
    const bodyScale = girthScale * (isLocal ? 1.1 : 1)
    const radius = SNAKE_RADIUS * bodyScale
    const radiusOffset = radius * SNAKE_LIFT_FACTOR
    const headScale = radius / SNAKE_RADIUS
    const headRadius = HEAD_RADIUS * headScale
    let headCurvePoint: THREE.Vector3 | null = null
    let secondCurvePoint: THREE.Vector3 | null = null
    let tailCurveTail: THREE.Vector3 | null = null
    let tailCurvePrev: THREE.Vector3 | null = null
    let tailExtensionDirection: THREE.Vector3 | null = null
    let tailDirMinLen = 0
    if (nodes.length < 2) {
      visual.tube.visible = false
      visual.selfOverlapGlow.visible = false
      visual.tail.visible = false
      lastTailDirections.delete(player.id)
      lastTailContactNormals.delete(player.id)
      tailFrameStates.delete(player.id)
    } else {
      visual.tube.visible = true
      visual.tail.visible = true
      const curvePoints = buildSnakeCurvePoints(
        nodes,
        radiusOffset,
        radius,
        groundingInfo,
      )
      headCurvePoint = curvePoints[0]?.clone() ?? null
      secondCurvePoint = curvePoints[1]?.clone() ?? null
      let tailBasisPrev: THREE.Vector3 | null = null
      let tailBasisTail: THREE.Vector3 | null = null
      let tailSegmentLength = 0
      if (curvePoints.length >= 3) {
        tailBasisPrev = curvePoints[curvePoints.length - 3]
        tailBasisTail = curvePoints[curvePoints.length - 2]
        if (tailBasisPrev.distanceToSquared(tailBasisTail) < 1e-6) {
          tailBasisPrev = null
          tailBasisTail = null
        }
      }
      if (curvePoints.length >= 2) {
        const tailPos = curvePoints[curvePoints.length - 1]
        const prevPos = curvePoints[curvePoints.length - 2]
        tailSegmentLength = tailPos.distanceTo(prevPos)
      }
      const referenceLength =
        tailBasisPrev && tailBasisTail
          ? tailBasisTail.distanceTo(tailBasisPrev)
          : tailSegmentLength
      tailDirMinLen = Number.isFinite(referenceLength)
        ? Math.max(0, referenceLength * TAIL_DIR_MIN_RATIO)
        : 0
      // Only apply `tailExtension` when we have the exact authoritative tail window. During
      // snapshot interpolation, transient `snakeLen`/`snakeTotalLen` mismatches can otherwise
      // produce one-frame over/under-shoots ("tail pops") under heavy growth/boost transitions.
      const hasAuthoritativeTailWindow = player.snakeStart + nodes.length === player.snakeTotalLen
      const extensionRatio = hasAuthoritativeTailWindow
        ? clamp(player.tailExtension, 0, 0.999_999)
        : 0
      // Prefer the actual last-segment length for tail extension distance (it matches the
      // server-side "commit a new node" spacing more closely). Fall back to the more stable
      // reference length if the tail segment is degenerate.
      const extensionBaseLength =
        Number.isFinite(tailSegmentLength) && tailSegmentLength > 1e-6 ? tailSegmentLength : referenceLength
      const extensionDistance = Math.max(0, extensionBaseLength * extensionRatio)
      tailExtensionDirection = computeTailExtendDirection(
        curvePoints,
        tailDirMinLen,
        lastTailDirection,
        tailFrameState,
      )
      if (extensionDistance > 0) {
        // Bias toward the raw last-segment direction when the tail is close to fully extended so
        // the extended tail point lines up with the server's next committed node, avoiding
        // occasional visible "pops" when rapid growth commits happen.
        let extensionDir = tailExtensionDirection
        if (curvePoints.length >= 2) {
          const tailPos = curvePoints[curvePoints.length - 1]
          const prevPos = curvePoints[curvePoints.length - 2]
          snakeContactNormalTemp.copy(tailPos).normalize()
          snakeContactTangentTemp.copy(tailPos).sub(prevPos)
          snakeContactTangentTemp.addScaledVector(
            snakeContactNormalTemp,
            -snakeContactTangentTemp.dot(snakeContactNormalTemp),
          )
          const rawDir = snakeContactTangentTemp.lengthSq() > 1e-8 ? snakeContactTangentTemp.normalize() : null
          if (rawDir && tailExtensionDirection) {
            const w = clamp((extensionRatio - 0.6) / 0.3, 0, 1)
            if (w >= 0.999_999) {
              extensionDir = rawDir
            } else if (w > 1e-6) {
              extensionDir = tailExtensionDirection
                .clone()
                .multiplyScalar(1 - w)
                .addScaledVector(rawDir, w)
              if (extensionDir.lengthSq() > 1e-8) {
                extensionDir.normalize()
              } else {
                extensionDir = rawDir
              }
            }
          } else if (rawDir) {
            extensionDir = rawDir
          }
        }
        const extendedTail = computeExtendedTailPoint(
          curvePoints,
          extensionDistance,
          extensionDir,
        )
        if (extendedTail) {
          curvePoints[curvePoints.length - 1] = extendedTail
        }
      }
      if (curvePoints.length >= 2) {
        const tailPos = curvePoints[curvePoints.length - 1]
        const prevPos = curvePoints[curvePoints.length - 2]
        snakeContactNormalTemp.copy(tailPos).normalize()
        snakeContactTangentTemp.copy(tailPos).sub(prevPos)
        snakeContactTangentTemp.addScaledVector(
          snakeContactNormalTemp,
          -snakeContactTangentTemp.dot(snakeContactNormalTemp),
        )
        if (snakeContactTangentTemp.lengthSq() <= 1e-8) {
          buildTangentBasis(
            snakeContactNormalTemp,
            snakeContactTangentTemp,
            snakeContactBitangentTemp,
          )
        } else {
          snakeContactTangentTemp.normalize()
        }
        const tailRadius = tailPos.length()
        const tailLift = applySnakeContactLift(
          snakeContactNormalTemp,
          snakeContactTangentTemp,
          tailRadius,
          radius,
          groundingInfo,
        )
        if (tailLift > 0) {
          tailPos.addScaledVector(snakeContactNormalTemp, tailLift)
          tailSegmentLength = tailPos.distanceTo(prevPos)
        }
      }
      if (curvePoints.length >= 2) {
        tailCurvePrev = curvePoints[curvePoints.length - 2]
        tailCurveTail = curvePoints[curvePoints.length - 1]
      }
      const baseCurve = new THREE.CatmullRomCurve3(curvePoints, false, 'centripetal')
      const tubularSegments = Math.max(8, curvePoints.length * 4)
      const tubeGeometry = new THREE.TubeGeometry(
        baseCurve,
        tubularSegments,
        radius,
        SNAKE_TUBE_RADIAL_SEGMENTS,
        false,
      )
      // Keep skin UV progression continuous while the tail is fractionally extended.
      applySnakeSkinUVs(tubeGeometry, player.snakeStart, nodes.length + extensionRatio)
      const digestionStartOffset = computeDigestionStartOffset(curvePoints)
      if (digestionVisuals.length) {
        applyDigestionBulges(tubeGeometry, digestionVisuals, digestionStartOffset, digestionBulgeScale)
      }
      let overlapMax = 0
      if (SNAKE_SELF_OVERLAP_GLOW_ENABLED && curvePoints.length >= SNAKE_SELF_OVERLAP_MIN_POINTS) {
        const overlap = computeSnakeSelfOverlapPointIntensities(curvePoints, radius)
        overlapMax = overlap.maxIntensity
        if (overlapMax > SNAKE_SELF_OVERLAP_GLOW_VISIBILITY_THRESHOLD) {
          applySnakeSelfOverlapColors(tubeGeometry, overlap.intensities, curvePoints.length)
        }
      }

      const oldTubeGeometry = visual.tube.geometry
      const oldGlowGeometry = visual.selfOverlapGlow.geometry
      visual.tube.geometry = tubeGeometry
      visual.selfOverlapGlow.geometry = tubeGeometry
      if (oldGlowGeometry !== oldTubeGeometry) {
        oldGlowGeometry.dispose()
      }
      oldTubeGeometry.dispose()

      visual.selfOverlapGlowMaterial.opacity = opacity * SNAKE_SELF_OVERLAP_GLOW_OPACITY
      visual.selfOverlapGlowMaterial.color.set(visual.color)
      visual.selfOverlapGlow.visible =
        visual.group.visible && overlapMax > SNAKE_SELF_OVERLAP_GLOW_VISIBILITY_THRESHOLD
    }

    if (nodes.length === 0) {
      visual.head.visible = false
      visual.eyeLeft.visible = false
      visual.eyeRight.visible = false
      visual.pupilLeft.visible = false
      visual.pupilRight.visible = false
      visual.tongue.visible = false
      visual.bowl.visible = false
      hideBoostDraft(visual)
      hideNameplate(visual)
      lastHeadPositions.delete(player.id)
      lastForwardDirections.delete(player.id)
      lastTailDirections.delete(player.id)
      lastTailContactNormals.delete(player.id)
      tailFrameStates.delete(player.id)
      tongueStates.delete(player.id)
      lastSnakeStarts.delete(player.id)
      if (isLocal) {
        localGroundingInfo = finalizeGroundingInfo(groundingInfo)
      }
      return null
    }

    const hasHead = player.snakeStart === 0
    let tongueOverride: PelletOverride | null = null

    if (!hasHead) {
      visual.head.visible = false
      visual.eyeLeft.visible = false
      visual.eyeRight.visible = false
      visual.pupilLeft.visible = false
      visual.pupilRight.visible = false
      visual.tongue.visible = false
      visual.bowl.visible = false
      hideBoostDraft(visual)
      hideNameplate(visual)
      lastHeadPositions.delete(player.id)
      lastForwardDirections.delete(player.id)
      tongueStates.delete(player.id)
    } else {
      visual.head.visible = true
      visual.eyeLeft.visible = true
      visual.eyeRight.visible = true
      visual.pupilLeft.visible = true
      visual.pupilRight.visible = true

    const headPoint = nodes[0]
    const headNormal = tempVector.set(headPoint.x, headPoint.y, headPoint.z).normalize()
    snakeContactTangentTemp.set(0, 0, 0)
    if (headCurvePoint && secondCurvePoint) {
      snakeContactTangentTemp.copy(headCurvePoint).sub(secondCurvePoint)
    } else if (nodes.length > 1) {
      const nextPoint = nodes[1]
      snakeContactFallbackTemp.set(nextPoint.x, nextPoint.y, nextPoint.z).normalize()
      snakeContactTangentTemp.copy(headNormal).sub(snakeContactFallbackTemp)
    }
    snakeContactTangentTemp.addScaledVector(
      headNormal,
      -snakeContactTangentTemp.dot(headNormal),
    )
    if (snakeContactTangentTemp.lengthSq() <= 1e-8) {
      buildTangentBasis(headNormal, snakeContactTangentTemp, snakeContactBitangentTemp)
    } else {
      snakeContactTangentTemp.normalize()
    }
    const headCenterlineRadius = getSnakeCenterlineRadius(
      headNormal,
      radiusOffset,
      radius,
    )
    const headLift = applySnakeContactLift(
      headNormal,
      snakeContactTangentTemp,
      headCenterlineRadius,
      headRadius,
      groundingInfo,
    )
    const headPosition = headNormal
      .clone()
      .multiplyScalar(headCenterlineRadius + headLift)
    visual.head.scale.setScalar(headScale)
    visual.bowl.scale.setScalar(headScale)
    visual.head.position.copy(headPosition)
    visual.bowl.position.copy(headPosition)

    let underwater = false
    if (lakes.length > 0) {
      const sample = sampleLakes(headNormal, lakes, lakeSampleTemp)
      underwater = !!sample.lake && sample.boundary > LAKE_WATER_MASK_THRESHOLD
    }
    const crackAmount = underwater ? clamp((0.35 - player.oxygen) / 0.35, 0, 1) : 0
    visual.bowlCrackUniform.value = crackAmount
    if (webglShaderHooksEnabled) {
      visual.bowlMaterial.color.set('#cfefff')
      visual.bowlMaterial.emissive.set(0x000000)
      visual.bowlMaterial.emissiveIntensity = 0
      visual.bowlMaterial.opacity = 0.45 * opacity
    } else {
      const tint = crackAmount
      visual.bowlMaterial.color.setRGB(
        0.81 - 0.31 * tint,
        0.94 - 0.44 * tint,
        1.0 - 0.54 * tint,
      )
      visual.bowlMaterial.emissive.setRGB(0.08 * tint, 0.04 * tint, 0.03 * tint)
      visual.bowlMaterial.emissiveIntensity = 1
      visual.bowlMaterial.opacity = (0.45 + tint * 0.22) * opacity
    }
    visual.bowl.visible = underwater && visual.group.visible

    let forward = tempVectorB
    let hasForward = false
    const lastHead = lastHeadPositions.get(player.id)
    const lastForward = lastForwardDirections.get(player.id)

    if (lastHead) {
      const delta = headPosition.clone().sub(lastHead)
      delta.addScaledVector(headNormal, -delta.dot(headNormal))
      if (delta.lengthSq() > 1e-8) {
        delta.normalize()
        forward.copy(delta)
        hasForward = true
        if (lastForward) {
          lastForward.copy(forward)
        } else {
          lastForwardDirections.set(player.id, forward.clone())
        }
      } else if (lastForward) {
        forward.copy(lastForward)
        hasForward = true
      }
    }

    if (!hasForward) {
      if (nodes.length > 1) {
        const nextPoint =
          secondCurvePoint ??
          (() => {
            const nextNode = nodes[1]
            const nextNormal = new THREE.Vector3(nextNode.x, nextNode.y, nextNode.z).normalize()
            const nextRadius = getSnakeCenterlineRadius(nextNormal, radiusOffset, radius)
            return nextNormal.multiplyScalar(nextRadius)
          })()
        forward = headPosition.clone().sub(nextPoint)
      } else {
        forward = new THREE.Vector3().crossVectors(headNormal, new THREE.Vector3(0, 1, 0))
      }
      if (forward.lengthSq() < 0.00001) {
        forward = new THREE.Vector3().crossVectors(headNormal, new THREE.Vector3(1, 0, 0))
      }
      forward.normalize()
    }

    const cachedHead = lastHeadPositions.get(player.id)
    if (cachedHead) {
      cachedHead.copy(headPosition)
    } else {
      lastHeadPositions.set(player.id, headPosition.clone())
    }

    const right = new THREE.Vector3().crossVectors(forward, headNormal)
    if (right.lengthSq() < 0.00001) {
      right.set(1, 0, 0)
    }
    right.normalize()
    updateBoostDraft(
      visual,
      player,
      headPosition,
      headNormal,
      forward,
      headRadius,
      opacity,
      deltaSeconds,
    )
    if (
      !isLocal &&
      player.alive &&
      visual.group.visible &&
      visual.nameplateTexture &&
      visual.nameplateCanvas &&
      visual.nameplateCtx
    ) {
      updateNameplateText(visual, player.name)
      const distanceToCamera = camera.position.distanceTo(headPosition)
      const distanceFade = 1 - smoothstep(
        NAMEPLATE_FADE_NEAR_DISTANCE,
        NAMEPLATE_FADE_FAR_DISTANCE,
        distanceToCamera,
      )
      const nameplateOpacity = clamp(opacity * distanceFade, 0, 1)
      if (nameplateOpacity > DEATH_VISIBILITY_CUTOFF) {
        const scale = headScale
        const nameplateWidth = NAMEPLATE_WORLD_WIDTH * scale
        visual.nameplate.position
          .copy(headPosition)
          .addScaledVector(headNormal, NAMEPLATE_WORLD_OFFSET * scale)
        visual.nameplate.quaternion.copy(camera.quaternion)
        visual.nameplate.scale.set(nameplateWidth, nameplateWidth / NAMEPLATE_WORLD_ASPECT, 1)
        visual.nameplateMaterial.opacity = nameplateOpacity
        visual.nameplate.visible = true
      } else {
        hideNameplate(visual)
      }
    } else {
      hideNameplate(visual)
    }

    visual.eyeLeft.scale.setScalar(headScale)
    visual.eyeRight.scale.setScalar(headScale)
    visual.pupilLeft.scale.setScalar(headScale)
    visual.pupilRight.scale.setScalar(headScale)

    const eyeOut = headRadius * 0.16
    const eyeForward = headRadius * 0.28
    const eyeSpacing = headRadius * 0.52

    const leftEyePosition = headPosition
      .clone()
      .addScaledVector(headNormal, eyeOut)
      .addScaledVector(forward, eyeForward)
      .addScaledVector(right, -eyeSpacing)
    const rightEyePosition = headPosition
      .clone()
      .addScaledVector(headNormal, eyeOut)
      .addScaledVector(forward, eyeForward)
      .addScaledVector(right, eyeSpacing)

    visual.eyeLeft.position.copy(leftEyePosition)
    visual.eyeRight.position.copy(rightEyePosition)

    const clampedYaw = 0
    const pupilSurfaceDistance = PUPIL_OFFSET * headScale

    const updatePupil = (eyePosition: THREE.Vector3, eyeNormal: THREE.Vector3, output: THREE.Vector3) => {
      tempVectorH.copy(right)
      tempVectorH.addScaledVector(eyeNormal, -tempVectorH.dot(eyeNormal))
      if (tempVectorH.lengthSq() > 1e-6) {
        tempVectorH.normalize()
      } else {
        tempVectorH.copy(right)
      }

      const yawCos = Math.cos(clampedYaw)
      const yawSin = Math.sin(clampedYaw)
      output
        .copy(eyePosition)
        .addScaledVector(eyeNormal, pupilSurfaceDistance * yawCos)
        .addScaledVector(tempVectorH, pupilSurfaceDistance * yawSin)
    }

    tempVectorF.copy(leftEyePosition).sub(headPosition).normalize()
    updatePupil(leftEyePosition, tempVectorF, visual.pupilLeft.position)
    tempVectorG.copy(rightEyePosition).sub(headPosition).normalize()
    updatePupil(rightEyePosition, tempVectorG, visual.pupilRight.position)

    if (isLocal) {
      tongueOverride = updateTongue(
        player.id,
        visual,
        headPosition,
        headNormal,
        forward,
        headScale,
        pellets,
        deltaSeconds,
      )
    } else {
      visual.tongue.visible = false
      tongueStates.delete(player.id)
    }
    }

    if (nodes.length > 1) {
      const tailPos =
        tailCurveTail ??
        (() => {
          const tailNode = nodes[nodes.length - 1]
          const tailNormalFallback = new THREE.Vector3(
            tailNode.x,
            tailNode.y,
            tailNode.z,
          ).normalize()
          const tailRadius = getSnakeCenterlineRadius(
            tailNormalFallback,
            radiusOffset,
            radius,
          )
          return tailNormalFallback.multiplyScalar(tailRadius)
        })()
      const prevPos =
        tailCurvePrev ??
        (() => {
          const prevNode = nodes[nodes.length - 2]
          const prevNormalFallback = new THREE.Vector3(
            prevNode.x,
            prevNode.y,
            prevNode.z,
          ).normalize()
          const prevRadius = getSnakeCenterlineRadius(
            prevNormalFallback,
            radiusOffset,
            radius,
          )
          return prevNormalFallback.multiplyScalar(prevRadius)
        })()
      const tailNormal = tailPos.clone().normalize()
      const contactNormal = lastTailContactNormals.get(player.id)
      if (contactNormal) {
        contactNormal.copy(tailNormal)
      } else {
        lastTailContactNormals.set(player.id, tailNormal.clone())
      }
      const tailSegmentLength = tailPos.distanceTo(prevPos)
      let tailDir = projectToTangentPlane(tailPos.clone().sub(prevPos), tailNormal)
      if (!tailDir || (tailDirMinLen > 0 && tailSegmentLength < tailDirMinLen)) {
        tailDir =
          (tailExtensionDirection && projectToTangentPlane(tailExtensionDirection, tailNormal)) ??
          (tailFrameState
            ? transportDirectionOnSphere(tailFrameState.tangent, tailFrameState.normal, tailNormal)
            : null) ??
          (lastTailDirection ? projectToTangentPlane(lastTailDirection, tailNormal) : null)
      }
      if (!tailDir) {
        tailDir = tailNormal.clone().cross(new THREE.Vector3(0, 1, 0))
        if (tailDir.lengthSq() < 1e-6) {
          tailDir.crossVectors(tailNormal, new THREE.Vector3(1, 0, 0))
        }
      }
      tailDir.normalize()
      if (lastTailDirection) {
        lastTailDirection.copy(tailDir)
      } else {
        lastTailDirections.set(player.id, tailDir.clone())
      }
      storeTailFrameState(player.id, tailNormal, tailDir)
      if (visual.tube.geometry instanceof THREE.TubeGeometry) {
        const capGeometry = buildTailCapGeometry(visual.tube.geometry, tailDir)
        if (capGeometry) {
          if (visual.tail.geometry !== tailGeometry) {
            visual.tail.geometry.dispose()
          }
          visual.tail.geometry = capGeometry
        }
      }
      visual.tail.position.set(0, 0, 0)
      visual.tail.quaternion.identity()
      visual.tail.scale.setScalar(1)
    }

    if (isLocal) {
      localGroundingInfo = finalizeGroundingInfo(groundingInfo)
    }

    return tongueOverride
  }

  const removeSnake = (visual: SnakeVisual, id: string) => {
    snakesGroup.remove(visual.group)
    const tubeGeometry = visual.tube.geometry
    const glowGeometry = visual.selfOverlapGlow.geometry
    tubeGeometry.dispose()
    if (glowGeometry !== tubeGeometry) {
      glowGeometry.dispose()
    }
    if (visual.tail.geometry !== tailGeometry) {
      visual.tail.geometry.dispose()
    }
    visual.tube.material.dispose()
    visual.selfOverlapGlowMaterial.dispose()
    visual.head.material.dispose()
    visual.eyeLeft.material.dispose()
    visual.eyeRight.material.dispose()
    visual.pupilLeft.material.dispose()
    visual.pupilRight.material.dispose()
    visual.tongueBase.material.dispose()
    visual.tongueForkLeft.material.dispose()
    visual.tongueForkRight.material.dispose()
    visual.boostDraftMaterial.dispose()
    visual.nameplateMaterial.dispose()
    visual.nameplateTexture?.dispose()
    visual.bowlMaterial.dispose()
    resetSnakeTransientState(id)
    deathStates.delete(id)
    lastAliveStates.delete(id)
    lastSnakeStarts.delete(id)
  }

  const updateSnakes = (
    players: PlayerSnapshot[],
    localPlayerId: string | null,
    deltaSeconds: number,
    pellets: PelletSnapshot[] | null,
    nowMs: number,
  ): PelletOverride | null => {
    const activeIds = new Set<string>()
    localGroundingInfo = null
    let pelletOverride: PelletOverride | null = null
    for (const player of players) {
      activeIds.add(player.id)
      const override = updateSnake(
        player,
        player.id === localPlayerId,
        deltaSeconds,
        pellets,
      )
      if (override) {
        pelletOverride = override
      }
      const tailContactNormal = lastTailContactNormals.get(player.id) ?? null
      updateBoostTrailForPlayer(player, tailContactNormal, nowMs)
    }

    for (const [id, visual] of snakes) {
      if (!activeIds.has(id)) {
        removeSnake(visual, id)
        snakes.delete(id)
        lastHeadPositions.delete(id)
        lastForwardDirections.delete(id)
      }
    }
    updateInactiveBoostTrails(activeIds, nowMs)

    return pelletOverride
  }

  const normalizePelletColorIndex = (colorIndex: number) => {
    if (PELLET_COLOR_BUCKET_COUNT <= 0) return 0
    const mod = colorIndex % PELLET_COLOR_BUCKET_COUNT
    return mod >= 0 ? mod : mod + PELLET_COLOR_BUCKET_COUNT
  }

  const pelletSizeTierIndex = (size: number) => {
    if (!Number.isFinite(size)) return 0
    if (size >= PELLET_SIZE_TIER_LARGE_MIN) return 2
    if (size >= PELLET_SIZE_TIER_MEDIUM_MIN) return 1
    return 0
  }

  const pelletBucketIndex = (colorIndex: number, size: number) => {
    const colorBucketIndex = normalizePelletColorIndex(colorIndex)
    const tierIndex = pelletSizeTierIndex(size)
    return tierIndex * PELLET_COLOR_BUCKET_COUNT + colorBucketIndex
  }

  const createPelletBucket = (bucketIndex: number, capacity: number): PelletSpriteBucket => {
    const sizeTierIndex = Math.floor(bucketIndex / PELLET_COLOR_BUCKET_COUNT)
    const colorBucketIndex = bucketIndex % PELLET_COLOR_BUCKET_COUNT
    const sizeMultiplier = PELLET_SIZE_TIER_MULTIPLIERS[sizeTierIndex] ?? 1
    const baseShadowSize = PELLET_SHADOW_POINT_SIZE * sizeMultiplier
    const baseCoreSize = PELLET_CORE_POINT_SIZE * sizeMultiplier
    const baseInnerGlowSize = PELLET_INNER_GLOW_POINT_SIZE * sizeMultiplier
    const baseGlowSize = PELLET_GLOW_POINT_SIZE * sizeMultiplier
    const geometry = new THREE.BufferGeometry()
    const positionArray = new Float32Array(capacity * 3)
    const positionAttribute = new THREE.BufferAttribute(positionArray, 3)
    positionAttribute.setUsage(THREE.DynamicDrawUsage)
    geometry.setAttribute('position', positionAttribute)
    geometry.setDrawRange(0, 0)

    const shadowMaterial = new THREE.PointsMaterial({
      size: baseShadowSize,
      map: pelletShadowTexture ?? undefined,
      alphaMap: pelletShadowTexture ?? undefined,
      color: '#000000',
      transparent: true,
      opacity: PELLET_SHADOW_OPACITY_BASE,
      depthWrite: false,
      depthTest: true,
      blending: THREE.NormalBlending,
      sizeAttenuation: true,
      toneMapped: false,
    })
    const coreMaterial = new THREE.PointsMaterial({
      size: baseCoreSize,
      map: pelletCoreTexture ?? undefined,
      alphaMap: pelletCoreTexture ?? undefined,
      color: PELLET_COLORS[colorBucketIndex] ?? '#ffd166',
      transparent: true,
      opacity: PELLET_CORE_OPACITY_BASE,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
      sizeAttenuation: true,
      toneMapped: false,
    })
    const innerGlowMaterial = new THREE.PointsMaterial({
      size: baseInnerGlowSize,
      map: pelletInnerGlowTexture ?? undefined,
      alphaMap: pelletInnerGlowTexture ?? undefined,
      color: PELLET_COLORS[colorBucketIndex] ?? '#ffd166',
      transparent: true,
      opacity: PELLET_INNER_GLOW_OPACITY_BASE,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
      sizeAttenuation: true,
      toneMapped: false,
    })
    const glowMaterial = new THREE.PointsMaterial({
      size: baseGlowSize,
      map: pelletGlowTexture ?? undefined,
      alphaMap: pelletGlowTexture ?? undefined,
      color: PELLET_COLORS[colorBucketIndex] ?? '#ffd166',
      transparent: true,
      opacity: PELLET_GLOW_OPACITY_BASE,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
      sizeAttenuation: true,
      toneMapped: false,
    })
    const shadowPoints = new THREE.Points(geometry, shadowMaterial)
    const glowPoints = new THREE.Points(geometry, glowMaterial)
    const innerGlowPoints = new THREE.Points(geometry, innerGlowMaterial)
    const corePoints = new THREE.Points(geometry, coreMaterial)
    shadowPoints.visible = false
    glowPoints.visible = false
    innerGlowPoints.visible = false
    corePoints.visible = false
    shadowPoints.frustumCulled = false
    glowPoints.frustumCulled = false
    innerGlowPoints.frustumCulled = false
    corePoints.frustumCulled = false
    shadowPoints.renderOrder = 1.2
    glowPoints.renderOrder = 1.3
    innerGlowPoints.renderOrder = 1.4
    corePoints.renderOrder = 1.5
    pelletsGroup.add(shadowPoints)
    pelletsGroup.add(glowPoints)
    pelletsGroup.add(innerGlowPoints)
    pelletsGroup.add(corePoints)
    return {
      shadowPoints,
      corePoints,
      innerGlowPoints,
      glowPoints,
      shadowMaterial,
      coreMaterial,
      innerGlowMaterial,
      glowMaterial,
      positionAttribute,
      capacity,
      baseShadowSize,
      baseCoreSize,
      baseInnerGlowSize,
      baseGlowSize,
      colorBucketIndex,
      sizeTierIndex,
    }
  }

  const ensurePelletBucketCapacity = (bucketIndex: number, required: number): PelletSpriteBucket => {
    const targetCapacity = Math.max(1, required)
    let bucket = pelletBuckets[bucketIndex]
    if (!bucket) {
      let capacity = 1
      while (capacity < targetCapacity) {
        capacity *= 2
      }
      bucket = createPelletBucket(bucketIndex, capacity)
      pelletBuckets[bucketIndex] = bucket
      return bucket
    }
    if (bucket.capacity >= targetCapacity) {
      return bucket
    }

    let nextCapacity = Math.max(1, bucket.capacity)
    while (nextCapacity < targetCapacity) {
      nextCapacity *= 2
    }
    const geometry = new THREE.BufferGeometry()
    const positionArray = new Float32Array(nextCapacity * 3)
    const positionAttribute = new THREE.BufferAttribute(positionArray, 3)
    positionAttribute.setUsage(THREE.DynamicDrawUsage)
    geometry.setAttribute('position', positionAttribute)
    geometry.setDrawRange(0, 0)

    const previousGeometry = bucket.corePoints.geometry
    bucket.shadowPoints.geometry = geometry
    bucket.corePoints.geometry = geometry
    bucket.innerGlowPoints.geometry = geometry
    bucket.glowPoints.geometry = geometry
    previousGeometry.dispose()
    bucket.positionAttribute = positionAttribute
    bucket.capacity = nextCapacity
    return bucket
  }

  const updatePellets = (
    pellets: PelletSnapshot[],
    override: PelletOverride | null,
    timeSeconds: number,
    cameraLocalDir: THREE.Vector3,
    viewAngle: number,
  ) => {
    pelletIdsSeen.clear()
    for (let i = 0; i < PELLET_BUCKET_COUNT; i += 1) {
      pelletBucketCounts[i] = 0
      pelletBucketOffsets[i] = 0
      pelletBucketPositionArrays[i] = null
    }

    // Keep large glow sprites stable near the horizon while culling the far hemisphere.
    const visibleLimit = Math.min(Math.PI - 1e-4, viewAngle + PELLET_GLOW_HORIZON_MARGIN)
    const minDirectionDot = Math.cos(visibleLimit)
    const forcedVisiblePelletId = override?.id ?? null
    let visibleCount = 0

    for (let i = 0; i < pellets.length; i += 1) {
      const pellet = pellets[i]
      pelletIdsSeen.add(pellet.id)
      const forceVisible = forcedVisiblePelletId !== null && pellet.id === forcedVisiblePelletId
      if (!forceVisible && !isPelletNearSide(pellet, cameraLocalDir, minDirectionDot)) {
        continue
      }
      const bucketIndex = pelletBucketIndex(pellet.colorIndex, pellet.size)
      pelletBucketCounts[bucketIndex] += 1
      visibleCount += 1
    }

    for (let bucketIndex = 0; bucketIndex < PELLET_BUCKET_COUNT; bucketIndex += 1) {
      const required = pelletBucketCounts[bucketIndex]
      const bucket = pelletBuckets[bucketIndex]
      if (required <= 0) {
        if (bucket) {
          bucket.shadowPoints.visible = false
          bucket.corePoints.visible = false
          bucket.innerGlowPoints.visible = false
          bucket.glowPoints.visible = false
          bucket.corePoints.geometry.setDrawRange(0, 0)
        }
        continue
      }
      const nextBucket = ensurePelletBucketCapacity(bucketIndex, required)
      nextBucket.shadowPoints.visible = true
      nextBucket.corePoints.visible = true
      nextBucket.innerGlowPoints.visible = true
      nextBucket.glowPoints.visible = true
      nextBucket.corePoints.geometry.setDrawRange(0, required)
      pelletBucketPositionArrays[bucketIndex] = nextBucket.positionAttribute.array as Float32Array
    }

    for (let i = 0; i < pellets.length; i += 1) {
      const pellet = pellets[i]
      const forceVisible = forcedVisiblePelletId !== null && pellet.id === forcedVisiblePelletId
      if (!forceVisible && !isPelletNearSide(pellet, cameraLocalDir, minDirectionDot)) {
        continue
      }
      const bucketIndex = pelletBucketIndex(pellet.colorIndex, pellet.size)
      const positions = pelletBucketPositionArrays[bucketIndex]
      if (!positions) continue

      if (override && override.id === pellet.id) {
        tempVector.copy(override.position)
      } else {
        getPelletSurfacePosition(pellet, tempVector)
        if (visibleCount <= PELLET_WOBBLE_DISABLE_VISIBLE_THRESHOLD) {
          applyPelletWobble(pellet, tempVector, timeSeconds)
        }
      }

      const itemIndex = pelletBucketOffsets[bucketIndex]
      pelletBucketOffsets[bucketIndex] += 1
      const pOffset = itemIndex * 3
      positions[pOffset] = tempVector.x
      positions[pOffset + 1] = tempVector.y
      positions[pOffset + 2] = tempVector.z
    }

    for (let bucketIndex = 0; bucketIndex < PELLET_BUCKET_COUNT; bucketIndex += 1) {
      if (pelletBucketCounts[bucketIndex] <= 0) continue
      const bucket = pelletBuckets[bucketIndex]
      if (!bucket) continue
      bucket.positionAttribute.needsUpdate = true
    }

    for (const id of pelletGroundCache.keys()) {
      if (!pelletIdsSeen.has(id)) {
        pelletGroundCache.delete(id)
      }
    }
    for (const id of pelletMotionStates.keys()) {
      if (!pelletIdsSeen.has(id)) {
        pelletMotionStates.delete(id)
      }
    }
  }

  const updatePelletGlow = (timeSeconds: number) => {
    for (let bucketIndex = 0; bucketIndex < PELLET_BUCKET_COUNT; bucketIndex += 1) {
      const bucket = pelletBuckets[bucketIndex]
      if (!bucket) continue
      const phase =
        timeSeconds * PELLET_GLOW_PULSE_SPEED +
        bucket.colorBucketIndex * PELLET_GLOW_PHASE_STEP +
        bucket.sizeTierIndex * 0.91
      const pulse = 0.5 + 0.5 * Math.cos(phase)
      const centered = (pulse - 0.5) * 2
      const shadowPulse = 0.5 + 0.5 * Math.cos(phase * 0.6 + 1.1)
      bucket.shadowMaterial.opacity = clamp(
        PELLET_SHADOW_OPACITY_BASE + shadowPulse * PELLET_SHADOW_OPACITY_RANGE,
        0.86,
        0.94,
      )
      bucket.shadowMaterial.size = bucket.baseShadowSize
      bucket.coreMaterial.opacity = clamp(
        PELLET_CORE_OPACITY_BASE + pulse * PELLET_CORE_OPACITY_RANGE,
        0.5,
        1,
      )
      bucket.coreMaterial.size = bucket.baseCoreSize * (1 + centered * PELLET_CORE_SIZE_RANGE)
      bucket.innerGlowMaterial.opacity = clamp(
        PELLET_INNER_GLOW_OPACITY_BASE + pulse * PELLET_INNER_GLOW_OPACITY_RANGE,
        0.012,
        0.11,
      )
      bucket.innerGlowMaterial.size =
        bucket.baseInnerGlowSize * (1 + centered * PELLET_INNER_GLOW_SIZE_RANGE)
      bucket.glowMaterial.opacity = clamp(
        PELLET_GLOW_OPACITY_BASE + pulse * PELLET_GLOW_OPACITY_RANGE,
        0.008,
        0.058,
      )
      bucket.glowMaterial.size = bucket.baseGlowSize * (1 + centered * PELLET_GLOW_SIZE_RANGE)
    }
  }

  const resolveDayFactor = (sourceNowMs: number) => {
    dayNightCycleMs =
      dayNightDebugMode === 'accelerated'
        ? DAY_NIGHT_CYCLE_ACCELERATED_MS
        : DAY_NIGHT_CYCLE_MS
    const wrapped =
      ((sourceNowMs % dayNightCycleMs) + dayNightCycleMs) % dayNightCycleMs
    dayNightPhase = wrapped / dayNightCycleMs
    const daylightWave = Math.sin(dayNightPhase * DAY_NIGHT_TAU - Math.PI * 0.5) * 0.5 + 0.5
    dayNightFactor = smoothstep(DAY_NIGHT_DAY_EDGE_START, DAY_NIGHT_DAY_EDGE_END, daylightWave)
    return dayNightFactor
  }

  const projectScreenToCamera = (
    xPx: number,
    yPx: number,
    depth: number,
    out: THREE.Vector3,
  ) => {
    const safeDepth = Math.max(0.001, Math.abs(depth))
    if (viewportWidth <= 1 || viewportHeight <= 1) {
      out.set(0, 0, -safeDepth)
      return out
    }
    const ndcX = (xPx / viewportWidth) * 2 - 1
    const ndcY = 1 - (yPx / viewportHeight) * 2
    const halfFov = THREE.MathUtils.degToRad(camera.fov) * 0.5
    const tanHalf = Math.tan(halfFov)
    out.set(ndcX * safeDepth * tanHalf * camera.aspect, ndcY * safeDepth * tanHalf, -safeDepth)
    return out
  }

  const computePlanetScreenInfo = () => {
    const safeWidth = Math.max(1, viewportWidth)
    const safeHeight = Math.max(1, viewportHeight)
    const fallbackCenterX = lastPlanetScreenCenterX * safeWidth
    const fallbackCenterY = lastPlanetScreenCenterY * safeHeight
    const fallbackRadius = clamp(
      lastPlanetScreenRadiusPx,
      Math.min(safeWidth, safeHeight) * 0.08,
      Math.max(safeWidth, safeHeight) * 0.95,
    )

    const centerNdc = tempVectorD.set(0, 0, 0).project(camera)
    if (!Number.isFinite(centerNdc.x) || !Number.isFinite(centerNdc.y) || !Number.isFinite(centerNdc.z)) {
      return {
        centerX: fallbackCenterX,
        centerY: fallbackCenterY,
        radiusPx: fallbackRadius,
      }
    }

    const centerX = (centerNdc.x * 0.5 + 0.5) * safeWidth
    const centerY = (-centerNdc.y * 0.5 + 0.5) * safeHeight
    let radiusPx = fallbackRadius

    const centerDistance = camera.position.length()
    if (centerDistance > PLANET_RADIUS + 1e-4) {
      tempVectorE.copy(camera.position).multiplyScalar(-1)
      tempVectorF.copy(tempVectorE).cross(WORLD_UP)
      if (tempVectorF.lengthSq() <= 1e-8) {
        tempVectorF.copy(tempVectorE).cross(WORLD_RIGHT)
      }
      if (tempVectorF.lengthSq() > 1e-8) {
        tempVectorF.normalize().multiplyScalar(PLANET_RADIUS)
        const rimNdc = tempVectorG.copy(tempVectorF).project(camera)
        if (Number.isFinite(rimNdc.x) && Number.isFinite(rimNdc.y)) {
          const dxPx = (rimNdc.x - centerNdc.x) * safeWidth * 0.5
          const dyPx = (rimNdc.y - centerNdc.y) * safeHeight * 0.5
          radiusPx = Math.hypot(dxPx, dyPx)
        }
      }

      if (!Number.isFinite(radiusPx) || radiusPx <= 0) {
        const halfFov = THREE.MathUtils.degToRad(camera.fov) * 0.5
        const focalPx = (safeHeight * 0.5) / Math.tan(halfFov)
        radiusPx = (PLANET_RADIUS / centerDistance) * focalPx
      }
    }

    if (Number.isFinite(centerX) && Number.isFinite(centerY) && Number.isFinite(radiusPx) && radiusPx > 1) {
      lastPlanetScreenCenterX = centerX / safeWidth
      lastPlanetScreenCenterY = centerY / safeHeight
      lastPlanetScreenRadiusPx = radiusPx
      return { centerX, centerY, radiusPx }
    }

    return {
      centerX: fallbackCenterX,
      centerY: fallbackCenterY,
      radiusPx: fallbackRadius,
    }
  }

  const updateDayNightVisuals = (sourceNowMs: number) => {
    dayNightSourceNowMs = sourceNowMs
    const dayFactor = resolveDayFactor(sourceNowMs)
    const nightFactor = 1 - dayFactor
    const starFactor = smoothstep(
      DAY_NIGHT_STAR_EDGE_START,
      DAY_NIGHT_STAR_EDGE_END,
      nightFactor,
    )

    skyTopTemp.lerpColors(SKY_NIGHT_TOP_COLOR, SKY_DAY_TOP_COLOR, dayFactor)
    skyHorizonTemp.lerpColors(SKY_NIGHT_HORIZON_COLOR, SKY_DAY_HORIZON_COLOR, dayFactor)
    skyBottomTemp.lerpColors(SKY_NIGHT_BOTTOM_COLOR, SKY_DAY_BOTTOM_COLOR, dayFactor)
    if (
      skyGradient &&
      (!Number.isFinite(lastSkyGradientFactor) ||
        Math.abs(lastSkyGradientFactor - dayFactor) > 0.004)
    ) {
      paintSkyGradientTexture(skyGradient, skyTopTemp, skyHorizonTemp, skyBottomTemp)
      lastSkyGradientFactor = dayFactor
    }

    ambient.intensity = lerp(0.26, 0.68, dayFactor)
    keyLight.intensity = lerp(0.14, 0.5, dayFactor)
    rimLight.intensity = lerp(0.12, 0.3, dayFactor)
    keyLight.color.lerpColors(NIGHT_LIGHT_COLOR, DAY_LIGHT_COLOR, dayFactor)
    rimLight.color.lerpColors(NIGHT_RIM_COLOR, DAY_RIM_COLOR, dayFactor)
    renderer.toneMappingExposure = lerp(DAY_NIGHT_EXPOSURE_NIGHT, DAY_NIGHT_EXPOSURE_DAY, dayFactor)

    const twinkle =
      0.88 + 0.12 * Math.sin(sourceNowMs * 0.001 * DAY_NIGHT_STAR_TWINKLE_SPEED)
    const starsOpacity = clamp(starFactor * twinkle, 0, 1)
    starsMaterial.opacity = starsOpacity
    starsMesh.visible = starsOpacity > 0.001

    const { centerX, centerY, radiusPx } = computePlanetScreenInfo()
    const safeWidth = Math.max(1, viewportWidth)
    const safeHeight = Math.max(1, viewportHeight)
    const halfFov = THREE.MathUtils.degToRad(camera.fov) * 0.5
    const tanHalf = Math.tan(halfFov)
    const sunDepth = Math.abs(DAY_NIGHT_CELESTIAL_ORBIT_Z)
    const moonDepth = Math.abs(DAY_NIGHT_CELESTIAL_ORBIT_Z + 0.2)
    const pixelsPerUnitAtSunDepth = (safeHeight * 0.5) / Math.max(0.001, tanHalf * sunDepth)
    const sunSpriteRadiusPx = DAY_NIGHT_SUN_GLOW_SIZE * pixelsPerUnitAtSunDepth * 0.5
    const moonSpriteRadiusPx = DAY_NIGHT_MOON_GLOW_SIZE * pixelsPerUnitAtSunDepth * 0.5

    const baseRimRadius = Math.max(1, radiusPx + DAY_NIGHT_CELESTIAL_RIM_OFFSET_PX)
    const orbitTheta = dayNightPhase * DAY_NIGHT_TAU - Math.PI * 0.5
    const orbitScaleX = DAY_NIGHT_CELESTIAL_ORBIT_X / 3.7
    const orbitScaleY = DAY_NIGHT_CELESTIAL_ORBIT_Y / 3.3
    const ellipseX = Math.cos(orbitTheta) * orbitScaleX
    const ellipseY = Math.sin(orbitTheta) * orbitScaleY

    const placeOnRim = (
      seedX: number,
      seedY: number,
      spriteRadiusPx: number,
      phaseX: number,
      phaseY: number,
    ) => {
      let x = seedX
      let y = seedY
      const margin = DAY_NIGHT_CELESTIAL_SAFE_MARGIN_PX + spriteRadiusPx
      x = clamp(x, margin, safeWidth - margin)
      y = clamp(y, margin, safeHeight - margin)
      const dx = x - centerX
      const dy = y - centerY
      const dist = Math.hypot(dx, dy)
      const minDist = radiusPx + spriteRadiusPx + 10
      if (dist < minDist) {
        const ux = dist > 1e-4 ? dx / dist : phaseX
        const uy = dist > 1e-4 ? dy / dist : phaseY
        x = centerX + ux * minDist
        y = centerY + uy * minDist
        x = clamp(x, margin, safeWidth - margin)
        y = clamp(y, margin, safeHeight - margin)
      }
      return { x, y }
    }

    const sunSeedX = centerX + ellipseX * baseRimRadius
    const sunSeedY = centerY + ellipseY * baseRimRadius
    const sunPos = placeOnRim(sunSeedX, sunSeedY, sunSpriteRadiusPx, ellipseX, ellipseY)
    const moonSeedX = centerX - ellipseX * baseRimRadius
    const moonSeedY = centerY - ellipseY * baseRimRadius + DAY_NIGHT_CELESTIAL_ORBIT_BASE_Y * 10
    const moonPos = placeOnRim(moonSeedX, moonSeedY, moonSpriteRadiusPx, -ellipseX, -ellipseY)

    projectScreenToCamera(sunPos.x, sunPos.y, sunDepth, tempVectorG)
    sunGroup.position.copy(tempVectorG)
    projectScreenToCamera(moonPos.x, moonPos.y, moonDepth, tempVectorH)
    moonGroup.position.copy(tempVectorH)

    const horizonDay = smoothstep(0.18, 0.82, dayFactor)
    const unitsPerPixelAtHorizonDepth =
      (Math.max(0.001, DAY_NIGHT_HORIZON_DEPTH) * tanHalf * 2) / safeHeight
    const horizonDiameterPx = Math.max(2, radiusPx * DAY_NIGHT_HORIZON_SCALE * 2)
    const horizonScale = horizonDiameterPx * unitsPerPixelAtHorizonDepth
    projectScreenToCamera(centerX, centerY, DAY_NIGHT_HORIZON_DEPTH, tempVectorF)
    horizonSprite.position.copy(tempVectorF)
    horizonSprite.scale.set(horizonScale, horizonScale, 1)
    horizonColorTemp.lerpColors(HORIZON_NIGHT_COLOR, HORIZON_DAY_COLOR, dayFactor)
    horizonMaterial.color.copy(horizonColorTemp)
    horizonMaterial.opacity = lerp(
      DAY_NIGHT_HORIZON_MIN_OPACITY,
      DAY_NIGHT_HORIZON_MAX_OPACITY,
      horizonDay,
    )
    horizonSprite.visible = horizonMaterial.opacity > 0.001

    const blendT = smoothstep(
      DAY_NIGHT_CELESTIAL_BLEND_START,
      DAY_NIGHT_CELESTIAL_BLEND_END,
      dayFactor,
    )
    const sunBaseOpacity = smoothstep(0.08, 0.4, dayFactor)
    const moonBaseOpacity = smoothstep(0.08, 0.5, nightFactor)
    const sunOpacity = sunBaseOpacity * blendT
    const moonOpacity = moonBaseOpacity * (1 - blendT)
    sunCoreMaterial.opacity = sunOpacity
    sunGlowMaterial.opacity = sunOpacity * 0.65
    moonCoreMaterial.opacity = moonOpacity
    moonGlowMaterial.opacity = moonOpacity * 0.55
    sunGroup.visible = sunOpacity > 0.001
    moonGroup.visible = moonOpacity > 0.001
  }

  const isLakeMesh = (child: THREE.Object3D) => {
    for (let i = 0; i < lakeMeshes.length; i += 1) {
      if (lakeMeshes[i] === child) return true
    }
    return false
  }

  const renderWorldPass = (
    mode: number,
    skyVisible: boolean,
    overrideMaterial: THREE.Material | null = null,
    clearDepth = false,
  ) => {
    const savedSkyVisible = skyGroup.visible
    const savedOverrideMaterial = scene.overrideMaterial
    const worldChildCount = world.children.length
    if (worldChildVisibilityScratch.length < worldChildCount) {
      worldChildVisibilityScratch.length = worldChildCount
    }
    for (let i = 0; i < worldChildCount; i += 1) {
      const child = world.children[i]
      const wasVisible = child.visible
      worldChildVisibilityScratch[i] = wasVisible
      let includeChild = false
      if (mode === RENDER_PASS_WORLD_NO_PELLETS_LAKES) {
        includeChild = child !== pelletsGroup && !isLakeMesh(child)
      } else if (mode === RENDER_PASS_PELLET_OCCLUDERS) {
        includeChild = child === environmentGroup || child === snakesGroup
      } else if (mode === RENDER_PASS_PELLETS_ONLY) {
        includeChild = child === pelletsGroup
      } else if (mode === RENDER_PASS_LAKES_ONLY) {
        includeChild = isLakeMesh(child)
      }
      child.visible = wasVisible && includeChild
    }

    skyGroup.visible = savedSkyVisible && skyVisible
    scene.overrideMaterial = overrideMaterial ?? null
    if (clearDepth) {
      renderer.clearDepth()
    }
    renderer.render(scene, camera)
    scene.overrideMaterial = savedOverrideMaterial
    skyGroup.visible = savedSkyVisible

    for (let i = 0; i < worldChildCount; i += 1) {
      const child = world.children[i]
      child.visible = worldChildVisibilityScratch[i]
    }
  }

  const beginOpaqueSnakeDepthOccluders = () => {
    hiddenSnakeDepthObjects.length = 0
    const hideForDepth = (object: THREE.Object3D) => {
      if (!object.visible) return
      object.visible = false
      hiddenSnakeDepthObjects.push(object)
    }

    for (const visual of snakes.values()) {
      const isOpaqueOccluder =
        visual.group.visible &&
        visual.tube.material.depthWrite &&
        visual.head.material.depthWrite &&
        visual.tail.material.depthWrite
      if (!isOpaqueOccluder) {
        hideForDepth(visual.group)
        continue
      }
      hideForDepth(visual.bowl)
      hideForDepth(visual.selfOverlapGlow)
      hideForDepth(visual.boostDraft)
      hideForDepth(visual.nameplate)
    }
  }

  const endOpaqueSnakeDepthOccluders = () => {
    for (let i = hiddenSnakeDepthObjects.length - 1; i >= 0; i -= 1) {
      hiddenSnakeDepthObjects[i].visible = true
    }
    hiddenSnakeDepthObjects.length = 0
  }

  const render = (
    snapshot: GameStateSnapshot | null,
    cameraState: Camera,
    localPlayerId: string | null,
    cameraDistance: number,
    cameraVerticalOffset = 0,
	  ) => {
	    const now = performance.now()
	    const deltaSeconds = Math.min(0.1, Math.max(0, (now - lastFrameTime) / 1000))
	    lastFrameTime = now
	    const perfEnabled = renderPerfInfo.enabled
	    const perfStartMs = perfEnabled ? now : 0
	    let afterSetupMs = perfStartMs
	    let afterSnakesMs = perfStartMs
	    let afterPelletsMs = perfStartMs
	    let afterVisibilityMs = perfStartMs
	    let afterWaterMs = perfStartMs
	    let passWorldMs = 0
	    let passOccludersMs = 0
	    let passPelletsMs = 0
	    let passDepthRebuildMs = 0
	    let passLakesMs = 0

	    if (cameraState.active) {
	      world.quaternion.set(cameraState.q.x, cameraState.q.y, cameraState.q.z, cameraState.q.w)
	    } else {
	      world.quaternion.identity()
    }
    pointerOverlayRoot.quaternion.copy(world.quaternion)
    if (Number.isFinite(cameraDistance)) {
      camera.position.set(
        0,
        Number.isFinite(cameraVerticalOffset) ? cameraVerticalOffset : 0,
        cameraDistance,
      )
    }
    camera.updateMatrixWorld()
	    const cycleNowMs = snapshot?.now ?? Date.now()
		    updateDayNightVisuals(cycleNowMs)
	
		    let localHeadScreen: { x: number; y: number } | null = null
		    let pointerHasLocalHead = false
		    void pointerHasLocalHead
		    pointerAxisActive = false
		    pointerOverlayRoot.visible = false

	    if (snapshot && localPlayerId) {
	      const localPlayer = snapshot.players.find((player) => player.id === localPlayerId)
	      const head = localPlayer?.snakeDetail !== 'stub' ? localPlayer?.snake[0] : undefined
	      if (head) {
        const girthScale = clamp(
          localPlayer?.girthScale ?? 1,
          SNAKE_GIRTH_SCALE_MIN,
          SNAKE_GIRTH_SCALE_MAX,
        )
        const radius = SNAKE_RADIUS * girthScale * 1.1
        const radiusOffset = radius * SNAKE_LIFT_FACTOR
        const headRadius = HEAD_RADIUS * (radius / SNAKE_RADIUS)
	        const headNormal = tempVectorC.set(head.x, head.y, head.z).normalize()
	        pointerLocalHeadNormalTemp.copy(headNormal)
	        pointerHasLocalHead = true
        snakeContactTangentTemp.set(0, 0, 0)
        if (localPlayer && localPlayer.snake.length > 1) {
          const next = localPlayer.snake[1]
          snakeContactFallbackTemp.set(next.x, next.y, next.z).normalize()
          snakeContactTangentTemp.copy(headNormal).sub(snakeContactFallbackTemp)
          snakeContactTangentTemp.addScaledVector(
            headNormal,
            -snakeContactTangentTemp.dot(headNormal),
          )
          if (snakeContactTangentTemp.lengthSq() <= 1e-8) {
            buildTangentBasis(headNormal, snakeContactTangentTemp, snakeContactBitangentTemp)
          } else {
            snakeContactTangentTemp.normalize()
          }
        } else {
          buildTangentBasis(headNormal, snakeContactTangentTemp, snakeContactBitangentTemp)
        }
        const headCenterlineRadius = getSnakeCenterlineRadius(
          headNormal,
          radiusOffset,
          radius,
        )
        const headLift = applySnakeContactLift(
          headNormal,
          snakeContactTangentTemp,
          headCenterlineRadius,
          headRadius,
          null,
        )
        const headPosition = headNormal
          .clone()
          .multiplyScalar(headCenterlineRadius + headLift)
        headPosition.applyQuaternion(world.quaternion)
        headPosition.project(camera)

        const screenX = (headPosition.x * 0.5 + 0.5) * viewportWidth
        const screenY = (-headPosition.y * 0.5 + 0.5) * viewportHeight
        if (Number.isFinite(screenX) && Number.isFinite(screenY)) {
          localHeadScreen = { x: screenX, y: screenY }
        }
      }
    }

    patchCenterQuat.copy(world.quaternion).invert()
    cameraLocalPosTemp.copy(camera.position).applyQuaternion(patchCenterQuat)
    const cameraLocalDistance = cameraLocalPosTemp.length()
	    if (!Number.isFinite(cameraLocalDistance) || cameraLocalDistance <= 1e-8) {
	      cameraLocalDirTemp.set(0, 0, 1)
	    } else {
	      cameraLocalDirTemp.copy(cameraLocalPosTemp).multiplyScalar(1 / cameraLocalDistance)
	    }

	    // Resolve pointer screen coords to a terrain hit and build an always-on-top curved arrow.
	    if (
	      pointerActive &&
	      pointerHasLocalHead &&
	      Number.isFinite(pointerScreenX) &&
	      Number.isFinite(pointerScreenY) &&
	      viewportWidth > 0 &&
	      viewportHeight > 0
	    ) {
	      const ndcX = (pointerScreenX / viewportWidth) * 2 - 1
	      const ndcY = -(pointerScreenY / viewportHeight) * 2 + 1
	      if (Number.isFinite(ndcX) && Number.isFinite(ndcY)) {
	        pointerNdcTemp.set(ndcX, ndcY)
	        pointerRaycaster.setFromCamera(pointerNdcTemp, camera)

	        pointerOriginLocalTemp.copy(pointerRaycaster.ray.origin).applyQuaternion(patchCenterQuat)
	        pointerDirLocalTemp.copy(pointerRaycaster.ray.direction).applyQuaternion(patchCenterQuat)
	        const dirLenSq = pointerDirLocalTemp.lengthSq()
	        if (dirLenSq > 1e-12) {
	          pointerDirLocalTemp.multiplyScalar(1 / Math.sqrt(dirLenSq))
	          pointerRayLocal.origin.copy(pointerOriginLocalTemp)
	          pointerRayLocal.direction.copy(pointerDirLocalTemp)

	          // Iteratively solve for intersection with the radial terrain surface (keeps the hit under the cursor).
	          pointerSphere.radius = PLANET_RADIUS
	          let hit = pointerRayLocal.intersectSphere(pointerSphere, pointerHitLocalTemp)
	          if (hit) {
	            let ok = true
	            for (let iter = 0; iter < 3; iter += 1) {
	              const hitLenSq = pointerHitLocalTemp.lengthSq()
	              if (hitLenSq <= 1e-12) {
	                ok = false
	                break
	              }
	              const invHitLen = 1 / Math.sqrt(hitLenSq)
	              pointerTargetNormalTemp.copy(pointerHitLocalTemp).multiplyScalar(invHitLen)
	              const radius = getTerrainRadius(pointerTargetNormalTemp)
	              if (!Number.isFinite(radius) || radius <= 0) {
	                ok = false
	                break
	              }
	              if (Math.abs(1 / invHitLen - radius) < 1e-4) {
	                break
	              }
	              pointerSphere.radius = radius
	              hit = pointerRayLocal.intersectSphere(pointerSphere, pointerHitLocalTemp)
	              if (!hit) {
	                ok = false
	                break
	              }
	            }

	            if (ok) {
	              pointerTargetNormalTemp.copy(pointerHitLocalTemp).normalize()

	              pointerAxisVectorTemp.crossVectors(pointerLocalHeadNormalTemp, pointerTargetNormalTemp)
	              const axisLenSq = pointerAxisVectorTemp.lengthSq()
	              if (axisLenSq > 1e-8) {
	                pointerAxisVectorTemp.multiplyScalar(1 / Math.sqrt(axisLenSq))
	                pointerAxisValue.x = pointerAxisVectorTemp.x
	                pointerAxisValue.y = pointerAxisVectorTemp.y
	                pointerAxisValue.z = pointerAxisVectorTemp.z
	                pointerAxisActive = true

	                const dotValue = clamp(
	                  pointerLocalHeadNormalTemp.dot(pointerTargetNormalTemp),
	                  -1,
	                  1,
	                )
		                const angle = Math.acos(dotValue)
		                if (Number.isFinite(angle) && angle > 1e-4) {
			                  const arc = Math.min(POINTER_ARROW_ARC_RADIANS, angle)
			                  const tStart = clamp(1 - arc / angle, 0, 1)
					                  const tipRadius = getTerrainRadius(pointerTargetNormalTemp)
					                  if (Number.isFinite(tipRadius) && tipRadius > 0) {
					                    // Keep the arrow stable over sharp low-poly terrain (dunes): once we have a
					                    // valid cursor hit radius, keep the arrow body on a constant-radius shell
					                    // instead of resampling per-segment terrain height.
					                    const arrowBaseRadius = tipRadius + POINTER_ARROW_LIFT
					                    pointerArrowTipPointTemp
					                      .copy(pointerTargetNormalTemp)
					                      .multiplyScalar(arrowBaseRadius)
					                    const desiredHeadAngle =
					                      POINTER_ARROW_HEAD_LENGTH / Math.max(1e-3, tipRadius)
					                    // Keep a visible shaft even when the cursor is very close: cap the head to
					                    // a fraction of the visible arrow arc.
					                    const headAngle = Math.min(desiredHeadAngle, arc * 0.65, angle)
					                    const headStartT = clamp(1 - headAngle / angle, tStart, 1)

					                    // Build the full arc up to the cursor so the head/tail are one continuous mesh.
					                    for (let i = 0; i <= POINTER_ARROW_SEGMENTS; i += 1) {
					                      const t = tStart + (1 - tStart) * (i / POINTER_ARROW_SEGMENTS)
					                      const dir = pointerArrowDirs[i]
					                      const point = pointerArrowPoints[i]
					                      slerpNormals(pointerLocalHeadNormalTemp, pointerTargetNormalTemp, t, dir)
					                      point.copy(dir).multiplyScalar(arrowBaseRadius)
					                    }

				                    for (let i = 0; i <= POINTER_ARROW_SEGMENTS; i += 1) {
				                      const normal = pointerArrowDirs[i]
				                      const point = pointerArrowPoints[i]
				                      if (i === 0) {
				                        pointerArrowTangentTemp.copy(pointerArrowPoints[1]).sub(point)
				                      } else if (i === POINTER_ARROW_SEGMENTS) {
				                        pointerArrowTangentTemp
				                          .copy(point)
				                          .sub(pointerArrowPoints[POINTER_ARROW_SEGMENTS - 1])
				                      } else {
				                        pointerArrowTangentTemp
				                          .copy(pointerArrowPoints[i + 1])
				                          .sub(pointerArrowPoints[i - 1])
				                          .multiplyScalar(0.5)
				                      }
				                      pointerArrowTangentTemp.addScaledVector(
				                        normal,
				                        -pointerArrowTangentTemp.dot(normal),
				                      )
				                      if (pointerArrowTangentTemp.lengthSq() <= 1e-10) {
				                        buildTangentBasis(normal, pointerArrowTangentTemp, pointerArrowSideTemp)
				                      } else {
				                        pointerArrowTangentTemp.normalize()
				                        pointerArrowSideTemp.crossVectors(normal, pointerArrowTangentTemp)
				                        if (pointerArrowSideTemp.lengthSq() <= 1e-10) {
				                          buildTangentBasis(normal, pointerArrowTangentTemp, pointerArrowSideTemp)
				                        } else {
				                          pointerArrowSideTemp.normalize()
				                        }
				                      }

				                      const t = tStart + (1 - tStart) * (i / POINTER_ARROW_SEGMENTS)
				                      const headDenom = Math.max(1e-4, 1 - headStartT)
				                      const headProgress = clamp((t - headStartT) / headDenom, 0, 1)
				                      let halfWidth =
				                        t >= headStartT
				                          ? lerp(
				                              POINTER_ARROW_HEAD_HALF_WIDTH,
				                              POINTER_ARROW_TIP_HALF_WIDTH,
				                              headProgress,
				                            )
				                          : POINTER_ARROW_HALF_WIDTH
				                      if (i === POINTER_ARROW_SEGMENTS) {
				                        halfWidth = POINTER_ARROW_TIP_HALF_WIDTH
				                      }

				                      const sx = pointerArrowSideTemp.x * halfWidth
				                      const sy = pointerArrowSideTemp.y * halfWidth
				                      const sz = pointerArrowSideTemp.z * halfWidth
				                      // Straight extrusion: use a single extrusion direction so side quads are
				                      // planar (no "weird" diagonal creases from non-coplanar quads).
				                      const nx = pointerTargetNormalTemp.x * POINTER_ARROW_THICKNESS
				                      const ny = pointerTargetNormalTemp.y * POINTER_ARROW_THICKNESS
				                      const nz = pointerTargetNormalTemp.z * POINTER_ARROW_THICKNESS
				                      const base = i * 4 * 3

				                      // bottomLeft
				                      const blx = point.x + sx
				                      const bly = point.y + sy
				                      const blz = point.z + sz
				                      pointerArrowPositions[base] = blx
				                      pointerArrowPositions[base + 1] = bly
				                      pointerArrowPositions[base + 2] = blz

				                      // bottomRight
				                      const brx = point.x - sx
				                      const bry = point.y - sy
				                      const brz = point.z - sz
				                      pointerArrowPositions[base + 3] = brx
				                      pointerArrowPositions[base + 4] = bry
				                      pointerArrowPositions[base + 5] = brz

				                      // topLeft
				                      pointerArrowPositions[base + 6] = blx + nx
				                      pointerArrowPositions[base + 7] = bly + ny
				                      pointerArrowPositions[base + 8] = blz + nz

				                      // topRight
				                      pointerArrowPositions[base + 9] = brx + nx
				                      pointerArrowPositions[base + 10] = bry + ny
				                      pointerArrowPositions[base + 11] = brz + nz
				                    }

				                    // Tip edge vertices (centerline) used by the wedge indices.
				                    const tipBase = pointerArrowRingCount * 4 * 3
				                    pointerArrowPositions[tipBase] = pointerArrowTipPointTemp.x
				                    pointerArrowPositions[tipBase + 1] = pointerArrowTipPointTemp.y
				                    pointerArrowPositions[tipBase + 2] = pointerArrowTipPointTemp.z
				                    pointerArrowPositions[tipBase + 3] =
				                      pointerArrowTipPointTemp.x + pointerTargetNormalTemp.x * POINTER_ARROW_THICKNESS
				                    pointerArrowPositions[tipBase + 4] =
				                      pointerArrowTipPointTemp.y + pointerTargetNormalTemp.y * POINTER_ARROW_THICKNESS
				                    pointerArrowPositions[tipBase + 5] =
				                      pointerArrowTipPointTemp.z + pointerTargetNormalTemp.z * POINTER_ARROW_THICKNESS

				                    pointerArrowMesh.visible = true
				                    pointerArrowPositionAttr.needsUpdate = true
				                    pointerArrowGeometry.computeVertexNormals()
				                    const normalAttr = pointerArrowGeometry.getAttribute('normal')
				                    if (normalAttr instanceof THREE.BufferAttribute) {
				                      normalAttr.needsUpdate = true
				                    }
				                    pointerOverlayRoot.visible = true
				                  }
			                }
			              }
		            }
	          }
	        }
	      }
	    }
		    const aspect = viewportHeight > 0 ? viewportWidth / viewportHeight : 1
		    const viewAngle = computeVisibleSurfaceAngle(cameraLocalDistance, aspect)
		    if (perfEnabled) {
		      afterSetupMs = performance.now()
		    }

	    if (snapshot) {
	      const pelletOverride = updateSnakes(
	        snapshot.players,
	        localPlayerId,
	        deltaSeconds,
	        snapshot.pellets,
	        now,
	      )
	      if (perfEnabled) {
	        afterSnakesMs = performance.now()
	      }
	      updatePellets(snapshot.pellets, pelletOverride, now * 0.001, cameraLocalDirTemp, viewAngle)
	      if (perfEnabled) {
	        afterPelletsMs = performance.now()
	      }
	    } else {
	      updateSnakes([], localPlayerId, deltaSeconds, null, now)
	      if (perfEnabled) {
	        afterSnakesMs = performance.now()
	      }
	      updatePellets([], null, now * 0.001, cameraLocalDirTemp, viewAngle)
	      if (perfEnabled) {
	        afterPelletsMs = performance.now()
	      }
	    }

	    if (PLANET_PATCH_ENABLED) {
	      updatePlanetPatchVisibility(cameraLocalDirTemp, viewAngle)
	    }
	    updateLakeVisibility(cameraLocalDirTemp, viewAngle)
	    updateEnvironmentVisibility(cameraLocalPosTemp, cameraLocalDirTemp, viewAngle)
	    if (perfEnabled) {
	      afterVisibilityMs = performance.now()
	    }

	    const lakeTimeSeconds = now * 0.001
	    for (let i = 0; i < lakeMaterials.length; i += 1) {
	      const material = lakeMaterials[i]
      const uniforms = (material.userData as LakeMaterialUserData).lakeWaterUniforms
      if (uniforms) {
        uniforms.time.value = lakeTimeSeconds
      } else {
	        material.emissiveIntensity =
	          LAKE_WATER_EMISSIVE_BASE +
	          Math.sin(lakeTimeSeconds * LAKE_WATER_WAVE_SPEED + i * 0.73) * LAKE_WATER_EMISSIVE_PULSE
	      }
	    }
	    updatePelletGlow(lakeTimeSeconds)
	    if (perfEnabled) {
	      afterWaterMs = performance.now()
	    }

	    const savedAutoClear = renderer.autoClear
	    renderer.autoClear = false
	    renderer.clear()
	    try {
	      // Pass 1: Render the main world without pellets/lakes so pellet occlusion can be composited separately.
	      let passStartMs = 0
	      if (perfEnabled) {
	        passStartMs = performance.now()
	      }
	      renderWorldPass(RENDER_PASS_WORLD_NO_PELLETS_LAKES, true)
	      if (perfEnabled) {
	        passWorldMs = performance.now() - passStartMs
	      }
	      // Passes 2-4 share the same snake-depth occluder mask to avoid duplicate snake scans.
	      beginOpaqueSnakeDepthOccluders()
	      try {
	        // Pass 2: Build depth from terrain objects + opaque snakes (not planet) to occlude pellet glow.
	        if (perfEnabled) {
	          passStartMs = performance.now()
	        }
	        renderWorldPass(RENDER_PASS_PELLET_OCCLUDERS, false, occluderDepthMaterial, true)
	        if (perfEnabled) {
	          passOccludersMs = performance.now() - passStartMs
	        }
	        // Pass 3: Render pellets against occluder depth for partial occlusion.
	        if (perfEnabled) {
	          passStartMs = performance.now()
	        }
	        renderWorldPass(RENDER_PASS_PELLETS_ONLY, false)
	        if (perfEnabled) {
	          passPelletsMs = performance.now() - passStartMs
	        }
	        // Pass 4: Rebuild full depth (including planet) so lake overlays depth-test correctly.
	        if (perfEnabled) {
	          passStartMs = performance.now()
	        }
	        renderWorldPass(RENDER_PASS_WORLD_NO_PELLETS_LAKES, false, occluderDepthMaterial, true)
	        if (perfEnabled) {
	          passDepthRebuildMs = performance.now() - passStartMs
	        }
	      } finally {
	        endOpaqueSnakeDepthOccluders()
	      }
	      // Pass 5: Render lakes last so underwater pellets still read through the water surface overlay.
	      if (perfEnabled) {
	        passStartMs = performance.now()
	      }
	      renderWorldPass(RENDER_PASS_LAKES_ONLY, false)
	      if (perfEnabled) {
	        passLakesMs = performance.now() - passStartMs
	      }

	        if (menuPreviewVisible && menuPreviewGroup.visible) {
	          menuPreviewGroup.rotation.set(menuPreviewPitch, menuPreviewYaw, 0)
	          renderer.clearDepth()
	          renderer.render(menuPreviewScene, menuPreviewCamera)
	        }
	        if (pointerOverlayRoot.visible) {
	          renderer.clearDepth()
	          renderer.render(pointerOverlayScene, camera)
	        }
		    } finally {
		      renderer.autoClear = savedAutoClear
		    }
	    if (perfEnabled) {
	      const frameEndMs = performance.now()
	      const totalMs = frameEndMs - perfStartMs
	      const frame: RenderPerfFrame = {
	        tMs: now,
	        totalMs,
	        setupMs: afterSetupMs - perfStartMs,
	        snakesMs: afterSnakesMs - afterSetupMs,
	        pelletsMs: afterPelletsMs - afterSnakesMs,
	        visibilityMs: afterVisibilityMs - afterPelletsMs,
	        waterMs: afterWaterMs - afterVisibilityMs,
	        passWorldMs,
	        passOccludersMs,
	        passPelletsMs,
	        passDepthRebuildMs,
	        passLakesMs,
	      }

	      renderPerfInfo.frameCount += 1
	      renderPerfInfo.maxTotalMs = Math.max(renderPerfInfo.maxTotalMs, totalMs)
	      renderPerfInfo.lastFrame = frame

	      if (totalMs >= renderPerfInfo.thresholdMs) {
	        renderPerfInfo.slowFrameCount += 1
	        renderPerfInfo.slowFrames.push(frame)
	        if (renderPerfInfo.slowFrames.length > renderPerfSlowFramesMax) {
	          renderPerfInfo.slowFrames.splice(
	            0,
	            renderPerfInfo.slowFrames.length - renderPerfSlowFramesMax,
	          )
	        }
	      }
	    }
	    return localHeadScreen
	  }

  const setEnvironment = (environment: Environment) => {
    buildEnvironment(environment)
  }

  const setDebugFlags = (flags: {
    mountainOutline?: boolean
    lakeCollider?: boolean
    treeCollider?: boolean
    terrainTessellation?: boolean
  }) => {
    if (typeof flags.mountainOutline === 'boolean') {
      mountainDebugEnabled = flags.mountainOutline
      if (mountainDebugGroup) {
        mountainDebugGroup.visible = mountainDebugEnabled
      }
    }
    if (typeof flags.lakeCollider === 'boolean') {
      lakeDebugEnabled = flags.lakeCollider
      if (lakeDebugGroup) {
        lakeDebugGroup.visible = lakeDebugEnabled
      }
    }
    if (typeof flags.treeCollider === 'boolean') {
      treeDebugEnabled = flags.treeCollider
      if (treeDebugGroup) {
        treeDebugGroup.visible = treeDebugEnabled
      }
    }
    if (typeof flags.terrainTessellation === 'boolean') {
      terrainTessellationDebugEnabled = flags.terrainTessellation
      if (planetPatchMaterial) {
        planetPatchMaterial.wireframe = terrainTessellationDebugEnabled
        planetPatchMaterial.needsUpdate = true
      }
      if (planetMesh?.material instanceof THREE.MeshStandardMaterial) {
        planetMesh.material.wireframe = terrainTessellationDebugEnabled
        planetMesh.material.needsUpdate = true
      }
    }
  }

  const setDayNightDebugMode = (mode: DayNightDebugMode) => {
    if (mode === 'accelerated' || mode === 'auto') {
      dayNightDebugMode = mode
      return
    }
    dayNightDebugMode = 'auto'
  }

  const resize = (width: number, height: number, dpr: number) => {
    viewportWidth = width
    viewportHeight = height
    renderer.setPixelRatio(dpr)
    renderer.setSize(width, height, false)
    const safeHeight = height > 0 ? height : 1
    const aspect = width / safeHeight
    camera.aspect = aspect
    camera.updateProjectionMatrix()
    menuPreviewCamera.aspect = aspect
    menuPreviewCamera.updateProjectionMatrix()
    // Keep the preview clear of the right-side skin UI panels on wide layouts.
    menuPreviewGroup.position.x = width > 920 ? -0.65 : 0
  }

  const dispose = () => {
    renderer.dispose()
    if (boostWarmupGroup) {
      world.remove(boostWarmupGroup)
      boostWarmupGroup = null
    }
    if (boostWarmupTrailGeometry) {
      boostWarmupTrailGeometry.dispose()
      boostWarmupTrailGeometry = null
    }
    if (boostWarmupTrailMaterial) {
      boostWarmupTrailMaterial.dispose()
      boostWarmupTrailMaterial = null
    }
    if (boostWarmupDraftMaterial) {
      boostWarmupDraftMaterial.dispose()
      boostWarmupDraftMaterial = null
    }
    disposeEnvironment()
    camera.remove(skyGroup)
    skyDomeGeometry.dispose()
    skyDomeMaterial.dispose()
    starsGeometry.dispose()
    starsMaterial.dispose()
    starTexture?.dispose()
    horizonTexture?.dispose()
    horizonMaterial.dispose()
    skyGradient?.texture.dispose()
    sunTexture?.dispose()
    sunGlowTexture?.dispose()
    moonTexture?.dispose()
    moonGlowTexture?.dispose()
    sunCoreMaterial.dispose()
    sunGlowMaterial.dispose()
    moonCoreMaterial.dispose()
    moonGlowMaterial.dispose()
    headGeometry.dispose()
    bowlGeometry.dispose()
    tailGeometry.dispose()
    eyeGeometry.dispose()
    pupilGeometry.dispose()
    eyeMaterial.dispose()
    pupilMaterial.dispose()
    tongueBaseGeometry.dispose()
    tongueForkGeometry.dispose()
    tongueMaterial.dispose()
	    boostDraftGeometry.dispose()
	    boostDraftTexture?.dispose()
		    menuPreviewMaterial.dispose()
		    menuPreviewHeadMaterial.dispose()
		    menuPreviewTube.geometry.dispose()
		    menuPreviewTail.geometry.dispose()
		    pointerArrowMaterial.dispose()
		    pointerArrowGeometry.dispose()
		    for (const texture of snakeSkinTextureCache.values()) {
		      texture.dispose()
		    }
    snakeSkinTextureCache.clear()
    for (let i = 0; i < pelletBuckets.length; i += 1) {
      const bucket = pelletBuckets[i]
      if (!bucket) continue
      pelletsGroup.remove(bucket.shadowPoints)
      pelletsGroup.remove(bucket.glowPoints)
      pelletsGroup.remove(bucket.innerGlowPoints)
      pelletsGroup.remove(bucket.corePoints)
      bucket.corePoints.geometry.dispose()
      bucket.shadowMaterial.dispose()
      bucket.coreMaterial.dispose()
      bucket.innerGlowMaterial.dispose()
      bucket.glowMaterial.dispose()
      pelletBuckets[i] = null
    }
    pelletShadowTexture?.dispose()
    pelletCoreTexture?.dispose()
    pelletInnerGlowTexture?.dispose()
    pelletGlowTexture?.dispose()
    occluderDepthMaterial.dispose()
    pelletGroundCache.clear()
    pelletMotionStates.clear()
    pelletIdsSeen.clear()
    for (const [id, visual] of snakes) {
      removeSnake(visual, id)
    }
    snakes.clear()
    for (const trails of boostTrails.values()) {
      for (const trail of trails) {
        disposeBoostTrail(trail)
      }
    }
    boostTrails.clear()
    boostTrailAlphaTexture?.dispose()
    for (const trail of boostTrailPool) {
      disposeBoostTrail(trail)
    }
    boostTrailPool.length = 0

    if ((debugEnabled || perfDebugEnabled) && typeof window !== 'undefined') {
      const debugWindow = window as Window & { __SNAKE_DEBUG__?: unknown }
      if (debugWindow.__SNAKE_DEBUG__ === debugApi) {
        delete debugWindow.__SNAKE_DEBUG__
      }
    }
  }

	  return {
	    resize,
	    render,
	    setPointerScreen,
	    getPointerAxis,
	    setMenuPreviewVisible,
	    setMenuPreviewSkin,
	    setMenuPreviewOrbit,
	    setEnvironment,
    setDebugFlags,
    setDayNightDebugMode,
    dispose,
  }
}
