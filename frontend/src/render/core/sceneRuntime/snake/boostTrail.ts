import * as THREE from 'three'
import type { PlayerSnapshot } from '../../../../game/types'
import { clamp, smoothstep } from '../utils/math'

export type TrailSample = {
  point: THREE.Vector3
  normal: THREE.Vector3
  createdAt: number
}

export type BoostTrailState = {
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

export type BoostTrailMaterialUserData = {
  retireCut: number
  retireCutUniform?: { value: number }
}

export type CreateBoostTrailControllerParams = {
  boostTrails: Map<string, BoostTrailState[]>
  boostTrailsGroup: THREE.Group
  createBoostTrailMaterial: () => THREE.MeshBasicMaterial
  webglShaderHooksEnabled: boolean
  getTerrainRadius: (normal: THREE.Vector3) => number
  buildTangentBasis: (
    normal: THREE.Vector3,
    tangent: THREE.Vector3,
    bitangent: THREE.Vector3,
  ) => void
  planetRadius: number
  boostTrailSurfaceOffset: number
  boostTrailMinSampleDistance: number
  boostTrailMaxSamples: number
  boostTrailMaxArcAngle: number
  boostTrailFadeSeconds: number
  boostTrailMaxCurveSegments: number
  boostTrailCurveSegmentsPerPoint: number
  boostTrailMaxCenterPoints: number
  boostTrailMaxVertexCount: number
  boostTrailMaxIndexCount: number
  boostTrailPoolMax: number
  boostTrailWidth: number
  boostTrailRetireFeather: number
  boostTrailEdgeFadeCap: number
}

export type BoostTrailController = {
  updateBoostTrailForPlayer: (
    player: PlayerSnapshot,
    tailContactNormal: THREE.Vector3 | null,
    nowMs: number,
  ) => void
  updateInactiveBoostTrails: (activeIds: Set<string>, nowMs: number) => void
  disposeBoostTrail: (trail: BoostTrailState) => void
  disposeAllBoostTrails: () => void
}

export const createBoostTrailAlphaTexture = ({
  width,
  height,
  edgeFadeCap,
  sideFadeCap,
}: {
  width: number
  height: number
  edgeFadeCap: number
  sideFadeCap: number
}): THREE.CanvasTexture | null => {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) return null

  const imageData = ctx.createImageData(width, height)
  const edgeCap = clamp(edgeFadeCap, 0, 0.5)
  const sideCap = clamp(sideFadeCap, 0, 0.5)

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

export const createBoostTrailMaterial = ({
  color,
  opacity,
  alphaTexture,
  retireFeather,
  webglShaderHooksEnabled,
}: {
  color: string
  opacity: number
  alphaTexture: THREE.Texture | null
  retireFeather: number
  webglShaderHooksEnabled: boolean
}): THREE.MeshBasicMaterial => {
  const materialParams: THREE.MeshBasicMaterialParameters = {
    color,
    transparent: true,
    opacity,
    side: THREE.DoubleSide,
  }
  if (alphaTexture) {
    // CanvasTexture alpha lives in the alpha channel; `alphaMap` samples the green channel.
    materialParams.map = alphaTexture
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
        value: clamp(retireFeather, 1e-4, 0.5),
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

export type BoostTrailWarmupManager = {
  warmOnce: () => void
  dispose: () => void
}

export const createBoostTrailWarmupManager = ({
  world,
  scene,
  camera,
  renderer,
  createBoostDraftMaterial,
  boostDraftGeometry,
  createBoostTrailMaterial,
  webglShaderHooksEnabled,
}: {
  world: THREE.Object3D
  scene: THREE.Scene
  camera: THREE.PerspectiveCamera
  renderer: { render: (scene: THREE.Scene, camera: THREE.PerspectiveCamera) => unknown }
  createBoostDraftMaterial: () => THREE.MeshBasicMaterial
  boostDraftGeometry: THREE.SphereGeometry
  createBoostTrailMaterial: () => THREE.MeshBasicMaterial
  webglShaderHooksEnabled: boolean
}): BoostTrailWarmupManager => {
  let boostWarmupGroup: THREE.Group | null = null
  let boostWarmupTrailGeometry: THREE.BufferGeometry | null = null
  let boostWarmupTrailMaterial: THREE.MeshBasicMaterial | null = null
  let boostWarmupDraftMaterial: THREE.MeshBasicMaterial | null = null

  const warmOnce = () => {
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

  const dispose = () => {
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
  }

  return {
    warmOnce,
    dispose,
  }
}

export const createBoostTrailController = ({
  boostTrails,
  boostTrailsGroup,
  createBoostTrailMaterial,
  webglShaderHooksEnabled,
  getTerrainRadius,
  buildTangentBasis,
  planetRadius,
  boostTrailSurfaceOffset,
  boostTrailMinSampleDistance,
  boostTrailMaxSamples,
  boostTrailMaxArcAngle,
  boostTrailFadeSeconds,
  boostTrailMaxCurveSegments,
  boostTrailCurveSegmentsPerPoint,
  boostTrailMaxCenterPoints,
  boostTrailMaxVertexCount,
  boostTrailMaxIndexCount,
  boostTrailPoolMax,
  boostTrailWidth,
  boostTrailRetireFeather,
  boostTrailEdgeFadeCap,
}: CreateBoostTrailControllerParams): BoostTrailController => {
  const boostTrailPool: BoostTrailState[] = []
  const trailSamplePointTemp = new THREE.Vector3()
  const trailSlerpNormalTemp = new THREE.Vector3()
  const trailReprojectNormalTemp = new THREE.Vector3()
  const trailReprojectPointTemp = new THREE.Vector3()
  const trailTangentTemp = new THREE.Vector3()
  const trailSideTemp = new THREE.Vector3()
  const trailOffsetTemp = new THREE.Vector3()

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
    const positionArray = new Float32Array(boostTrailMaxVertexCount * 3)
    const uvArray = new Float32Array(boostTrailMaxVertexCount * 2)
    const trailProgressArray = webglShaderHooksEnabled
      ? new Float32Array(boostTrailMaxVertexCount)
      : null
    const indexArray = new Uint16Array(boostTrailMaxIndexCount)

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
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), planetRadius + 2)

    const mesh = new THREE.Mesh(geometry, material)
    mesh.visible = false
    mesh.renderOrder = 1
    boostTrailsGroup.add(mesh)
    const projectedPoints: THREE.Vector3[] = new Array(boostTrailMaxCenterPoints)
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
    if (boostTrailPool.length >= boostTrailPoolMax) {
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

  const getTrailSurfacePointFromNormal = (normal: THREE.Vector3, out: THREE.Vector3) => {
    const radius = getTerrainRadius(normal)
    out.copy(normal).multiplyScalar(radius + boostTrailSurfaceOffset)
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
    if (trail.samples.length <= boostTrailMaxSamples) return
    const excess = trail.samples.length - boostTrailMaxSamples
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
    const minDistanceSq = boostTrailMinSampleDistance * boostTrailMinSampleDistance
    if (trailSamplePointTemp.distanceToSquared(last.point) < minDistanceSq) {
      return
    }

    const arcAngle = Math.acos(clamp(last.normal.dot(normalized), -1, 1))
    const subdivisions = Math.max(0, Math.ceil(arcAngle / boostTrailMaxArcAngle) - 1)
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
    const durationMs = boostTrailFadeSeconds * 1000
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
      Math.min(boostTrailMaxCurveSegments, (curvePoints.length - 1) * boostTrailCurveSegmentsPerPoint),
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
    const halfWidth = boostTrailWidth * 0.5
    const retireCut = trail.retiring ? clamp(trail.retireCut, 0, 0.9999) : 0
    const retireFadeEnd = trail.retiring
      ? clamp(retireCut + boostTrailRetireFeather, retireCut + 1e-4, 1)
      : 0
    const edgeCap = clamp(boostTrailEdgeFadeCap, 1e-4, 0.5)

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

  const disposeAllBoostTrails = () => {
    for (const trails of boostTrails.values()) {
      for (const trail of trails) {
        disposeBoostTrail(trail)
      }
    }
    boostTrails.clear()
    for (const trail of boostTrailPool) {
      disposeBoostTrail(trail)
    }
    boostTrailPool.length = 0
  }

  return {
    updateBoostTrailForPlayer,
    updateInactiveBoostTrails,
    disposeBoostTrail,
    disposeAllBoostTrails,
  }
}
