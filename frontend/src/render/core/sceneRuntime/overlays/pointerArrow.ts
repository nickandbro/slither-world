import * as THREE from 'three'
import type { Point } from '../../../../game/types'
import { clamp, lerp } from '../utils/math'

export type PointerArrowConstants = {
  segments: number
  arcRadians: number
  lift: number
  halfWidth: number
  headHalfWidth: number
  thickness: number
  headLength: number
  tipHalfWidth: number
}

export type PointerArrowOverlay = {
  scene: THREE.Scene
  root: THREE.Group
  mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>
  geometry: THREE.BufferGeometry
  material: THREE.MeshStandardMaterial
  positions: Float32Array
  positionAttribute: THREE.BufferAttribute
  ringCount: number
  constants: PointerArrowConstants
  raycaster: THREE.Raycaster
  ndcTemp: THREE.Vector2
  rayLocal: THREE.Ray
  sphere: THREE.Sphere
  originLocalTemp: THREE.Vector3
  dirLocalTemp: THREE.Vector3
  hitLocalTemp: THREE.Vector3
  targetNormalTemp: THREE.Vector3
  axisVectorTemp: THREE.Vector3
  tipPointTemp: THREE.Vector3
  dirs: THREE.Vector3[]
  points: THREE.Vector3[]
  tangentTemp: THREE.Vector3
  sideTemp: THREE.Vector3
}

