import * as THREE from 'three'
import { createMenuPreviewOverlay, type MenuPreviewOverlay } from './menuPreview'
import { createPointerArrowOverlay, type PointerArrowOverlay } from './pointerArrow'
import { normalizeHexColor } from '../utils/color'
import { createSnakeSkinTexture, resolveSkinSlots } from '../utils/texture'

type GetSnakeSkinTextureResult = {
  key: string
  texture: THREE.CanvasTexture
  primary: string
  slots: string[]
}

type MenuPreviewRuntimeDeps = {
  renderer: THREE.WebGLRenderer
  headGeometry: THREE.BufferGeometry
  snakeRadius: number
  snakeTubeRadialSegments: number
  tailCapSegments: number
  snakeTailCapUSpan: number
  applySnakeSkinUVs: (
    geometry: THREE.TubeGeometry,
    headStartOffset: number,
    snakeTotalLen: number,
  ) => void
  buildTailCapGeometry: (
    tubeGeometry: THREE.TubeGeometry,
    tailDirection: THREE.Vector3,
    options: {
      tailCapSegments: number
      snakeTailCapUSpan: number
    },
  ) => THREE.BufferGeometry | null
  pelletConsumeTargetByPelletId: Map<number, string>
}

export type MenuPreviewRuntime = {
  menuPreviewOverlay: MenuPreviewOverlay
  pointerArrowOverlay: PointerArrowOverlay
  pointerOverlayScene: THREE.Scene
  pointerOverlayRoot: THREE.Group
  snakeSkinTextureCache: Map<string, THREE.CanvasTexture>
  getSnakeSkinTexture: (
    primaryColor: string,
    skinColors?: string[] | null,
  ) => GetSnakeSkinTextureResult
  setMenuPreviewVisible: (visible: boolean) => void
  setMenuPreviewSkin: (colors: string[] | null, previewLen?: number) => void
  setMenuPreviewOrbit: (yaw: number, pitch: number) => void
  queuePelletConsumeTargets: (targets: ReadonlyMap<number, string> | null) => void
  clearPelletConsumeTargets: () => void
}

export const createMenuPreviewRuntime = (deps: MenuPreviewRuntimeDeps): MenuPreviewRuntime => {
  const {
    renderer,
    headGeometry,
    snakeRadius,
    snakeTubeRadialSegments,
    tailCapSegments,
    snakeTailCapUSpan,
    applySnakeSkinUVs,
    buildTailCapGeometry,
    pelletConsumeTargetByPelletId,
  } = deps

  const snakeSkinTextureCache = new Map<string, THREE.CanvasTexture>()
  const maxAnisotropy = renderer.capabilities.getMaxAnisotropy()

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
    return {
      key,
      texture,
      primary: slots[0] ?? (normalizeHexColor(primaryColor) ?? '#ffffff'),
      slots,
    }
  }

  const menuPreviewOverlay = createMenuPreviewOverlay({
    headGeometry,
    snakeRadius,
    snakeTubeRadialSegments,
    getSkinTexture: getSnakeSkinTexture,
    applySnakeSkinUVs,
    buildTailCapGeometry: (tubeGeometry, tailDirection) =>
      buildTailCapGeometry(tubeGeometry, tailDirection, {
        tailCapSegments,
        snakeTailCapUSpan,
      }),
  })
  const setMenuPreviewVisible = (visible: boolean) => {
    menuPreviewOverlay.setVisible(visible)
  }
  const setMenuPreviewSkin = (colors: string[] | null, previewLen?: number) => {
    menuPreviewOverlay.setSkin(colors, previewLen)
  }
  const setMenuPreviewOrbit = (yaw: number, pitch: number) => {
    menuPreviewOverlay.setOrbit(yaw, pitch)
  }

  const pointerArrowOverlay = createPointerArrowOverlay(snakeRadius)
  const pointerOverlayScene = pointerArrowOverlay.scene
  const pointerOverlayRoot = pointerArrowOverlay.root

  const queuePelletConsumeTargets = (targets: ReadonlyMap<number, string> | null) => {
    if (!targets) return
    for (const [pelletId, targetPlayerId] of targets) {
      if (!Number.isFinite(pelletId) || typeof targetPlayerId !== 'string' || targetPlayerId.length <= 0) {
        continue
      }
      pelletConsumeTargetByPelletId.set(pelletId, targetPlayerId)
    }
  }
  const clearPelletConsumeTargets = () => {
    pelletConsumeTargetByPelletId.clear()
  }

  return {
    menuPreviewOverlay,
    pointerArrowOverlay,
    pointerOverlayScene,
    pointerOverlayRoot,
    snakeSkinTextureCache,
    getSnakeSkinTexture,
    setMenuPreviewVisible,
    setMenuPreviewSkin,
    setMenuPreviewOrbit,
    queuePelletConsumeTargets,
    clearPelletConsumeTargets,
  }
}
