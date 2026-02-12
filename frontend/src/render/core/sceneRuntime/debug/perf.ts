export type RenderPerfFrame = {
  tMs: number
  totalMs: number
  setupMs: number
  snakesMs: number
  pelletsMs: number
  visibilityMs: number
  waterMs: number
  passWorldMs: number
  passOccludersMs: number
  passPelletsMs: number
  passDepthRebuildMs: number
  passLakesMs: number
}

export type RenderPerfInfo = {
  enabled: boolean
  thresholdMs: number
  frameCount: number
  slowFrameCount: number
  maxTotalMs: number
  lastFrame: RenderPerfFrame | null
  slowFrames: RenderPerfFrame[]
}

export const cloneRenderPerfInfo = (
  perfInfo: RenderPerfInfo,
): RenderPerfInfo => ({
  ...perfInfo,
  lastFrame: perfInfo.lastFrame ? { ...perfInfo.lastFrame } : null,
  slowFrames: perfInfo.slowFrames.map((frame) => ({ ...frame })),
})
