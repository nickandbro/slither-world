import { formatRendererError as sharedFormatRendererError } from '@shared/render/errors'

export const formatRendererError = (error: unknown) =>
  sharedFormatRendererError(error, 'WebGPU initialization failed')

export const hasWebGpuSupport = async () => {
  if (typeof navigator === 'undefined') return false
  const nav = navigator as Navigator & {
    gpu?: {
      requestAdapter?: () => Promise<unknown>
    }
  }
  if (!nav.gpu || typeof nav.gpu.requestAdapter !== 'function') {
    return false
  }
  try {
    const adapter = await nav.gpu.requestAdapter()
    return !!adapter
  } catch {
    return false
  }
}
