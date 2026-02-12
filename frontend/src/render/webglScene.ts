import {
  createScene,
  type CreateRenderSceneResult,
  type DayNightDebugMode,
  type RendererBackend,
  type RendererPreference,
  type RenderScene,
  type WebGLScene,
} from './core/sceneRuntime'
import { formatRendererError, hasWebGpuSupport } from './core/rendererSupport'

export type {
  CreateRenderSceneResult,
  DayNightDebugMode,
  RendererBackend,
  RendererPreference,
  RenderScene,
  WebGLScene,
}

export async function createRenderScene(
  canvas: HTMLCanvasElement,
  requestedBackend: RendererPreference = 'auto',
): Promise<CreateRenderSceneResult> {
  if (requestedBackend === 'webgl') {
    const scene = await createScene(canvas, requestedBackend, 'webgl', null)
    return {
      scene,
      activeBackend: 'webgl',
      fallbackReason: null,
    }
  }

  if (!(await hasWebGpuSupport())) {
    const fallbackReason = 'WebGPU is unavailable in this browser/runtime'
    const scene = await createScene(canvas, requestedBackend, 'webgl', fallbackReason)
    return {
      scene,
      activeBackend: 'webgl',
      fallbackReason,
    }
  }

  try {
    const scene = await createScene(canvas, requestedBackend, 'webgpu', null)
    return {
      scene,
      activeBackend: 'webgpu',
      fallbackReason: null,
    }
  } catch (error) {
    const fallbackReason = formatRendererError(error)
    const scene = await createScene(canvas, requestedBackend, 'webgl', fallbackReason)
    return {
      scene,
      activeBackend: 'webgl',
      fallbackReason,
    }
  }
}
