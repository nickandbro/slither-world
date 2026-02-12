import { useCallback } from 'react'
import type { MutableRefObject, PointerEvent as ReactPointerEvent } from 'react'
import type { Camera, Point } from '@game/types'
import { axisFromPointer } from '@game/camera'
import { clamp } from '@game/math'
import {
  CAMERA_DISTANCE_MAX,
  CAMERA_DISTANCE_MIN,
  CAMERA_ZOOM_SENSITIVITY,
} from '@app/core/constants'

const JOY_ZONE_MIN_X_RATIO = 0.55
const JOY_ZONE_MIN_Y_RATIO = 0.55
const JOY_RADIUS_MIN_PX = 72
const JOY_RADIUS_MAX_PX = 117
const JOY_RADIUS_VIEWPORT_RATIO = 0.2
const JOY_DEADZONE_RATIO = 0.12
const JOY_BOOST_ON_RATIO = 0.86
const JOY_BOOST_OFF_RATIO = 0.78

const PINCH_ZOOM_RATIO_MIN = 0.85
const PINCH_ZOOM_RATIO_MAX = 1.15
const PINCH_ZOOM_SENSITIVITY = 1

export type UsePointerCanvasControlsOptions = {
  glCanvasRef: MutableRefObject<HTMLCanvasElement | null>
  renderConfigRef: MutableRefObject<{ width: number; height: number } | null>
  webglRef: MutableRefObject<{ setPointerScreen?: (x: number, y: number, active: boolean) => void } | null>
  inputEnabledRef: MutableRefObject<boolean>
  pointerRef: MutableRefObject<{ screenX: number; screenY: number; active: boolean }>
  touchControlRef: MutableRefObject<{
    pointers: Map<number, { x: number; y: number }>
    pinchActive: boolean
    pinchPrevDistancePx: number | null
  }>
  joystickAxisRef: MutableRefObject<Point | null>
  joystickUiRef: MutableRefObject<{
    active: boolean
    pointerId: number | null
    centerX: number
    centerY: number
    radius: number
    boostWanted: boolean
  }>
  joystickRootRef: MutableRefObject<HTMLDivElement | null>
  cameraRef: MutableRefObject<Camera>
  cameraDistanceRef: MutableRefObject<number>
  sendInputSnapshot: (force?: boolean) => void
  setPointerButtonBoostInput: (active: boolean) => void
}

export type PointerCanvasControls = {
  stopJoystick: () => void
  handlePointerDown: (event: ReactPointerEvent<HTMLCanvasElement>) => void
  handlePointerMove: (event: ReactPointerEvent<HTMLCanvasElement>) => void
  handlePointerUp: (event: ReactPointerEvent<HTMLCanvasElement>) => void
  handlePointerLeave: (event: ReactPointerEvent<HTMLCanvasElement>) => void
  handlePointerCancel: (event: ReactPointerEvent<HTMLCanvasElement>) => void
  handleWheel: (event: WheelEvent) => void
}

