import * as THREE from 'three'
import {
  applyLakeDepressions,
  buildLakeFromData,
  buildMountainFromData,
  buildTreeFromData,
  createFilteredGridGeometry,
  createLakeMaterial,
  createLakeMaskMaterial,
  createLakes,
  createLakeSurfaceGeometry,
  createShorelineFillGeometry,
  createShorelineGeometry,
  isDesertBiome,
  isLakeDebugEnabled,
  sampleLakes,
} from './lakes'
import { createTerrainContactSampler } from './terrain'
import {
  CACTUS_ARM_TUBE_SEGMENTS,
  CACTUS_BASE_SINK,
  CACTUS_LEFT_ARM_BASE_HEIGHT,
  CACTUS_LEFT_ARM_RADIUS,
  CACTUS_MAX_UNIFORM_SCALE,
  CACTUS_MIN_UNIFORM_SCALE,
  CACTUS_RIGHT_ARM_BASE_HEIGHT,
  CACTUS_RIGHT_ARM_RADIUS,
  CACTUS_TRUNK_HEIGHT,
  CACTUS_TRUNK_RADIUS,
  CACTUS_TRUNK_TUBE_SEGMENTS,
  CACTUS_TUBE_RADIAL_SEGMENTS,
  CACTUS_UNIFORM_SCALE_MULTIPLIER,
  DESERT_CACTUS_COUNT,
  GRID_LINE_COLOR,
  GRID_LINE_OPACITY,
  LAKE_COUNT,
  LAKE_EXCLUSION_THRESHOLD,
  LAKE_SURFACE_ICOSPHERE_DETAIL,
  LAKE_SURFACE_RINGS,
  LAKE_SURFACE_SEGMENTS,
  LAKE_WATER_SURFACE_LIFT,
  MOUNTAIN_BASE_SINK,
  MOUNTAIN_COUNT,
  MOUNTAIN_HEIGHT_MAX,
  MOUNTAIN_HEIGHT_MIN,
  MOUNTAIN_MIN_ANGLE,
  MOUNTAIN_OUTLINE_SAMPLES,
  MOUNTAIN_RADIUS_MAX,
  MOUNTAIN_RADIUS_MIN,
  MOUNTAIN_VARIANTS,
  PEBBLE_COUNT,
  PEBBLE_OFFSET,
  PEBBLE_RADIUS_MAX,
  PEBBLE_RADIUS_MIN,
  PEBBLE_RADIUS_VARIANCE,
  PLANET_BASE_ICOSPHERE_DETAIL,
  PLANET_PATCH_BANDS,
  PLANET_PATCH_ENABLED,
  PLANET_PATCH_SLICES,
  PLANET_RADIUS,
  SHORELINE_LINE_OPACITY,
  SHORE_SAND_COLOR,
  TERRAIN_CONTACT_BANDS,
  TERRAIN_CONTACT_SLICES,
  TREE_BASE_OFFSET,
  TREE_COUNT,
  TREE_HEIGHT,
  TREE_MAX_HEIGHT,
  TREE_MAX_SCALE,
  TREE_MIN_ANGLE,
  TREE_MIN_HEIGHT,
  TREE_MIN_SCALE,
  TREE_TIER_HEIGHT_FACTORS,
  TREE_TIER_OVERLAP,
  TREE_TIER_RADIUS_FACTORS,
  TREE_TRUNK_HEIGHT,
  TREE_TRUNK_RADIUS,
} from '../constants'
import {
  clamp,
  createIcosphereGeometry,
  createMountainGeometry,
  createSeededRandom,
  randomOnSphere,
} from '../utils/math'
import type {
  BuildEnvironmentRuntimeDeps,
  BuildEnvironmentRuntimeState,
} from './buildRuntimeTypes'

const buildPlanetPatchAtlas = (
  state: BuildEnvironmentRuntimeState,
  world: THREE.Group,
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
  const directionTemp = new THREE.Vector3()

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
    state.planetPatches.push({ mesh, center, angularExtent, visible: false })
  }
  state.visiblePlanetPatchCount = 0
}

