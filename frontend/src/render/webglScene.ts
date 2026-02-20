import {
  createScene,
  type CreateRenderSceneResult,
  type DayNightDebugMode,
  type RendererBackend,
  type RenderScene,
  type WebGLScene,
} from './core/sceneRuntime'

export type {
  CreateRenderSceneResult,
  DayNightDebugMode,
  RendererBackend,
  RenderScene,
  WebGLScene,
}

export async function createRenderScene(canvas: HTMLCanvasElement): Promise<CreateRenderSceneResult> {
  const scene = await createScene(canvas)
  return { scene }
}
