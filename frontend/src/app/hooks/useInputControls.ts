import { useEffect, useRef } from 'react'
import type { MutableRefObject } from 'react'

export type UseInputControlsOptions = {
  inputEnabledRef: MutableRefObject<boolean>
  boostInputRef: MutableRefObject<{ keyboard: boolean; pointerButton: boolean }>
  sendIntervalRef: MutableRefObject<number | null>
  menuOverlayExitTimerRef: MutableRefObject<number | null>
  syncBoostInput: () => void
}

export function useInputControls(options: UseInputControlsOptions): void {
  const syncBoostInputRef = useRef(options.syncBoostInput)

  useEffect(() => {
    syncBoostInputRef.current = options.syncBoostInput
  }, [options.syncBoostInput])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code === 'Space' && options.inputEnabledRef.current) {
        event.preventDefault()
        options.boostInputRef.current.keyboard = true
        syncBoostInputRef.current()
      }
    }

    const onKeyUp = (event: KeyboardEvent) => {
      if (event.code === 'Space') {
        event.preventDefault()
        options.boostInputRef.current.keyboard = false
        syncBoostInputRef.current()
      }
    }

    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)

    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
    }
  }, [options.boostInputRef, options.inputEnabledRef])

  useEffect(() => {
    return () => {
      if (options.sendIntervalRef.current !== null) {
        window.clearInterval(options.sendIntervalRef.current)
      }
      options.sendIntervalRef.current = null
      if (options.menuOverlayExitTimerRef.current !== null) {
        window.clearTimeout(options.menuOverlayExitTimerRef.current)
      }
      options.menuOverlayExitTimerRef.current = null
    }
  }, [options.menuOverlayExitTimerRef, options.sendIntervalRef])
}
