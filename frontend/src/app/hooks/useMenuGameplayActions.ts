import { useCallback, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'
import type { Camera, Point } from '@game/types'
import { createRandomPlayerName, sanitizeRoomName, storeRendererPreference } from '@game/storage'
import { encodeRespawn } from '@game/wsProtocol'
import type { RenderScene, RendererPreference } from '@render/webglScene'
import {
  MENU_CAMERA,
  MENU_CAMERA_TARGET,
  type MenuPhase,
} from '@app/core/menuCamera'
import {
  MENU_CAMERA_DISTANCE,
  MENU_OVERLAY_FADE_OUT_MS,
} from '@app/core/constants'

type MenuUiMode = 'home' | 'skin' | 'builder'

type UseMenuGameplayActionsOptions = {
  roomInput: string
  roomName: string
  setRoomInput: Dispatch<SetStateAction<string>>
  setRoomName: Dispatch<SetStateAction<string>>
  setMenuPhase: Dispatch<SetStateAction<MenuPhase>>
  socketRef: MutableRefObject<WebSocket | null>
  sendJoin: (socket: WebSocket, deferSpawn?: boolean) => void
  menuPhaseRef: MutableRefObject<MenuPhase>
  menuOverlayExitTimerRef: MutableRefObject<number | null>
  setMenuOverlayExiting: Dispatch<SetStateAction<boolean>>
  menuOverlayExiting: boolean
  menuUiModeRef: MutableRefObject<MenuUiMode>
  setMenuUiMode: Dispatch<SetStateAction<MenuUiMode>>
  playerName: string
  setPlayerName: Dispatch<SetStateAction<string>>
  playerNameRef: MutableRefObject<string>
  allowPreplayAutoResumeRef: MutableRefObject<boolean>
  pointerRef: MutableRefObject<{
    boost: boolean
    active: boolean
    screenX: number
    screenY: number
  }>
  webglRef: MutableRefObject<RenderScene | null>
  clearBoostInputs: () => void
  localHeadRef: MutableRefObject<Point | null>
  cameraBlendRef: MutableRefObject<number>
  cameraBlendStartMsRef: MutableRefObject<number | null>
  returnBlendStartMsRef: MutableRefObject<number | null>
  returnFromCameraQRef: MutableRefObject<Camera['q']>
  returnFromDistanceRef: MutableRefObject<number>
  returnFromVerticalOffsetRef: MutableRefObject<number>
  localLifeSpawnedRef: MutableRefObject<boolean>
  deathStartedAtMsRef: MutableRefObject<number | null>
  returnToMenuCommittedRef: MutableRefObject<boolean>
  rendererPreference: RendererPreference
}

type UseMenuGameplayActionsResult = {
  handleJoinRoom: () => void
  handlePlay: () => void
  handleRendererModeChange: (value: string) => void
}

export function useMenuGameplayActions(
  options: UseMenuGameplayActionsOptions,
): UseMenuGameplayActionsResult {
  const {
    roomInput,
    roomName,
    setRoomInput,
    setRoomName,
    setMenuPhase,
    socketRef,
    sendJoin,
    menuPhaseRef,
    menuOverlayExitTimerRef,
    setMenuOverlayExiting,
    menuOverlayExiting,
    menuUiModeRef,
    setMenuUiMode,
    playerName,
    setPlayerName,
    playerNameRef,
    allowPreplayAutoResumeRef,
    pointerRef,
    webglRef,
    clearBoostInputs,
    localHeadRef,
    cameraBlendRef,
    cameraBlendStartMsRef,
    returnBlendStartMsRef,
    returnFromCameraQRef,
    returnFromDistanceRef,
    returnFromVerticalOffsetRef,
    localLifeSpawnedRef,
    deathStartedAtMsRef,
    returnToMenuCommittedRef,
    rendererPreference,
  } = options

  const handleJoinRoom = useCallback(() => {
    if (menuOverlayExitTimerRef.current !== null) {
      window.clearTimeout(menuOverlayExitTimerRef.current)
      menuOverlayExitTimerRef.current = null
    }
    setMenuOverlayExiting(false)

    const nextRoom = sanitizeRoomName(roomInput)
    setRoomInput(nextRoom)
    if (nextRoom !== roomName) {
      setRoomName(nextRoom)
      setMenuPhase('preplay')
    } else if (socketRef.current) {
      sendJoin(socketRef.current, menuPhaseRef.current !== 'playing')
    }
  }, [
    menuOverlayExitTimerRef,
    menuPhaseRef,
    roomInput,
    roomName,
    sendJoin,
    setMenuOverlayExiting,
    setMenuPhase,
    setRoomInput,
    setRoomName,
    socketRef,
  ])

  const handlePlay = useCallback(() => {
    const socket = socketRef.current
    if (!socket || socket.readyState !== WebSocket.OPEN) return
    if (menuOverlayExiting) return
    if (menuUiModeRef.current !== 'home') {
      setMenuUiMode('home')
    }

    const trimmedName = playerName.trim()
    const nextName = trimmedName || createRandomPlayerName()
    if (nextName !== playerName) {
      setPlayerName(nextName)
    }
    playerNameRef.current = nextName

    allowPreplayAutoResumeRef.current = false
    setMenuOverlayExiting(true)

    if (menuOverlayExitTimerRef.current !== null) {
      window.clearTimeout(menuOverlayExitTimerRef.current)
      menuOverlayExitTimerRef.current = null
    }

    menuOverlayExitTimerRef.current = window.setTimeout(() => {
      menuOverlayExitTimerRef.current = null

      const activeSocket = socketRef.current
      if (!activeSocket || activeSocket.readyState !== WebSocket.OPEN) {
        setMenuOverlayExiting(false)
        return
      }

      pointerRef.current.active = false
      webglRef.current?.setPointerScreen?.(Number.NaN, Number.NaN, false)
      clearBoostInputs()
      localHeadRef.current = MENU_CAMERA_TARGET
      cameraBlendRef.current = 0
      cameraBlendStartMsRef.current = null
      returnBlendStartMsRef.current = null
      returnFromCameraQRef.current = { ...MENU_CAMERA.q }
      returnFromDistanceRef.current = MENU_CAMERA_DISTANCE
      returnFromVerticalOffsetRef.current = 0
      localLifeSpawnedRef.current = false
      deathStartedAtMsRef.current = null
      returnToMenuCommittedRef.current = false
      setMenuOverlayExiting(false)
      setMenuPhase('spawning')

      sendJoin(activeSocket, true)
      activeSocket.send(encodeRespawn())
    }, MENU_OVERLAY_FADE_OUT_MS)
  }, [
    allowPreplayAutoResumeRef,
    cameraBlendRef,
    cameraBlendStartMsRef,
    clearBoostInputs,
    deathStartedAtMsRef,
    localHeadRef,
    localLifeSpawnedRef,
    menuOverlayExitTimerRef,
    menuOverlayExiting,
    menuUiModeRef,
    playerName,
    playerNameRef,
    pointerRef,
    returnBlendStartMsRef,
    returnFromCameraQRef,
    returnFromDistanceRef,
    returnFromVerticalOffsetRef,
    returnToMenuCommittedRef,
    sendJoin,
    setMenuOverlayExiting,
    setMenuPhase,
    setMenuUiMode,
    setPlayerName,
    socketRef,
    webglRef,
  ])

  const handleRendererModeChange = useCallback((value: string) => {
    const mode: RendererPreference =
      value === 'webgl' || value === 'webgpu' || value === 'auto' ? value : 'auto'
    if (mode === rendererPreference) return
    storeRendererPreference(mode)
    const url = new URL(window.location.href)
    url.searchParams.set('renderer', mode)
    window.location.replace(url.toString())
  }, [rendererPreference])

  return {
    handleJoinRoom,
    handlePlay,
    handleRendererModeChange,
  }
}
