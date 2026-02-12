import * as THREE from 'three'
import { WebGPURenderer } from 'three/webgpu'

export type RuntimeRendererBackend = 'webgl' | 'webgpu'

export const createRenderer = async (
  canvas: HTMLCanvasElement,
  backend: RuntimeRendererBackend,
): Promise<THREE.WebGLRenderer | WebGPURenderer> => {
  if (backend === 'webgpu') {
    const renderer = new WebGPURenderer({
      canvas,
      antialias: true,
      alpha: true,
    })
    renderer.outputColorSpace = THREE.SRGBColorSpace
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.toneMappingExposure = 1.05
    renderer.setClearColor(0x000000, 0)
    await renderer.init()
    return renderer
  }

  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: true,
  })
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 1.05
  renderer.setClearColor(0x000000, 0)
  return renderer
}
