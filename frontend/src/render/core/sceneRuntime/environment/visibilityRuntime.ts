import * as THREE from 'three'
import { isAngularVisible, isPointVisible } from './culling'
import type {
  CactusCullEntry,
  MountainCullEntry,
  PebbleCullEntry,
  TerrainPatchInstance,
  TreeCullEntry,
} from '../runtimeTypes'
import type { Lake } from './lakes'
import { smoothstep } from '../utils/math'

type PlanetPatchVisibilityContext = {
  planetPatches: TerrainPatchInstance[]
  viewMargin: number
  hideExtra: number
}

type LakeVisibilityContext = {
  lakes: Lake[]
  lakeMeshes: THREE.Mesh[]
  webglShaderHooksEnabled: boolean
  visibilityExtraRadius: number
  visibilityMargin: number
  visibilityHideExtra: number
}

type EnvironmentVisibilityContext = {
  treeCullEntries: TreeCullEntry[]
  treeVisibilityState: boolean[]
  treeVisibleIndices: number[]
  nextTreeVisibleScratch: number[]
  treeTrunkMesh: THREE.InstancedMesh | null
  treeTrunkSourceMatrices: THREE.Matrix4[]
  treeTierMeshes: THREE.InstancedMesh[]
  treeTierSourceMatrices: THREE.Matrix4[][]

  cactusCullEntries: CactusCullEntry[]
  cactusVisibilityState: boolean[]
  cactusVisibleIndices: number[]
  nextCactusVisibleScratch: number[]
  cactusTrunkMesh: THREE.InstancedMesh | null
  cactusTrunkSourceMatrices: THREE.Matrix4[]
  cactusPartMeshes: THREE.InstancedMesh[]
  cactusPartSourceMatrices: THREE.Matrix4[][]

  mountainMeshes: THREE.InstancedMesh[]
  mountainCullEntriesByVariant: MountainCullEntry[][]
  mountainVisibilityStateByVariant: boolean[][]
  mountainVisibleIndicesByVariant: number[][]
  nextMountainVisibleScratchByVariant: number[][]
  mountainSourceMatricesByVariant: THREE.Matrix4[][]

  pebbleCullEntries: PebbleCullEntry[]
  pebbleVisibilityState: boolean[]
  pebbleVisibleIndices: number[]
  nextPebbleVisibleScratch: number[]
  pebbleMesh: THREE.InstancedMesh | null
  pebbleSourceMatrices: THREE.Matrix4[]

  constants: {
    planetObjectViewMargin: number
    planetObjectHideExtra: number
    planetEdgePreloadStartAngle: number
    planetEdgePreloadEndAngle: number
    treeEdgePreloadMargin: number
    treeEdgePreloadHideExtra: number
    treeEdgePreloadOcclusionLead: number
    rockEdgePreloadMargin: number
    rockEdgePreloadHideExtra: number
    rockEdgePreloadOcclusionLead: number
    pebbleEdgePreloadMargin: number
    pebbleEdgePreloadHideExtra: number
    pebbleEdgePreloadOcclusionLead: number
  }
}

const arraysEqual = (a: number[], b: number[]) => {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false
  }
  return true
}

export const updatePlanetPatchVisibilityRuntime = (
  context: PlanetPatchVisibilityContext,
  cameraLocalDir: THREE.Vector3,
  viewAngle: number,
) => {
  let visibleCount = 0
  for (const patch of context.planetPatches) {
    const directionDot = patch.center.dot(cameraLocalDir)
    const visible = isAngularVisible(
      directionDot,
      viewAngle,
      patch.angularExtent,
      patch.visible,
      context.viewMargin,
      context.hideExtra,
    )
    patch.visible = visible
    patch.mesh.visible = visible
    if (visible) visibleCount += 1
  }
  return visibleCount
}

export const updateLakeVisibilityRuntime = (
  context: LakeVisibilityContext,
  cameraLocalDir: THREE.Vector3,
  viewAngle: number,
) => {
  if (context.lakeMeshes.length === 0 || context.lakes.length === 0) {
    return 0
  }

  if (context.webglShaderHooksEnabled) {
    let visible = 0
    for (let i = 0; i < context.lakeMeshes.length; i += 1) {
      const lake = context.lakes[i]
      const mesh = context.lakeMeshes[i]
      if (!lake || !mesh) continue
      const effectiveRadius = lake.radius + context.visibilityExtraRadius
      const inView = isAngularVisible(
        lake.center.dot(cameraLocalDir),
        viewAngle,
        effectiveRadius,
        mesh.visible,
        context.visibilityMargin,
        context.visibilityHideExtra,
      )
      const visibleNow = inView
      mesh.visible = visibleNow
      if (visibleNow) visible += 1
    }
    return visible
  }

  let anyVisible = false
  let visible = 0
  for (const lake of context.lakes) {
    const effectiveRadius = lake.radius + context.visibilityExtraRadius
    const visibleNow = isAngularVisible(
      lake.center.dot(cameraLocalDir),
      viewAngle,
      effectiveRadius,
      anyVisible,
      context.visibilityMargin,
      context.visibilityHideExtra,
    )
    if (visibleNow) {
      anyVisible = true
      visible += 1
    }
  }
  for (const mesh of context.lakeMeshes) {
    mesh.visible = anyVisible
  }
  return visible
}

