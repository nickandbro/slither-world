import * as THREE from 'three'
import { clamp } from '../utils/math'

type SkinTexture = {
  key: string
  texture: THREE.CanvasTexture
  primary: string
}

type TailCapBuilder = (
  tubeGeometry: THREE.TubeGeometry,
  tailDirection: THREE.Vector3,
) => THREE.BufferGeometry | null

type ApplySkinUvs = (
  geometry: THREE.TubeGeometry,
  headStartOffset: number,
  snakeTotalLen: number,
) => void

type GetSkinTexture = (primaryColor: string, skinColors?: string[] | null) => SkinTexture

export type MenuPreviewOverlay = {
  scene: THREE.Scene
  camera: THREE.PerspectiveCamera
  group: THREE.Group
  setVisible: (visible: boolean) => void
  setSkin: (colors: string[] | null, previewLen?: number) => void
  setOrbit: (yaw: number, pitch: number) => void
  isVisible: () => boolean
  applyRenderRotation: () => void
  resize: (width: number, aspect: number) => void
  dispose: () => void
}

export const createMenuPreviewOverlay = ({
  headGeometry,
  snakeRadius,
  snakeTubeRadialSegments,
  getSkinTexture,
  applySnakeSkinUVs,
  buildTailCapGeometry,
}: {
  headGeometry: THREE.BufferGeometry
  snakeRadius: number
  snakeTubeRadialSegments: number
  getSkinTexture: GetSkinTexture
  applySnakeSkinUVs: ApplySkinUvs
  buildTailCapGeometry: TailCapBuilder
}): MenuPreviewOverlay => {
  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 20)
  camera.position.set(0, 0, 2.65)
  scene.add(camera)

  const ambient = new THREE.AmbientLight(0xffffff, 0.85)
  const keyLight = new THREE.DirectionalLight(0xffffff, 0.92)
  keyLight.position.set(2, 3, 4)
  const rimLight = new THREE.DirectionalLight(0x9bd7ff, 0.35)
  rimLight.position.set(-2, -1, 2)
  camera.add(ambient)
  camera.add(keyLight)
  camera.add(rimLight)

  const group = new THREE.Group()
  scene.add(group)
  group.visible = false
  group.position.set(0, 0.1, 0)

  const material = new THREE.MeshStandardMaterial({
    color: '#ffffff',
    roughness: 0.35,
    metalness: 0.1,
    flatShading: false,
    transparent: true,
    opacity: 1,
  })
  material.emissive = new THREE.Color('#ffffff')
  material.emissiveIntensity = 0.22

  const seedSkin = getSkinTexture('#ffffff', ['#ffffff'])
  material.map = seedSkin.texture
  material.emissiveMap = seedSkin.texture

  const tube = new THREE.Mesh(new THREE.BufferGeometry(), material)
  const tail = new THREE.Mesh(new THREE.BufferGeometry(), material)
  const headMaterial = new THREE.MeshStandardMaterial({
    color: seedSkin.primary,
    roughness: 0.25,
    metalness: 0.1,
    transparent: true,
    opacity: 1,
  })
  headMaterial.emissive = new THREE.Color(seedSkin.primary)
  headMaterial.emissiveIntensity = 0.12
  const head = new THREE.Mesh(headGeometry, headMaterial)
  group.add(tube)
  group.add(tail)
  group.add(head)

  let visible = false
  let skinKey = seedSkin.key
  let previewLen = 8
  let geometryReady = false
  let yaw = -0.35
  let pitch = 0.08

  const rebuildGeometry = (nextLen: number) => {
    const len = clamp(Math.floor(nextLen), 1, 8)
    const pointCount = Math.max(2, len)
    const points: THREE.Vector3[] = []
    const spacing = 0.21
    const half = (pointCount - 1) * 0.5
    for (let i = 0; i < pointCount; i += 1) {
      const t = pointCount > 1 ? i / (pointCount - 1) : 0
      const x = (i - half) * spacing
      const y = Math.sin(i * 0.85) * 0.07
      const z = Math.cos(t * Math.PI * 1.1) * 0.06
      points.push(new THREE.Vector3(x, y, z))
    }
    const curve = new THREE.CatmullRomCurve3(points, false, 'centripetal')
    const tubularSegments = Math.max(32, pointCount * 22)
    const radius = snakeRadius * 1.25
    const tubeGeometry = new THREE.TubeGeometry(
      curve,
      tubularSegments,
      radius,
      snakeTubeRadialSegments,
      false,
    )

    applySnakeSkinUVs(tubeGeometry, 0, len)

    const prevPoint = points[points.length - 2] ?? points[0]
    const tailPoint = points[points.length - 1] ?? points[0]
    const tailDir = tailPoint.clone().sub(prevPoint)
    if (tailDir.lengthSq() > 1e-8) tailDir.normalize()
    const capGeometry = buildTailCapGeometry(tubeGeometry, tailDir) ?? null

    const oldTube = tube.geometry
    const oldTail = tail.geometry
    tube.geometry = tubeGeometry
    if (capGeometry) {
      tail.geometry = capGeometry
    } else {
      tail.geometry = new THREE.BufferGeometry()
    }

    const headPoint = points[0] ?? null
    if (headPoint) {
      head.position.copy(headPoint)
    } else {
      head.position.set(0, 0, 0)
    }
    oldTube.dispose()
    oldTail.dispose()
    geometryReady = true
  }

  const setVisible = (nextVisible: boolean) => {
    visible = nextVisible
    group.visible = nextVisible
  }

  const setSkin = (colors: string[] | null, nextPreviewLen?: number) => {
    const safeLen = typeof nextPreviewLen === 'number' ? nextPreviewLen : previewLen
    const list = colors && colors.length ? colors : ['#ffffff']
    const primary = list[0] ?? '#ffffff'
    const skin = getSkinTexture(primary, list)
    if (skin.key !== skinKey) {
      skinKey = skin.key
      material.map = skin.texture
      material.emissiveMap = skin.texture
      material.needsUpdate = true
    }
    headMaterial.color.set(skin.primary)
    headMaterial.emissive.set(skin.primary)
    const clampedLen = clamp(Math.floor(safeLen), 1, 8)
    if (!geometryReady || clampedLen !== previewLen) {
      previewLen = clampedLen
      rebuildGeometry(previewLen)
    }
  }

  const setOrbit = (nextYaw: number, nextPitch: number) => {
    if (!Number.isFinite(nextYaw) || !Number.isFinite(nextPitch)) return
    yaw = nextYaw
    pitch = clamp(nextPitch, -1.25, 1.25)
  }

  const applyRenderRotation = () => {
    group.rotation.set(pitch, yaw, 0)
  }

  const isVisible = () => visible && group.visible

  const resize = (width: number, aspect: number) => {
    camera.aspect = aspect
    camera.updateProjectionMatrix()
    // Keep the preview clear of the right-side skin UI panels on wide layouts.
    group.position.x = width > 920 ? -0.65 : 0
  }

  const dispose = () => {
    material.dispose()
    headMaterial.dispose()
    tube.geometry.dispose()
    tail.geometry.dispose()
  }

  return {
    scene,
    camera,
    group,
    setVisible,
    setSkin,
    setOrbit,
    isVisible,
    applyRenderRotation,
    resize,
    dispose,
  }
}
