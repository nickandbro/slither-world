import * as THREE from 'three'
import type { Camera, GameStateSnapshot, PlayerSnapshot, Point } from './gameTypes'

type SnakeVisual = {
  group: THREE.Group
  tube: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>
  head: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>
  tail: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>
  eyeLeft: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>
  eyeRight: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>
  pupilLeft: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>
  pupilRight: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>
  color: string
}

type DigestionVisual = {
  t: number
  strength: number
}

type TailAddState = {
  progress: number
  duration: number
  carryDistance: number
  carryExtra: number | null
  startPos: THREE.Vector3 | null
}

type TailExtraState = {
  value: number
}

type TailDebugState = {
  lastExtendActive: boolean
  lastExtBucket: number
  lastDirAngleBucket: number
}

type WebGLScene = {
  resize: (width: number, height: number, dpr: number) => void
  render: (
    snapshot: GameStateSnapshot | null,
    camera: Camera,
    localPlayerId: string | null,
  ) => { x: number; y: number } | null
  dispose: () => void
}

const PLANET_RADIUS = 1
const SNAKE_RADIUS = 0.045
const HEAD_RADIUS = SNAKE_RADIUS * 1.35
const SNAKE_LIFT_FACTOR = 0.85
const EYE_RADIUS = SNAKE_RADIUS * 0.45
const PUPIL_RADIUS = EYE_RADIUS * 0.5
const PELLET_RADIUS = SNAKE_RADIUS * 0.75
const PELLET_OFFSET = 0.035
const TAIL_CAP_SEGMENTS = 5
const TAIL_DIR_MIN_RATIO = 0.35
const DIGESTION_BULGE = 0.45
const DIGESTION_WIDTH = 2.5
const DIGESTION_MAX_BULGE = 0.7
const DIGESTION_START_RINGS = 3
const DIGESTION_START_MAX = 0.18
const TAIL_ADD_SMOOTH_MS = 180
const TAIL_EXTEND_RATE_UP = 0.14
const TAIL_EXTEND_RATE_DOWN = 2.6
const TAIL_EXTEND_RATE_UP_ADD = 0.12
const TAIL_EXTEND_RATE_DOWN_ADD = 1.6
const TAIL_EXTEND_MAX_GROW_SPEED = 0.12
const TAIL_EXTEND_MAX_GROW_SPEED_ADD = 0.08
const TAIL_EXTEND_MAX_SHRINK_SPEED = 0.35
const TAIL_EXTEND_MAX_SHRINK_SPEED_ADD = 0.25
const TAIL_GROWTH_RATE_UP = 0.35
const TAIL_GROWTH_RATE_DOWN = 1.2
const TAIL_GROWTH_EASE = 2.5
const TAIL_EXTEND_CURVE_BLEND = 0.65
const DEBUG_TAIL = false

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))
const formatNum = (value: number, digits = 4) =>
  Number.isFinite(value) ? value.toFixed(digits) : 'NaN'
const smoothValue = (current: number, target: number, deltaSeconds: number, rateUp: number, rateDown: number) => {
  const rate = target >= current ? rateUp : rateDown
  const alpha = 1 - Math.exp(-rate * Math.max(0, deltaSeconds))
  return current + (target - current) * alpha
}
const slerpOnSphere = (from: THREE.Vector3, to: THREE.Vector3, alpha: number, radius: number) => {
  const fromDir = from.clone().normalize()
  const toDir = to.clone().normalize()
  const dotValue = clamp(fromDir.dot(toDir), -1, 1)
  const angle = Math.acos(dotValue)
  if (!Number.isFinite(angle) || angle < 1e-6) {
    return toDir.multiplyScalar(radius)
  }
  const axis = new THREE.Vector3().crossVectors(fromDir, toDir)
  if (axis.lengthSq() < 1e-8) {
    return toDir.multiplyScalar(radius)
  }
  axis.normalize()
  fromDir.applyAxisAngle(axis, angle * alpha)
  return fromDir.multiplyScalar(radius)
}
const advanceOnSphere = (
  origin: THREE.Vector3,
  direction: THREE.Vector3,
  distance: number,
  radius: number,
) => {
  if (distance <= 0) return origin.clone()
  const normal = origin.clone().normalize()
  const dir = direction.clone().addScaledVector(normal, -direction.dot(normal))
  if (dir.lengthSq() < 1e-8) return origin.clone()
  dir.normalize()
  const axis = normal.clone().cross(dir)
  const angle = distance / radius
  if (axis.lengthSq() < 1e-8 || !Number.isFinite(angle)) {
    return origin.clone().addScaledVector(dir, distance).normalize().multiplyScalar(radius)
  }
  axis.normalize()
  return origin.clone().applyAxisAngle(axis, angle).normalize().multiplyScalar(radius)
}
const isTailDebugEnabled = () => {
  if (DEBUG_TAIL) return true
  if (typeof window === 'undefined') return false
  try {
    if ((window as { __TAIL_DEBUG__?: boolean }).__TAIL_DEBUG__ === true) return true
    return window.localStorage.getItem('spherical_snake_tail_debug') === '1'
  } catch {
    return false
  }
}

function pointToVector(point: Point, radius: number) {
  return new THREE.Vector3(point.x, point.y, point.z).normalize().multiplyScalar(radius)
}

class SphericalCurve extends THREE.Curve<THREE.Vector3> {
  private base: THREE.CatmullRomCurve3
  private radius: number

  constructor(base: THREE.CatmullRomCurve3, radius: number) {
    super()
    this.base = base
    this.radius = radius
  }

  getPoint(t: number, optionalTarget = new THREE.Vector3()) {
    this.base.getPoint(t, optionalTarget)
    return optionalTarget.normalize().multiplyScalar(this.radius)
  }
}

