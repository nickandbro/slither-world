/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect } from 'react'
import type { GameStateSnapshot } from '@game/types'
import { decodeServerMessage, resetDeltaDecoderState } from '@game/wsProtocol'
import { storePlayerId } from '@game/storage'
import { resolveWebSocketUrl } from '@services/backend'
import { requestMatchmake } from '@services/matchmake'
import { MAX_EXTRAPOLATION_MS, MENU_CAMERA_DISTANCE, MENU_CAMERA_VERTICAL_OFFSET, resolveNetTuning } from '@app/core/constants'
import { MENU_CAMERA, MENU_CAMERA_TARGET } from '@app/core/menuCamera'
import { applyPelletsToSnapshotBuffer, rebuildPelletsArray } from '@app/orchestration/connectionHandlers'

export function useSocketConnectionRuntime(options: any): void {
  const {
    roomName,
    pushSnapshot,
    snapshotBufferRef,
    serverOffsetRef,
    serverTickMsRef,
    lastSnapshotTimeRef,
    lastSnapshotReceivedAtRef,
    receiveIntervalMsRef,
    receiveJitterMsRef,
    receiveJitterDelayMsRef,
    netRxWindowStartMsRef,
    netRxWindowBytesRef,
    netRxBpsRef,
    netRxTotalBytesRef,
    lastInputSignatureRef,
    lastInputSentAtMsRef,
    lastViewSignatureRef,
    lastViewSentAtMsRef,
    playoutDelayMsRef,
    delayBoostMsRef,
    lastDelayUpdateMsRef,
    latestSeqRef,
    seqGapDetectedRef,
    lastSeqGapAtMsRef,
    lagSpikeActiveRef,
    lagSpikeCauseRef,
    lagSpikeEnterCandidateAtMsRef,
    lagSpikeExitCandidateAtMsRef,
    lagSpikeArrivalGapCooldownUntilMsRef,
    lagImpairmentUntilMsRef,
    netTuningRef,
    netTuningOverridesRef,
    tickIntervalRef,
    clearPelletConsumeTargets,
    playerMetaRef,
    playerIdByNetIdRef,
    pelletMapRef,
    pelletsArrayRef,
    netDebugInfoRef,
    netTuningRevisionRef,
    motionDebugInfoRef,
    netLagEventsRef,
    netLagEventIdRef,
    lastNetSummaryLogMsRef,
    lastHeadSampleRef,
    localSnakeDisplayRef,
    lastRenderFrameMsRef,
    localHeadRef,
    stableGameplayCameraRef,
    lagCameraHoldActiveRef,
    lagCameraHoldQRef,
    lagCameraRecoveryStartMsRef,
    lagCameraRecoveryFromQRef,
    renderCameraDistanceRef,
    renderCameraVerticalOffsetRef,
    cameraBlendRef,
    cameraBlendStartMsRef,
    returnBlendStartMsRef,
    returnFromCameraQRef,
    returnFromDistanceRef,
    returnFromVerticalOffsetRef,
    localLifeSpawnedRef,
    deathStartedAtMsRef,
    returnToMenuCommittedRef,
    allowPreplayAutoResumeRef,
    menuOverlayExitTimerRef,
    setMenuOverlayExiting,
    pointerRef,
    webglRef,
    clearBoostInputs,
    setConnectionStatus,
    setGameState,
    setEnvironment,
    setMenuPhase,
    setRoomInput,
    setRoomName,
    socketRef,
    sendJoin,
    startInputLoop,
    setPlayerId,
    playerIdRef,
    resetPredictionState,
  } = options

  useEffect(() => {
    let reconnectTimer: number | null = null
    let cancelled = false

    const connect = async () => {
      if (cancelled) return
      snapshotBufferRef.current = []
      serverOffsetRef.current = null
      serverTickMsRef.current = 50
      lastSnapshotTimeRef.current = null
      lastSnapshotReceivedAtRef.current = null
      receiveIntervalMsRef.current = 50
      receiveJitterMsRef.current = 0
      receiveJitterDelayMsRef.current = 0
      netRxWindowStartMsRef.current = null
      netRxWindowBytesRef.current = 0
      netRxBpsRef.current = 0
      netRxTotalBytesRef.current = 0
      lastInputSignatureRef.current = ''
      lastInputSentAtMsRef.current = 0
      lastViewSignatureRef.current = ''
      lastViewSentAtMsRef.current = 0
      playoutDelayMsRef.current = 100
      delayBoostMsRef.current = 0
      lastDelayUpdateMsRef.current = null
      latestSeqRef.current = null
      seqGapDetectedRef.current = false
      lastSeqGapAtMsRef.current = null
      lagSpikeActiveRef.current = false
      lagSpikeCauseRef.current = 'none'
      lagSpikeEnterCandidateAtMsRef.current = null
      lagSpikeExitCandidateAtMsRef.current = null
      lagSpikeArrivalGapCooldownUntilMsRef.current = 0
      lagImpairmentUntilMsRef.current = 0
      netTuningRef.current = resolveNetTuning(netTuningOverridesRef.current)
      tickIntervalRef.current = 50
      clearPelletConsumeTargets()
      playerMetaRef.current = new Map()
      playerIdByNetIdRef.current = new Map()
      resetDeltaDecoderState()
      pelletMapRef.current = new Map()
      pelletsArrayRef.current = []
      netDebugInfoRef.current = {
        lagSpikeActive: false,
        lagSpikeCause: 'none',
        playoutDelayMs: 100,
        delayBoostMs: 0,
        jitterDelayMs: 0,
        jitterMs: 0,
        receiveIntervalMs: 50,
        staleMs: 0,
        impairmentMsRemaining: 0,
        maxExtrapolationMs: MAX_EXTRAPOLATION_MS,
        latestSeq: null,
        seqGapDetected: false,
        tuningRevision: netTuningRevisionRef.current,
        tuningOverrides: { ...netTuningOverridesRef.current },
      }
      motionDebugInfoRef.current = {
        backwardCorrectionCount: 0,
        minHeadDot: 1,
        sampleCount: 0,
      }
      netLagEventsRef.current = []
      netLagEventIdRef.current = 1
      lastNetSummaryLogMsRef.current = 0
      lastHeadSampleRef.current = null
      localSnakeDisplayRef.current = null
      resetPredictionState()
      lastRenderFrameMsRef.current = null
      localHeadRef.current = MENU_CAMERA_TARGET
      stableGameplayCameraRef.current = { q: { ...MENU_CAMERA.q }, active: true }
      lagCameraHoldActiveRef.current = false
      lagCameraHoldQRef.current = { ...MENU_CAMERA.q }
      lagCameraRecoveryStartMsRef.current = null
      lagCameraRecoveryFromQRef.current = { ...MENU_CAMERA.q }
      renderCameraDistanceRef.current = MENU_CAMERA_DISTANCE
      renderCameraVerticalOffsetRef.current = MENU_CAMERA_VERTICAL_OFFSET
      cameraBlendRef.current = 0
      cameraBlendStartMsRef.current = null
      returnBlendStartMsRef.current = null
      returnFromCameraQRef.current = { ...MENU_CAMERA.q }
      returnFromDistanceRef.current = MENU_CAMERA_DISTANCE
      returnFromVerticalOffsetRef.current = 0
      localLifeSpawnedRef.current = false
      deathStartedAtMsRef.current = null
      returnToMenuCommittedRef.current = false
      allowPreplayAutoResumeRef.current = true
      if (menuOverlayExitTimerRef.current !== null) {
        window.clearTimeout(menuOverlayExitTimerRef.current)
        menuOverlayExitTimerRef.current = null
      }
      setMenuOverlayExiting(false)
      pointerRef.current.active = false
      webglRef.current?.setPointerScreen?.(Number.NaN, Number.NaN, false)
      clearBoostInputs()
      setConnectionStatus('Matchmaking')
      setGameState(null)
      setEnvironment(null)
      setMenuPhase('preplay')

      let assignedRoom = roomName
      let roomToken = ''
      try {
        const assignment = await requestMatchmake(roomName)
        assignedRoom = assignment.roomId
        roomToken = assignment.roomToken
      } catch {
        if (cancelled) return
        setConnectionStatus('Reconnecting')
        reconnectTimer = window.setTimeout(() => {
          void connect()
        }, 1500)
        return
      }

      if (cancelled) return
      if (assignedRoom !== roomName) {
        setRoomInput(assignedRoom)
        setRoomName(assignedRoom)
        return
      }
      setRoomInput((previous: string) => (previous === assignedRoom ? previous : assignedRoom))

      const socket = new WebSocket(
        resolveWebSocketUrl(
          `/api/room/${encodeURIComponent(assignedRoom)}?rt=${encodeURIComponent(roomToken)}`,
        ),
      )
      socket.binaryType = 'arraybuffer'
      socketRef.current = socket

      socket.addEventListener('open', () => {
        setConnectionStatus('Connected')
        sendJoin(socket, true)
        startInputLoop()
      })

      socket.addEventListener('message', (event) => {
        if (!(event.data instanceof ArrayBuffer)) return
        const bytes = event.data.byteLength
        netRxTotalBytesRef.current += bytes
        netRxWindowBytesRef.current += bytes
        const nowMs = performance.now()
        if (netRxWindowStartMsRef.current === null) {
          netRxWindowStartMsRef.current = nowMs
        } else {
          const elapsedMs = nowMs - netRxWindowStartMsRef.current
          if (elapsedMs >= 1000) {
            netRxBpsRef.current = (netRxWindowBytesRef.current * 1000) / Math.max(1, elapsedMs)
            netRxWindowStartMsRef.current = nowMs
            netRxWindowBytesRef.current = 0
          }
        }
        const decoded = decodeServerMessage(
          event.data,
          playerMetaRef.current,
          playerIdByNetIdRef.current,
        )
        if (!decoded) return

        if (decoded.type === 'pellet_reset') {
          pelletMapRef.current = new Map(decoded.pellets.map((pellet) => [pellet.id, pellet]))
          clearPelletConsumeTargets()
          const pellets = rebuildPelletsArray(pelletMapRef.current, pelletsArrayRef)
          applyPelletsToSnapshotBuffer(snapshotBufferRef.current, pellets, 'all')
          setGameState((previous: GameStateSnapshot | null) =>
            previous ? { ...previous, pellets } : previous,
          )
          return
        }

        if (decoded.type === 'pellet_delta') {
          for (const pellet of decoded.adds) pelletMapRef.current.set(pellet.id, pellet)
          for (const pellet of decoded.updates) pelletMapRef.current.set(pellet.id, pellet)
          for (const id of decoded.removes) pelletMapRef.current.delete(id)
          const pellets = rebuildPelletsArray(pelletMapRef.current, pelletsArrayRef)
          applyPelletsToSnapshotBuffer(snapshotBufferRef.current, pellets, 'latest')
          setGameState((previous: GameStateSnapshot | null) =>
            previous ? { ...previous, pellets } : previous,
          )
          return
        }

        if (decoded.type === 'pellet_consume') {
          let pelletsChanged = false
          let hasTargets = false
          for (const consume of decoded.consumes) {
            if (pelletMapRef.current.delete(consume.pelletId)) {
              pelletsChanged = true
            }
            const targetPlayerId = playerIdByNetIdRef.current.get(consume.targetNetId)
            if (targetPlayerId) {
              options.pelletConsumeTargetsRef.current.set(consume.pelletId, targetPlayerId)
              hasTargets = true
            }
          }
          if (hasTargets) {
            options.syncPelletConsumeTargetsToRenderer()
          }
          if (pelletsChanged) {
            const pellets = rebuildPelletsArray(pelletMapRef.current, pelletsArrayRef)
            applyPelletsToSnapshotBuffer(snapshotBufferRef.current, pellets, 'latest')
            setGameState((previous: GameStateSnapshot | null) =>
              previous ? { ...previous, pellets } : previous,
            )
          }
          return
        }

        if (decoded.type === 'init') {
          setPlayerId(decoded.playerId)
          playerIdRef.current = decoded.playerId
          storePlayerId(decoded.playerId)
          if (Number.isFinite(decoded.tickMs) && decoded.tickMs > 0) {
            const normalizedTickMs = Math.max(16, decoded.tickMs)
            serverTickMsRef.current = normalizedTickMs
            tickIntervalRef.current = normalizedTickMs
            receiveIntervalMsRef.current = normalizedTickMs
            netDebugInfoRef.current = {
              ...netDebugInfoRef.current,
              receiveIntervalMs: normalizedTickMs,
            }
          }
          setEnvironment(decoded.environment)
          clearPelletConsumeTargets()
          const state: GameStateSnapshot = { ...decoded.state, pellets: pelletsArrayRef.current }
          pushSnapshot(state)
          setGameState(state)
          return
        }

        if (decoded.type === 'state') {
          const state: GameStateSnapshot = { ...decoded.state, pellets: pelletsArrayRef.current }
          pushSnapshot(state)
          setGameState(state)
        }
      })

      socket.addEventListener('close', () => {
        if (cancelled) return
        setConnectionStatus('Reconnecting')
        reconnectTimer = window.setTimeout(() => {
          void connect()
        }, 1500)
      })

      socket.addEventListener('error', () => {
        socket.close()
      })
    }

    void connect()

    return () => {
      cancelled = true
      if (reconnectTimer) window.clearTimeout(reconnectTimer)
      resetDeltaDecoderState()
      socketRef.current?.close()
      socketRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomName, pushSnapshot])
}