export function usePointerCanvasControls(
  options: UsePointerCanvasControlsOptions,
): PointerCanvasControls {
  const {
    glCanvasRef,
    renderConfigRef,
    webglRef,
    inputEnabledRef,
    pointerRef,
    touchControlRef,
    joystickAxisRef,
    joystickUiRef,
    joystickRootRef,
    cameraRef,
    cameraDistanceRef,
    sendInputSnapshot,
    setPointerButtonBoostInput,
  } = options

  const isTouchLikePointer = useCallback((event: ReactPointerEvent<HTMLCanvasElement>) => {
    return event.pointerType === 'touch' || event.pointerType === 'pen'
  }, [])

  const getViewportMinDim = useCallback(() => {
    const config = renderConfigRef.current
    if (
      config &&
      Number.isFinite(config.width) &&
      Number.isFinite(config.height) &&
      config.width > 0 &&
      config.height > 0
    ) {
      return Math.min(config.width, config.height)
    }
    const canvas = glCanvasRef.current
    if (canvas) {
      const rect = canvas.getBoundingClientRect()
      if (rect.width > 0 && rect.height > 0) {
        return Math.min(rect.width, rect.height)
      }
    }
    return 0
  }, [glCanvasRef, renderConfigRef])

  const setPointerScreen = useCallback((x: number, y: number, active: boolean) => {
    pointerRef.current.screenX = x
    pointerRef.current.screenY = y
    pointerRef.current.active = active
    webglRef.current?.setPointerScreen?.(x, y, active)
  }, [pointerRef, webglRef])

  const clearTouchState = useCallback(() => {
    const touch = touchControlRef.current
    touch.pointers.clear()
    touch.pinchActive = false
    touch.pinchPrevDistancePx = null
  }, [touchControlRef])

  const updatePointer = useCallback((event: ReactPointerEvent<HTMLCanvasElement>) => {
    const canvas = glCanvasRef.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    const localX = event.clientX - rect.left
    const localY = event.clientY - rect.top
    const active = inputEnabledRef.current
    setPointerScreen(localX, localY, active)
    sendInputSnapshot(true)
  }, [glCanvasRef, inputEnabledRef, sendInputSnapshot, setPointerScreen])

  const isPointerBoostButtonPressed = useCallback((event: ReactPointerEvent<HTMLCanvasElement>) => {
    return (event.buttons & (1 | 2)) !== 0
  }, [])

  const getJoystickRadiusPx = useCallback(() => {
    let minDim = getViewportMinDim()
    if (!(minDim > 0)) minDim = 400
    return clamp(minDim * JOY_RADIUS_VIEWPORT_RATIO, JOY_RADIUS_MIN_PX, JOY_RADIUS_MAX_PX)
  }, [getViewportMinDim])

  const isPointInJoystickZone = useCallback((x: number, y: number, width: number, height: number) => {
    if (!(width > 0) || !(height > 0)) return false
    const bottom = y >= height * JOY_ZONE_MIN_Y_RATIO
    const right = x >= width * JOY_ZONE_MIN_X_RATIO
    const left = x <= width * (1 - JOY_ZONE_MIN_X_RATIO)
    return bottom && (right || left)
  }, [])

  const setJoystickUiVisible = useCallback((visible: boolean) => {
    const el = joystickRootRef.current
    if (!el) return
    el.classList.toggle('touch-joystick--visible', visible)
  }, [joystickRootRef])

  const setJoystickUiBoost = useCallback((boost: boolean) => {
    const el = joystickRootRef.current
    if (!el) return
    el.classList.toggle('touch-joystick--boost', boost)
  }, [joystickRootRef])

  const setJoystickUiVars = useCallback((
    centerX: number,
    centerY: number,
    radius: number,
    knobX: number,
    knobY: number,
  ) => {
    const el = joystickRootRef.current
    if (!el) return
    el.style.setProperty('--joy-x', `${centerX.toFixed(1)}px`)
    el.style.setProperty('--joy-y', `${centerY.toFixed(1)}px`)
    el.style.setProperty('--joy-radius', `${Math.max(0, radius).toFixed(1)}px`)
    el.style.setProperty('--joy-knob-x', `${knobX.toFixed(1)}px`)
    el.style.setProperty('--joy-knob-y', `${knobY.toFixed(1)}px`)
  }, [joystickRootRef])

  const startJoystick = useCallback((
    pointerId: number,
    localX: number,
    localY: number,
    width: number,
    height: number,
  ) => {
    if (!inputEnabledRef.current) return
    setPointerScreen(Number.NaN, Number.NaN, false)

    const radius = getJoystickRadiusPx()
    const margin = 12
    const centerX =
      width > 0
        ? clamp(localX, radius + margin, Math.max(radius + margin, width - radius - margin))
        : localX
    const centerY =
      height > 0
        ? clamp(localY, radius + margin, Math.max(radius + margin, height - radius - margin))
        : localY

    const joy = joystickUiRef.current
    joy.active = true
    joy.pointerId = pointerId
    joy.centerX = centerX
    joy.centerY = centerY
    joy.radius = radius
    joy.boostWanted = false

    joystickAxisRef.current = null
    setPointerButtonBoostInput(false)
    setJoystickUiBoost(false)
    setJoystickUiVars(centerX, centerY, radius, 0, 0)
    setJoystickUiVisible(true)
    sendInputSnapshot(true)
  }, [
    getJoystickRadiusPx,
    inputEnabledRef,
    joystickAxisRef,
    joystickUiRef,
    sendInputSnapshot,
    setJoystickUiBoost,
    setJoystickUiVars,
    setJoystickUiVisible,
    setPointerButtonBoostInput,
    setPointerScreen,
  ])

  const stopJoystick = useCallback(() => {
    const joy = joystickUiRef.current
    if (!joy.active) {
      joystickAxisRef.current = null
      setPointerButtonBoostInput(false)
      setJoystickUiBoost(false)
      setJoystickUiVisible(false)
      sendInputSnapshot(true)
      return
    }

    joy.active = false
    joy.pointerId = null
    joy.boostWanted = false
    joystickAxisRef.current = null
    setPointerButtonBoostInput(false)
    setJoystickUiBoost(false)
    setJoystickUiVars(joy.centerX, joy.centerY, joy.radius, 0, 0)
    setJoystickUiVisible(false)
    sendInputSnapshot(true)
  }, [
    joystickAxisRef,
    joystickUiRef,
    sendInputSnapshot,
    setJoystickUiBoost,
    setJoystickUiVars,
    setJoystickUiVisible,
    setPointerButtonBoostInput,
  ])

  const updateJoystick = useCallback((pointerId: number, localX: number, localY: number) => {
    if (!inputEnabledRef.current) return
    const joy = joystickUiRef.current
    if (!joy.active || joy.pointerId !== pointerId) return

    const radius = joy.radius > 0 ? joy.radius : getJoystickRadiusPx()
    const dx0 = localX - joy.centerX
    const dy0 = localY - joy.centerY
    let dx = dx0
    let dy = dy0
    let dist = Math.hypot(dx, dy)
    if (!Number.isFinite(dist) || dist < 1e-8) dist = 0
    if (radius > 0 && dist > radius && dist > 1e-8) {
      const scale = radius / dist
      dx *= scale
      dy *= scale
      dist = radius
    }

    const t = radius > 0 ? clamp(dist / radius, 0, 1) : 0
    setJoystickUiVars(joy.centerX, joy.centerY, radius, dx, dy)

    if (t <= JOY_DEADZONE_RATIO) {
      joystickAxisRef.current = null
    } else {
      const angle = Math.atan2(dy, dx)
      joystickAxisRef.current = axisFromPointer(angle, cameraRef.current)
    }

    const wanted = joy.boostWanted ? t >= JOY_BOOST_OFF_RATIO : t >= JOY_BOOST_ON_RATIO
    if (wanted !== joy.boostWanted) {
      joy.boostWanted = wanted
      setPointerButtonBoostInput(wanted)
      setJoystickUiBoost(wanted)
    }
    sendInputSnapshot(true)
  }, [
    cameraRef,
    getJoystickRadiusPx,
    inputEnabledRef,
    joystickAxisRef,
    joystickUiRef,
    sendInputSnapshot,
    setJoystickUiBoost,
    setJoystickUiVars,
    setPointerButtonBoostInput,
  ])

  const updatePinchZoom = useCallback(() => {
    if (!inputEnabledRef.current) return
    const touch = touchControlRef.current
    if (touch.pointers.size < 2) return

    const iter = touch.pointers.values()
    const a = iter.next().value as { x: number; y: number } | undefined
    const b = iter.next().value as { x: number; y: number } | undefined
    if (!a || !b) return

    const dist = Math.hypot(a.x - b.x, a.y - b.y)
    if (!Number.isFinite(dist) || dist <= 0) return

    const prev = touch.pinchPrevDistancePx
    if (prev !== null && Number.isFinite(prev) && prev > 0) {
      let ratio = dist / prev
      if (Number.isFinite(ratio) && ratio > 0) {
        ratio = clamp(ratio, PINCH_ZOOM_RATIO_MIN, PINCH_ZOOM_RATIO_MAX)
        const zoomFactor = Math.exp(-Math.log(ratio) * PINCH_ZOOM_SENSITIVITY)
        cameraDistanceRef.current = clamp(
          cameraDistanceRef.current * zoomFactor,
          CAMERA_DISTANCE_MIN,
          CAMERA_DISTANCE_MAX,
        )
      }
    }
    touch.pinchPrevDistancePx = dist
  }, [cameraDistanceRef, inputEnabledRef, touchControlRef])

  const handlePointerDown = useCallback((event: ReactPointerEvent<HTMLCanvasElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId)
    if (isTouchLikePointer(event)) {
      if (event.cancelable) event.preventDefault()
      const canvas = glCanvasRef.current
      let localX = Number.NaN
      let localY = Number.NaN
      let viewportWidth = 0
      let viewportHeight = 0
      if (canvas) {
        const rect = canvas.getBoundingClientRect()
        viewportWidth = rect.width
        viewportHeight = rect.height
        localX = event.clientX - rect.left
        localY = event.clientY - rect.top
        touchControlRef.current.pointers.set(event.pointerId, { x: localX, y: localY })
      }

      const touch = touchControlRef.current
      if (touch.pointers.size >= 2) {
        touch.pinchActive = true
        touch.pinchPrevDistancePx = null
        stopJoystick()
        updatePinchZoom()
        return
      }

      touch.pinchActive = false
      touch.pinchPrevDistancePx = null
      if (
        inputEnabledRef.current &&
        Number.isFinite(localX) &&
        Number.isFinite(localY) &&
        isPointInJoystickZone(localX, localY, viewportWidth, viewportHeight)
      ) {
        startJoystick(event.pointerId, localX, localY, viewportWidth, viewportHeight)
      }
      return
    }

    updatePointer(event)
    setPointerButtonBoostInput(inputEnabledRef.current && isPointerBoostButtonPressed(event))
  }, [
    glCanvasRef,
    inputEnabledRef,
    isPointInJoystickZone,
    isPointerBoostButtonPressed,
    isTouchLikePointer,
    setPointerButtonBoostInput,
    startJoystick,
    stopJoystick,
    touchControlRef,
    updatePinchZoom,
    updatePointer,
  ])

  const handlePointerMove = useCallback((event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (isTouchLikePointer(event)) {
      if (event.cancelable) event.preventDefault()
      const canvas = glCanvasRef.current
      let localX = Number.NaN
      let localY = Number.NaN
      if (canvas) {
        const rect = canvas.getBoundingClientRect()
        localX = event.clientX - rect.left
        localY = event.clientY - rect.top
        touchControlRef.current.pointers.set(event.pointerId, { x: localX, y: localY })
      }

      const touch = touchControlRef.current
      if (touch.pointers.size >= 2) {
        if (!touch.pinchActive) {
          touch.pinchActive = true
          touch.pinchPrevDistancePx = null
          stopJoystick()
        }
        updatePinchZoom()
        return
      }

      if (touch.pinchActive) {
        touch.pinchActive = false
        touch.pinchPrevDistancePx = null
      }
      if (Number.isFinite(localX) && Number.isFinite(localY)) {
        updateJoystick(event.pointerId, localX, localY)
      }
      return
    }

    updatePointer(event)
    setPointerButtonBoostInput(inputEnabledRef.current && isPointerBoostButtonPressed(event))
  }, [
    glCanvasRef,
    inputEnabledRef,
    isPointerBoostButtonPressed,
    isTouchLikePointer,
    setPointerButtonBoostInput,
    stopJoystick,
    touchControlRef,
    updatePinchZoom,
    updatePointer,
    updateJoystick,
  ])

  const handlePointerUp = useCallback((event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    if (isTouchLikePointer(event)) {
      if (event.cancelable) event.preventDefault()
      const touch = touchControlRef.current
      touch.pointers.delete(event.pointerId)

      if (joystickUiRef.current.active && joystickUiRef.current.pointerId === event.pointerId) {
        stopJoystick()
      }

      if (touch.pointers.size >= 2) {
        touch.pinchActive = true
        touch.pinchPrevDistancePx = null
        stopJoystick()
        updatePinchZoom()
        return
      }

      if (touch.pointers.size === 1) {
        touch.pinchActive = false
        touch.pinchPrevDistancePx = null
        const remaining = touch.pointers.entries().next().value as
          | [number, { x: number; y: number }]
          | undefined
        if (remaining && inputEnabledRef.current) {
          const canvas = glCanvasRef.current
          if (canvas) {
            const rect = canvas.getBoundingClientRect()
            const [remainingId, remainingPos] = remaining
            if (isPointInJoystickZone(remainingPos.x, remainingPos.y, rect.width, rect.height)) {
              startJoystick(remainingId, remainingPos.x, remainingPos.y, rect.width, rect.height)
              return
            }
          }
        }
      }

      if (touch.pointers.size === 0) {
        clearTouchState()
        stopJoystick()
      }
      return
    }

    setPointerButtonBoostInput(inputEnabledRef.current && isPointerBoostButtonPressed(event))
  }, [
    clearTouchState,
    glCanvasRef,
    inputEnabledRef,
    isPointInJoystickZone,
    isPointerBoostButtonPressed,
    isTouchLikePointer,
    joystickUiRef,
    setPointerButtonBoostInput,
    startJoystick,
    stopJoystick,
    touchControlRef,
    updatePinchZoom,
  ])

  const handlePointerLeave = useCallback((event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (isTouchLikePointer(event)) {
      clearTouchState()
      stopJoystick()
    }
    setPointerScreen(Number.NaN, Number.NaN, false)
    setPointerButtonBoostInput(false)
    sendInputSnapshot(true)
  }, [
    clearTouchState,
    isTouchLikePointer,
    sendInputSnapshot,
    setPointerButtonBoostInput,
    setPointerScreen,
    stopJoystick,
  ])

  const handlePointerCancel = useCallback((event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }

    if (isTouchLikePointer(event)) {
      if (event.cancelable) event.preventDefault()
      const touch = touchControlRef.current
      touch.pointers.delete(event.pointerId)

      if (joystickUiRef.current.active && joystickUiRef.current.pointerId === event.pointerId) {
        stopJoystick()
      }

      if (touch.pointers.size >= 2) {
        touch.pinchActive = true
        touch.pinchPrevDistancePx = null
        stopJoystick()
        updatePinchZoom()
        return
      }

      if (touch.pointers.size === 1) {
        touch.pinchActive = false
        touch.pinchPrevDistancePx = null
        const remaining = touch.pointers.entries().next().value as
          | [number, { x: number; y: number }]
          | undefined
        if (remaining && inputEnabledRef.current) {
          const canvas = glCanvasRef.current
          if (canvas) {
            const rect = canvas.getBoundingClientRect()
            const [remainingId, remainingPos] = remaining
            if (isPointInJoystickZone(remainingPos.x, remainingPos.y, rect.width, rect.height)) {
              startJoystick(remainingId, remainingPos.x, remainingPos.y, rect.width, rect.height)
              return
            }
          }
        }
      }

      if (touch.pointers.size === 0) {
        clearTouchState()
        stopJoystick()
      }
    }

    setPointerScreen(Number.NaN, Number.NaN, false)
    setPointerButtonBoostInput(false)
    sendInputSnapshot(true)
  }, [
    clearTouchState,
    glCanvasRef,
    inputEnabledRef,
    isPointInJoystickZone,
    isTouchLikePointer,
    joystickUiRef,
    sendInputSnapshot,
    setPointerButtonBoostInput,
    setPointerScreen,
    startJoystick,
    stopJoystick,
    touchControlRef,
    updatePinchZoom,
  ])

  const handleWheel = useCallback((event: WheelEvent) => {
    if (!inputEnabledRef.current) return
    if (!Number.isFinite(event.deltaY) || event.deltaY === 0) return
    if (event.cancelable) event.preventDefault()
    const clampedDelta = clamp(event.deltaY, -120, 120)
    const zoomFactor = Math.exp(clampedDelta * CAMERA_ZOOM_SENSITIVITY)
    const nextDistance = clamp(
      cameraDistanceRef.current * zoomFactor,
      CAMERA_DISTANCE_MIN,
      CAMERA_DISTANCE_MAX,
    )
    cameraDistanceRef.current = nextDistance
    sendInputSnapshot(true)
  }, [cameraDistanceRef, inputEnabledRef, sendInputSnapshot])

  return {
    stopJoystick,
    handlePointerDown,
    handlePointerMove,
    handlePointerUp,
    handlePointerLeave,
    handlePointerCancel,
    handleWheel,
  }
}
