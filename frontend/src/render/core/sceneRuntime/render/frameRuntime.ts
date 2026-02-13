import * as THREE from 'three'
import type { WebGPURenderer } from 'three/webgpu'
import type { Camera, GameStateSnapshot, Point } from '../../../../game/types'
import { updatePointerArrowOverlay, type PointerArrowOverlay } from '../overlays/pointerArrow'
import type { MenuPreviewOverlay } from '../overlays/menuPreview'
import type { LakeMaterialUserData } from '../environment/lakes'
import type { RenderPerfFrame, RenderPerfInfo } from '../debug/perf'
import type { SnakeVisual } from '../runtimeTypes'
import { clamp, computeVisibleSurfaceAngle } from '../utils/math'

type RenderPassUpdater = (
  cameraLocalPos: THREE.Vector3,
  cameraLocalDir: THREE.Vector3,
  viewAngle: number,
) => void

type SceneFrameRuntimeDeps = {
  renderer: THREE.WebGLRenderer | WebGPURenderer
  scene: THREE.Scene
  camera: THREE.PerspectiveCamera
  world: THREE.Group
  skyGroup: THREE.Group
  environmentGroup: THREE.Group
  snakesGroup: THREE.Group
  pelletsGroup: THREE.Group
  lakeMeshes: THREE.Mesh[]
  lakeMaterials: THREE.MeshStandardMaterial[]
  snakes: Map<string, SnakeVisual>
  occluderDepthMaterial: THREE.Material
  menuPreviewOverlay: MenuPreviewOverlay
  pointerArrowOverlay: PointerArrowOverlay
  pointerOverlayRoot: THREE.Group
  pointerOverlayScene: THREE.Scene
  patchCenterQuat: THREE.Quaternion
  cameraLocalPosTemp: THREE.Vector3
  cameraLocalDirTemp: THREE.Vector3
  tempVectorC: THREE.Vector3
  snakeContactTangentTemp: THREE.Vector3
  snakeContactFallbackTemp: THREE.Vector3
  snakeContactBitangentTemp: THREE.Vector3
  updateDayNightVisuals: (nowMs: number) => void
  updateSnakes: (
    players: GameStateSnapshot['players'],
    localPlayerId: string | null,
    deltaSeconds: number,
    nowMs: number,
  ) => void
  updatePellets: (
    pellets: GameStateSnapshot['pellets'],
    timeSeconds: number,
    deltaSeconds: number,
    cameraLocalDir: THREE.Vector3,
    viewAngle: number,
  ) => void
  updatePelletGlow: (timeSeconds: number) => void
  updatePlanetPatchVisibility: (cameraLocalDir: THREE.Vector3, viewAngle: number) => void
  updateLakeVisibility: (cameraLocalDir: THREE.Vector3, viewAngle: number) => void
  updateEnvironmentVisibility: RenderPassUpdater
  buildTangentBasis: (
    normal: THREE.Vector3,
    tangent: THREE.Vector3,
    bitangent: THREE.Vector3,
  ) => void
  getSnakeCenterlineRadius: (
    normal: THREE.Vector3,
    radiusOffset: number,
    snakeRadius: number,
  ) => number
  applySnakeContactLift: (
    normal: THREE.Vector3,
    tangent: THREE.Vector3,
    centerlineRadius: number,
    snakeRadius: number,
    groundingInfo: null,
  ) => number
  getTerrainRadius: (normal: THREE.Vector3) => number
  getViewportSize: () => { width: number; height: number }
  renderPerfInfo: RenderPerfInfo
  renderPerfSlowFramesMax: number
  webgpuOffscreenEnabled: boolean
  webgpuWorldTarget: THREE.RenderTarget | null
  webgpuPresentScene: THREE.Scene | null
  webgpuPresentCamera: THREE.OrthographicCamera | null
  constants: {
    snakeRadius: number
    snakeGirthScaleMin: number
    snakeGirthScaleMax: number
    snakeLiftFactor: number
    headRadius: number
    lakeWaterEmissiveBase: number
    lakeWaterEmissivePulse: number
    lakeWaterWaveSpeed: number
    planetPatchEnabled: boolean
  }
}

const RENDER_PASS_WORLD_NO_PELLETS_LAKES = 0
const RENDER_PASS_PELLET_OCCLUDERS = 1
const RENDER_PASS_PELLETS_ONLY = 2
const RENDER_PASS_LAKES_ONLY = 3
const RENDER_PASS_TERRAIN_DEPTH_FILL = 4

