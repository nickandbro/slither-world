import * as THREE from 'three'
import type { Environment } from '../../../../game/types'
import type { PelletConsumeGhost } from '../pellets/consumeGhosts'
import type { PelletGroundCacheEntry } from '../pellets/surface'
import type { PelletMotionState, PelletVisualState } from '../pellets/motion'
import type { BuildEnvironmentRuntimeState } from './buildRuntimeTypes'
import { buildEnvironmentRuntime } from './buildRuntime'
import {
  updateEnvironmentVisibilityRuntime,
  updateLakeVisibilityRuntime,
  updatePlanetPatchVisibilityRuntime,
} from './visibilityRuntime'
import { type Lake } from './lakes'
import {
  LAKE_DEBUG_OFFSET,
  LAKE_DEBUG_SEGMENTS,
  LAKE_VISIBILITY_EXTRA_RADIUS,
  LAKE_VISIBILITY_HIDE_EXTRA,
  LAKE_VISIBILITY_MARGIN,
  PEBBLE_EDGE_PRELOAD_HIDE_EXTRA,
  PEBBLE_EDGE_PRELOAD_MARGIN,
  PEBBLE_EDGE_PRELOAD_OCCLUSION_LEAD,
  PLANET_EDGE_PRELOAD_END_ANGLE,
  PLANET_EDGE_PRELOAD_START_ANGLE,
  PLANET_OBJECT_HIDE_EXTRA,
  PLANET_OBJECT_VIEW_MARGIN,
  PLANET_PATCH_HIDE_EXTRA,
  PLANET_PATCH_VIEW_MARGIN,
  PLANET_RADIUS,
  ROCK_EDGE_PRELOAD_HIDE_EXTRA,
  ROCK_EDGE_PRELOAD_MARGIN,
  ROCK_EDGE_PRELOAD_OCCLUSION_LEAD,
  TREE_DEBUG_OFFSET,
  TREE_DEBUG_SEGMENTS,
  TREE_EDGE_PRELOAD_HIDE_EXTRA,
  TREE_EDGE_PRELOAD_MARGIN,
  TREE_EDGE_PRELOAD_OCCLUSION_LEAD,
  TREE_TRUNK_RADIUS,
} from '../constants'
import { clamp, computeVisibleSurfaceAngle } from '../utils/math'

export type EnvironmentDebugFlags = {
  mountainOutline?: boolean
  lakeCollider?: boolean
  treeCollider?: boolean
  terrainTessellation?: boolean
}

export type EnvironmentRuntimeControllerState = BuildEnvironmentRuntimeState & {
  mountainDebugGroup: THREE.Group | null
  mountainDebugMaterial: THREE.LineBasicMaterial | null
  mountainDebugEnabled: boolean
  lakeDebugGroup: THREE.Group | null
  lakeDebugMaterial: THREE.LineBasicMaterial | null
  lakeDebugEnabled: boolean
  treeDebugGroup: THREE.Group | null
  treeDebugMaterial: THREE.LineBasicMaterial | null
  treeDebugEnabled: boolean
  terrainTessellationDebugEnabled: boolean
  nextTreeVisibleScratch: number[]
  nextCactusVisibleScratch: number[]
  nextMountainVisibleScratchByVariant: number[][]
  nextPebbleVisibleScratch: number[]
  visibleLakeCount: number
}

type EnvironmentRuntimeControllerDeps = {
  state: EnvironmentRuntimeControllerState
  world: THREE.Group
  environmentGroup: THREE.Group
  camera: THREE.PerspectiveCamera
  patchCenterQuat: THREE.Quaternion
  cameraLocalPosTemp: THREE.Vector3
  cameraLocalDirTemp: THREE.Vector3
  getViewport: () => { width: number; height: number }
  webglShaderHooksEnabled: boolean
  tempVector: THREE.Vector3
  tempVectorB: THREE.Vector3
  buildTangentBasis: (
    normal: THREE.Vector3,
    tangent: THREE.Vector3,
    bitangent: THREE.Vector3,
  ) => void
  pelletGroundCache: Map<number, PelletGroundCacheEntry>
  pelletMotionStates: Map<number, PelletMotionState>
  pelletVisualStates: Map<number, PelletVisualState>
  pelletConsumeGhosts: PelletConsumeGhost[]
  pelletMouthTargets: Map<string, THREE.Vector3>
  pelletConsumeTargetByPelletId: Map<number, string>
}

