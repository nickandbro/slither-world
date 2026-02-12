import type {
  BufferGeometry,
  Group,
  InstancedMesh,
  LineSegments,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
} from 'three'
import type { Environment } from '../../../../game/types'
import type { TerrainContactSampler } from './terrain'
import type { Lake, MountainInstance, TreeInstance } from './lakes'
import type {
  CactusCullEntry,
  MountainCullEntry,
  PebbleCullEntry,
  TerrainPatchInstance,
  TreeCullEntry,
} from '../runtimeTypes'

export type BuildEnvironmentRuntimeState = {
  lakes: Lake[]
  trees: TreeInstance[]
  mountains: MountainInstance[]
  planetMesh: Mesh | null
  planetPatches: TerrainPatchInstance[]
  planetPatchMaterial: MeshStandardMaterial | null
  visiblePlanetPatchCount: number
  gridMesh: LineSegments | null
  shorelineLineMesh: LineSegments | null
  shorelineFillMesh: Mesh | null
  lakeSurfaceGeometry: BufferGeometry | null
  lakeMeshes: Mesh[]
  lakeMaterials: MeshStandardMaterial[]
  terrainContactSampler: TerrainContactSampler | null
  treeTierGeometries: BufferGeometry[]
  treeTierMeshes: InstancedMesh[]
  treeTrunkGeometry: BufferGeometry | null
  treeTrunkMesh: InstancedMesh | null
  treeLeafMaterial: MeshStandardMaterial | null
  treeTrunkMaterial: MeshStandardMaterial | null
  cactusPartGeometries: BufferGeometry[]
  cactusPartMeshes: InstancedMesh[]
  cactusTrunkGeometry: BufferGeometry | null
  cactusTrunkMesh: InstancedMesh | null
  cactusMaterial: MeshStandardMaterial | null
  cactusArmMaterial: MeshStandardMaterial | null
  mountainGeometries: BufferGeometry[]
  mountainMeshes: InstancedMesh[]
  mountainMaterial: MeshStandardMaterial | null
  pebbleGeometry: BufferGeometry | null
  pebbleMaterial: MeshStandardMaterial | null
  pebbleMesh: InstancedMesh | null
  treeTrunkSourceMatrices: Matrix4[]
  treeTierSourceMatrices: Matrix4[][]
  treeCullEntries: TreeCullEntry[]
  treeVisibilityState: boolean[]
  treeVisibleIndices: number[]
  cactusTrunkSourceMatrices: Matrix4[]
  cactusPartSourceMatrices: Matrix4[][]
  cactusCullEntries: CactusCullEntry[]
  cactusVisibilityState: boolean[]
  cactusVisibleIndices: number[]
  visibleTreeCount: number
  visibleCactusCount: number
  mountainSourceMatricesByVariant: Matrix4[][]
  mountainCullEntriesByVariant: MountainCullEntry[][]
  mountainVisibilityStateByVariant: boolean[][]
  mountainVisibleIndicesByVariant: number[][]
  visibleMountainCount: number
  pebbleSourceMatrices: Matrix4[]
  pebbleCullEntries: PebbleCullEntry[]
  pebbleVisibilityState: boolean[]
  pebbleVisibleIndices: number[]
  visiblePebbleCount: number
}

export type BuildEnvironmentRuntimeDeps = {
  data: Environment | null
  world: Group
  environmentGroup: Group
  terrainTessellationDebugEnabled: boolean
  webglShaderHooksEnabled: boolean
}
