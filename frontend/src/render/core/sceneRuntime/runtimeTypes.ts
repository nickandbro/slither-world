import * as THREE from 'three'
import type { Camera, Environment, GameStateSnapshot, Point } from '../../../game/types'

export type SnakeVisual = {
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
  bowl: THREE.Mesh<THREE.BufferGeometry, THREE.MeshPhysicalMaterial>
  bowlMaterial: THREE.MeshPhysicalMaterial
  bowlCrackUniform: { value: number }
  boostDraft: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>
  boostDraftMaterial: THREE.MeshBasicMaterial
  boostDraftPhase: number
  boostDraftIntensity: number
  intakeCone: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>
  intakeConeMaterial: THREE.MeshBasicMaterial
  intakeConeIntensity: number
  intakeConeHoldUntilMs: number
  nameplate: THREE.Sprite
  nameplateMaterial: THREE.SpriteMaterial
  nameplateTexture: THREE.CanvasTexture | null
  nameplateCanvas: HTMLCanvasElement | null
  nameplateCtx: CanvasRenderingContext2D | null
  nameplateText: string
  color: string
  skinKey: string
}

export type DeathState = {
  start: number
}

export type TerrainPatchInstance = {
  mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>
  center: THREE.Vector3
  angularExtent: number
  visible: boolean
}

export type TreeCullEntry = {
  basePoint: THREE.Vector3
  topPoint: THREE.Vector3
  baseRadius: number
  topRadius: number
}

export type CactusCullEntry = {
  basePoint: THREE.Vector3
  topPoint: THREE.Vector3
  leftArmTipPoint: THREE.Vector3
  rightArmTipPoint: THREE.Vector3
  baseRadius: number
  topRadius: number
  armRadius: number
}

export type MountainCullEntry = {
  basePoint: THREE.Vector3
  peakPoint: THREE.Vector3
  baseRadius: number
  peakRadius: number
  variant: number
}

export type PebbleCullEntry = {
  point: THREE.Vector3
  radius: number
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
  queuePelletConsumeTargets?: (targets: ReadonlyMap<number, string> | null) => void
  clearPelletConsumeTargets?: () => void
  // WebGPU-only quality knob (offscreen MSAA samples). No-op on WebGL.
  setWebgpuWorldSamples?: (samples: number) => void
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