export function createWebGLScene(canvas: HTMLCanvasElement): WebGLScene {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: true,
  })
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 1.05
  renderer.setClearColor(0x000000, 0)

  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 20)
  camera.position.set(0, 0, 3)
  scene.add(camera)

  const world = new THREE.Group()
  scene.add(world)

  const ambient = new THREE.AmbientLight(0xffffff, 0.65)
  const keyLight = new THREE.DirectionalLight(0xffffff, 0.9)
  keyLight.position.set(2, 3, 4)
  const rimLight = new THREE.DirectionalLight(0x9bd7ff, 0.35)
  rimLight.position.set(-2, -1, 2)
  camera.add(ambient)
  camera.add(keyLight)
  camera.add(rimLight)

  const planetGeometry = new THREE.SphereGeometry(PLANET_RADIUS, 64, 64)
  const planetMaterial = new THREE.MeshStandardMaterial({
    color: '#7ddf6a',
    roughness: 0.9,
    metalness: 0.05,
  })
  const planetMesh = new THREE.Mesh(planetGeometry, planetMaterial)
  world.add(planetMesh)

  const gridGeometry = new THREE.WireframeGeometry(planetGeometry)
  const gridMaterial = new THREE.LineBasicMaterial({
    color: '#1b4965',
    transparent: true,
    opacity: 0.12,
  })
  gridMaterial.depthWrite = false
  const gridMesh = new THREE.LineSegments(gridGeometry, gridMaterial)
  gridMesh.scale.setScalar(1.002)
  world.add(gridMesh)

  const snakesGroup = new THREE.Group()
  const pelletsGroup = new THREE.Group()
  world.add(snakesGroup)
  world.add(pelletsGroup)

  const headGeometry = new THREE.SphereGeometry(HEAD_RADIUS, 18, 18)
  const tailGeometry = new THREE.SphereGeometry(1, 18, 12, 0, Math.PI * 2, 0, Math.PI / 2)
  const eyeGeometry = new THREE.SphereGeometry(EYE_RADIUS, 12, 12)
  const pupilGeometry = new THREE.SphereGeometry(PUPIL_RADIUS, 10, 10)
  const eyeMaterial = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.2 })
  const pupilMaterial = new THREE.MeshStandardMaterial({ color: '#1b1b1b', roughness: 0.4 })

  const pelletGeometry = new THREE.SphereGeometry(PELLET_RADIUS, 14, 14)
  const pelletMaterial = new THREE.MeshStandardMaterial({
    color: '#ffb703',
    emissive: '#b86a00',
    emissiveIntensity: 0.45,
    roughness: 0.25,
  })
  let pelletMesh: THREE.InstancedMesh | null = null
  let pelletCapacity = 0
  let viewportWidth = 1
  let viewportHeight = 1
  let lastFrameTime = performance.now()

  const snakes = new Map<string, SnakeVisual>()
  const lastHeadPositions = new Map<string, THREE.Vector3>()
  const lastForwardDirections = new Map<string, THREE.Vector3>()
  const lastTailDirections = new Map<string, THREE.Vector3>()
  const lastSnakeLengths = new Map<string, number>()
  const tailAddStates = new Map<string, TailAddState>()
  const tailExtraStates = new Map<string, TailExtraState>()
  const lastTailBasePositions = new Map<string, THREE.Vector3>()
  const lastTailExtensionDistances = new Map<string, number>()
  const lastTailTotalLengths = new Map<string, number>()
  const tailGrowthStates = new Map<string, number>()
  const tailDebugStates = new Map<string, TailDebugState>()
  const tempMatrix = new THREE.Matrix4()
  const tempVector = new THREE.Vector3()
  const tempVectorB = new THREE.Vector3()
  const tempVectorC = new THREE.Vector3()

  const createSnakeVisual = (color: string): SnakeVisual => {
    const group = new THREE.Group()

    const tubeMaterial = new THREE.MeshStandardMaterial({
      color,
      roughness: 0.35,
      metalness: 0.1,
      flatShading: true,
    })
    const tube = new THREE.Mesh(new THREE.BufferGeometry(), tubeMaterial)
    group.add(tube)

    const headMaterial = new THREE.MeshStandardMaterial({
      color,
      roughness: 0.25,
      metalness: 0.1,
    })
    const head = new THREE.Mesh(headGeometry, headMaterial)
    group.add(head)

    const tail = new THREE.Mesh(tailGeometry, tubeMaterial)
    group.add(tail)

    const eyeLeft = new THREE.Mesh(eyeGeometry, eyeMaterial)
    const eyeRight = new THREE.Mesh(eyeGeometry, eyeMaterial)
    const pupilLeft = new THREE.Mesh(pupilGeometry, pupilMaterial)
    const pupilRight = new THREE.Mesh(pupilGeometry, pupilMaterial)
    group.add(eyeLeft)
    group.add(eyeRight)
    group.add(pupilLeft)
    group.add(pupilRight)

    return {
      group,
      tube,
      head,
      tail,
      eyeLeft,
      eyeRight,
      pupilLeft,
      pupilRight,
      color,
    }
  }

  const updateSnakeMaterial = (material: THREE.MeshStandardMaterial, color: string, isLocal: boolean) => {
    const base = new THREE.Color(color)
    material.color.copy(base)
    material.emissive.copy(base)
    material.emissiveIntensity = isLocal ? 0.3 : 0.12
  }

  const buildTailCapGeometry = (
    tubeGeometry: THREE.TubeGeometry,
    tailDirection: THREE.Vector3,
  ): THREE.BufferGeometry | null => {
    const params = tubeGeometry.parameters as { radialSegments?: number; tubularSegments?: number }
    const radialSegments = params.radialSegments ?? 8
    const tubularSegments = params.tubularSegments ?? 1
    const ringVertexCount = radialSegments + 1
    const ringStart = tubularSegments * ringVertexCount
    const positions = tubeGeometry.attributes.position
    if (!positions || positions.count < ringStart + radialSegments) return null

    const ringPoints: THREE.Vector3[] = []
    const ringVectors: THREE.Vector3[] = []
    const center = new THREE.Vector3()

    for (let i = 0; i < radialSegments; i += 1) {
      const index = ringStart + i
      const point = new THREE.Vector3(
        positions.getX(index),
        positions.getY(index),
        positions.getZ(index),
      )
      ringPoints.push(point)
      center.add(point)
    }

    if (ringPoints.length === 0) return null
    center.multiplyScalar(1 / ringPoints.length)

    let radius = 0
    for (const point of ringPoints) {
      const vector = point.clone().sub(center)
      ringVectors.push(vector)
      radius += vector.length()
    }
    radius = radius / ringVectors.length
    if (!Number.isFinite(radius) || radius <= 0) return null

    const ringNormal = ringVectors[1 % radialSegments].clone().cross(ringVectors[0])
    if (ringNormal.lengthSq() < 1e-8) return null
    ringNormal.normalize()
    const tailDirNorm = tailDirection.clone().normalize()
    const flip = ringNormal.dot(tailDirNorm) < 0
    const capDir = flip ? ringNormal.clone().negate() : ringNormal.clone()

    const rings = Math.max(2, TAIL_CAP_SEGMENTS)
    const vertexCount = rings * radialSegments + 1
    const capPositions = new Float32Array(vertexCount * 3)

    for (let s = 0; s < rings; s += 1) {
      const theta = (s / rings) * (Math.PI / 2)
      const scale = Math.cos(theta)
      const offset = Math.sin(theta) * radius
      for (let i = 0; i < radialSegments; i += 1) {
        const vector = ringVectors[i]
        const point = center
          .clone()
          .addScaledVector(vector, scale)
          .addScaledVector(capDir, offset)
        const index = (s * radialSegments + i) * 3
        capPositions[index] = point.x
        capPositions[index + 1] = point.y
        capPositions[index + 2] = point.z
      }
    }

    const tip = center.clone().addScaledVector(capDir, radius)
    const tipOffset = rings * radialSegments * 3
    capPositions[tipOffset] = tip.x
    capPositions[tipOffset + 1] = tip.y
    capPositions[tipOffset + 2] = tip.z

    const indices: number[] = []
    const pushTri = (a: number, b: number, c: number) => {
      if (flip) {
        indices.push(a, c, b)
      } else {
        indices.push(a, b, c)
      }
    }

    for (let s = 0; s < rings - 1; s += 1) {
      for (let i = 0; i < radialSegments; i += 1) {
        const next = (i + 1) % radialSegments
        const a = s * radialSegments + i
        const b = s * radialSegments + next
        const c = (s + 1) * radialSegments + i
        const d = (s + 1) * radialSegments + next
        pushTri(a, c, b)
        pushTri(b, c, d)
      }
    }

    const tipIndex = rings * radialSegments
    const lastRingStart = (rings - 1) * radialSegments
    for (let i = 0; i < radialSegments; i += 1) {
      const next = (i + 1) % radialSegments
      const a = lastRingStart + i
      const b = lastRingStart + next
      pushTri(a, tipIndex, b)
    }

    const capGeometry = new THREE.BufferGeometry()
    capGeometry.setAttribute('position', new THREE.BufferAttribute(capPositions, 3))
    capGeometry.setIndex(indices)
    capGeometry.computeVertexNormals()
    capGeometry.computeBoundingSphere()
    return capGeometry
  }

  const applyDigestionBulges = (tubeGeometry: THREE.TubeGeometry, digestions: DigestionVisual[]) => {
    if (!digestions.length) return
    const params = tubeGeometry.parameters as { radialSegments?: number; tubularSegments?: number }
    const radialSegments = params.radialSegments ?? 8
    const tubularSegments = params.tubularSegments ?? 1
    const ringVertexCount = radialSegments + 1
    const ringCount = tubularSegments + 1
    const positions = tubeGeometry.attributes.position
    if (!positions) return

    const bulgeByRing = new Array(ringCount).fill(0)
    const startOffset = Math.min(
      DIGESTION_START_MAX,
      DIGESTION_START_RINGS / Math.max(1, ringCount - 1),
    )
    for (const digestion of digestions) {
      const strength = clamp(digestion.strength, 0, 1)
      if (strength <= 0) continue
      const t = clamp(digestion.t, 0, 1)
      const mapped = startOffset + t * (1 - startOffset)
      const center = mapped * (ringCount - 1)
      const start = Math.max(0, Math.floor(center - DIGESTION_WIDTH * 2))
      const end = Math.min(ringCount - 1, Math.ceil(center + DIGESTION_WIDTH * 2))
      for (let ring = start; ring <= end; ring += 1) {
        const dist = ring - center
        const weight = Math.exp(-(dist * dist) / (2 * DIGESTION_WIDTH * DIGESTION_WIDTH))
        bulgeByRing[ring] = Math.min(
          DIGESTION_MAX_BULGE,
          bulgeByRing[ring] + weight * DIGESTION_BULGE * strength,
        )
      }
    }

    const center = new THREE.Vector3()
    const vertex = new THREE.Vector3()
    for (let ring = 0; ring < ringCount; ring += 1) {
      const bulge = bulgeByRing[ring]
      if (bulge <= 0) continue
      center.set(0, 0, 0)
      const ringStart = ring * ringVertexCount
      for (let i = 0; i < radialSegments; i += 1) {
        const index = ringStart + i
        center.x += positions.getX(index)
        center.y += positions.getY(index)
        center.z += positions.getZ(index)
      }
      center.multiplyScalar(1 / radialSegments)

      const scale = 1 + bulge
      for (let i = 0; i < ringVertexCount; i += 1) {
        const index = ringStart + i
        vertex.set(positions.getX(index), positions.getY(index), positions.getZ(index))
        vertex.sub(center).multiplyScalar(scale).add(center)
        positions.setXYZ(index, vertex.x, vertex.y, vertex.z)
      }
    }

    positions.needsUpdate = true
    tubeGeometry.computeVertexNormals()
  }

  const buildDigestionVisuals = (digestions: number[]) => {
    const visuals: DigestionVisual[] = []
    let tailGrowth = 0

    for (const digestion of digestions) {
      const travelT = clamp(digestion, 0, 1)
      const growth = clamp(digestion - 1, 0, 1)
      visuals.push({ t: travelT, strength: 1 - growth })
      if (growth > tailGrowth) tailGrowth = growth
    }

    return { visuals, tailGrowth }
  }


  const computeTailDirection = (
    curvePoints: THREE.Vector3[],
    centerlineRadius: number,
    tailBasisPrev?: THREE.Vector3 | null,
    tailBasisTail?: THREE.Vector3 | null,
    fallbackDirection?: THREE.Vector3 | null,
    overrides?: {
      tailPos?: THREE.Vector3
      prevPos?: THREE.Vector3
      preferFallbackBelow?: number
    },
  ) => {
    if (curvePoints.length < 2) return null
    const tailPos = overrides?.tailPos ?? curvePoints[curvePoints.length - 1]
    const prevPos = overrides?.prevPos ?? curvePoints[curvePoints.length - 2]
    const preferFallbackBelow = overrides?.preferFallbackBelow ?? 0
    const tailNormal = tailPos.clone().normalize()

    const projectToTangent = (dir: THREE.Vector3) => {
      dir.addScaledVector(tailNormal, -dir.dot(tailNormal))
      return dir
    }

    const lastSegmentDir = projectToTangent(tailPos.clone().sub(prevPos))
    const lastSegmentLen = lastSegmentDir.length()
    const hasLastSegment = lastSegmentLen > 1e-8
    const lastSegmentUnit = hasLastSegment
      ? lastSegmentDir.multiplyScalar(1 / lastSegmentLen)
      : null

    let fallbackDir: THREE.Vector3 | null = null
    if (tailBasisPrev && tailBasisTail) {
      const basisDir = projectToTangent(tailBasisTail.clone().sub(tailBasisPrev))
      if (basisDir.lengthSq() > 1e-8) {
        fallbackDir = basisDir.normalize()
      }
    }

    if (!fallbackDir && fallbackDirection) {
      const providedDir = projectToTangent(fallbackDirection.clone())
      if (providedDir.lengthSq() > 1e-8) {
        fallbackDir = providedDir.normalize()
      }
    }

    if (lastSegmentUnit && fallbackDir && preferFallbackBelow > 0) {
      const blendStart = preferFallbackBelow
      const blendEnd = preferFallbackBelow * 1.5
      if (lastSegmentLen <= blendStart) {
        return fallbackDir
      }
      if (lastSegmentLen >= blendEnd) {
        return lastSegmentUnit
      }
      const t = clamp((lastSegmentLen - blendStart) / (blendEnd - blendStart), 0, 1)
      return fallbackDir.clone().lerp(lastSegmentUnit, t).normalize()
    }

    if (lastSegmentUnit) {
      return lastSegmentUnit
    }

    return fallbackDir
  }

  const computeExtendedTailPoint = (
    curvePoints: THREE.Vector3[],
    extendDistance: number,
    centerlineRadius: number,
    tailBasisPrev?: THREE.Vector3 | null,
    tailBasisTail?: THREE.Vector3 | null,
    fallbackDirection?: THREE.Vector3 | null,
    preferFallbackBelow?: number,
    overrideDirection?: THREE.Vector3 | null,
  ) => {
    if (extendDistance <= 0 || curvePoints.length < 2) return null
    const tailPos = curvePoints[curvePoints.length - 1]
    const tailNormal = tailPos.clone().normalize()
    let tailDir = overrideDirection
      ? overrideDirection.clone()
      : computeTailDirection(
          curvePoints,
          centerlineRadius,
          tailBasisPrev,
          tailBasisTail,
          fallbackDirection,
          { preferFallbackBelow },
        )
    if (tailDir) {
      tailDir.addScaledVector(tailNormal, -tailDir.dot(tailNormal))
      if (tailDir.lengthSq() > 1e-8) {
        tailDir.normalize()
      } else {
        tailDir = null
      }
    }
    if (!tailDir) return null

    const axis = tailNormal.clone().cross(tailDir)
    const angle = extendDistance / centerlineRadius
    let extended: THREE.Vector3
    if (axis.lengthSq() < 1e-8 || !Number.isFinite(angle)) {
      extended = tailPos
        .clone()
        .addScaledVector(tailDir, extendDistance)
        .normalize()
        .multiplyScalar(centerlineRadius)
    } else {
      axis.normalize()
      extended = tailPos
        .clone()
        .applyAxisAngle(axis, angle)
        .normalize()
        .multiplyScalar(centerlineRadius)
    }
    return extended
  }

  const computeTailExtendDirection = (
    curvePoints: THREE.Vector3[],
    preferFallbackBelow: number,
  ) => {
    if (curvePoints.length < 2) return null
    const tailPos = curvePoints[curvePoints.length - 1]
    const prevPos = curvePoints[curvePoints.length - 2]
    const tailNormal = tailPos.clone().normalize()

    const projectToTangent = (dir: THREE.Vector3) => {
      dir.addScaledVector(tailNormal, -dir.dot(tailNormal))
      return dir
    }

    const lastDir = projectToTangent(tailPos.clone().sub(prevPos))
    const lastLen = lastDir.length()

    let prevDir: THREE.Vector3 | null = null
    let prevLen = 0
    if (curvePoints.length >= 3) {
      const prevPrev = curvePoints[curvePoints.length - 3]
      prevDir = projectToTangent(prevPos.clone().sub(prevPrev))
      prevLen = prevDir.length()
    }

    if (lastLen < preferFallbackBelow && prevDir && prevLen > 1e-8) {
      return prevDir.multiplyScalar(1 / prevLen)
    }

    if (lastLen > 1e-8 && prevDir && prevLen > 1e-8) {
      lastDir.multiplyScalar(1 / lastLen)
      prevDir.multiplyScalar(1 / prevLen)
      if (prevDir.dot(lastDir) < 0) {
        prevDir.multiplyScalar(-1)
      }
      return prevDir.lerp(lastDir, TAIL_EXTEND_CURVE_BLEND).normalize()
    }

    if (lastLen > 1e-8) {
      return lastDir.multiplyScalar(1 / lastLen)
    }

    if (prevDir && prevLen > 1e-8) {
      return prevDir.multiplyScalar(1 / prevLen)
    }

    return null
  }


  const updateSnake = (player: PlayerSnapshot, isLocal: boolean, deltaSeconds: number) => {
    let visual = snakes.get(player.id)
    if (!visual) {
      visual = createSnakeVisual(player.color)
      snakes.set(player.id, visual)
      snakesGroup.add(visual.group)
    }

    if (visual.color !== player.color) {
      visual.color = player.color
    }

    updateSnakeMaterial(visual.tube.material, visual.color, isLocal)
    updateSnakeMaterial(visual.head.material, visual.color, isLocal)

    const nodes = player.snake
    const debug = isTailDebugEnabled() && isLocal
    const maxDigestion =
      player.digestions.length > 0 ? Math.max(...player.digestions) : 0
    const lastTailDirection = lastTailDirections.get(player.id) ?? null
    let lengthIncreased = false
    const prevLength = lastSnakeLengths.get(player.id)
    if (prevLength !== undefined) {
      if (nodes.length > prevLength && nodes.length >= 2) {
        lengthIncreased = true
        tailAddStates.set(player.id, {
          progress: 0,
          duration: Math.max(0.05, TAIL_ADD_SMOOTH_MS / 1000),
          carryDistance: lastTailTotalLengths.get(player.id) ?? 0,
          carryExtra: lastTailExtensionDistances.get(player.id) ?? 0,
          startPos: null,
        })
        if (debug) {
          console.log(
            `[TAIL_DEBUG] ${player.id} length_increase ${prevLength} -> ${nodes.length} max_digestion=${maxDigestion.toFixed(
              3,
            )}`,
          )
        }
      } else if (nodes.length < prevLength) {
        tailAddStates.delete(player.id)
        tailGrowthStates.delete(player.id)
        if (debug) {
          console.log(
            `[TAIL_DEBUG] ${player.id} length_decrease ${prevLength} -> ${nodes.length}`,
          )
        }
      }
    }
    lastSnakeLengths.set(player.id, nodes.length)
    const digestionState = buildDigestionVisuals(player.digestions)
    const targetTailGrowth = digestionState.tailGrowth
    const previousGrowth = tailGrowthStates.get(player.id)
    let smoothedTailGrowth = targetTailGrowth
    if (previousGrowth !== undefined && targetTailGrowth < previousGrowth) {
      smoothedTailGrowth = smoothValue(
        previousGrowth,
        targetTailGrowth,
        deltaSeconds,
        TAIL_GROWTH_RATE_UP,
        TAIL_GROWTH_RATE_DOWN,
      )
    }
    if (targetTailGrowth > 0) {
      smoothedTailGrowth = Math.max(previousGrowth ?? 0, smoothedTailGrowth)
    }
    tailGrowthStates.set(player.id, smoothedTailGrowth)
    const radius = isLocal ? SNAKE_RADIUS * 1.1 : SNAKE_RADIUS
    const centerlineRadius = PLANET_RADIUS + radius * SNAKE_LIFT_FACTOR
    let tailCurveTail: THREE.Vector3 | null = null
    let tailCurvePrev: THREE.Vector3 | null = null
    let tailExtendDistance = 0
    let tailAddProgress = 0
    let tailBasisPrev: THREE.Vector3 | null = null
    let tailBasisTail: THREE.Vector3 | null = null
    let tailSegmentLength = 0
    let tailSegmentDir: THREE.Vector3 | null = null
    let tailDirMinLen = 0
    let tailExtraTarget = 0
    let tailExtensionDistance = 0
    let tailDirDebug: THREE.Vector3 | null = null
    let tailSegDirDebug: THREE.Vector3 | null = null
    let tailDirAngle = 0
    let tailExtendOverride: THREE.Vector3 | null = null
    if (nodes.length < 2) {
      visual.tube.visible = false
      visual.tail.visible = false
    } else {
      visual.tube.visible = true
      visual.tail.visible = true
      const curvePoints = nodes.map((node) => pointToVector(node, centerlineRadius))
      const tailAddState = tailAddStates.get(player.id)
      if (tailAddState && curvePoints.length >= 2) {
        tailAddState.progress = clamp(
          tailAddState.progress + deltaSeconds / tailAddState.duration,
          0,
          1,
        )
        tailAddProgress = tailAddState.progress
        const fallbackStart = curvePoints[curvePoints.length - 2]
        const end = curvePoints[curvePoints.length - 1]
        let referenceDir: THREE.Vector3 | null = null
        let referenceDistance = fallbackStart.distanceTo(end)
        if (curvePoints.length >= 3) {
          const prev = curvePoints[curvePoints.length - 3]
          const startNormal = fallbackStart.clone().normalize()
          const rawDir = fallbackStart.clone().sub(prev)
          rawDir.addScaledVector(startNormal, -rawDir.dot(startNormal))
          if (rawDir.lengthSq() > 1e-8) {
            referenceDistance = rawDir.length()
            referenceDir = rawDir.multiplyScalar(1 / referenceDistance)
          }
        }
        if (!tailAddState.startPos) {
          tailAddState.startPos = fallbackStart.clone()
        }
        let start = tailAddState.startPos
        if (!start) {
          start = end
        }
        start = start.clone().normalize().multiplyScalar(centerlineRadius)

        let blendedEnd = end
        if (referenceDir && referenceDistance > 1e-6) {
          const syntheticEnd = advanceOnSphere(
            start,
            referenceDir,
            referenceDistance,
            centerlineRadius,
          )
          const alignBlend = clamp((tailAddState.progress - 0.35) / 0.35, 0, 1)
          blendedEnd = slerpOnSphere(syntheticEnd, end, alignBlend, centerlineRadius)
        }

        curvePoints[curvePoints.length - 1] = slerpOnSphere(
          start,
          blendedEnd,
          tailAddState.progress,
          centerlineRadius,
        )
        if (tailAddState.progress >= 1) {
          tailAddStates.delete(player.id)
        }
        if (curvePoints.length >= 3) {
          tailBasisPrev = curvePoints[curvePoints.length - 3]
          tailBasisTail = curvePoints[curvePoints.length - 2]
          if (tailBasisPrev.distanceToSquared(tailBasisTail) < 1e-6) {
            tailBasisPrev = null
            tailBasisTail = null
          }
        }
      }
      if (curvePoints.length >= 2) {
        const tailPos = curvePoints[curvePoints.length - 1]
        const prevPos = curvePoints[curvePoints.length - 2]
        tailSegmentLength = tailPos.distanceTo(prevPos)
        const tailNormal = tailPos.clone().normalize()
        const segmentDir = tailPos.clone().sub(prevPos)
        segmentDir.addScaledVector(tailNormal, -segmentDir.dot(tailNormal))
        if (segmentDir.lengthSq() > 1e-8) {
          tailSegmentDir = segmentDir.normalize()
        }
      }
      const referenceLength =
        tailBasisPrev && tailBasisTail
          ? tailBasisTail.distanceTo(tailBasisPrev)
          : tailSegmentLength
      tailDirMinLen = Number.isFinite(referenceLength)
        ? Math.max(0, referenceLength * TAIL_DIR_MIN_RATIO)
        : 0
      const baseLength = tailSegmentLength
      const easedGrowth = Math.pow(clamp(smoothedTailGrowth, 0, 1), TAIL_GROWTH_EASE)
      const growthExtra = referenceLength * easedGrowth
      let extraLengthTarget = growthExtra
      let minExtraLength = 0
      if (tailAddState) {
        const carryDistance = Number.isFinite(tailAddState.carryDistance)
          ? tailAddState.carryDistance
          : lastTailTotalLengths.get(player.id) ?? baseLength
        tailAddState.carryDistance = carryDistance
        minExtraLength = Math.max(0, carryDistance - baseLength)
        extraLengthTarget = minExtraLength + growthExtra
      }
      const extraTargetClamped = Math.max(0, extraLengthTarget)
      let extensionDistance = extraTargetClamped
      const previousExtension = lastTailExtensionDistances.get(player.id)
      const seedOverride = lengthIncreased ? extraTargetClamped : null
      const extraState = tailExtraStates.get(player.id)
      if (extraState) {
        const seed = seedOverride ?? previousExtension ?? extraState.value ?? extraTargetClamped
        extraState.value = seed
        const rateUp = tailAddState ? TAIL_EXTEND_RATE_UP_ADD : TAIL_EXTEND_RATE_UP
        const rateDown = tailAddState ? TAIL_EXTEND_RATE_DOWN_ADD : TAIL_EXTEND_RATE_DOWN
        extensionDistance = smoothValue(
          extraState.value,
          extraTargetClamped,
          deltaSeconds,
          rateUp,
          rateDown,
        )
        if (!Number.isFinite(extensionDistance)) {
          extensionDistance = extraTargetClamped
        }
        extraState.value = extensionDistance
      } else {
        const seed = seedOverride ?? previousExtension ?? extraTargetClamped
        const rateUp = tailAddState ? TAIL_EXTEND_RATE_UP_ADD : TAIL_EXTEND_RATE_UP
        const rateDown = tailAddState ? TAIL_EXTEND_RATE_DOWN_ADD : TAIL_EXTEND_RATE_DOWN
        extensionDistance = smoothValue(seed, extraTargetClamped, deltaSeconds, rateUp, rateDown)
        if (!Number.isFinite(extensionDistance)) {
          extensionDistance = extraTargetClamped
        }
        tailExtraStates.set(player.id, { value: extensionDistance })
      }
      if (tailAddState) {
        extensionDistance = Math.min(extensionDistance, extraTargetClamped)
        extensionDistance = Math.max(extensionDistance, minExtraLength)
        const clampState = tailExtraStates.get(player.id)
        if (clampState) {
          clampState.value = extensionDistance
        }
      }
      const prevExtension = lastTailExtensionDistances.get(player.id)
      if (prevExtension !== undefined) {
        const maxGrow =
          (tailAddState ? TAIL_EXTEND_MAX_GROW_SPEED_ADD : TAIL_EXTEND_MAX_GROW_SPEED) *
          deltaSeconds
        const maxShrink =
          (tailAddState
            ? TAIL_EXTEND_MAX_SHRINK_SPEED_ADD
            : TAIL_EXTEND_MAX_SHRINK_SPEED) * deltaSeconds
        extensionDistance = clamp(
          extensionDistance,
          prevExtension - maxShrink,
          prevExtension + maxGrow,
        )
        const limitedState = tailExtraStates.get(player.id)
        if (limitedState) {
          limitedState.value = extensionDistance
        }
      }
      extensionDistance = Math.min(extensionDistance, extraTargetClamped)
      if (seedOverride !== null) {
        lastTailExtensionDistances.set(player.id, extensionDistance)
      }
      tailExtraTarget = extraTargetClamped
      tailExtensionDistance = extensionDistance
      lastTailExtensionDistances.set(player.id, extensionDistance)
      const extendDir = computeTailExtendDirection(curvePoints, tailDirMinLen)
      if (extendDir) {
        tailExtendOverride = extendDir
      }
      if (debug && (extensionDistance > 0 || extraTargetClamped > 0 || tailAddState)) {
        tailDirDebug =
          tailExtendOverride ??
          tailSegmentDir ??
          computeTailDirection(
            curvePoints,
            centerlineRadius,
            tailBasisPrev,
            tailBasisTail,
            lastTailDirection,
            { preferFallbackBelow: tailDirMinLen },
          )
        if (curvePoints.length >= 2) {
          const tailPos = curvePoints[curvePoints.length - 1]
          const prevPos = curvePoints[curvePoints.length - 2]
          const tailNormal = tailPos.clone().normalize()
          tailSegDirDebug = tailPos.clone().sub(prevPos)
          tailSegDirDebug.addScaledVector(tailNormal, -tailSegDirDebug.dot(tailNormal))
          if (tailSegDirDebug.lengthSq() > 1e-8) {
            tailSegDirDebug.normalize()
          }
        }
        if (tailDirDebug && tailSegDirDebug && tailSegDirDebug.lengthSq() > 1e-8) {
          const dotValue = clamp(tailDirDebug.dot(tailSegDirDebug), -1, 1)
          tailDirAngle = Math.acos(dotValue)
        }
      }
      if (extensionDistance > 0) {
        const extendedTail = computeExtendedTailPoint(
          curvePoints,
          extensionDistance,
          centerlineRadius,
          tailBasisPrev,
          tailBasisTail,
          lastTailDirection,
          tailDirMinLen,
          tailExtendOverride,
        )
        if (extendedTail) {
          curvePoints[curvePoints.length - 1] = extendedTail
          const prevPos = curvePoints[curvePoints.length - 2]
          tailSegmentLength = extendedTail.distanceTo(prevPos)
        }
      }
      if (curvePoints.length >= 2) {
        tailCurvePrev = curvePoints[curvePoints.length - 2]
        tailCurveTail = curvePoints[curvePoints.length - 1]
        tailExtendDistance = tailCurveTail.distanceTo(tailCurvePrev)
        lastTailTotalLengths.set(player.id, baseLength + extensionDistance)
        lastTailBasePositions.set(player.id, tailCurveTail.clone())
      }
      const baseCurve = new THREE.CatmullRomCurve3(curvePoints, false, 'centripetal')
      const curve = new SphericalCurve(baseCurve, centerlineRadius)
      const tubularSegments = Math.max(8, nodes.length * 4)
      const tubeGeometry = new THREE.TubeGeometry(curve, tubularSegments, radius, 10, false)
      if (digestionState.visuals.length) {
        applyDigestionBulges(tubeGeometry, digestionState.visuals)
      }
      visual.tube.geometry.dispose()
      visual.tube.geometry = tubeGeometry
    }

    if (nodes.length === 0) {
      visual.head.visible = false
      visual.eyeLeft.visible = false
      visual.eyeRight.visible = false
      visual.pupilLeft.visible = false
      visual.pupilRight.visible = false
      lastHeadPositions.delete(player.id)
      lastForwardDirections.delete(player.id)
      lastTailDirections.delete(player.id)
      lastSnakeLengths.delete(player.id)
      tailAddStates.delete(player.id)
      tailExtraStates.delete(player.id)
      lastTailBasePositions.delete(player.id)
      lastTailExtensionDistances.delete(player.id)
      lastTailTotalLengths.delete(player.id)
      tailGrowthStates.delete(player.id)
      tailDebugStates.delete(player.id)
      return
    }

    visual.head.visible = true
    visual.eyeLeft.visible = true
    visual.eyeRight.visible = true
    visual.pupilLeft.visible = true
    visual.pupilRight.visible = true

    if (debug) {
      const prevDebug = tailDebugStates.get(player.id)
      const extendActive = tailExtraTarget > 0 || tailExtensionDistance > 0
      const extBucket = extendActive ? Math.floor(tailExtensionDistance / 0.01) : -1
      const angleBucket =
        extendActive && Number.isFinite(tailDirAngle) ? Math.floor(tailDirAngle / 0.25) : -1
      const extendStarted = extendActive && (!prevDebug || !prevDebug.lastExtendActive)
      const extendEnded = !extendActive && !!prevDebug?.lastExtendActive
      const extendStep =
        extendActive &&
        (!prevDebug ||
          prevDebug.lastExtBucket !== extBucket ||
          prevDebug.lastDirAngleBucket !== angleBucket)

      if (extendStarted) {
        console.log(
          `[TAIL_DEBUG] ${player.id} tail_extend_start ` +
            `ext=${formatNum(tailExtensionDistance)} target=${formatNum(tailExtraTarget)} ` +
            `seg_len=${formatNum(tailSegmentLength)} add_prog=${formatNum(tailAddProgress, 3)} ` +
            `tail_growth=${formatNum(digestionState.tailGrowth, 3)}`,
        )
      }

      if (extendStep) {
        console.log(
          `[TAIL_DEBUG] ${player.id} tail_extend ` +
            `ext=${formatNum(tailExtensionDistance)} target=${formatNum(tailExtraTarget)} ` +
            `extend_len=${formatNum(tailExtendDistance)} seg_len=${formatNum(tailSegmentLength)} ` +
            `dir_angle=${formatNum(tailDirAngle, 3)}`,
        )
      }

      if (extendEnded) {
        console.log(`[TAIL_DEBUG] ${player.id} tail_extend_end`)
      }

      tailDebugStates.set(player.id, {
        lastExtendActive: extendActive,
        lastExtBucket: extBucket,
        lastDirAngleBucket: angleBucket,
      })
    }

    const headPoint = nodes[0]
    const headNormal = tempVector.set(headPoint.x, headPoint.y, headPoint.z).normalize()
    const headPosition = headNormal.clone().multiplyScalar(centerlineRadius)
    visual.head.position.copy(headPosition)

    let forward = tempVectorB
    let hasForward = false
    const lastHead = lastHeadPositions.get(player.id)
    const lastForward = lastForwardDirections.get(player.id)

    if (lastHead) {
      const delta = headPosition.clone().sub(lastHead)
      delta.addScaledVector(headNormal, -delta.dot(headNormal))
      if (delta.lengthSq() > 1e-8) {
        delta.normalize()
        forward.copy(delta)
        hasForward = true
        if (lastForward) {
          lastForward.copy(forward)
        } else {
          lastForwardDirections.set(player.id, forward.clone())
        }
      } else if (lastForward) {
        forward.copy(lastForward)
        hasForward = true
      }
    }

    if (!hasForward) {
      if (nodes.length > 1) {
        const nextPoint = pointToVector(nodes[1], centerlineRadius)
        forward = headPosition.clone().sub(nextPoint)
      } else {
        forward = new THREE.Vector3().crossVectors(headNormal, new THREE.Vector3(0, 1, 0))
      }
      if (forward.lengthSq() < 0.00001) {
        forward = new THREE.Vector3().crossVectors(headNormal, new THREE.Vector3(1, 0, 0))
      }
      forward.normalize()
    }

    const cachedHead = lastHeadPositions.get(player.id)
    if (cachedHead) {
      cachedHead.copy(headPosition)
    } else {
      lastHeadPositions.set(player.id, headPosition.clone())
    }

    const right = new THREE.Vector3().crossVectors(forward, headNormal)
    if (right.lengthSq() < 0.00001) {
      right.set(1, 0, 0)
    }
    right.normalize()

    const eyeOut = HEAD_RADIUS * 0.2
    const eyeForward = HEAD_RADIUS * 0.28
    const eyeSpacing = HEAD_RADIUS * 0.6

    const leftEyePosition = headPosition
      .clone()
      .addScaledVector(headNormal, eyeOut)
      .addScaledVector(forward, eyeForward)
      .addScaledVector(right, -eyeSpacing)
    const rightEyePosition = headPosition
      .clone()
      .addScaledVector(headNormal, eyeOut)
      .addScaledVector(forward, eyeForward)
      .addScaledVector(right, eyeSpacing)

    visual.eyeLeft.position.copy(leftEyePosition)
    visual.eyeRight.position.copy(rightEyePosition)

    const pupilForward = HEAD_RADIUS * 0.18
    visual.pupilLeft.position.copy(leftEyePosition).addScaledVector(forward, pupilForward)
    visual.pupilRight.position.copy(rightEyePosition).addScaledVector(forward, pupilForward)

    if (nodes.length > 1) {
      const tailPos = tailCurveTail ?? pointToVector(nodes[nodes.length - 1], centerlineRadius)
      const prevPos = tailCurvePrev ?? pointToVector(nodes[nodes.length - 2], centerlineRadius)
      const tailNormal = tailPos.clone().normalize()
      const tailDir = tailPos.clone().sub(prevPos)
      tailDir.addScaledVector(tailNormal, -tailDir.dot(tailNormal))
      if (tailDir.lengthSq() < 1e-8 || (tailDirMinLen > 0 && tailDir.length() < tailDirMinLen)) {
        if (lastTailDirection) {
          tailDir.copy(lastTailDirection)
        }
      }
      if (tailDir.lengthSq() < 1e-8) {
        tailDir.crossVectors(tailNormal, new THREE.Vector3(0, 1, 0))
        if (tailDir.lengthSq() < 1e-6) {
          tailDir.crossVectors(tailNormal, new THREE.Vector3(1, 0, 0))
        }
      }
      tailDir.normalize()
      if (lastTailDirection) {
        lastTailDirection.copy(tailDir)
      } else {
        lastTailDirections.set(player.id, tailDir.clone())
      }
      if (visual.tube.geometry instanceof THREE.TubeGeometry) {
        const capGeometry = buildTailCapGeometry(visual.tube.geometry, tailDir)
        if (capGeometry) {
          if (visual.tail.geometry !== tailGeometry) {
            visual.tail.geometry.dispose()
          }
          visual.tail.geometry = capGeometry
        }
      }
      visual.tail.position.set(0, 0, 0)
      visual.tail.quaternion.identity()
      visual.tail.scale.setScalar(1)
    }
  }

  const removeSnake = (visual: SnakeVisual, id: string) => {
    snakesGroup.remove(visual.group)
    visual.tube.geometry.dispose()
    if (visual.tail.geometry !== tailGeometry) {
      visual.tail.geometry.dispose()
    }
    visual.tube.material.dispose()
    visual.head.material.dispose()
    lastSnakeLengths.delete(id)
    lastTailDirections.delete(id)
    tailAddStates.delete(id)
    tailExtraStates.delete(id)
    lastTailBasePositions.delete(id)
    lastTailExtensionDistances.delete(id)
    lastTailTotalLengths.delete(id)
    tailGrowthStates.delete(id)
    tailDebugStates.delete(id)
  }

  const updateSnakes = (
    players: PlayerSnapshot[],
    localPlayerId: string | null,
    deltaSeconds: number,
  ) => {
    const activeIds = new Set<string>()
    for (const player of players) {
      activeIds.add(player.id)
      updateSnake(player, player.id === localPlayerId, deltaSeconds)
    }

    for (const [id, visual] of snakes) {
      if (!activeIds.has(id)) {
        removeSnake(visual, id)
        snakes.delete(id)
        lastHeadPositions.delete(id)
        lastForwardDirections.delete(id)
      }
    }
  }

  const updatePellets = (pellets: Point[]) => {
    const count = pellets.length
    if (!pelletMesh || pelletCapacity !== Math.max(count, 1)) {
      if (pelletMesh) {
        pelletsGroup.remove(pelletMesh)
      }
      pelletCapacity = Math.max(count, 1)
      pelletMesh = new THREE.InstancedMesh(pelletGeometry, pelletMaterial, pelletCapacity)
      pelletsGroup.add(pelletMesh)
    }

    if (!pelletMesh) return
    pelletMesh.count = count
    pelletMesh.visible = count > 0

    for (let i = 0; i < count; i += 1) {
      const pellet = pellets[i]
      tempVector.set(pellet.x, pellet.y, pellet.z).normalize().multiplyScalar(PLANET_RADIUS + PELLET_OFFSET)
      tempMatrix.makeTranslation(tempVector.x, tempVector.y, tempVector.z)
      pelletMesh.setMatrixAt(i, tempMatrix)
    }
    pelletMesh.instanceMatrix.needsUpdate = true
  }

  const render = (snapshot: GameStateSnapshot | null, cameraState: Camera, localPlayerId: string | null) => {
    const now = performance.now()
    const deltaSeconds = Math.min(0.1, Math.max(0, (now - lastFrameTime) / 1000))
    lastFrameTime = now

    if (cameraState.active) {
      world.quaternion.set(cameraState.q.x, cameraState.q.y, cameraState.q.z, cameraState.q.w)
    } else {
      world.quaternion.identity()
    }
    camera.updateMatrixWorld()

    let localHeadScreen: { x: number; y: number } | null = null

    if (snapshot) {
      updateSnakes(snapshot.players, localPlayerId, deltaSeconds)
      updatePellets(snapshot.pellets)

      if (localPlayerId) {
        const localPlayer = snapshot.players.find((player) => player.id === localPlayerId)
        const head = localPlayer?.snake[0]
        if (head) {
          const radius = SNAKE_RADIUS * 1.1
          const centerlineRadius = PLANET_RADIUS + radius * SNAKE_LIFT_FACTOR
          const headNormal = tempVectorC.set(head.x, head.y, head.z).normalize()
          const headPosition = headNormal.clone().multiplyScalar(centerlineRadius)
          headPosition.applyQuaternion(world.quaternion)
          headPosition.project(camera)

          const screenX = (headPosition.x * 0.5 + 0.5) * viewportWidth
          const screenY = (-headPosition.y * 0.5 + 0.5) * viewportHeight
          if (Number.isFinite(screenX) && Number.isFinite(screenY)) {
            localHeadScreen = { x: screenX, y: screenY }
          }
        }
      }
    } else {
      updateSnakes([], localPlayerId, deltaSeconds)
      updatePellets([])
    }

    renderer.render(scene, camera)
    return localHeadScreen
  }

  const resize = (width: number, height: number, dpr: number) => {
    viewportWidth = width
    viewportHeight = height
    renderer.setPixelRatio(dpr)
    renderer.setSize(width, height, false)
    camera.aspect = width / height
    camera.updateProjectionMatrix()
  }

  const dispose = () => {
    renderer.dispose()
    planetGeometry.dispose()
    planetMaterial.dispose()
    gridGeometry.dispose()
    gridMaterial.dispose()
    headGeometry.dispose()
    tailGeometry.dispose()
    eyeGeometry.dispose()
    pupilGeometry.dispose()
    eyeMaterial.dispose()
    pupilMaterial.dispose()
    pelletGeometry.dispose()
    pelletMaterial.dispose()
    if (pelletMesh) {
      pelletsGroup.remove(pelletMesh)
    }
    for (const [id, visual] of snakes) {
      removeSnake(visual, id)
    }
    snakes.clear()
  }

  return {
    resize,
    render,
    dispose,
  }
}