export const updateEnvironmentVisibilityRuntime = (
  context: EnvironmentVisibilityContext,
  cameraLocalPos: THREE.Vector3,
  cameraLocalDir: THREE.Vector3,
  viewAngle: number,
) => {
  const {
    planetObjectViewMargin,
    planetObjectHideExtra,
    planetEdgePreloadStartAngle,
    planetEdgePreloadEndAngle,
    treeEdgePreloadMargin,
    treeEdgePreloadHideExtra,
    treeEdgePreloadOcclusionLead,
    rockEdgePreloadMargin,
    rockEdgePreloadHideExtra,
    rockEdgePreloadOcclusionLead,
    pebbleEdgePreloadMargin,
    pebbleEdgePreloadHideExtra,
    pebbleEdgePreloadOcclusionLead,
  } = context.constants

  const edgePreload = smoothstep(
    planetEdgePreloadStartAngle,
    planetEdgePreloadEndAngle,
    viewAngle,
  )
  const treeMargin = planetObjectViewMargin + treeEdgePreloadMargin * edgePreload
  const treeHideExtra = planetObjectHideExtra + treeEdgePreloadHideExtra * edgePreload
  const treeOcclusionLead = 1 + treeEdgePreloadOcclusionLead * edgePreload
  const cactusMargin = treeMargin
  const cactusHideExtra = treeHideExtra
  const cactusOcclusionLead = treeOcclusionLead
  const rockMargin = planetObjectViewMargin + rockEdgePreloadMargin * edgePreload
  const rockHideExtra = planetObjectHideExtra + rockEdgePreloadHideExtra * edgePreload
  const rockOcclusionLead = 1 + rockEdgePreloadOcclusionLead * edgePreload
  const pebbleMargin = planetObjectViewMargin + pebbleEdgePreloadMargin * edgePreload
  const pebbleHideExtra = planetObjectHideExtra + pebbleEdgePreloadHideExtra * edgePreload
  const pebbleOcclusionLead = 1 + pebbleEdgePreloadOcclusionLead * edgePreload

  const nextTreeVisible = context.nextTreeVisibleScratch
  nextTreeVisible.length = 0
  for (let i = 0; i < context.treeCullEntries.length; i += 1) {
    const entry = context.treeCullEntries[i]!
    const wasVisible = context.treeVisibilityState[i] ?? false
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
    context.treeVisibilityState[i] = visible
    if (visible) nextTreeVisible.push(i)
  }
  if (!arraysEqual(nextTreeVisible, context.treeVisibleIndices)) {
    context.treeVisibleIndices.length = nextTreeVisible.length
    for (let i = 0; i < nextTreeVisible.length; i += 1) {
      context.treeVisibleIndices[i] = nextTreeVisible[i]!
    }
    if (context.treeTrunkMesh) {
      for (let write = 0; write < context.treeVisibleIndices.length; write += 1) {
        const source = context.treeTrunkSourceMatrices[context.treeVisibleIndices[write]!]
        if (!source) continue
        context.treeTrunkMesh.setMatrixAt(write, source)
      }
      context.treeTrunkMesh.count = context.treeVisibleIndices.length
      context.treeTrunkMesh.instanceMatrix.needsUpdate = true
    }
    for (let tier = 0; tier < context.treeTierMeshes.length; tier += 1) {
      const mesh = context.treeTierMeshes[tier]
      const sourceMatrices = context.treeTierSourceMatrices[tier]
      if (!mesh || !sourceMatrices) continue
      for (let write = 0; write < context.treeVisibleIndices.length; write += 1) {
        const source = sourceMatrices[context.treeVisibleIndices[write]!]
        if (!source) continue
        mesh.setMatrixAt(write, source)
      }
      mesh.count = context.treeVisibleIndices.length
      mesh.instanceMatrix.needsUpdate = true
    }
  }
  const visibleTreeCount = context.treeVisibleIndices.length

  const nextCactusVisible = context.nextCactusVisibleScratch
  nextCactusVisible.length = 0
  for (let i = 0; i < context.cactusCullEntries.length; i += 1) {
    const entry = context.cactusCullEntries[i]!
    const wasVisible = context.cactusVisibilityState[i] ?? false
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
    context.cactusVisibilityState[i] = visible
    if (visible) nextCactusVisible.push(i)
  }
  if (!arraysEqual(nextCactusVisible, context.cactusVisibleIndices)) {
    context.cactusVisibleIndices.length = nextCactusVisible.length
    for (let i = 0; i < nextCactusVisible.length; i += 1) {
      context.cactusVisibleIndices[i] = nextCactusVisible[i]!
    }
    if (context.cactusTrunkMesh) {
      for (let write = 0; write < context.cactusVisibleIndices.length; write += 1) {
        const source = context.cactusTrunkSourceMatrices[context.cactusVisibleIndices[write]!]
        if (!source) continue
        context.cactusTrunkMesh.setMatrixAt(write, source)
      }
      context.cactusTrunkMesh.count = context.cactusVisibleIndices.length
      context.cactusTrunkMesh.instanceMatrix.needsUpdate = true
    }
    for (let p = 0; p < context.cactusPartMeshes.length; p += 1) {
      const mesh = context.cactusPartMeshes[p]
      const sourceMatrices = context.cactusPartSourceMatrices[p]
      if (!mesh || !sourceMatrices) continue
      for (let write = 0; write < context.cactusVisibleIndices.length; write += 1) {
        const source = sourceMatrices[context.cactusVisibleIndices[write]!]
        if (!source) continue
        mesh.setMatrixAt(write, source)
      }
      mesh.count = context.cactusVisibleIndices.length
      mesh.instanceMatrix.needsUpdate = true
    }
  }
  const visibleCactusCount = context.cactusVisibleIndices.length

  let mountainVisibleTotal = 0
  for (let variant = 0; variant < context.mountainMeshes.length; variant += 1) {
    const entries = context.mountainCullEntriesByVariant[variant] ?? []
    const state = context.mountainVisibilityStateByVariant[variant] ?? []
    const nextVariantVisible =
      context.nextMountainVisibleScratchByVariant[variant] ??
      (context.nextMountainVisibleScratchByVariant[variant] = [])
    nextVariantVisible.length = 0
    for (let i = 0; i < entries.length; i += 1) {
      const entry = entries[i]!
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
    context.mountainVisibilityStateByVariant[variant] = state
    const currentVisible =
      context.mountainVisibleIndicesByVariant[variant] ??
      (context.mountainVisibleIndicesByVariant[variant] = [])
    if (!arraysEqual(nextVariantVisible, currentVisible)) {
      currentVisible.length = nextVariantVisible.length
      for (let i = 0; i < nextVariantVisible.length; i += 1) {
        currentVisible[i] = nextVariantVisible[i]!
      }
      const mesh = context.mountainMeshes[variant]
      const sourceMatrices = context.mountainSourceMatricesByVariant[variant] ?? []
      if (mesh) {
        for (let write = 0; write < currentVisible.length; write += 1) {
          const source = sourceMatrices[currentVisible[write]!]
          if (!source) continue
          mesh.setMatrixAt(write, source)
        }
        mesh.count = currentVisible.length
        mesh.instanceMatrix.needsUpdate = true
      }
    }
    mountainVisibleTotal += currentVisible.length
  }

  const nextPebbleVisible = context.nextPebbleVisibleScratch
  nextPebbleVisible.length = 0
  for (let i = 0; i < context.pebbleCullEntries.length; i += 1) {
    const entry = context.pebbleCullEntries[i]!
    const wasVisible = context.pebbleVisibilityState[i] ?? false
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
    context.pebbleVisibilityState[i] = visible
    if (visible) nextPebbleVisible.push(i)
  }
  if (!arraysEqual(nextPebbleVisible, context.pebbleVisibleIndices)) {
    context.pebbleVisibleIndices.length = nextPebbleVisible.length
    for (let i = 0; i < nextPebbleVisible.length; i += 1) {
      context.pebbleVisibleIndices[i] = nextPebbleVisible[i]!
    }
    if (context.pebbleMesh) {
      for (let write = 0; write < context.pebbleVisibleIndices.length; write += 1) {
        const source = context.pebbleSourceMatrices[context.pebbleVisibleIndices[write]!]
        if (!source) continue
        context.pebbleMesh.setMatrixAt(write, source)
      }
      context.pebbleMesh.count = context.pebbleVisibleIndices.length
      context.pebbleMesh.instanceMatrix.needsUpdate = true
    }
  }
  const visiblePebbleCount = context.pebbleVisibleIndices.length

  return {
    visibleTreeCount,
    visibleCactusCount,
    visibleMountainCount: mountainVisibleTotal,
    visiblePebbleCount,
  }
}
