import type { AppDebugApi, RegisterAppDebugApiOptions } from './types'

function getRootDebugApi(): AppDebugApi | null {
  if (typeof window === 'undefined') return null
  const debugWindow = window as Window & { __SNAKE_DEBUG__?: AppDebugApi }
  if (!debugWindow.__SNAKE_DEBUG__ || typeof debugWindow.__SNAKE_DEBUG__ !== 'object') {
    debugWindow.__SNAKE_DEBUG__ = {}
  }
  return debugWindow.__SNAKE_DEBUG__
}

export function registerAppDebugApi(options: RegisterAppDebugApiOptions): void {
  const rootDebugApi = getRootDebugApi()
  if (!rootDebugApi) return

  rootDebugApi.getMenuFlowInfo = () => ({ ...options.menuDebugInfoRef.current })
  rootDebugApi.getNetSmoothingInfo = () => ({ ...options.netDebugInfoRef.current })
  rootDebugApi.getNetTrafficInfo = () => ({
    rxBps: options.netRxBpsRef.current,
    rxTotalBytes: options.netRxTotalBytesRef.current,
    rxWindowBytes: options.netRxWindowBytesRef.current,
  })
  rootDebugApi.getMotionStabilityInfo = () => ({ ...options.motionDebugInfoRef.current })
  rootDebugApi.getNetLagEvents = () => options.netLagEventsRef.current.slice()
  rootDebugApi.getNetLagReport = () => options.buildNetLagReport()
  rootDebugApi.clearNetLagEvents = () => {
    options.clearNetLagEvents()
  }
  rootDebugApi.getTailGrowthEvents = () => options.tailGrowthEventsRef.current.slice()
  rootDebugApi.getTailGrowthReport = () => options.buildTailGrowthReport()
  rootDebugApi.clearTailGrowthEvents = () => {
    options.clearTailGrowthEvents()
  }
  rootDebugApi.getNetTuningOverrides = () => options.getNetTuningOverrides()
  rootDebugApi.getResolvedNetTuning = () => options.getResolvedNetTuning()
  rootDebugApi.setNetTuningOverrides = (overrides) => options.setNetTuningOverrides(overrides)
  rootDebugApi.resetNetTuningOverrides = () => options.resetNetTuningOverrides()
  rootDebugApi.getRafPerfInfo = () => options.getRafPerfInfo()
  rootDebugApi.clearRafPerf = () => {
    options.clearRafPerf()
  }
}
