import { useCallback } from 'react'
import type { MutableRefObject, PointerEvent as ReactPointerEvent } from 'react'
import { clamp } from '@game/math'
import {
  DEFAULT_SOLID_SKIN,
  MAX_SAVED_SKIN_DESIGNS,
  SKIN_PALETTE_COLORS,
  SNAKE_PATTERN_LEN,
  createSkinDesign,
  deleteSkinDesign,
  getSavedSkinDesigns,
  saveSkinDesign,
  type SelectedSkinV1,
  type SnakeSkinDesignV1,
} from '@game/skins'
import type { RenderScene } from '@render/webglScene'
import type { MenuPhase } from '@app/core/menuCamera'

export type UseSkinMenuActionsOptions = {
  menuOverlayExiting: boolean
  menuOverlayExitingRef: MutableRefObject<boolean>
  menuPhaseRef: MutableRefObject<MenuPhase>
  webglRef: MutableRefObject<RenderScene | null>
  setMenuUiMode: (mode: 'home' | 'skin' | 'builder') => void
  solidPaletteIndex: number
  solidPaletteColor: string
  setSolidPaletteIndex: (index: number) => void
  selectedSkin: SelectedSkinV1
  setSelectedSkin: (skin: SelectedSkinV1) => void
  skinDesigns: SnakeSkinDesignV1[]
  setSkinDesigns: (designs: SnakeSkinDesignV1[]) => void
  menuPreviewOrbitRef: MutableRefObject<{ yaw: number; pitch: number }>
  menuPreviewDragRef: MutableRefObject<{
    active: boolean
    pointerId: number | null
    lastX: number
    lastY: number
  }>
  builderPaletteIndexRef: MutableRefObject<number>
  builderPaletteColorRef: MutableRefObject<string>
  builderPattern: Array<string | null>
  setBuilderPattern: (updater: (current: Array<string | null>) => Array<string | null>) => void
  setBuilderPaletteColor: (color: string) => void
  setBuilderDesignName: (name: string) => void
  builderDesignName: string
}

export type SkinMenuActions = {
  refreshSkinDesigns: () => void
  resetMenuPreviewOrbit: () => void
  handleOpenSkin: () => void
  handleMenuPreviewPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void
  handleMenuPreviewPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => void
  handleMenuPreviewPointerUp: (event: ReactPointerEvent<HTMLDivElement>) => void
  handleMenuPreviewPointerCancel: (event: ReactPointerEvent<HTMLDivElement>) => void
  handleMenuPreviewPointerLeave: (event: ReactPointerEvent<HTMLDivElement>) => void
  handleSolidPrev: () => void
  handleSolidNext: () => void
  handleSelectSolid: (color: string) => void
  handleSelectDesign: (id: string) => void
  handleDeleteDesign: (id: string) => void
  resetBuilder: () => void
  handleStartBuilder: () => void
  handleBuilderPrev: () => void
  handleBuilderNext: () => void
  handleBuilderPickColor: (value: string) => void
  handleBuilderAddColor: () => void
  handleBuilderPaintSlot: (index: number) => void
  handleBuilderSave: () => void
}

