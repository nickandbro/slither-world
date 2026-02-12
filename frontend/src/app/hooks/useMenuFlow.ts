import { useEffect } from 'react'
import type { MutableRefObject } from 'react'
import type { RenderScene } from '@render/webglScene'
import type { MenuPhase } from '@app/core/menuCamera'

export type UseMenuFlowOptions = {
  menuPhase: MenuPhase
  menuPhaseRef: MutableRefObject<MenuPhase>
  allowPreplayAutoResumeRef: MutableRefObject<boolean>
  setMenuUiMode: (mode: 'home' | 'skin' | 'builder') => void
  inputEnabledRef: MutableRefObject<boolean>
  pointerRef: MutableRefObject<{ active: boolean }>
  webglRef: MutableRefObject<RenderScene | null>
  touchControlRef: MutableRefObject<{
    pointers: Map<number, { x: number; y: number }>
    pinchActive: boolean
    pinchPrevDistancePx: number | null
  }>
  stopJoystick: () => void
  clearBoostInputs: () => void
  socketRef: MutableRefObject<WebSocket | null>
  sendJoin: (socket: WebSocket, deferSpawn?: boolean) => void
}

export function useMenuFlow(options: UseMenuFlowOptions): void {
  useEffect(() => {
    options.menuPhaseRef.current = options.menuPhase
    if (options.menuPhase === 'preplay') {
      options.setMenuUiMode('home')
    }
    options.inputEnabledRef.current = options.menuPhase === 'playing'

    if (options.menuPhase !== 'playing') {
      options.pointerRef.current.active = false
      options.webglRef.current?.setPointerScreen?.(Number.NaN, Number.NaN, false)
      options.touchControlRef.current.pointers.clear()
      options.touchControlRef.current.pinchActive = false
      options.touchControlRef.current.pinchPrevDistancePx = null
      options.stopJoystick()
      options.clearBoostInputs()
    }

    if (options.menuPhase === 'preplay' && !options.allowPreplayAutoResumeRef.current) {
      const socket = options.socketRef.current
      if (socket && socket.readyState === WebSocket.OPEN) {
        options.sendJoin(socket, true)
      }
    }
  }, [options.menuPhase]) // eslint-disable-line react-hooks/exhaustive-deps
}
