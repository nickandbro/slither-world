import { useEffect, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'
import type { Camera, Environment, GameStateSnapshot, Point } from '@game/types'
import type { RenderConfig } from '@game/hud'
import {
  createRenderScene,
  type DayNightDebugMode,
  type RenderScene,
  type RendererBackend,
  type RendererPreference,
} from '@render/webglScene'
import { updateCamera } from '@game/camera'
import { clamp, normalize } from '@game/math'
import { drawHud } from '@game/hud'
import {
  DEATH_TO_MENU_DELAY_MS,
  MENU_CAMERA_DISTANCE,
  MENU_CAMERA_VERTICAL_OFFSET,
  MENU_TO_GAMEPLAY_BLEND_MS,
  MOTION_BACKWARD_DOT_THRESHOLD,
  type NetTuning,
  type NetTuningOverrides,
} from '@app/core/constants'
import {
  MENU_CAMERA,
  MENU_CAMERA_TARGET,
  easeInOutCubic,
  slerpQuaternion,
  type MenuFlowDebugInfo,
  type MenuPhase,
} from '@app/core/menuCamera'
import { formatRendererError } from '@app/core/renderMath'
import { resetBoostFx, updateBoostFx, type BoostFxState } from '@app/core/boostFx'
import type { ScoreRadialVisualState } from '@app/core/scoreRadial'
import {
  updateAdaptiveQuality,
  type AdaptiveQualityState,
} from '@app/orchestration/rendererLifecycle'
import {
  TAIL_RENDER_SAMPLE_INTERVAL_MS,
  computeTailEndMetrics,
  digestionMaxProgress,
} from '@app/orchestration/tailGrowthDebug'
import { updateScoreRadialController } from '@app/orchestration/scoreRadialController'
import type {
  LagSpikeCause,
  MotionStabilityDebugInfo,
  NetLagEvent,
  NetSmoothingDebugInfo,
  RafPerfInfo,
  TailEndSample,
  TailGrowthEvent,
  TailGrowthEventInput,
} from '@app/debug/types'

type MenuUiMode = 'home' | 'skin' | 'builder'

type DebugFlags = {
  mountainOutline: boolean
  lakeCollider: boolean
  treeCollider: boolean
  terrainTessellation: boolean
}

type UseRendererSceneRuntimeOptions = {
  rendererPreference: RendererPreference
  glCanvasRef: MutableRefObject<HTMLCanvasElement | null>
  hudCanvasRef: MutableRefObject<HTMLCanvasElement | null>
  boostFxRef: MutableRefObject<HTMLDivElement | null>
  boostFxStateRef: MutableRefObject<BoostFxState>
  webglRef: MutableRefObject<RenderScene | null>
  renderConfigRef: MutableRefObject<RenderConfig | null>
  headScreenRef: MutableRefObject<{ x: number; y: number } | null>
  localSnakeDisplayRef: MutableRefObject<Point[] | null>
  lastRenderFrameMsRef: MutableRefObject<number | null>
  setActiveRenderer: Dispatch<SetStateAction<RendererBackend | null>>
  setRendererFallbackReason: Dispatch<SetStateAction<string | null>>
  environmentRef: MutableRefObject<Environment | null>
  debugFlagsRef: MutableRefObject<DebugFlags>
  dayNightDebugModeRef: MutableRefObject<DayNightDebugMode>
  adaptiveQualityRef: MutableRefObject<AdaptiveQualityState>
  syncPelletConsumeTargetsToRenderer: () => void
  handleWheel: (event: WheelEvent) => void
  rafPerfRef: MutableRefObject<RafPerfInfo>
  playerIdRef: MutableRefObject<string | null>
  getRenderSnapshot: () => GameStateSnapshot | null
  stabilizeLocalSnapshot: (
    snapshot: GameStateSnapshot | null,
    localId: string | null,
    frameDeltaSeconds: number,
  ) => GameStateSnapshot | null
  tailDebugEnabled: boolean
  lastTailRenderSampleAtMsRef: MutableRefObject<number | null>
  lastTailEndSampleRef: MutableRefObject<TailEndSample | null>
  pointerRef: MutableRefObject<{
    boost: boolean
    active: boolean
    screenX: number
    screenY: number
  }>
  appendTailGrowthEvent: (event: TailGrowthEventInput) => void
  cameraUpRef: MutableRefObject<Point>
  menuPhaseRef: MutableRefObject<MenuPhase>
  motionDebugInfoRef: MutableRefObject<MotionStabilityDebugInfo>
  lastHeadSampleRef: MutableRefObject<Point | null>
  netTuningRef: MutableRefObject<NetTuning>
  lagSpikeActiveRef: MutableRefObject<boolean>
  lagSpikeCauseRef: MutableRefObject<LagSpikeCause>
  lagCameraRecoveryStartMsRef: MutableRefObject<number | null>
  lagCameraHoldActiveRef: MutableRefObject<boolean>
  lagCameraHoldQRef: MutableRefObject<Camera['q']>
  lagCameraRecoveryFromQRef: MutableRefObject<Camera['q']>
  stableGameplayCameraRef: MutableRefObject<Camera>
  localLifeSpawnedRef: MutableRefObject<boolean>
  deathStartedAtMsRef: MutableRefObject<number | null>
  clearBoostInputs: () => void
  socketRef: MutableRefObject<WebSocket | null>
  sendJoin: (socket: WebSocket, deferSpawn?: boolean) => void
  returnFromCameraQRef: MutableRefObject<Camera['q']>
  renderCameraDistanceRef: MutableRefObject<number>
  renderCameraVerticalOffsetRef: MutableRefObject<number>
  cameraDistanceRef: MutableRefObject<number>
  returnFromDistanceRef: MutableRefObject<number>
  returnFromVerticalOffsetRef: MutableRefObject<number>
  returnBlendStartMsRef: MutableRefObject<number | null>
  returnToMenuCommittedRef: MutableRefObject<boolean>
  allowPreplayAutoResumeRef: MutableRefObject<boolean>
  setShowPlayAgain: Dispatch<SetStateAction<boolean>>
  setMenuPhase: Dispatch<SetStateAction<MenuPhase>>
  cameraBlendRef: MutableRefObject<number>
  cameraBlendStartMsRef: MutableRefObject<number | null>
  cameraRef: MutableRefObject<Camera>
  localHeadRef: MutableRefObject<Point | null>
  inputEnabledRef: MutableRefObject<boolean>
  menuUiModeRef: MutableRefObject<MenuUiMode>
  menuOverlayExitingRef: MutableRefObject<boolean>
  builderPatternRef: MutableRefObject<Array<string | null>>
  builderPaletteColorRef: MutableRefObject<string>
  joinSkinColorsRef: MutableRefObject<string[]>
  scoreRadialStateRef: MutableRefObject<ScoreRadialVisualState>
  menuDebugInfoRef: MutableRefObject<MenuFlowDebugInfo>
  netDebugEnabled: boolean
  netDebugInfoRef: MutableRefObject<NetSmoothingDebugInfo>
  appendNetLagEvent: (
    type: NetLagEvent['type'],
    message: string,
    extras?: Partial<Pick<NetLagEvent, 'droppedSeq' | 'seqGapSize'>>,
  ) => void
  lastNetSummaryLogMsRef: MutableRefObject<number>
  netRxBpsRef: MutableRefObject<number>
  netRxTotalBytesRef: MutableRefObject<number>
  buildNetLagReport: () => unknown
  applyNetTuningOverrides: (
    incoming: NetTuningOverrides | null | undefined,
    options?: { announce?: boolean },
  ) => {
    revision: number
    overrides: NetTuningOverrides
    resolved: NetTuning
  }
}

export function useRendererSceneRuntime(options: UseRendererSceneRuntimeOptions) {
  const {
    rendererPreference,
    glCanvasRef,
    hudCanvasRef,
    boostFxRef,
    boostFxStateRef,
    webglRef,
    renderConfigRef,
    headScreenRef,
    localSnakeDisplayRef,
    lastRenderFrameMsRef,
    setActiveRenderer,
    setRendererFallbackReason,
    environmentRef,
    debugFlagsRef,
    dayNightDebugModeRef,
    adaptiveQualityRef,
    syncPelletConsumeTargetsToRenderer,
    handleWheel,
    rafPerfRef,
    playerIdRef,
    getRenderSnapshot,
    stabilizeLocalSnapshot,
    tailDebugEnabled,
    lastTailRenderSampleAtMsRef,
    lastTailEndSampleRef,
    pointerRef,
    appendTailGrowthEvent,
    cameraUpRef,
    menuPhaseRef,
    motionDebugInfoRef,
    lastHeadSampleRef,
    netTuningRef,
    lagSpikeActiveRef,
    lagSpikeCauseRef,
    lagCameraRecoveryStartMsRef,
    lagCameraHoldActiveRef,
    lagCameraHoldQRef,
    lagCameraRecoveryFromQRef,
    stableGameplayCameraRef,
    localLifeSpawnedRef,
    deathStartedAtMsRef,
    clearBoostInputs,
    socketRef,
    sendJoin,
    returnFromCameraQRef,
    renderCameraDistanceRef,
    renderCameraVerticalOffsetRef,
    cameraDistanceRef,
    returnFromDistanceRef,
    returnFromVerticalOffsetRef,
    returnBlendStartMsRef,
    returnToMenuCommittedRef,
    allowPreplayAutoResumeRef,
    setShowPlayAgain,
    setMenuPhase,
    cameraBlendRef,
    cameraBlendStartMsRef,
    cameraRef,
    localHeadRef,
    inputEnabledRef,
    menuUiModeRef,
    menuOverlayExitingRef,
    builderPatternRef,
    builderPaletteColorRef,
    joinSkinColorsRef,
    scoreRadialStateRef,
    menuDebugInfoRef,
    netDebugEnabled,
    netDebugInfoRef,
    appendNetLagEvent,
    lastNetSummaryLogMsRef,
    netRxBpsRef,
    netRxTotalBytesRef,
    buildNetLagReport,
    applyNetTuningOverrides,
  } = options

  const RAF_SLOW_FRAMES_MAX = 24

  const resetBoostFxVisual = () => {
    resetBoostFx(boostFxRef.current, boostFxStateRef.current)
  }

  const updateBoostFxVisual = (boostActive: boolean) => {
    updateBoostFx(boostFxRef.current, boostFxStateRef.current, boostActive)
  }
  useEffect(() => {
    const glCanvas = glCanvasRef.current
    const hudCanvas = hudCanvasRef.current
    if (!glCanvas || !hudCanvas) return
    const hudCtx = hudCanvas.getContext('2d')
    if (!hudCtx) return
    setActiveRenderer(null)
    setRendererFallbackReason(null)

    let disposed = false
    let webgl: RenderScene | null = null
    let observer: ResizeObserver | null = null
    let updateConfig: (() => void) | null = null
    let frameId = 0

    const setupScene = async () => {
      try {
        resetBoostFxVisual()
        const created = await createRenderScene(glCanvas, rendererPreference)
        if (disposed) {
          created.scene.dispose()
          return
        }
        webgl = created.scene
        webglRef.current = webgl
        setActiveRenderer(created.activeBackend)
        setRendererFallbackReason(created.fallbackReason)

        if (environmentRef.current) {
        webgl.setEnvironment?.(environmentRef.current)
        }
        webgl.setDebugFlags?.(debugFlagsRef.current)
        webgl.setDayNightDebugMode?.(dayNightDebugModeRef.current)
        webgl.setWebgpuWorldSamples?.(adaptiveQualityRef.current.webgpuSamples)
        syncPelletConsumeTargetsToRenderer()

        const handleResize = () => {
          const rect = glCanvas.getBoundingClientRect()
          if (!rect.width || !rect.height) return
          const adaptive = adaptiveQualityRef.current
          const baseMaxDpr = Math.min(window.devicePixelRatio || 1, 2)
          const maxDpr = Math.min(baseMaxDpr, adaptive.maxDprCap)
          const minDpr = adaptive.minDpr
          let dpr = maxDpr
          if (adaptive.enabled) {
            if (!Number.isFinite(adaptive.currentDpr) || adaptive.currentDpr <= 0) {
              adaptive.currentDpr = maxDpr
            }
            adaptive.currentDpr = clamp(adaptive.currentDpr, minDpr, maxDpr)
            dpr = adaptive.currentDpr
          } else {
            adaptive.currentDpr = maxDpr
            dpr = maxDpr
          }
          dpr = Math.round(dpr * 100) / 100
          webgl?.resize(rect.width, rect.height, dpr)
          hudCanvas.width = Math.round(rect.width * dpr)
          hudCanvas.height = Math.round(rect.height * dpr)
          hudCtx.setTransform(dpr, 0, 0, dpr, 0, 0)
          renderConfigRef.current = {
            width: rect.width,
            height: rect.height,
            centerX: rect.width / 2,
            centerY: rect.height / 2,
          }
        }
        updateConfig = handleResize

        handleResize()
        observer = new ResizeObserver(handleResize)
        observer.observe(glCanvas)
        window.addEventListener('resize', handleResize)
        glCanvas.addEventListener('wheel', handleWheel, { passive: false })

	        const renderLoop = () => {
	          const config = renderConfigRef.current
	          let boostActive = false
	          const rafPerf = rafPerfRef.current
	          const rafPerfEnabled = rafPerf.enabled
	          let frameStartMs = 0
	          let nowMs = 0
	          let afterSnapshotMs = 0
	          let afterCameraMs = 0
	          let afterRenderMs = 0
	          let afterHudMs = 0
	          let afterDebugMs = 0
	          let snapshotPlayerCount = 0
	          let snapshotPelletCount = 0
            let frameDeltaSeconds = 1 / 60
		          if (config && webgl) {
		            nowMs = performance.now()
		            if (rafPerfEnabled) {
		              frameStartMs = nowMs
	            }
		            const lastRenderFrameMs = lastRenderFrameMsRef.current
		            frameDeltaSeconds =
		              lastRenderFrameMs !== null
		                ? Math.max(0, Math.min(0.1, (nowMs - lastRenderFrameMs) / 1000))
		                : 1 / 60
		            lastRenderFrameMsRef.current = nowMs
			            const localId = playerIdRef.current
			            const rawSnapshot = getRenderSnapshot()
			            const snapshot = stabilizeLocalSnapshot(rawSnapshot, localId, frameDeltaSeconds)
			            snapshotPlayerCount = snapshot?.players.length ?? 0
			            snapshotPelletCount = snapshot?.pellets.length ?? 0
			            if (rafPerfEnabled) {
			              afterSnapshotMs = performance.now()
			            }
		            const localSnapshotPlayer =
		              snapshot?.players.find((player) => player.id === localId) ?? null
		            const rawSnapshotPlayer =
		              rawSnapshot?.players.find((player) => player.id === localId) ?? null
            const localHead = localSnapshotPlayer?.snake[0] ?? null
            const hasSpawnedSnake =
              !!localSnapshotPlayer && localSnapshotPlayer.alive && localSnapshotPlayer.snake.length > 0
            const rawGameplayCamera = updateCamera(localHead, cameraUpRef)
            const phase = menuPhaseRef.current

	            if (tailDebugEnabled) {
	              const lastSampleAt = lastTailRenderSampleAtMsRef.current
	              const shouldSample =
	                lastSampleAt === null || nowMs - lastSampleAt >= TAIL_RENDER_SAMPLE_INTERVAL_MS
	              if (shouldSample) {
	                lastTailRenderSampleAtMsRef.current = nowMs
	                const boostInput = pointerRef.current.boost
	                const stableTailExt = localSnapshotPlayer?.tailExtension ?? null
	                const rawTailExt = rawSnapshotPlayer?.tailExtension ?? null
	                const stableMetrics =
	                  localSnapshotPlayer && stableTailExt !== null
	                    ? computeTailEndMetrics(localSnapshotPlayer.snake, stableTailExt)
	                    : null
	                const rawMetrics =
	                  rawSnapshotPlayer && rawTailExt !== null
	                    ? computeTailEndMetrics(rawSnapshotPlayer.snake, rawTailExt)
	                    : null
	                const stableExtRatio = stableTailExt === null ? null : clamp(stableTailExt, 0, 0.999_999)
	                const rawExtRatio = rawTailExt === null ? null : clamp(rawTailExt, 0, 0.999_999)
	                const stableTotalLen =
	                  localSnapshotPlayer?.snakeTotalLen ?? localSnapshotPlayer?.snake.length ?? null
	                const rawTotalLen = rawSnapshotPlayer?.snakeTotalLen ?? rawSnapshotPlayer?.snake.length ?? null
	                const stableLenUnits =
	                  stableTotalLen === null || stableExtRatio === null ? null : stableTotalLen + stableExtRatio
		                const rawLenUnits =
		                  rawTotalLen === null || rawExtRatio === null ? null : rawTotalLen + rawExtRatio

		                let kind: TailGrowthEvent['kind'] = 'render'
		                const stableEndLen = stableMetrics?.endLen ?? null
		                const prevSample = lastTailEndSampleRef.current
		                const prevEndLen = prevSample?.endLen ?? null
		                const stableSample: TailEndSample | null =
		                  stableMetrics && stableEndLen !== null && Number.isFinite(stableEndLen)
		                    ? {
		                        seq: snapshot?.seq ?? null,
		                        now: snapshot?.now ?? null,
		                        snakeLen: localSnapshotPlayer?.snake.length ?? null,
		                        snakeTotalLen: localSnapshotPlayer?.snakeTotalLen ?? null,
		                        tailExtension: stableTailExt ?? null,
		                        ...stableMetrics,
		                      }
		                    : null
		                if (
		                  stableEndLen !== null &&
		                  prevEndLen !== null &&
		                  Number.isFinite(stableEndLen) &&
		                  Number.isFinite(prevEndLen) &&
		                  !(localSnapshotPlayer?.isBoosting ?? false) &&
		                  !boostInput
		                ) {
		                  const refLen = stableMetrics?.refLen ?? 0
		                  const threshold = Math.max(0.003, refLen * 0.35)
		                  if (stableEndLen < prevEndLen - threshold) {
		                    kind = 'shrink'
		                    console.info(
		                      `[tail] shrink seq=${snapshot?.seq ?? -1} endLen=${stableEndLen.toFixed(4)} prev=${prevEndLen.toFixed(4)} ref=${refLen.toFixed(4)} tailExt=${(stableTailExt ?? 0).toFixed(3)} boost=${localSnapshotPlayer?.isBoosting ?? false} input=${boostInput}`,
		                      {
		                        prev: prevSample,
		                        current: stableSample,
		                        stable: {
		                          snakeLen: localSnapshotPlayer?.snake.length ?? null,
		                          snakeTotalLen: localSnapshotPlayer?.snakeTotalLen ?? null,
		                          tailExtension: stableTailExt,
		                          ...stableMetrics,
		                        },
		                        raw: rawSnapshotPlayer
		                          ? {
		                              snakeLen: rawSnapshotPlayer.snake.length,
		                              snakeTotalLen: rawSnapshotPlayer.snakeTotalLen,
		                              tailExtension: rawTailExt,
		                              ...rawMetrics,
		                            }
		                          : null,
		                      },
		                    )
		                  } else if (stableEndLen > prevEndLen + threshold) {
		                    kind = 'stretch'
		                    console.info(
		                      `[tail] stretch seq=${snapshot?.seq ?? -1} endLen=${stableEndLen.toFixed(4)} prev=${prevEndLen.toFixed(4)} ref=${refLen.toFixed(4)} tailExt=${(stableTailExt ?? 0).toFixed(3)} boost=${localSnapshotPlayer?.isBoosting ?? false} input=${boostInput}`,
		                      {
		                        prev: prevSample,
		                        current: stableSample,
		                        stable: {
		                          snakeLen: localSnapshotPlayer?.snake.length ?? null,
		                          snakeTotalLen: localSnapshotPlayer?.snakeTotalLen ?? null,
		                          tailExtension: stableTailExt,
		                          ...stableMetrics,
		                        },
		                        raw: rawSnapshotPlayer
		                          ? {
		                              snakeLen: rawSnapshotPlayer.snake.length,
		                              snakeTotalLen: rawSnapshotPlayer.snakeTotalLen,
		                              tailExtension: rawTailExt,
		                              ...rawMetrics,
		                            }
		                          : null,
		                      },
		                    )
		                  }
		                }
		                lastTailEndSampleRef.current = stableSample

		                appendTailGrowthEvent({
		                  kind,
		                  phase,
	                  seq: snapshot?.seq ?? null,
	                  now: snapshot?.now ?? null,
	                  localId,
	                  alive: localSnapshotPlayer?.alive ?? null,
	                  isBoosting: localSnapshotPlayer?.isBoosting ?? null,
	                  boostInput,
	                  score: localSnapshotPlayer?.score ?? null,
	                  scoreFraction: localSnapshotPlayer?.scoreFraction ?? null,
	                  snakeLen: localSnapshotPlayer?.snake.length ?? null,
	                  snakeTotalLen: localSnapshotPlayer?.snakeTotalLen ?? null,
	                  tailExtension: stableTailExt,
	                  lenUnits: stableLenUnits,
	                  digestions: localSnapshotPlayer?.digestions.length ?? null,
	                  digestionMaxProgress: localSnapshotPlayer
	                    ? digestionMaxProgress(localSnapshotPlayer.digestions)
	                    : null,
	                  tailSegLen: stableMetrics?.segLen ?? null,
	                  tailRefLen: stableMetrics?.refLen ?? null,
	                  tailExtRatio: stableMetrics?.extRatio ?? null,
	                  tailExtDist: stableMetrics?.extDist ?? null,
	                  tailEndLen: stableMetrics?.endLen ?? null,
	                  rawSnakeLen: rawSnapshotPlayer?.snake.length ?? null,
	                  rawSnakeTotalLen: rawSnapshotPlayer?.snakeTotalLen ?? null,
	                  rawTailExtension: rawTailExt,
	                  rawLenUnits,
	                  rawTailSegLen: rawMetrics?.segLen ?? null,
	                  rawTailRefLen: rawMetrics?.refLen ?? null,
	                  rawTailExtRatio: rawMetrics?.extRatio ?? null,
	                  rawTailExtDist: rawMetrics?.extDist ?? null,
	                  rawTailEndLen: rawMetrics?.endLen ?? null,
	                })
	              }
	            }

            if (phase === 'playing' && hasSpawnedSnake && localHead) {
              const normalizedHead = normalize(localHead)
              const previousHead = lastHeadSampleRef.current
              if (previousHead) {
                const headDot = clamp(
                  previousHead.x * normalizedHead.x +
                    previousHead.y * normalizedHead.y +
                    previousHead.z * normalizedHead.z,
                  -1,
                  1,
                )
                const motionInfo = motionDebugInfoRef.current
                motionInfo.sampleCount += 1
                motionInfo.minHeadDot = Math.min(motionInfo.minHeadDot, headDot)
                if (headDot < MOTION_BACKWARD_DOT_THRESHOLD) {
                  motionInfo.backwardCorrectionCount += 1
                }
              }
              lastHeadSampleRef.current = normalizedHead
            } else {
              lastHeadSampleRef.current = null
            }

            if (hasSpawnedSnake) {
              deathStartedAtMsRef.current = null
              if (!localLifeSpawnedRef.current) {
                localLifeSpawnedRef.current = true
              }
            } else if (localLifeSpawnedRef.current && deathStartedAtMsRef.current === null) {
              deathStartedAtMsRef.current = nowMs
              pointerRef.current.active = false
              webglRef.current?.setPointerScreen?.(Number.NaN, Number.NaN, false)
              clearBoostInputs()
            }

            if (
              phase === 'playing' &&
              localLifeSpawnedRef.current &&
              deathStartedAtMsRef.current !== null &&
              nowMs - deathStartedAtMsRef.current >= DEATH_TO_MENU_DELAY_MS
            ) {
              const sourceCameraQ = rawGameplayCamera.active ? rawGameplayCamera.q : cameraRef.current.q
              returnFromCameraQRef.current = { ...sourceCameraQ }
              returnFromDistanceRef.current = renderCameraDistanceRef.current
              returnFromVerticalOffsetRef.current = renderCameraVerticalOffsetRef.current
              returnBlendStartMsRef.current = nowMs
              returnToMenuCommittedRef.current = false
              localLifeSpawnedRef.current = false
              deathStartedAtMsRef.current = null
              const socket = socketRef.current
              if (socket && socket.readyState === WebSocket.OPEN) {
                sendJoin(socket, true)
              }
              setMenuPhase('returning')
            }

            let gameplayCamera = rawGameplayCamera
            if (phase === 'playing' && hasSpawnedSnake && rawGameplayCamera.active) {
              const tuning = netTuningRef.current
              const hardSpikeActive =
                lagSpikeActiveRef.current && lagSpikeCauseRef.current !== 'arrival-gap'
              if (hardSpikeActive) {
                lagCameraRecoveryStartMsRef.current = null
                if (!lagCameraHoldActiveRef.current) {
                  const stableCamera = stableGameplayCameraRef.current
                  lagCameraHoldQRef.current = {
                    ...(stableCamera.active ? stableCamera.q : rawGameplayCamera.q),
                  }
                  lagCameraHoldActiveRef.current = true
                  lagCameraRecoveryFromQRef.current = { ...lagCameraHoldQRef.current }
                }
                const spikeFollowAlpha =
                  1 - Math.exp(-tuning.netCameraSpikeFollowRate * Math.max(0, frameDeltaSeconds))
                lagCameraHoldQRef.current = slerpQuaternion(
                  lagCameraHoldQRef.current,
                  rawGameplayCamera.q,
                  spikeFollowAlpha,
                )
                gameplayCamera = {
                  active: true,
                  q: lagCameraHoldQRef.current,
                }
              } else if (lagCameraHoldActiveRef.current) {
                if (lagCameraRecoveryStartMsRef.current === null) {
                  lagCameraRecoveryStartMsRef.current = nowMs
                  lagCameraRecoveryFromQRef.current = { ...lagCameraHoldQRef.current }
                }
                const recoveryElapsed = nowMs - lagCameraRecoveryStartMsRef.current
                const recoveryBlend = clamp(recoveryElapsed / tuning.netCameraRecoveryMs, 0, 1)
                const easedRecovery = easeInOutCubic(recoveryBlend)
                gameplayCamera = {
                  active: true,
                  q: slerpQuaternion(
                    lagCameraRecoveryFromQRef.current,
                    rawGameplayCamera.q,
                    easedRecovery,
                  ),
                }
                if (recoveryBlend >= 0.999) {
                  lagCameraHoldActiveRef.current = false
                  lagCameraRecoveryStartMsRef.current = null
                }
              }

              if (gameplayCamera.active && !hardSpikeActive) {
                stableGameplayCameraRef.current = {
                  active: true,
                  q: { ...gameplayCamera.q },
                }
              }
            } else {
              lagCameraHoldActiveRef.current = false
              lagCameraRecoveryStartMsRef.current = null
            }

            let blend = cameraBlendRef.current
            if (phase === 'preplay') {
              blend = 0
              cameraBlendStartMsRef.current = null
              returnBlendStartMsRef.current = null
            } else if (phase === 'spawning') {
              if (hasSpawnedSnake && gameplayCamera.active) {
                if (cameraBlendStartMsRef.current === null) {
                  cameraBlendStartMsRef.current = nowMs
                }
                const elapsed = nowMs - cameraBlendStartMsRef.current
                blend = clamp(elapsed / MENU_TO_GAMEPLAY_BLEND_MS, 0, 1)
              } else {
                blend = 0
                cameraBlendStartMsRef.current = null
              }
              returnBlendStartMsRef.current = null
            } else if (phase === 'returning') {
              if (returnBlendStartMsRef.current === null) {
                returnBlendStartMsRef.current = nowMs
              }
              const elapsed = nowMs - returnBlendStartMsRef.current
              blend = clamp(elapsed / MENU_TO_GAMEPLAY_BLEND_MS, 0, 1)
              cameraBlendStartMsRef.current = null
            } else {
              blend = 1
              cameraBlendStartMsRef.current = null
              returnBlendStartMsRef.current = null
            }
            cameraBlendRef.current = blend
            const easedBlend = easeInOutCubic(blend)

            let renderCamera = MENU_CAMERA
            let renderDistance = MENU_CAMERA_DISTANCE
            let renderVerticalOffset = MENU_CAMERA_VERTICAL_OFFSET
            if (phase === 'playing') {
              renderCamera = gameplayCamera.active ? gameplayCamera : MENU_CAMERA
              renderDistance = cameraDistanceRef.current
              renderVerticalOffset = 0
              cameraBlendRef.current = 1
            } else if (phase === 'spawning' && gameplayCamera.active) {
              renderCamera = {
                active: true,
                q: slerpQuaternion(MENU_CAMERA.q, gameplayCamera.q, easedBlend),
              }
              renderDistance =
                MENU_CAMERA_DISTANCE + (cameraDistanceRef.current - MENU_CAMERA_DISTANCE) * easedBlend
              renderVerticalOffset = MENU_CAMERA_VERTICAL_OFFSET * (1 - easedBlend)
              if (blend >= 0.999 && hasSpawnedSnake) {
                setMenuPhase('playing')
              }
            } else if (phase === 'returning') {
              renderCamera = {
                active: true,
                q: slerpQuaternion(returnFromCameraQRef.current, MENU_CAMERA.q, easedBlend),
              }
              renderDistance =
                returnFromDistanceRef.current +
                (MENU_CAMERA_DISTANCE - returnFromDistanceRef.current) * easedBlend
              renderVerticalOffset =
                returnFromVerticalOffsetRef.current +
                (MENU_CAMERA_VERTICAL_OFFSET - returnFromVerticalOffsetRef.current) * easedBlend
              if (blend >= 0.999 && !returnToMenuCommittedRef.current) {
                returnToMenuCommittedRef.current = true
                allowPreplayAutoResumeRef.current = false
                const socket = socketRef.current
                if (socket && socket.readyState === WebSocket.OPEN) {
                  sendJoin(socket, true)
                }
                setShowPlayAgain(true)
                setMenuPhase('preplay')
              }
            }

            cameraRef.current = renderCamera
            renderCameraDistanceRef.current = renderDistance
            renderCameraVerticalOffsetRef.current = renderVerticalOffset
            localHeadRef.current = hasSpawnedSnake && localHead ? normalize(localHead) : MENU_CAMERA_TARGET
            if (!hasSpawnedSnake) {
              pointerRef.current.active = false
              webglRef.current?.setPointerScreen?.(Number.NaN, Number.NaN, false)
              clearBoostInputs()
            }
	            boostActive =
	              inputEnabledRef.current &&
	              !!localSnapshotPlayer &&
	              localSnapshotPlayer.alive &&
	              localSnapshotPlayer.isBoosting

	            if (rafPerfEnabled) {
	              afterCameraMs = performance.now()
	            }

              const uiMode = menuUiModeRef.current
              const showSkinPreview =
                phase === 'preplay' && uiMode !== 'home' && !menuOverlayExitingRef.current
              webgl.setMenuPreviewVisible(showSkinPreview)
              if (showSkinPreview) {
                if (uiMode === 'builder') {
                  const pattern = builderPatternRef.current
                  const colors: string[] = []
                  for (let i = 0; i < pattern.length; i += 1) {
                    const entry = pattern[i]
                    if (!entry) break
                    colors.push(entry)
                  }
                  const previewColors = colors.length ? colors : [builderPaletteColorRef.current]
                  webgl.setMenuPreviewSkin(previewColors, 8)
                } else {
                  webgl.setMenuPreviewSkin(joinSkinColorsRef.current, 8)
                }
              }

	            const headScreen = webgl.render(
	              snapshot,
	              renderCamera,
	              localId,
	              renderDistance,
	              renderVerticalOffset,
	            )
	            if (rafPerfEnabled) {
	              afterRenderMs = performance.now()
	            }
	            headScreenRef.current = headScreen

            if (inputEnabledRef.current) {
              const oxygenPct = localSnapshotPlayer
                ? clamp(localSnapshotPlayer.oxygen, 0, 1) * 100
                : null
              const scoreRadialView = updateScoreRadialController(
                scoreRadialStateRef.current,
                localSnapshotPlayer,
                nowMs,
                pointerRef.current.boost,
                !!localSnapshotPlayer && localSnapshotPlayer.alive && localSnapshotPlayer.isBoosting,
              )
              drawHud(
                hudCtx,
                config,
                null,
                headScreen,
                null,
                null,
                {
                  pct: oxygenPct,
                  low: oxygenPct !== null && oxygenPct <= 35,
                  anchor: headScreen,
                },
                {
                  active: scoreRadialView.active,
                  score: scoreRadialView.score,
                  intervalPct: scoreRadialView.intervalPct,
                  blocked: scoreRadialView.blocked,
                  opacity: scoreRadialView.opacity,
                  anchor: headScreen,
                },
              )
	            } else {
	              hudCtx.clearRect(0, 0, config.width, config.height)
	            }

	            if (rafPerfEnabled) {
	              afterHudMs = performance.now()
	            }

	            menuDebugInfoRef.current = {
	              phase,
	              hasSpawned: hasSpawnedSnake,
	              cameraBlend: phase === 'playing' ? 1 : blend,
              cameraDistance: Math.hypot(renderDistance, renderVerticalOffset),
            }
            if (netDebugEnabled && phase === 'playing') {
              const elapsedSinceSummary = nowMs - lastNetSummaryLogMsRef.current
              if (elapsedSinceSummary >= 5000) {
                const netInfo = netDebugInfoRef.current
                const motionInfo = motionDebugInfoRef.current
                const rxKiBps = netRxBpsRef.current / 1024
                const rxTotalMiB = netRxTotalBytesRef.current / (1024 * 1024)
                appendNetLagEvent(
                  'summary',
                  `summary lag=${netInfo.lagSpikeActive ? '1' : '0'} cause=${netInfo.lagSpikeCause} delay=${netInfo.playoutDelayMs.toFixed(1)}ms boost=${netInfo.delayBoostMs.toFixed(1)}ms jitter=${netInfo.jitterMs.toFixed(1)}ms jitterDelay=${netInfo.jitterDelayMs.toFixed(1)}ms interval=${netInfo.receiveIntervalMs.toFixed(1)}ms stale=${netInfo.staleMs.toFixed(1)}ms impair=${netInfo.impairmentMsRemaining.toFixed(0)}ms rx=${rxKiBps.toFixed(1)}KiB/s total=${rxTotalMiB.toFixed(2)}MiB tuningRev=${netInfo.tuningRevision} backward=${motionInfo.backwardCorrectionCount}/${motionInfo.sampleCount} minDot=${motionInfo.minHeadDot.toFixed(4)}`,
                )
                console.info(
                  `[net] summary lag=${netInfo.lagSpikeActive} cause=${netInfo.lagSpikeCause} delay=${netInfo.playoutDelayMs.toFixed(1)}ms boost=${netInfo.delayBoostMs.toFixed(1)}ms jitter=${netInfo.jitterMs.toFixed(1)}ms jitterDelay=${netInfo.jitterDelayMs.toFixed(1)}ms interval=${netInfo.receiveIntervalMs.toFixed(1)}ms stale=${netInfo.staleMs.toFixed(1)}ms impair=${netInfo.impairmentMsRemaining.toFixed(0)}ms rx=${rxKiBps.toFixed(1)}KiB/s total=${rxTotalMiB.toFixed(2)}MiB tuningRev=${netInfo.tuningRevision} backward=${motionInfo.backwardCorrectionCount}/${motionInfo.sampleCount} minDot=${motionInfo.minHeadDot.toFixed(4)}`,
                )
                lastNetSummaryLogMsRef.current = nowMs
              }
            }
	          }
	          if (rafPerfEnabled && frameStartMs > 0) {
	            afterDebugMs = performance.now()
	          }
	          updateBoostFxVisual(boostActive)
	          if (rafPerfEnabled && frameStartMs > 0 && afterSnapshotMs > 0) {
	            const frameEndMs = performance.now()
	            const totalMs = frameEndMs - frameStartMs
	            const threshold = rafPerf.thresholdMs
	            const snapshotMs = afterSnapshotMs - frameStartMs
	            const cameraMs = afterCameraMs - afterSnapshotMs
	            const renderMs = afterRenderMs - afterCameraMs
	            const hudMs = afterHudMs - afterRenderMs
	            const debugMs = afterDebugMs - afterHudMs
	            const tailMs = frameEndMs - afterDebugMs

	            rafPerf.frameCount += 1
	            rafPerf.maxTotalMs = Math.max(rafPerf.maxTotalMs, totalMs)
	            rafPerf.lastFrame = {
	              tMs: nowMs,
	              totalMs,
	              snapshotMs,
	              cameraMs,
	              renderMs,
	              hudMs,
	              debugMs,
	              tailMs,
	            }

	            if (totalMs >= threshold) {
	              rafPerf.slowFrameCount += 1
	              rafPerf.slowFrames.push({ ...rafPerf.lastFrame })
	              if (rafPerf.slowFrames.length > RAF_SLOW_FRAMES_MAX) {
	                rafPerf.slowFrames.splice(0, rafPerf.slowFrames.length - RAF_SLOW_FRAMES_MAX)
	              }

		              // Throttle warnings to avoid turning perf debugging into the perf problem.
		              if (nowMs - rafPerf.lastSlowLogMs >= 1000) {
		                rafPerf.lastSlowLogMs = nowMs
		                console.warn(
		                  `[raf] slow frame ${totalMs.toFixed(1)}ms (snapshot ${snapshotMs.toFixed(
		                    1,
		                  )}ms camera ${cameraMs.toFixed(1)}ms render ${renderMs.toFixed(
		                    1,
		                  )}ms hud ${hudMs.toFixed(1)}ms debug ${debugMs.toFixed(1)}ms tail ${tailMs.toFixed(1)}ms)`,
		                )
		                try {
		                  const debugApi = (
		                    window as Window & { __SNAKE_DEBUG__?: Record<string, unknown> }
		                  ).__SNAKE_DEBUG__
		                  const getRenderPerfInfo = debugApi && (debugApi as { getRenderPerfInfo?: unknown }).getRenderPerfInfo
		                  if (typeof getRenderPerfInfo === 'function') {
		                    const perf = (getRenderPerfInfo as () => { lastFrame?: unknown })()
		                    const frame = perf?.lastFrame as
		                      | {
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
		                      | null
		                    const getRendererInfo =
		                      debugApi && (debugApi as { getRendererInfo?: unknown }).getRendererInfo
		                    const rendererInfo =
		                      typeof getRendererInfo === 'function'
		                        ? (getRendererInfo as () => { activeBackend?: string; webglShaderHooksEnabled?: boolean })()
		                        : null
		                    if (frame) {
		                      console.warn(
		                        `[render] backend=${rendererInfo?.activeBackend ?? 'unknown'} hooks=${
		                          typeof rendererInfo?.webglShaderHooksEnabled === 'boolean'
		                            ? rendererInfo.webglShaderHooksEnabled
		                              ? 1
		                              : 0
		                            : '?'
		                        } total=${frame.totalMs.toFixed(1)}ms setup=${frame.setupMs.toFixed(
		                          1,
		                        )} snakes=${frame.snakesMs.toFixed(1)} pellets=${frame.pelletsMs.toFixed(
		                          1,
		                        )} vis=${frame.visibilityMs.toFixed(1)} water=${frame.waterMs.toFixed(
		                          1,
		                        )} passWorld=${frame.passWorldMs.toFixed(
		                          1,
		                        )} passOcc=${frame.passOccludersMs.toFixed(
		                          1,
		                        )} passPel=${frame.passPelletsMs.toFixed(
		                          1,
		                        )} passDepth=${frame.passDepthRebuildMs.toFixed(
		                          1,
		                        )} passLakes=${frame.passLakesMs.toFixed(1)} players=${
		                          snapshotPlayerCount
		                        } pellets=${snapshotPelletCount}`,
		                      )
		                    }
		                  }
		                } catch {
		                  // Ignore perf log errors; raf perf is opt-in debug-only.
		                }
		              }
		            }
		          }
              if (config && webgl && updateConfig) {
                updateAdaptiveQuality(adaptiveQualityRef.current, frameDeltaSeconds, nowMs, webgl, updateConfig)
              }
		          frameId = window.requestAnimationFrame(renderLoop)
		        }

        renderLoop()
      } catch (error) {
        if (disposed) return
        setActiveRenderer(null)
        setRendererFallbackReason(formatRendererError(error))
      }
    }

    void setupScene()

    return () => {
      disposed = true
      observer?.disconnect()
      if (updateConfig) {
        window.removeEventListener('resize', updateConfig)
      }
      glCanvas.removeEventListener('wheel', handleWheel)
      window.cancelAnimationFrame(frameId)
      webgl?.dispose()
      webglRef.current = null
      renderConfigRef.current = null
      headScreenRef.current = null
      localSnakeDisplayRef.current = null
      lastRenderFrameMsRef.current = null
      resetBoostFxVisual()
    }
    // Renderer swaps are intentionally triggered by explicit backend preference only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    rendererPreference,
    getRenderSnapshot,
    netDebugEnabled,
    appendNetLagEvent,
    buildNetLagReport,
    stabilizeLocalSnapshot,
    applyNetTuningOverrides,
  ])

}