export function useSkinMenuActions(options: UseSkinMenuActionsOptions): SkinMenuActions {
  const {
    menuOverlayExiting,
    menuOverlayExitingRef,
    menuPhaseRef,
    webglRef,
    setMenuUiMode,
    solidPaletteIndex,
    solidPaletteColor,
    setSolidPaletteIndex,
    selectedSkin,
    setSelectedSkin,
    skinDesigns,
    setSkinDesigns,
    menuPreviewOrbitRef,
    menuPreviewDragRef,
    builderPaletteIndexRef,
    builderPaletteColorRef,
    builderPattern,
    setBuilderPattern,
    setBuilderPaletteColor,
    setBuilderDesignName,
    builderDesignName,
  } = options

  const refreshSkinDesigns = useCallback(() => {
    setSkinDesigns(getSavedSkinDesigns())
  }, [setSkinDesigns])

  const resetMenuPreviewOrbit = useCallback(() => {
    const orbit = menuPreviewOrbitRef.current
    orbit.yaw = -0.35
    orbit.pitch = 0.08
    webglRef.current?.setMenuPreviewOrbit(orbit.yaw, orbit.pitch)
  }, [menuPreviewOrbitRef, webglRef])

  const handleOpenSkin = useCallback(() => {
    if (menuOverlayExiting || menuPhaseRef.current !== 'preplay') return
    resetMenuPreviewOrbit()
    setMenuUiMode('skin')
  }, [menuOverlayExiting, menuPhaseRef, resetMenuPreviewOrbit, setMenuUiMode])

  const cyclePaletteIndex = useCallback((index: number, delta: number) => {
    const count = SKIN_PALETTE_COLORS.length
    if (count <= 0) return 0
    const next = (index + delta) % count
    return next < 0 ? next + count : next
  }, [])

  const stopMenuPreviewDrag = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = menuPreviewDragRef.current
    if (!drag.active) return
    drag.active = false
    drag.pointerId = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }, [menuPreviewDragRef])

  const handleMenuPreviewPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (menuOverlayExitingRef.current) return
    if (menuPhaseRef.current !== 'preplay') return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    const drag = menuPreviewDragRef.current
    drag.active = true
    drag.pointerId = event.pointerId
    drag.lastX = event.clientX
    drag.lastY = event.clientY
  }, [menuOverlayExitingRef, menuPhaseRef, menuPreviewDragRef])

  const handleMenuPreviewPointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = menuPreviewDragRef.current
    if (!drag.active || drag.pointerId !== event.pointerId) return
    event.preventDefault()
    const dx = event.clientX - drag.lastX
    const dy = event.clientY - drag.lastY
    drag.lastX = event.clientX
    drag.lastY = event.clientY

    const orbit = menuPreviewOrbitRef.current
    const sensitivity = 0.006
    orbit.yaw += dx * sensitivity
    orbit.pitch = clamp(orbit.pitch + dy * sensitivity, -1.25, 1.25)
    webglRef.current?.setMenuPreviewOrbit(orbit.yaw, orbit.pitch)
  }, [menuPreviewDragRef, menuPreviewOrbitRef, webglRef])

  const handleMenuPreviewPointerUp = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    stopMenuPreviewDrag(event)
  }, [stopMenuPreviewDrag])

  const handleMenuPreviewPointerCancel = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    stopMenuPreviewDrag(event)
  }, [stopMenuPreviewDrag])

  const handleMenuPreviewPointerLeave = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    stopMenuPreviewDrag(event)
  }, [stopMenuPreviewDrag])

  const handleSolidPrev = useCallback(() => {
    const nextIndex = cyclePaletteIndex(solidPaletteIndex, -1)
    const nextColor = SKIN_PALETTE_COLORS[nextIndex] ?? solidPaletteColor
    setSolidPaletteIndex(nextIndex)
    setSelectedSkin({ kind: 'solid', color: nextColor })
  }, [cyclePaletteIndex, setSelectedSkin, setSolidPaletteIndex, solidPaletteColor, solidPaletteIndex])

  const handleSolidNext = useCallback(() => {
    const nextIndex = cyclePaletteIndex(solidPaletteIndex, 1)
    const nextColor = SKIN_PALETTE_COLORS[nextIndex] ?? solidPaletteColor
    setSolidPaletteIndex(nextIndex)
    setSelectedSkin({ kind: 'solid', color: nextColor })
  }, [cyclePaletteIndex, setSelectedSkin, setSolidPaletteIndex, solidPaletteColor, solidPaletteIndex])

  const handleSelectSolid = useCallback((color: string) => {
    setSelectedSkin({ kind: 'solid', color })
  }, [setSelectedSkin])

  const handleSelectDesign = useCallback((id: string) => {
    setSelectedSkin({ kind: 'design', id })
  }, [setSelectedSkin])

  const handleDeleteDesign = useCallback((id: string) => {
    if (typeof window !== 'undefined') {
      const design = skinDesigns.find((d) => d.id === id)
      const confirmed = window.confirm(`Delete design "${design?.name ?? 'Unnamed'}"?`)
      if (!confirmed) return
    }
    deleteSkinDesign(id)
    refreshSkinDesigns()
    if (selectedSkin.kind === 'design' && selectedSkin.id === id) {
      setSelectedSkin(DEFAULT_SOLID_SKIN)
    }
  }, [refreshSkinDesigns, selectedSkin, setSelectedSkin, skinDesigns])

  const resetBuilder = useCallback(() => {
    builderPaletteIndexRef.current = 0
    setBuilderPaletteColor(SKIN_PALETTE_COLORS[0] ?? '#ffffff')
    setBuilderPattern(() => new Array(SNAKE_PATTERN_LEN).fill(null))
    setBuilderDesignName('')
  }, [builderPaletteIndexRef, setBuilderDesignName, setBuilderPaletteColor, setBuilderPattern])

  const handleStartBuilder = useCallback(() => {
    resetBuilder()
    resetMenuPreviewOrbit()
    setMenuUiMode('builder')
  }, [resetBuilder, resetMenuPreviewOrbit, setMenuUiMode])

  const handleBuilderPrev = useCallback(() => {
    const nextIndex = cyclePaletteIndex(builderPaletteIndexRef.current, -1)
    builderPaletteIndexRef.current = nextIndex
    setBuilderPaletteColor(SKIN_PALETTE_COLORS[nextIndex] ?? builderPaletteColorRef.current)
  }, [builderPaletteColorRef, builderPaletteIndexRef, cyclePaletteIndex, setBuilderPaletteColor])

  const handleBuilderNext = useCallback(() => {
    const nextIndex = cyclePaletteIndex(builderPaletteIndexRef.current, 1)
    builderPaletteIndexRef.current = nextIndex
    setBuilderPaletteColor(SKIN_PALETTE_COLORS[nextIndex] ?? builderPaletteColorRef.current)
  }, [builderPaletteColorRef, builderPaletteIndexRef, cyclePaletteIndex, setBuilderPaletteColor])

  const handleBuilderPickColor = useCallback((value: string) => {
    const normalized = value.trim().toLowerCase()
    setBuilderPaletteColor(normalized)
    const idx = SKIN_PALETTE_COLORS.findIndex((color) => color.toLowerCase() === normalized)
    if (idx >= 0) builderPaletteIndexRef.current = idx
  }, [builderPaletteIndexRef, setBuilderPaletteColor])

  const handleBuilderAddColor = useCallback(() => {
    setBuilderPattern((current) => {
      const next = current.slice(0, SNAKE_PATTERN_LEN)
      const idx = next.findIndex((c) => !c)
      if (idx === -1) return next
      next[idx] = builderPaletteColorRef.current
      return next
    })
  }, [builderPaletteColorRef, setBuilderPattern])

  const handleBuilderPaintSlot = useCallback((index: number) => {
    setBuilderPattern((current) => {
      const next = current.slice(0, SNAKE_PATTERN_LEN)
      if (!next[index]) return next
      next[index] = builderPaletteColorRef.current
      return next
    })
  }, [builderPaletteColorRef, setBuilderPattern])

  const handleBuilderSave = useCallback(() => {
    if (skinDesigns.length >= MAX_SAVED_SKIN_DESIGNS) return
    const seed: string[] = []
    for (let i = 0; i < SNAKE_PATTERN_LEN; i += 1) {
      const entry = builderPattern[i]
      if (typeof entry === 'string' && entry) {
        seed.push(entry)
        continue
      }
      break
    }
    if (seed.length < 1) return
    const colors: string[] = []
    for (let i = 0; i < SNAKE_PATTERN_LEN; i += 1) {
      colors.push(seed[i % seed.length] ?? seed[0] ?? '#ffffff')
    }
    const design = createSkinDesign(builderDesignName, colors)
    if (!design) return
    const saved = saveSkinDesign(design)
    if (!saved.ok) {
      if (typeof window !== 'undefined' && saved.error === 'max') {
        window.alert('Max designs reached. Delete one to save a new design.')
      }
      return
    }
    refreshSkinDesigns()
    setSelectedSkin({ kind: 'design', id: design.id })
    setMenuUiMode('skin')
    resetBuilder()
  }, [
    builderDesignName,
    builderPattern,
    refreshSkinDesigns,
    resetBuilder,
    setMenuUiMode,
    setSelectedSkin,
    skinDesigns.length,
  ])

  return {
    refreshSkinDesigns,
    resetMenuPreviewOrbit,
    handleOpenSkin,
    handleMenuPreviewPointerDown,
    handleMenuPreviewPointerMove,
    handleMenuPreviewPointerUp,
    handleMenuPreviewPointerCancel,
    handleMenuPreviewPointerLeave,
    handleSolidPrev,
    handleSolidNext,
    handleSelectSolid,
    handleSelectDesign,
    handleDeleteDesign,
    resetBuilder,
    handleStartBuilder,
    handleBuilderPrev,
    handleBuilderNext,
    handleBuilderPickColor,
    handleBuilderAddColor,
    handleBuilderPaintSlot,
    handleBuilderSave,
  }
}
