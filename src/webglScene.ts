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

  const snakes = new Map<string, SnakeVisual>()
  const lastHeadPositions = new Map<string, THREE.Vector3>()
  const lastForwardDirections = new Map<string, THREE.Vector3>()
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

    const ringNormal = ringVectors[1 % radialSegments].clone().cross(ringVectors[0]).normalize()
    const flip = ringNormal.dot(tailDirection) < 0

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
          .addScaledVector(tailDirection, offset)
        const index = (s * radialSegments + i) * 3
        capPositions[index] = point.x
        capPositions[index + 1] = point.y
        capPositions[index + 2] = point.z
      }
    }

    const tip = center.clone().addScaledVector(tailDirection, radius)
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

  const updateSnake = (player: PlayerSnapshot, isLocal: boolean) => {
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
    const radius = isLocal ? SNAKE_RADIUS * 1.1 : SNAKE_RADIUS
    const centerlineRadius = PLANET_RADIUS + radius * SNAKE_LIFT_FACTOR
    if (nodes.length < 2) {
      visual.tube.visible = false
      visual.tail.visible = false
    } else {
      visual.tube.visible = true
      visual.tail.visible = true
      const curvePoints = nodes.map((node) => pointToVector(node, centerlineRadius))
      const baseCurve = new THREE.CatmullRomCurve3(curvePoints, false, 'centripetal')
      const curve = new SphericalCurve(baseCurve, centerlineRadius)
      const tubularSegments = Math.max(8, curvePoints.length * 4)
      const tubeGeometry = new THREE.TubeGeometry(curve, tubularSegments, radius, 10, false)
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
      return
    }

    visual.head.visible = true
    visual.eyeLeft.visible = true
    visual.eyeRight.visible = true
    visual.pupilLeft.visible = true
    visual.pupilRight.visible = true

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
      const tailIndex = nodes.length - 1
      const tailPos = pointToVector(nodes[tailIndex], centerlineRadius)
      const prevPos = pointToVector(nodes[tailIndex - 1], centerlineRadius)
      const tailDir = tailPos.clone().sub(prevPos)
      const tailNormal = tailPos.clone().normalize()
      tailDir.addScaledVector(tailNormal, -tailDir.dot(tailNormal))
      if (tailDir.lengthSq() < 1e-6) {
        tailDir.crossVectors(tailNormal, new THREE.Vector3(0, 1, 0))
        if (tailDir.lengthSq() < 1e-6) {
          tailDir.crossVectors(tailNormal, new THREE.Vector3(1, 0, 0))
        }
      }
      tailDir.normalize()
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

  const removeSnake = (visual: SnakeVisual) => {
    snakesGroup.remove(visual.group)
    visual.tube.geometry.dispose()
    if (visual.tail.geometry !== tailGeometry) {
      visual.tail.geometry.dispose()
    }
    visual.tube.material.dispose()
    visual.head.material.dispose()
  }

  const updateSnakes = (players: PlayerSnapshot[], localPlayerId: string | null) => {
    const activeIds = new Set<string>()
    for (const player of players) {
      activeIds.add(player.id)
      updateSnake(player, player.id === localPlayerId)
    }

    for (const [id, visual] of snakes) {
      if (!activeIds.has(id)) {
        removeSnake(visual)
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
    if (cameraState.active) {
      world.quaternion.set(cameraState.q.x, cameraState.q.y, cameraState.q.z, cameraState.q.w)
    } else {
      world.quaternion.identity()
    }
    camera.updateMatrixWorld()

    let localHeadScreen: { x: number; y: number } | null = null

    if (snapshot) {
      updateSnakes(snapshot.players, localPlayerId)
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
      updateSnakes([], localPlayerId)
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
    for (const visual of snakes.values()) {
      removeSnake(visual)
    }
    snakes.clear()
  }

  return {
    resize,
    render,
    dispose,
  }
}