export type EnvironmentRuntimeController = {
  buildEnvironment: (data: Environment | null) => void
  disposeEnvironment: () => void
  updatePlanetPatchVisibility: (cameraLocalDir: THREE.Vector3, viewAngle: number) => void
  updateLakeVisibility: (cameraLocalDir: THREE.Vector3, viewAngle: number) => void
  updateEnvironmentVisibility: (
    cameraLocalPos: THREE.Vector3,
    cameraLocalDir: THREE.Vector3,
    viewAngle: number,
  ) => void
  setDebugFlags: (flags: EnvironmentDebugFlags) => void
}

const disposeMaterial = (material: THREE.Material | THREE.Material[] | null) => {
  if (!material) return
  if (Array.isArray(material)) {
    for (const mat of material) {
      mat.dispose()
    }
    return
  }
  material.dispose()
}

const disposeDebugLineLoopGroup = (world: THREE.Group, group: THREE.Group | null) => {
  if (!group) return
  world.remove(group)
  group.traverse((child) => {
    if (child instanceof THREE.LineLoop) {
      child.geometry.dispose()
    }
  })
}

const disposeDebugGroupState = (
  world: THREE.Group,
  group: THREE.Group | null,
  material: THREE.LineBasicMaterial | null,
) => {
  disposeDebugLineLoopGroup(world, group)
  material?.dispose()
}

