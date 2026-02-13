import * as THREE from 'three'
import { paintNameplateTexture } from '../utils/texture'

type SnakeBoostBodyGlowVisual = {
  boostBodyGlowGroup: THREE.Group
  boostBodyGlowSprites: THREE.Sprite[]
  boostBodyGlowPhase: number
  boostBodyGlowIntensity: number
  boostBodyGlowWaveCount: number
  boostBodyGlowMode: 'off' | 'sprite-wave'
}

type SnakeIntakeConeVisual = {
  intakeCone: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>
  intakeConeMaterial: THREE.MeshBasicMaterial
  intakeConeIntensity: number
  intakeConeHoldUntilMs: number
}

type SnakeNameplateVisual = {
  nameplate: THREE.Sprite
  nameplateMaterial: THREE.SpriteMaterial
  nameplateTexture: THREE.CanvasTexture | null
  nameplateCanvas: HTMLCanvasElement | null
  nameplateCtx: CanvasRenderingContext2D | null
  nameplateText: string
}

export const updateSnakeMaterial = (
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

export const hideBoostBodyGlow = (visual: SnakeBoostBodyGlowVisual) => {
  visual.boostBodyGlowPhase = 0
  visual.boostBodyGlowIntensity = 0
  visual.boostBodyGlowWaveCount = 1
  visual.boostBodyGlowMode = 'off'
  visual.boostBodyGlowGroup.visible = false
  for (const sprite of visual.boostBodyGlowSprites) {
    sprite.visible = false
    sprite.material.opacity = 0
  }
}

export const hideIntakeCone = (visual: SnakeIntakeConeVisual) => {
  visual.intakeCone.visible = false
  visual.intakeConeMaterial.opacity = 0
  visual.intakeConeIntensity = 0
  visual.intakeConeHoldUntilMs = 0
}

export const hideNameplate = (visual: SnakeNameplateVisual) => {
  visual.nameplate.visible = false
  visual.nameplateMaterial.opacity = 0
}

export const updateNameplateText = (visual: SnakeNameplateVisual, name: string) => {
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