export const createSceneFrameRuntime = (deps: SceneFrameRuntimeDeps) => {
  const {
    renderer,
    scene,
    camera,
    world,
    skyGroup,
    environmentGroup,
    snakesGroup,
    pelletsGroup,
    lakeMeshes,
    lakeMaterials,
    snakes,
    occluderDepthMaterial,
    menuPreviewOverlay,
    pointerArrowOverlay,
    pointerOverlayRoot,
    pointerOverlayScene,
    patchCenterQuat,
    cameraLocalPosTemp,
    cameraLocalDirTemp,
    tempVectorC,
    snakeContactTangentTemp,
    snakeContactFallbackTemp,
    snakeContactBitangentTemp,
    updateDayNightVisuals,
    updateSnakes,
    updatePellets,
    updatePelletGlow,
    updatePlanetPatchVisibility,
    updateLakeVisibility,
    updateEnvironmentVisibility,
    buildTangentBasis,
    getSnakeCenterlineRadius,
    applySnakeContactLift,
    getTerrainRadius,
    getViewportSize,
    renderPerfInfo,
    renderPerfSlowFramesMax,
    webgpuOffscreenEnabled,
    webgpuWorldTarget,
    webgpuPresentScene,
    webgpuPresentCamera,
    constants,
  } = deps

  const worldChildVisibilityScratch: boolean[] = []
  const hiddenSnakeDepthObjects: THREE.Object3D[] = []
  const pointerLocalHeadNormalTemp = new THREE.Vector3(0, 0, 1)
  const pointerAxisValue: Point = { x: 0, y: 0, z: 0 }
  let pointerAxisActive = false
  let pointerScreenX = Number.NaN
  let pointerScreenY = Number.NaN
  let pointerActive = false
  let lastFrameTime = performance.now()

  const setPointerScreen = (x: number, y: number, active: boolean) => {
    pointerScreenX = x
    pointerScreenY = y
    pointerActive = active
  }

  const getPointerAxis = () => (pointerAxisActive ? pointerAxisValue : null)

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
      } else if (mode === RENDER_PASS_TERRAIN_DEPTH_FILL) {
        includeChild = child instanceof THREE.Mesh && !isLakeMesh(child)
      }
      child.visible = wasVisible && includeChild
    }

    skyGroup.visible = savedSkyVisible && skyVisible
    scene.overrideMaterial = overrideMaterial ?? null
    if (clearDepth) {
      renderer.clear(false, true, false)
    }
    renderer.render(scene, camera)
    scene.overrideMaterial = savedOverrideMaterial
    skyGroup.visible = savedSkyVisible

    for (let i = 0; i < worldChildCount; i += 1) {
      const child = world.children[i]
      child.visible = worldChildVisibilityScratch[i]!
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
      hideForDepth(visual.intakeCone)
      hideForDepth(visual.nameplate)
    }
  }

  const endOpaqueSnakeDepthOccluders = () => {
    for (let i = hiddenSnakeDepthObjects.length - 1; i >= 0; i -= 1) {
      hiddenSnakeDepthObjects[i]!.visible = true
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

    const { width: viewportWidth, height: viewportHeight } = getViewportSize()

    if (snapshot && localPlayerId) {
      const localPlayer = snapshot.players.find((player) => player.id === localPlayerId)
      const head = localPlayer?.snakeDetail !== 'stub' ? localPlayer?.snake[0] : undefined
      if (head) {
        const girthScale = clamp(
          localPlayer?.girthScale ?? 1,
          constants.snakeGirthScaleMin,
          constants.snakeGirthScaleMax,
        )
        const radius = constants.snakeRadius * girthScale * 1.1
        const radiusOffset = radius * constants.snakeLiftFactor
        const headRadius = constants.headRadius * (radius / constants.snakeRadius)
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
        const headCenterlineRadius = getSnakeCenterlineRadius(headNormal, radiusOffset, radius)
        const headLift = applySnakeContactLift(
          headNormal,
          snakeContactTangentTemp,
          headCenterlineRadius,
          headRadius,
          null,
        )
        const headPosition = headNormal.clone().multiplyScalar(headCenterlineRadius + headLift)
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

    const pointerUpdate = updatePointerArrowOverlay({
      overlay: pointerArrowOverlay,
      active: pointerActive,
      hasLocalHead: pointerHasLocalHead,
      screenX: pointerScreenX,
      screenY: pointerScreenY,
      viewportWidth,
      viewportHeight,
      camera,
      worldInverse: patchCenterQuat,
      localHeadNormal: pointerLocalHeadNormalTemp,
      getTerrainRadius,
      buildTangentBasis,
    })
    pointerAxisActive = pointerUpdate.axisActive
    if (pointerUpdate.axisActive) {
      pointerAxisValue.x = pointerUpdate.axis.x
      pointerAxisValue.y = pointerUpdate.axis.y
      pointerAxisValue.z = pointerUpdate.axis.z
    }
    const aspect = viewportHeight > 0 ? viewportWidth / viewportHeight : 1
    const viewAngle = computeVisibleSurfaceAngle(cameraLocalDistance, aspect)
    if (perfEnabled) {
      afterSetupMs = performance.now()
    }

    if (snapshot) {
      updateSnakes(
        snapshot.players,
        localPlayerId,
        deltaSeconds,
        now,
      )
      if (perfEnabled) {
        afterSnakesMs = performance.now()
      }
      updatePellets(
        snapshot.pellets,
        now * 0.001,
        deltaSeconds,
        cameraLocalDirTemp,
        viewAngle,
      )
      if (perfEnabled) {
        afterPelletsMs = performance.now()
      }
    } else {
      updateSnakes([], localPlayerId, deltaSeconds, now)
      if (perfEnabled) {
        afterSnakesMs = performance.now()
      }
      updatePellets([], now * 0.001, deltaSeconds, cameraLocalDirTemp, viewAngle)
      if (perfEnabled) {
        afterPelletsMs = performance.now()
      }
    }

    if (constants.planetPatchEnabled) {
      updatePlanetPatchVisibility(cameraLocalDirTemp, viewAngle)
    }
    updateLakeVisibility(cameraLocalDirTemp, viewAngle)
    updateEnvironmentVisibility(cameraLocalPosTemp, cameraLocalDirTemp, viewAngle)
    if (perfEnabled) {
      afterVisibilityMs = performance.now()
    }

    const lakeTimeSeconds = now * 0.001
    for (let i = 0; i < lakeMaterials.length; i += 1) {
      const material = lakeMaterials[i]!
      const uniforms = (material.userData as LakeMaterialUserData).lakeWaterUniforms
      if (uniforms) {
        uniforms.time.value = lakeTimeSeconds
      } else {
        material.emissiveIntensity =
          constants.lakeWaterEmissiveBase +
          Math.sin(lakeTimeSeconds * constants.lakeWaterWaveSpeed + i * 0.73) *
            constants.lakeWaterEmissivePulse
      }
    }
    updatePelletGlow(lakeTimeSeconds)
    if (perfEnabled) {
      afterWaterMs = performance.now()
    }

    const savedAutoClear = renderer.autoClear
    const savedRenderTarget =
      (renderer as unknown as { getRenderTarget?: () => unknown }).getRenderTarget?.() ?? null
    const useWebgpuOffscreen =
      webgpuOffscreenEnabled &&
      webgpuWorldTarget !== null &&
      webgpuPresentScene !== null &&
      webgpuPresentCamera !== null

    if (useWebgpuOffscreen) {
      ;(renderer as unknown as { setRenderTarget?: (target: unknown) => void }).setRenderTarget?.(
        webgpuWorldTarget,
      )
    }

    renderer.autoClear = false
    renderer.clear()
    try {
      let passStartMs = 0
      if (perfEnabled) {
        passStartMs = performance.now()
      }
      renderWorldPass(RENDER_PASS_WORLD_NO_PELLETS_LAKES, true)
      if (perfEnabled) {
        passWorldMs = performance.now() - passStartMs
      }

      beginOpaqueSnakeDepthOccluders()
      try {
        if (perfEnabled) {
          passStartMs = performance.now()
        }
        renderWorldPass(RENDER_PASS_PELLET_OCCLUDERS, false, occluderDepthMaterial, true)
        if (perfEnabled) {
          passOccludersMs = performance.now() - passStartMs
        }

        if (perfEnabled) {
          passStartMs = performance.now()
        }
        renderWorldPass(RENDER_PASS_PELLETS_ONLY, false)
        if (perfEnabled) {
          passPelletsMs = performance.now() - passStartMs
        }

        if (perfEnabled) {
          passStartMs = performance.now()
        }
        renderWorldPass(RENDER_PASS_TERRAIN_DEPTH_FILL, false, occluderDepthMaterial)
        if (perfEnabled) {
          passDepthRebuildMs = performance.now() - passStartMs
        }
      } finally {
        endOpaqueSnakeDepthOccluders()
      }

      if (perfEnabled) {
        passStartMs = performance.now()
      }
      renderWorldPass(RENDER_PASS_LAKES_ONLY, false)
      if (perfEnabled) {
        passLakesMs = performance.now() - passStartMs
      }

      if (useWebgpuOffscreen) {
        if (menuPreviewOverlay.isVisible()) {
          menuPreviewOverlay.applyRenderRotation()
          renderer.clear(false, true, false)
          renderer.render(menuPreviewOverlay.scene, menuPreviewOverlay.camera)
        }
        if (pointerOverlayRoot.visible) {
          renderer.clear(false, true, false)
          renderer.render(pointerOverlayScene, camera)
        }
      } else {
        if (menuPreviewOverlay.isVisible()) {
          menuPreviewOverlay.applyRenderRotation()
          renderer.clearDepth()
          renderer.render(menuPreviewOverlay.scene, menuPreviewOverlay.camera)
        }
        if (pointerOverlayRoot.visible) {
          renderer.clearDepth()
          renderer.render(pointerOverlayScene, camera)
        }
      }
    } finally {
      renderer.autoClear = savedAutoClear
    }

    if (useWebgpuOffscreen) {
      ;(renderer as unknown as { setRenderTarget?: (target: unknown) => void }).setRenderTarget?.(
        null,
      )
      const savedPresentAutoClear = renderer.autoClear
      renderer.autoClear = true
      renderer.render(webgpuPresentScene!, webgpuPresentCamera!)
      renderer.autoClear = savedPresentAutoClear
      ;(renderer as unknown as { setRenderTarget?: (target: unknown) => void }).setRenderTarget?.(
        savedRenderTarget,
      )
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

  return {
    render,
    setPointerScreen,
    getPointerAxis,
  }
}
