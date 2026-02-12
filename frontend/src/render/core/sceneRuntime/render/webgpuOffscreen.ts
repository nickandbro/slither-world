import * as THREE from 'three'

export type WebgpuOffscreenSetup = {
  worldTarget: THREE.RenderTarget | null
  worldSamples: number
  presentScene: THREE.Scene | null
  presentCamera: THREE.OrthographicCamera | null
  presentMaterial: THREE.MeshBasicMaterial | null
  presentQuad: THREE.Mesh | null
}

export const createWebgpuWorldTarget = (samples: number) => {
  const target = new THREE.RenderTarget(1, 1, {
    depthBuffer: true,
    stencilBuffer: false,
    samples,
    colorSpace: THREE.LinearSRGBColorSpace,
  })
  target.texture.name = 'snake_world_target'
  target.texture.colorSpace = THREE.LinearSRGBColorSpace
  return target
}

export const createWebgpuOffscreenSetup = (enabled: boolean): WebgpuOffscreenSetup => {
  if (!enabled) {
    return {
      worldTarget: null,
      worldSamples: 4,
      presentScene: null,
      presentCamera: null,
      presentMaterial: null,
      presentQuad: null,
    }
  }

  const worldSamples = 4
  const worldTarget = createWebgpuWorldTarget(worldSamples)
  const presentScene = new THREE.Scene()
  const presentCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10)
  presentCamera.position.z = 1
  const presentMaterial = new THREE.MeshBasicMaterial({
    map: worldTarget.texture,
    toneMapped: false,
    depthTest: false,
    depthWrite: false,
    transparent: true,
    blending: THREE.NoBlending,
  })
  const presentGeometry = new THREE.PlaneGeometry(2, 2)
  const presentUv = presentGeometry.getAttribute('uv')
  if (presentUv instanceof THREE.BufferAttribute) {
    for (let i = 0; i < presentUv.count; i += 1) {
      presentUv.setY(i, 1 - presentUv.getY(i))
    }
    presentUv.needsUpdate = true
  }
  const presentQuad = new THREE.Mesh(presentGeometry, presentMaterial)
  presentQuad.frustumCulled = false
  presentScene.add(presentQuad)
  return {
    worldTarget,
    worldSamples,
    presentScene,
    presentCamera,
    presentMaterial,
    presentQuad,
  }
}