const disposeInstancedEnvironment = (
  environmentGroup: THREE.Group,
  state: EnvironmentRuntimeControllerState,
) => {
  for (const mesh of state.treeTierMeshes) {
    environmentGroup.remove(mesh)
  }
  if (state.treeTrunkMesh) {
    environmentGroup.remove(state.treeTrunkMesh)
  }
  for (const mesh of state.cactusPartMeshes) {
    environmentGroup.remove(mesh)
  }
  if (state.cactusTrunkMesh) {
    environmentGroup.remove(state.cactusTrunkMesh)
  }
  for (const mesh of state.mountainMeshes) {
    environmentGroup.remove(mesh)
  }
  if (state.pebbleMesh) {
    environmentGroup.remove(state.pebbleMesh)
  }

  for (const geometry of state.treeTierGeometries) {
    geometry.dispose()
  }
  state.treeTierGeometries = []
  state.treeTierMeshes = []
  state.treeTrunkGeometry?.dispose()
  state.treeTrunkGeometry = null
  state.treeLeafMaterial?.dispose()
  state.treeLeafMaterial = null
  state.treeTrunkMaterial?.dispose()
  state.treeTrunkMaterial = null

  for (const geometry of state.cactusPartGeometries) {
    geometry.dispose()
  }
  state.cactusPartGeometries = []
  state.cactusPartMeshes = []
  state.cactusTrunkGeometry?.dispose()
  state.cactusTrunkGeometry = null
  state.cactusMaterial?.dispose()
  state.cactusMaterial = null
  state.cactusArmMaterial?.dispose()
  state.cactusArmMaterial = null

  for (const geometry of state.mountainGeometries) {
    geometry.dispose()
  }
  state.mountainGeometries = []
  state.mountainMeshes = []
  state.mountainMaterial?.dispose()
  state.mountainMaterial = null

  state.pebbleGeometry?.dispose()
  state.pebbleGeometry = null
  state.pebbleMaterial?.dispose()
  state.pebbleMaterial = null
  state.pebbleMesh = null

  state.treeTrunkSourceMatrices = []
  state.treeTierSourceMatrices = []
  state.cactusTrunkSourceMatrices = []
  state.cactusPartSourceMatrices = []
  state.treeCullEntries = []
  state.treeVisibilityState = []
  state.treeVisibleIndices = []
  state.cactusCullEntries = []
  state.cactusVisibilityState = []
  state.cactusVisibleIndices = []
  state.visibleTreeCount = 0
  state.visibleCactusCount = 0
  state.mountainSourceMatricesByVariant = []
  state.mountainCullEntriesByVariant = []
  state.mountainVisibilityStateByVariant = []
  state.mountainVisibleIndicesByVariant = []
  state.visibleMountainCount = 0
  state.pebbleSourceMatrices = []
  state.pebbleCullEntries = []
  state.pebbleVisibilityState = []
  state.pebbleVisibleIndices = []
  state.visiblePebbleCount = 0
  state.visibleLakeCount = 0
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

export const createEnvironmentRuntimeController = (
  deps: EnvironmentRuntimeControllerDeps,
): EnvironmentRuntimeController => {
  const {
    state,
    world,
    environmentGroup,
    camera,
    patchCenterQuat,
    cameraLocalPosTemp,
    cameraLocalDirTemp,
    getViewport,
    webglShaderHooksEnabled,
    tempVector,
    tempVectorB,
    buildTangentBasis,
    pelletGroundCache,
    pelletMotionStates,
    pelletVisualStates,
    pelletConsumeGhosts,
    pelletMouthTargets,
    pelletConsumeTargetByPelletId,
  } = deps

  const updatePlanetPatchVisibility = (cameraLocalDir: THREE.Vector3, viewAngle: number) => {
    state.visiblePlanetPatchCount = updatePlanetPatchVisibilityRuntime(
      {
        planetPatches: state.planetPatches,
        viewMargin: PLANET_PATCH_VIEW_MARGIN,
        hideExtra: PLANET_PATCH_HIDE_EXTRA,
      },
      cameraLocalDir,
      viewAngle,
    )
  }

  const updateLakeVisibility = (cameraLocalDir: THREE.Vector3, viewAngle: number) => {
    state.visibleLakeCount = updateLakeVisibilityRuntime(
      {
        lakes: state.lakes,
        lakeMeshes: state.lakeMeshes,
        webglShaderHooksEnabled,
        visibilityExtraRadius: LAKE_VISIBILITY_EXTRA_RADIUS,
        visibilityMargin: LAKE_VISIBILITY_MARGIN,
        visibilityHideExtra: LAKE_VISIBILITY_HIDE_EXTRA,
      },
      cameraLocalDir,
      viewAngle,
    )
  }

  const updateEnvironmentVisibility = (
    cameraLocalPos: THREE.Vector3,
    cameraLocalDir: THREE.Vector3,
    viewAngle: number,
  ) => {
    const result = updateEnvironmentVisibilityRuntime(
      {
        treeCullEntries: state.treeCullEntries,
        treeVisibilityState: state.treeVisibilityState,
        treeVisibleIndices: state.treeVisibleIndices,
        nextTreeVisibleScratch: state.nextTreeVisibleScratch,
        treeTrunkMesh: state.treeTrunkMesh,
        treeTrunkSourceMatrices: state.treeTrunkSourceMatrices,
        treeTierMeshes: state.treeTierMeshes,
        treeTierSourceMatrices: state.treeTierSourceMatrices,
        cactusCullEntries: state.cactusCullEntries,
        cactusVisibilityState: state.cactusVisibilityState,
        cactusVisibleIndices: state.cactusVisibleIndices,
        nextCactusVisibleScratch: state.nextCactusVisibleScratch,
        cactusTrunkMesh: state.cactusTrunkMesh,
        cactusTrunkSourceMatrices: state.cactusTrunkSourceMatrices,
        cactusPartMeshes: state.cactusPartMeshes,
        cactusPartSourceMatrices: state.cactusPartSourceMatrices,
        mountainMeshes: state.mountainMeshes,
        mountainCullEntriesByVariant: state.mountainCullEntriesByVariant,
        mountainVisibilityStateByVariant: state.mountainVisibilityStateByVariant,
        mountainVisibleIndicesByVariant: state.mountainVisibleIndicesByVariant,
        nextMountainVisibleScratchByVariant: state.nextMountainVisibleScratchByVariant,
        mountainSourceMatricesByVariant: state.mountainSourceMatricesByVariant,
        pebbleCullEntries: state.pebbleCullEntries,
        pebbleVisibilityState: state.pebbleVisibilityState,
        pebbleVisibleIndices: state.pebbleVisibleIndices,
        nextPebbleVisibleScratch: state.nextPebbleVisibleScratch,
        pebbleMesh: state.pebbleMesh,
        pebbleSourceMatrices: state.pebbleSourceMatrices,
        constants: {
          planetObjectViewMargin: PLANET_OBJECT_VIEW_MARGIN,
          planetObjectHideExtra: PLANET_OBJECT_HIDE_EXTRA,
          planetEdgePreloadStartAngle: PLANET_EDGE_PRELOAD_START_ANGLE,
          planetEdgePreloadEndAngle: PLANET_EDGE_PRELOAD_END_ANGLE,
          treeEdgePreloadMargin: TREE_EDGE_PRELOAD_MARGIN,
          treeEdgePreloadHideExtra: TREE_EDGE_PRELOAD_HIDE_EXTRA,
          treeEdgePreloadOcclusionLead: TREE_EDGE_PRELOAD_OCCLUSION_LEAD,
          rockEdgePreloadMargin: ROCK_EDGE_PRELOAD_MARGIN,
          rockEdgePreloadHideExtra: ROCK_EDGE_PRELOAD_HIDE_EXTRA,
          rockEdgePreloadOcclusionLead: ROCK_EDGE_PRELOAD_OCCLUSION_LEAD,
          pebbleEdgePreloadMargin: PEBBLE_EDGE_PRELOAD_MARGIN,
          pebbleEdgePreloadHideExtra: PEBBLE_EDGE_PRELOAD_HIDE_EXTRA,
          pebbleEdgePreloadOcclusionLead: PEBBLE_EDGE_PRELOAD_OCCLUSION_LEAD,
        },
      },
      cameraLocalPos,
      cameraLocalDir,
      viewAngle,
    )
    state.visibleTreeCount = result.visibleTreeCount
    state.visibleCactusCount = result.visibleCactusCount
    state.visibleMountainCount = result.visibleMountainCount
    state.visiblePebbleCount = result.visiblePebbleCount
  }

  const rebuildMountainDebug = () => {
    disposeDebugGroupState(world, state.mountainDebugGroup, state.mountainDebugMaterial)
    state.mountainDebugGroup = null
    state.mountainDebugMaterial = null
    if (state.mountains.length === 0) return

    const material = new THREE.LineBasicMaterial({
      color: '#f97316',
      transparent: true,
      opacity: 0.75,
    })
    material.depthWrite = false
    material.depthTest = false
    state.mountainDebugMaterial = material

    const group = new THREE.Group()
    const offset = 0.01
    for (const mountain of state.mountains) {
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

    group.visible = state.mountainDebugEnabled
    world.add(group)
    state.mountainDebugGroup = group
  }

  const rebuildLakeDebug = () => {
    disposeDebugGroupState(world, state.lakeDebugGroup, state.lakeDebugMaterial)
    state.lakeDebugGroup = null
    state.lakeDebugMaterial = null
    if (state.lakes.length === 0) return

    const material = new THREE.LineBasicMaterial({
      color: '#38bdf8',
      transparent: true,
      opacity: 0.75,
    })
    material.depthWrite = false
    material.depthTest = false
    state.lakeDebugMaterial = material

    const group = new THREE.Group()
    const dir = new THREE.Vector3()
    const point = new THREE.Vector3()
    for (const lake of state.lakes) {
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

    group.visible = state.lakeDebugEnabled
    world.add(group)
    state.lakeDebugGroup = group
  }

  const rebuildTreeDebug = () => {
    disposeDebugGroupState(world, state.treeDebugGroup, state.treeDebugMaterial)
    state.treeDebugGroup = null
    state.treeDebugMaterial = null
    if (state.trees.length === 0) return

    const material = new THREE.LineBasicMaterial({
      color: '#facc15',
      transparent: true,
      opacity: 0.75,
    })
    material.depthWrite = false
    material.depthTest = false
    state.treeDebugMaterial = material

    const group = new THREE.Group()
    const tangent = new THREE.Vector3()
    const bitangent = new THREE.Vector3()
    const dir = new THREE.Vector3()
    const point = new THREE.Vector3()

    for (const tree of state.trees) {
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

    group.visible = state.treeDebugEnabled
    world.add(group)
    state.treeDebugGroup = group
  }

  const disposeEnvironment = () => {
    state.visiblePlanetPatchCount = 0
    state.terrainContactSampler = null
    pelletGroundCache.clear()
    pelletMotionStates.clear()
    pelletVisualStates.clear()
    pelletConsumeGhosts.length = 0
    pelletMouthTargets.clear()
    pelletConsumeTargetByPelletId.clear()

    if (state.planetMesh) {
      world.remove(state.planetMesh)
      state.planetMesh.geometry.dispose()
      disposeMaterial(state.planetMesh.material)
      state.planetMesh = null
    }
    for (const patch of state.planetPatches) {
      world.remove(patch.mesh)
      patch.mesh.geometry.dispose()
    }
    state.planetPatches = []
    state.planetPatchMaterial?.dispose()
    state.planetPatchMaterial = null

    if (state.gridMesh) {
      world.remove(state.gridMesh)
      state.gridMesh.geometry.dispose()
      disposeMaterial(state.gridMesh.material)
      state.gridMesh = null
    }
    if (state.shorelineLineMesh) {
      world.remove(state.shorelineLineMesh)
      state.shorelineLineMesh.geometry.dispose()
      disposeMaterial(state.shorelineLineMesh.material)
      state.shorelineLineMesh = null
    }
    if (state.shorelineFillMesh) {
      world.remove(state.shorelineFillMesh)
      state.shorelineFillMesh.geometry.dispose()
      disposeMaterial(state.shorelineFillMesh.material)
      state.shorelineFillMesh = null
    }

    for (const mesh of state.lakeMeshes) {
      world.remove(mesh)
    }
    for (const material of state.lakeMaterials) {
      material.dispose()
    }
    state.lakeMeshes = []
    state.lakeMaterials = []
    state.lakeSurfaceGeometry?.dispose()
    state.lakeSurfaceGeometry = null

    disposeDebugGroupState(world, state.mountainDebugGroup, state.mountainDebugMaterial)
    state.mountainDebugGroup = null
    state.mountainDebugMaterial = null
    disposeDebugGroupState(world, state.lakeDebugGroup, state.lakeDebugMaterial)
    state.lakeDebugGroup = null
    state.lakeDebugMaterial = null
    disposeDebugGroupState(world, state.treeDebugGroup, state.treeDebugMaterial)
    state.treeDebugGroup = null
    state.treeDebugMaterial = null

    disposeInstancedEnvironment(environmentGroup, state)
    state.lakes = []
    state.trees = []
    state.mountains = []
  }

  const buildEnvironment = (data: Environment | null) => {
    disposeEnvironment()
    buildEnvironmentRuntime(state, {
      data,
      world,
      environmentGroup,
      terrainTessellationDebugEnabled: state.terrainTessellationDebugEnabled,
      webglShaderHooksEnabled,
    })

    patchCenterQuat.copy(world.quaternion).invert()
    cameraLocalPosTemp.copy(camera.position).applyQuaternion(patchCenterQuat)
    cameraLocalDirTemp.copy(cameraLocalPosTemp).normalize()
    const { width, height } = getViewport()
    const aspect = height > 0 ? width / height : 1
    const viewAngle = computeVisibleSurfaceAngle(camera.position.z, aspect)
    updatePlanetPatchVisibility(cameraLocalDirTemp, viewAngle)
    updateLakeVisibility(cameraLocalDirTemp, viewAngle)
    updateEnvironmentVisibility(cameraLocalPosTemp, cameraLocalDirTemp, viewAngle)

    rebuildMountainDebug()
    rebuildLakeDebug()
    rebuildTreeDebug()
  }

  const setDebugFlags = (flags: EnvironmentDebugFlags) => {
    if (typeof flags.mountainOutline === 'boolean') {
      state.mountainDebugEnabled = flags.mountainOutline
      if (state.mountainDebugGroup) {
        state.mountainDebugGroup.visible = state.mountainDebugEnabled
      }
    }
    if (typeof flags.lakeCollider === 'boolean') {
      state.lakeDebugEnabled = flags.lakeCollider
      if (state.lakeDebugGroup) {
        state.lakeDebugGroup.visible = state.lakeDebugEnabled
      }
    }
    if (typeof flags.treeCollider === 'boolean') {
      state.treeDebugEnabled = flags.treeCollider
      if (state.treeDebugGroup) {
        state.treeDebugGroup.visible = state.treeDebugEnabled
      }
    }
    if (typeof flags.terrainTessellation === 'boolean') {
      state.terrainTessellationDebugEnabled = flags.terrainTessellation
      if (state.planetPatchMaterial) {
        state.planetPatchMaterial.wireframe = state.terrainTessellationDebugEnabled
        state.planetPatchMaterial.needsUpdate = true
      }
      if (state.planetMesh?.material instanceof THREE.MeshStandardMaterial) {
        state.planetMesh.material.wireframe = state.terrainTessellationDebugEnabled
        state.planetMesh.material.needsUpdate = true
      }
    }
  }

  return {
    buildEnvironment,
    disposeEnvironment,
    updatePlanetPatchVisibility,
    updateLakeVisibility,
    updateEnvironmentVisibility,
    setDebugFlags,
  }
}