export type PointerArrowUpdateResult = {
  axisActive: boolean
  axis: Point
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

export const createPointerArrowOverlay = (snakeRadius: number): PointerArrowOverlay => {
  const constants: PointerArrowConstants = {
    segments: 16,
    arcRadians: 0.09,
    lift: snakeRadius * 0.25,
    halfWidth: snakeRadius * 0.65,
    headHalfWidth: snakeRadius * 1.7,
    thickness: snakeRadius * 0.55,
    headLength: snakeRadius * 3.2,
    tipHalfWidth: snakeRadius * 0.65 * 0.04,
  }

  const scene = new THREE.Scene()
  const root = new THREE.Group()
  root.visible = false
  scene.add(root)

  // Keep contrast so faces read as low-poly shaded instead of flat white.
  const ambient = new THREE.AmbientLight(0xffffff, 0.34)
  const keyLight = new THREE.DirectionalLight(0xffffff, 1.08)
  keyLight.position.set(2.2, 3.1, 3.4)
  const rimLight = new THREE.DirectionalLight(0x9bd7ff, 0.34)
  rimLight.position.set(-3.2, -1.4, -2.6)
  scene.add(ambient)
  scene.add(keyLight)
  scene.add(rimLight)
  scene.add(keyLight.target)
  scene.add(rimLight.target)

  const material = new THREE.MeshStandardMaterial({
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

  const ringCount = constants.segments + 1
  // Each ring has 4 vertices (bottomLeft, bottomRight, topLeft, topRight) plus 2 tip vertices.
  const vertexCount = ringCount * 4 + 2
  const positions = new Float32Array(vertexCount * 3)
  const positionAttribute = new THREE.BufferAttribute(positions, 3)

  // 24 indices per segment (top/bottom/left/right), plus 6 for the tail cap, plus 18 for the tip wedge.
  const indexCount = constants.segments * 24 + 6 + 18
  const indices = new Uint16Array(indexCount)
  let indexOffset = 0
  for (let i = 0; i < constants.segments; i += 1) {
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
    indices[indexOffset++] = tl0
    indices[indexOffset++] = tr0
    indices[indexOffset++] = tl1
    indices[indexOffset++] = tr0
    indices[indexOffset++] = tr1
    indices[indexOffset++] = tl1

    // Bottom surface (-normal).
    indices[indexOffset++] = bl0
    indices[indexOffset++] = bl1
    indices[indexOffset++] = br0
    indices[indexOffset++] = br0
    indices[indexOffset++] = bl1
    indices[indexOffset++] = br1

    // Left side (+side).
    indices[indexOffset++] = bl0
    indices[indexOffset++] = tl0
    indices[indexOffset++] = bl1
    indices[indexOffset++] = tl0
    indices[indexOffset++] = tl1
    indices[indexOffset++] = bl1

    // Right side (-side).
    indices[indexOffset++] = br0
    indices[indexOffset++] = br1
    indices[indexOffset++] = tr0
    indices[indexOffset++] = tr0
    indices[indexOffset++] = br1
    indices[indexOffset++] = tr1
  }

  // Tail cap.
  indices[indexOffset++] = 0
  indices[indexOffset++] = 1
  indices[indexOffset++] = 2
  indices[indexOffset++] = 1
  indices[indexOffset++] = 3
  indices[indexOffset++] = 2

  // Tip wedge (connect the final ring to the tip edge). This keeps the arrowhead and tail as one
  // seamless low-poly mesh and avoids the tail clipping through a separate head mesh.
  const lastBase = constants.segments * 4
  const tipBottomIndex = ringCount * 4
  const tipTopIndex = tipBottomIndex + 1
  indices[indexOffset++] = lastBase + 2
  indices[indexOffset++] = lastBase + 3
  indices[indexOffset++] = tipTopIndex
  indices[indexOffset++] = lastBase + 0
  indices[indexOffset++] = tipBottomIndex
  indices[indexOffset++] = lastBase + 1
  indices[indexOffset++] = lastBase + 0
  indices[indexOffset++] = lastBase + 2
  indices[indexOffset++] = tipBottomIndex
  indices[indexOffset++] = lastBase + 2
  indices[indexOffset++] = tipTopIndex
  indices[indexOffset++] = tipBottomIndex
  indices[indexOffset++] = lastBase + 1
  indices[indexOffset++] = tipBottomIndex
  indices[indexOffset++] = lastBase + 3
  indices[indexOffset++] = lastBase + 3
  indices[indexOffset++] = tipBottomIndex
  indices[indexOffset++] = tipTopIndex

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', positionAttribute)
  geometry.setIndex(new THREE.BufferAttribute(indices, 1))

  const mesh = new THREE.Mesh(geometry, material)
  mesh.frustumCulled = false
  mesh.renderOrder = 10_000
  root.add(mesh)

  const raycaster = new THREE.Raycaster()
  const ndcTemp = new THREE.Vector2()
  const rayLocal = new THREE.Ray(new THREE.Vector3(), new THREE.Vector3(0, 0, -1))
  const sphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 3)
  const originLocalTemp = new THREE.Vector3()
  const dirLocalTemp = new THREE.Vector3()
  const hitLocalTemp = new THREE.Vector3()
  const targetNormalTemp = new THREE.Vector3(0, 0, 1)
  const axisVectorTemp = new THREE.Vector3()
  const tipPointTemp = new THREE.Vector3()
  const dirs = Array.from({ length: constants.segments + 1 }, () => new THREE.Vector3())
  const points = Array.from({ length: constants.segments + 1 }, () => new THREE.Vector3())
  const tangentTemp = new THREE.Vector3()
  const sideTemp = new THREE.Vector3()

  return {
    scene,
    root,
    mesh,
    geometry,
    material,
    positions,
    positionAttribute,
    ringCount,
    constants,
    raycaster,
    ndcTemp,
    rayLocal,
    sphere,
    originLocalTemp,
    dirLocalTemp,
    hitLocalTemp,
    targetNormalTemp,
    axisVectorTemp,
    tipPointTemp,
    dirs,
    points,
    tangentTemp,
    sideTemp,
  }
}

export const updatePointerArrowOverlay = ({
  overlay,
  active,
  hasLocalHead,
  screenX,
  screenY,
  viewportWidth,
  viewportHeight,
  camera,
  worldInverse,
  localHeadNormal,
  getTerrainRadius,
  buildTangentBasis,
}: {
  overlay: PointerArrowOverlay
  active: boolean
  hasLocalHead: boolean
  screenX: number
  screenY: number
  viewportWidth: number
  viewportHeight: number
  camera: THREE.Camera
  worldInverse: THREE.Quaternion
  localHeadNormal: THREE.Vector3
  getTerrainRadius: (normal: THREE.Vector3) => number
  buildTangentBasis: (
    normal: THREE.Vector3,
    tangent: THREE.Vector3,
    bitangent: THREE.Vector3,
  ) => void
}): PointerArrowUpdateResult => {
  const axis: Point = { x: 0, y: 0, z: 0 }
  overlay.root.visible = false
  overlay.mesh.visible = false

  if (
    !active ||
    !hasLocalHead ||
    !Number.isFinite(screenX) ||
    !Number.isFinite(screenY) ||
    viewportWidth <= 0 ||
    viewportHeight <= 0
  ) {
    return { axisActive: false, axis }
  }

  const ndcX = (screenX / viewportWidth) * 2 - 1
  const ndcY = -(screenY / viewportHeight) * 2 + 1
  if (!Number.isFinite(ndcX) || !Number.isFinite(ndcY)) {
    return { axisActive: false, axis }
  }

  overlay.ndcTemp.set(ndcX, ndcY)
  overlay.raycaster.setFromCamera(overlay.ndcTemp, camera)

  overlay.originLocalTemp.copy(overlay.raycaster.ray.origin).applyQuaternion(worldInverse)
  overlay.dirLocalTemp.copy(overlay.raycaster.ray.direction).applyQuaternion(worldInverse)
  const dirLenSq = overlay.dirLocalTemp.lengthSq()
  if (dirLenSq <= 1e-12) {
    return { axisActive: false, axis }
  }
  overlay.dirLocalTemp.multiplyScalar(1 / Math.sqrt(dirLenSq))
  overlay.rayLocal.origin.copy(overlay.originLocalTemp)
  overlay.rayLocal.direction.copy(overlay.dirLocalTemp)

  overlay.sphere.radius = 3
  let hit = overlay.rayLocal.intersectSphere(overlay.sphere, overlay.hitLocalTemp)
  if (!hit) {
    return { axisActive: false, axis }
  }

  let ok = true
  for (let iter = 0; iter < 3; iter += 1) {
    const hitLenSq = overlay.hitLocalTemp.lengthSq()
    if (hitLenSq <= 1e-12) {
      ok = false
      break
    }
    const invHitLen = 1 / Math.sqrt(hitLenSq)
    overlay.targetNormalTemp.copy(overlay.hitLocalTemp).multiplyScalar(invHitLen)
    const radius = getTerrainRadius(overlay.targetNormalTemp)
    if (!Number.isFinite(radius) || radius <= 0) {
      ok = false
      break
    }
    if (Math.abs(1 / invHitLen - radius) < 1e-4) {
      break
    }
    overlay.sphere.radius = radius
    hit = overlay.rayLocal.intersectSphere(overlay.sphere, overlay.hitLocalTemp)
    if (!hit) {
      ok = false
      break
    }
  }
  if (!ok) {
    return { axisActive: false, axis }
  }

  overlay.targetNormalTemp.copy(overlay.hitLocalTemp).normalize()
  overlay.axisVectorTemp.crossVectors(localHeadNormal, overlay.targetNormalTemp)
  const axisLenSq = overlay.axisVectorTemp.lengthSq()
  if (axisLenSq <= 1e-8) {
    return { axisActive: false, axis }
  }

  overlay.axisVectorTemp.multiplyScalar(1 / Math.sqrt(axisLenSq))
  axis.x = overlay.axisVectorTemp.x
  axis.y = overlay.axisVectorTemp.y
  axis.z = overlay.axisVectorTemp.z

  const dotValue = clamp(localHeadNormal.dot(overlay.targetNormalTemp), -1, 1)
  const angle = Math.acos(dotValue)
  if (!Number.isFinite(angle) || angle <= 1e-4) {
    return { axisActive: true, axis }
  }

  const arc = Math.min(overlay.constants.arcRadians, angle)
  const tStart = clamp(1 - arc / angle, 0, 1)
  const tipRadius = getTerrainRadius(overlay.targetNormalTemp)
  if (!Number.isFinite(tipRadius) || tipRadius <= 0) {
    return { axisActive: true, axis }
  }

  // Keep the arrow stable over sharp low-poly terrain: once we have a valid hit radius, keep the body
  // on a constant-radius shell instead of resampling per-segment terrain height.
  const arrowBaseRadius = tipRadius + overlay.constants.lift
  overlay.tipPointTemp.copy(overlay.targetNormalTemp).multiplyScalar(arrowBaseRadius)
  const desiredHeadAngle = overlay.constants.headLength / Math.max(1e-3, tipRadius)
  const headAngle = Math.min(desiredHeadAngle, arc * 0.65, angle)
  const headStartT = clamp(1 - headAngle / angle, tStart, 1)

  for (let i = 0; i <= overlay.constants.segments; i += 1) {
    const t = tStart + (1 - tStart) * (i / overlay.constants.segments)
    const dir = overlay.dirs[i]
    const point = overlay.points[i]
    slerpNormals(localHeadNormal, overlay.targetNormalTemp, t, dir)
    point.copy(dir).multiplyScalar(arrowBaseRadius)
  }

  for (let i = 0; i <= overlay.constants.segments; i += 1) {
    const normal = overlay.dirs[i]
    const point = overlay.points[i]
    if (i === 0) {
      overlay.tangentTemp.copy(overlay.points[1]).sub(point)
    } else if (i === overlay.constants.segments) {
      overlay.tangentTemp.copy(point).sub(overlay.points[overlay.constants.segments - 1])
    } else {
      overlay.tangentTemp
        .copy(overlay.points[i + 1])
        .sub(overlay.points[i - 1])
        .multiplyScalar(0.5)
    }
    overlay.tangentTemp.addScaledVector(
      normal,
      -overlay.tangentTemp.dot(normal),
    )
    if (overlay.tangentTemp.lengthSq() <= 1e-10) {
      buildTangentBasis(normal, overlay.tangentTemp, overlay.sideTemp)
    } else {
      overlay.tangentTemp.normalize()
      overlay.sideTemp.crossVectors(normal, overlay.tangentTemp)
      if (overlay.sideTemp.lengthSq() <= 1e-10) {
        buildTangentBasis(normal, overlay.tangentTemp, overlay.sideTemp)
      } else {
        overlay.sideTemp.normalize()
      }
    }

    const t = tStart + (1 - tStart) * (i / overlay.constants.segments)
    const headDenom = Math.max(1e-4, 1 - headStartT)
    const headProgress = clamp((t - headStartT) / headDenom, 0, 1)
    let halfWidth =
      t >= headStartT
        ? lerp(
            overlay.constants.headHalfWidth,
            overlay.constants.tipHalfWidth,
            headProgress,
          )
        : overlay.constants.halfWidth
    if (i === overlay.constants.segments) {
      halfWidth = overlay.constants.tipHalfWidth
    }

    const sx = overlay.sideTemp.x * halfWidth
    const sy = overlay.sideTemp.y * halfWidth
    const sz = overlay.sideTemp.z * halfWidth
    // Straight extrusion: use a single extrusion direction so side quads are planar.
    const nx = overlay.targetNormalTemp.x * overlay.constants.thickness
    const ny = overlay.targetNormalTemp.y * overlay.constants.thickness
    const nz = overlay.targetNormalTemp.z * overlay.constants.thickness
    const base = i * 4 * 3

    const blx = point.x + sx
    const bly = point.y + sy
    const blz = point.z + sz
    overlay.positions[base] = blx
    overlay.positions[base + 1] = bly
    overlay.positions[base + 2] = blz

    const brx = point.x - sx
    const bry = point.y - sy
    const brz = point.z - sz
    overlay.positions[base + 3] = brx
    overlay.positions[base + 4] = bry
    overlay.positions[base + 5] = brz

    overlay.positions[base + 6] = blx + nx
    overlay.positions[base + 7] = bly + ny
    overlay.positions[base + 8] = blz + nz

    overlay.positions[base + 9] = brx + nx
    overlay.positions[base + 10] = bry + ny
    overlay.positions[base + 11] = brz + nz
  }

  const tipBase = overlay.ringCount * 4 * 3
  overlay.positions[tipBase] = overlay.tipPointTemp.x
  overlay.positions[tipBase + 1] = overlay.tipPointTemp.y
  overlay.positions[tipBase + 2] = overlay.tipPointTemp.z
  overlay.positions[tipBase + 3] =
    overlay.tipPointTemp.x + overlay.targetNormalTemp.x * overlay.constants.thickness
  overlay.positions[tipBase + 4] =
    overlay.tipPointTemp.y + overlay.targetNormalTemp.y * overlay.constants.thickness
  overlay.positions[tipBase + 5] =
    overlay.tipPointTemp.z + overlay.targetNormalTemp.z * overlay.constants.thickness

  overlay.mesh.visible = true
  overlay.positionAttribute.needsUpdate = true
  overlay.geometry.computeVertexNormals()
  const normalAttr = overlay.geometry.getAttribute('normal')
  if (normalAttr instanceof THREE.BufferAttribute) {
    normalAttr.needsUpdate = true
  }
  overlay.root.visible = true

  return {
    axisActive: true,
    axis,
  }
}