export const buildEnvironmentRuntime = (
  state: BuildEnvironmentRuntimeState,
  deps: BuildEnvironmentRuntimeDeps,
) => {
  const {
    data,
    world,
    environmentGroup,
    terrainTessellationDebugEnabled,
    webglShaderHooksEnabled,
  } = deps

  state.lakes = data?.lakes?.length ? data.lakes.map(buildLakeFromData) : createLakes(0x91fcae12, LAKE_COUNT)

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
    applyLakeDepressions(planetGeometry, state.lakes)
    state.terrainContactSampler = createTerrainContactSampler(
      planetGeometry,
      TERRAIN_CONTACT_BANDS,
      TERRAIN_CONTACT_SLICES,
    )
    state.planetPatchMaterial = planetMaterial
    buildPlanetPatchAtlas(state, world, planetGeometry, planetMaterial)

    const rawShorelineGeometry = new THREE.WireframeGeometry(planetGeometry)
    const shorelineOnlyGeometry = createShorelineGeometry(rawShorelineGeometry, state.lakes)
    rawShorelineGeometry.dispose()
    if ((shorelineOnlyGeometry.attributes.position?.count ?? 0) > 0) {
      const shorelineLineMaterial = new THREE.LineBasicMaterial({
        color: GRID_LINE_COLOR,
        transparent: true,
        opacity: SHORELINE_LINE_OPACITY,
      })
      shorelineLineMaterial.depthWrite = false
      state.shorelineLineMesh = new THREE.LineSegments(shorelineOnlyGeometry, shorelineLineMaterial)
      state.shorelineLineMesh.scale.setScalar(1.002)
      world.add(state.shorelineLineMesh)
    } else {
      shorelineOnlyGeometry.dispose()
    }

    const shorelineFillGeometry = createShorelineFillGeometry(planetGeometry, state.lakes)
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
      state.shorelineFillMesh = new THREE.Mesh(shorelineFillGeometry, shorelineFillMaterial)
      state.shorelineFillMesh.renderOrder = 1
      state.shorelineFillMesh.scale.setScalar(1.001)
      world.add(state.shorelineFillMesh)
    } else {
      shorelineFillGeometry.dispose()
    }

    planetGeometry.dispose()
    basePlanetGeometry.dispose()
  } else {
    const basePlanetGeometry = createIcosphereGeometry(PLANET_RADIUS, PLANET_BASE_ICOSPHERE_DETAIL)
    const planetGeometry = basePlanetGeometry.clone()
    applyLakeDepressions(planetGeometry, state.lakes)
    state.terrainContactSampler = createTerrainContactSampler(
      planetGeometry,
      TERRAIN_CONTACT_BANDS,
      TERRAIN_CONTACT_SLICES,
    )
    state.planetMesh = new THREE.Mesh(planetGeometry, planetMaterial)
    world.add(state.planetMesh)

    const rawGridGeometry = new THREE.WireframeGeometry(planetGeometry)
    const gridGeometry = createFilteredGridGeometry(rawGridGeometry, state.lakes)
    const shorelineLineGeometry = createShorelineGeometry(rawGridGeometry, state.lakes)
    rawGridGeometry.dispose()
    const gridMaterial = new THREE.LineBasicMaterial({
      color: GRID_LINE_COLOR,
      transparent: true,
      opacity: GRID_LINE_OPACITY,
    })
    gridMaterial.depthWrite = false
    state.gridMesh = new THREE.LineSegments(gridGeometry, gridMaterial)
    state.gridMesh.scale.setScalar(1.002)
    world.add(state.gridMesh)
    const shorelineLineMaterial = new THREE.LineBasicMaterial({
      color: GRID_LINE_COLOR,
      transparent: true,
      opacity: SHORELINE_LINE_OPACITY,
    })
    shorelineLineMaterial.depthWrite = false
    state.shorelineLineMesh = new THREE.LineSegments(shorelineLineGeometry, shorelineLineMaterial)
    state.shorelineLineMesh.scale.setScalar(1.002)
    world.add(state.shorelineLineMesh)

    const shorelineFillGeometry = createShorelineFillGeometry(planetGeometry, state.lakes)
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
    state.shorelineFillMesh = new THREE.Mesh(shorelineFillGeometry, shorelineFillMaterial)
    state.shorelineFillMesh.renderOrder = 1
    state.shorelineFillMesh.scale.setScalar(1.001)
    world.add(state.shorelineFillMesh)

    basePlanetGeometry.dispose()
  }

  if (webglShaderHooksEnabled) {
    state.lakeSurfaceGeometry = new THREE.SphereGeometry(1, LAKE_SURFACE_SEGMENTS, LAKE_SURFACE_RINGS)
    for (const lake of state.lakes) {
      const lakeMaterial = createLakeMaskMaterial(lake)
      const lakeMesh = new THREE.Mesh(state.lakeSurfaceGeometry, lakeMaterial)
      lakeMesh.scale.setScalar(PLANET_RADIUS - lake.surfaceInset + LAKE_WATER_SURFACE_LIFT)
      lakeMesh.renderOrder = 2
      world.add(lakeMesh)
      state.lakeMeshes.push(lakeMesh)
      state.lakeMaterials.push(lakeMaterial)
    }
  } else {
    const lakeBaseGeometry = createIcosphereGeometry(PLANET_RADIUS, LAKE_SURFACE_ICOSPHERE_DETAIL)
    state.lakeSurfaceGeometry = createLakeSurfaceGeometry(lakeBaseGeometry, state.lakes)
    lakeBaseGeometry.dispose()
    if ((state.lakeSurfaceGeometry.attributes.position?.count ?? 0) > 0) {
      const lakeMaterial = createLakeMaterial()
      const lakeMesh = new THREE.Mesh(state.lakeSurfaceGeometry, lakeMaterial)
      lakeMesh.renderOrder = 2
      world.add(lakeMesh)
      state.lakeMeshes.push(lakeMesh)
      state.lakeMaterials.push(lakeMaterial)
    }
  }
  if (isLakeDebugEnabled()) {
    const lakeBaseGeometry = createIcosphereGeometry(PLANET_RADIUS, LAKE_SURFACE_ICOSPHERE_DETAIL)
    const lakeGeometry = createLakeSurfaceGeometry(lakeBaseGeometry, state.lakes)
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
  state.treeLeafMaterial = leafMaterial
  state.treeTrunkMaterial = trunkMaterial
  state.cactusMaterial = cactusBodyMaterial
  state.cactusArmMaterial = cactusArmMat
  const treeInstanceCount = Math.max(0, TREE_COUNT - MOUNTAIN_COUNT)

  for (let i = 0; i < treeTierHeights.length; i += 1) {
    const height = treeTierHeights[i]
    const radius = treeTierRadii[i]
    const geometry = new THREE.ConeGeometry(radius, height, 6, 1)
    geometry.translate(0, height / 2, 0)
    state.treeTierGeometries.push(geometry)
    const mesh = new THREE.InstancedMesh(geometry, leafMaterial, TREE_COUNT)
    mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage)
    mesh.frustumCulled = false
    mesh.count = treeInstanceCount
    state.treeTierMeshes.push(mesh)
    environmentGroup.add(mesh)
  }

  state.treeTrunkGeometry = new THREE.CylinderGeometry(
    TREE_TRUNK_RADIUS * 0.7,
    TREE_TRUNK_RADIUS,
    TREE_TRUNK_HEIGHT,
    6,
    1,
  )
  state.treeTrunkGeometry.translate(0, TREE_TRUNK_HEIGHT / 2, 0)
  state.treeTrunkMesh = new THREE.InstancedMesh(state.treeTrunkGeometry, trunkMaterial, TREE_COUNT)
  state.treeTrunkMesh.instanceMatrix.setUsage(THREE.StaticDrawUsage)
  state.treeTrunkMesh.frustumCulled = false
  state.treeTrunkMesh.count = treeInstanceCount
  environmentGroup.add(state.treeTrunkMesh)

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
  state.cactusTrunkGeometry = new THREE.TubeGeometry(
    trunkCurve,
    CACTUS_TRUNK_TUBE_SEGMENTS,
    CACTUS_TRUNK_RADIUS,
    CACTUS_TUBE_RADIAL_SEGMENTS,
    false,
  )
  state.cactusTrunkMesh = new THREE.InstancedMesh(state.cactusTrunkGeometry, cactusBodyMaterial, TREE_COUNT)
  state.cactusTrunkMesh.instanceMatrix.setUsage(THREE.StaticDrawUsage)
  state.cactusTrunkMesh.frustumCulled = false
  state.cactusTrunkMesh.count = 0
  environmentGroup.add(state.cactusTrunkMesh)

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
    state.cactusPartGeometries.push(geometry)
    const mesh = new THREE.InstancedMesh(geometry, cactusArmMat, TREE_COUNT)
    mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage)
    mesh.frustumCulled = false
    mesh.count = 0
    state.cactusPartMeshes.push(mesh)
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
    state.cactusPartGeometries.push(geometry)
    const mesh = new THREE.InstancedMesh(geometry, spec.material, TREE_COUNT)
    mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage)
    mesh.frustumCulled = false
    mesh.count = 0
    state.cactusPartMeshes.push(mesh)
    environmentGroup.add(mesh)
  }

  state.mountainMaterial = new THREE.MeshStandardMaterial({
    color: '#8f8f8f',
    roughness: 0.95,
    metalness: 0.02,
    flatShading: true,
  })
  for (let i = 0; i < MOUNTAIN_VARIANTS; i += 1) {
    const geometry = createMountainGeometry(0x3f2a9b1 + i * 57)
    state.mountainGeometries.push(geometry)
    const mesh = new THREE.InstancedMesh(geometry, state.mountainMaterial, MOUNTAIN_COUNT)
    mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage)
    mesh.frustumCulled = false
    mesh.count = 0
    state.mountainMeshes.push(mesh)
    environmentGroup.add(mesh)
  }

  state.pebbleGeometry = new THREE.IcosahedronGeometry(1, 0)
  const rockMaterial = new THREE.MeshStandardMaterial({
    color: '#808080',
    roughness: 0.95,
    metalness: 0.05,
    flatShading: true,
  })
  state.pebbleMaterial = rockMaterial
  state.pebbleMesh = new THREE.InstancedMesh(state.pebbleGeometry, rockMaterial, PEBBLE_COUNT)
  state.pebbleMesh.instanceMatrix.setUsage(THREE.StaticDrawUsage)
  state.pebbleMesh.frustumCulled = false
  environmentGroup.add(state.pebbleMesh)

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
    sampleLakes(candidate, state.lakes, lakeSampleTemp).boundary > LAKE_EXCLUSION_THRESHOLD
  state.treeTrunkSourceMatrices = []
  state.treeTierSourceMatrices = state.treeTierMeshes.map(() => [])
  state.cactusTrunkSourceMatrices = []
  state.cactusPartSourceMatrices = state.cactusPartMeshes.map(() => [])
  state.treeCullEntries = []
  state.treeVisibilityState = []
  state.treeVisibleIndices = []
  state.cactusCullEntries = []
  state.cactusVisibilityState = []
  state.cactusVisibleIndices = []
  state.visibleTreeCount = 0
  state.visibleCactusCount = 0
  state.mountainSourceMatricesByVariant = state.mountainMeshes.map(() => [])
  state.mountainCullEntriesByVariant = state.mountainMeshes.map(() => [])
  state.mountainVisibilityStateByVariant = state.mountainMeshes.map(() => [])
  state.mountainVisibleIndicesByVariant = state.mountainMeshes.map(() => [])
  state.visibleMountainCount = 0
  state.pebbleSourceMatrices = []
  state.pebbleCullEntries = []
  state.pebbleVisibilityState = []
  state.pebbleVisibleIndices = []
  state.visiblePebbleCount = 0

  if (data?.trees?.length) {
    state.trees = data.trees.map(buildTreeFromData)
  } else {
    const forestNormals: THREE.Vector3[] = []
    const cactusNormals: THREE.Vector3[] = []
    const treeScales: THREE.Vector3[] = []
    const cactusScales: THREE.Vector3[] = []
    const pickSparseNormal = (
      out: THREE.Vector3,
      existing: THREE.Vector3[],
      minDotValue: number,
      predicate: (candidate: THREE.Vector3) => boolean,
    ) => {
      for (let attempt = 0; attempt < 60; attempt += 1) {
        randomOnSphere(rng, out)
        if (predicate(out)) continue
        let ok = true
        for (const sample of existing) {
          if (sample.dot(out) > minDotValue) {
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
    state.trees = [...generatedForest, ...generatedCactus]
  }

  const forestTrees = state.trees.filter((tree) => tree.widthScale >= 0)
  const cactusTrees = state.trees.filter((tree) => tree.widthScale < 0)
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
    state.treeTrunkSourceMatrices.push(baseMatrix.clone())

    for (let t = 0; t < state.treeTierMeshes.length; t += 1) {
      localMatrix.makeTranslation(0, treeTierOffsets[t], 0)
      worldMatrix.copy(baseMatrix).multiply(localMatrix)
      state.treeTierSourceMatrices[t]?.push(worldMatrix.clone())
    }
    state.treeCullEntries.push({
      basePoint: normal.clone().multiplyScalar(treeBaseRadius),
      topPoint: normal
        .clone()
        .multiplyScalar(treeBaseRadius + baseTreeHeight * tree.heightScale),
      baseRadius: TREE_TRUNK_RADIUS * tree.widthScale,
      topRadius: Math.max(TREE_TRUNK_RADIUS, treeCanopyRadius) * tree.widthScale,
    })
    state.treeVisibilityState.push(false)
  }
  state.cactusTrunkSourceMatrices = []
  state.cactusPartSourceMatrices = state.cactusPartMeshes.map(() => [])
  state.cactusCullEntries = []
  state.cactusVisibilityState = []
  state.cactusVisibleIndices = []
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
    state.cactusTrunkSourceMatrices.push(baseMatrix.clone())
    for (let p = 0; p < state.cactusPartMeshes.length; p += 1) {
      state.cactusPartSourceMatrices[p]?.push(baseMatrix.clone())
    }
    const basePoint = new THREE.Vector3(0, 0, 0).applyMatrix4(baseMatrix)
    const topPoint = cactusTopLocalPoint.clone().applyMatrix4(baseMatrix)
    const leftArmTipPoint = cactusLeftTipLocalPoint.clone().applyMatrix4(baseMatrix)
    const rightArmTipPoint = cactusRightTipLocalPoint.clone().applyMatrix4(baseMatrix)
    const baseRadius = CACTUS_TRUNK_RADIUS * cactusScale
    const armRadius = Math.max(CACTUS_LEFT_ARM_RADIUS, CACTUS_RIGHT_ARM_RADIUS) * cactusScale
    state.cactusCullEntries.push({
      basePoint,
      topPoint,
      leftArmTipPoint,
      rightArmTipPoint,
      baseRadius,
      topRadius: baseRadius * 0.96,
      armRadius,
    })
    state.cactusVisibilityState.push(false)
  }

  if (state.treeTrunkMesh) {
    state.treeTrunkMesh.count = 0
    state.treeTrunkMesh.instanceMatrix.needsUpdate = true
  }
  for (const mesh of state.treeTierMeshes) {
    mesh.count = 0
    mesh.instanceMatrix.needsUpdate = true
  }
  if (state.cactusTrunkMesh) {
    state.cactusTrunkMesh.count = 0
    state.cactusTrunkMesh.instanceMatrix.needsUpdate = true
  }
  for (let p = 0; p < state.cactusPartMeshes.length; p += 1) {
    const mesh = state.cactusPartMeshes[p]
    mesh.count = 0
    mesh.instanceMatrix.needsUpdate = true
  }
  state.visibleCactusCount = 0

  if (data?.mountains?.length) {
    state.mountains = data.mountains.map(buildMountainFromData)
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
      state.mountains.push({
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

  if (state.mountainMeshes.length > 0) {
    for (const mountain of state.mountains) {
      const variantIndex = Math.min(state.mountainMeshes.length - 1, Math.max(0, Math.floor(mountain.variant)))
      if (variantIndex < 0) continue
      normal.copy(mountain.normal)
      baseQuat.setFromUnitVectors(up, normal)
      twistQuat.setFromAxisAngle(up, mountain.twist)
      baseQuat.multiply(twistQuat)
      baseScale.set(mountain.radius, mountain.height, mountain.radius)
      position.copy(normal).multiplyScalar(PLANET_RADIUS - MOUNTAIN_BASE_SINK)
      baseMatrix.compose(position, baseQuat, baseScale)
      state.mountainSourceMatricesByVariant[variantIndex]?.push(baseMatrix.clone())
      state.mountainCullEntriesByVariant[variantIndex]?.push({
        basePoint: normal.clone().multiplyScalar(PLANET_RADIUS - MOUNTAIN_BASE_SINK),
        peakPoint: normal
          .clone()
          .multiplyScalar(PLANET_RADIUS - MOUNTAIN_BASE_SINK + mountain.height * 0.92),
        baseRadius: mountain.radius,
        peakRadius: mountain.radius * 0.58,
        variant: variantIndex,
      })
      state.mountainVisibilityStateByVariant[variantIndex]?.push(false)
    }
    for (let i = 0; i < state.mountainMeshes.length; i += 1) {
      const mesh = state.mountainMeshes[i]
      mesh.count = 0
      mesh.instanceMatrix.needsUpdate = true
    }
  }

  if (state.pebbleMesh) {
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
      state.pebbleSourceMatrices.push(worldMatrix.clone())
      state.pebbleCullEntries.push({
        point: position.clone(),
        radius: radius * 1.2,
      })
      state.pebbleVisibilityState.push(false)
      placed += 1
    }
    state.pebbleMesh.count = 0
    state.pebbleMesh.instanceMatrix.needsUpdate = true
  }
}
