import { useEffect, type MutableRefObject } from 'react'
import type { Environment } from '@game/types'
import { storePlayerName, storeRendererPreference, storeRoomName } from '@game/storage'
import {
  persistDayNightDebugMode,
  persistDebugSettings,
} from '@app/core/debugSettings'
import type {
  DayNightDebugMode,
  RenderScene,
  RendererPreference,
} from '@render/webglScene'

type MenuUiMode = 'home' | 'skin' | 'builder'

type DebugFlags = {
  mountainOutline: boolean
  lakeCollider: boolean
  treeCollider: boolean
  terrainTessellation: boolean
}

type UseAppStateSyncOptions = {
  playerId: string | null
  playerIdRef: MutableRefObject<string | null>
  playerName: string
  playerNameRef: MutableRefObject<string>
  menuUiMode: MenuUiMode
  menuUiModeRef: MutableRefObject<MenuUiMode>
  menuOverlayExiting: boolean
  menuOverlayExitingRef: MutableRefObject<boolean>
  environment: Environment | null
  environmentRef: MutableRefObject<Environment | null>
  webglRef: MutableRefObject<RenderScene | null>
  mountainDebug: boolean
  lakeDebug: boolean
  treeDebug: boolean
  terrainTessellationDebug: boolean
  debugFlagsRef: MutableRefObject<DebugFlags>
  dayNightDebugMode: DayNightDebugMode
  dayNightDebugModeRef: MutableRefObject<DayNightDebugMode>
  roomName: string
  rendererPreference: RendererPreference
}

export function useAppStateSync(options: UseAppStateSyncOptions) {
  const {
    playerId,
    playerIdRef,
    playerName,
    playerNameRef,
    menuUiMode,
    menuUiModeRef,
    menuOverlayExiting,
    menuOverlayExitingRef,
    environment,
    environmentRef,
    webglRef,
    mountainDebug,
    lakeDebug,
    treeDebug,
    terrainTessellationDebug,
    debugFlagsRef,
    dayNightDebugMode,
    dayNightDebugModeRef,
    roomName,
    rendererPreference,
  } = options

  useEffect(() => {
    playerIdRef.current = playerId
  }, [playerId, playerIdRef])

  useEffect(() => {
    playerNameRef.current = playerName
  }, [playerName, playerNameRef])

  useEffect(() => {
    menuUiModeRef.current = menuUiMode
  }, [menuUiMode, menuUiModeRef])

  useEffect(() => {
    menuOverlayExitingRef.current = menuOverlayExiting
  }, [menuOverlayExiting, menuOverlayExitingRef])

  useEffect(() => {
    const webgl = webglRef.current
    environmentRef.current = environment
    if (webgl && environment) {
      webgl.setEnvironment?.(environment)
    }
  }, [environment, environmentRef, webglRef])

  useEffect(() => {
    persistDebugSettings({
      mountainDebug,
      lakeDebug,
      treeDebug,
      terrainTessellationDebug,
    })
    debugFlagsRef.current = {
      mountainOutline: mountainDebug,
      lakeCollider: lakeDebug,
      treeCollider: treeDebug,
      terrainTessellation: terrainTessellationDebug,
    }
    webglRef.current?.setDebugFlags?.(debugFlagsRef.current)
  }, [
    mountainDebug,
    lakeDebug,
    treeDebug,
    terrainTessellationDebug,
    debugFlagsRef,
    webglRef,
  ])

  useEffect(() => {
    persistDayNightDebugMode(dayNightDebugMode)
    dayNightDebugModeRef.current = dayNightDebugMode
    webglRef.current?.setDayNightDebugMode?.(dayNightDebugModeRef.current)
  }, [dayNightDebugMode, dayNightDebugModeRef, webglRef])

  useEffect(() => {
    storePlayerName(playerName)
  }, [playerName])

  useEffect(() => {
    storeRoomName(roomName)
    const url = new URL(window.location.href)
    url.searchParams.set('room', roomName)
    window.history.replaceState({}, '', url)
  }, [roomName])

  useEffect(() => {
    storeRendererPreference(rendererPreference)
    const url = new URL(window.location.href)
    url.searchParams.set('renderer', rendererPreference)
    window.history.replaceState({}, '', url)
  }, [rendererPreference])
}
