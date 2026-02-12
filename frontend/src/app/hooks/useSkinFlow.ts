import { useEffect } from 'react'
import type { MutableRefObject } from 'react'
import type { MenuPhase } from '@app/core/menuCamera'
import {
  SKIN_PALETTE_COLORS,
  resolveSelectedSkinColors,
  storeSelectedSkin,
  type SelectedSkinV1,
  type SnakeSkinDesignV1,
} from '@game/skins'

export type UseSkinFlowOptions = {
  selectedSkin: SelectedSkinV1
  skinDesigns: SnakeSkinDesignV1[]
  solidPaletteIndex: number
  setSolidPaletteIndex: (index: number) => void
  joinSkinColorsRef: MutableRefObject<string[]>
  menuPhaseRef: MutableRefObject<MenuPhase>
  socketRef: MutableRefObject<WebSocket | null>
  sendJoin: (socket: WebSocket, deferSpawn?: boolean) => void
  builderPattern: Array<string | null>
  builderPatternRef: MutableRefObject<Array<string | null>>
  builderPaletteColor: string
  builderPaletteColorRef: MutableRefObject<string>
}

export function useSkinFlow(options: UseSkinFlowOptions): void {
  useEffect(() => {
    storeSelectedSkin(options.selectedSkin)
  }, [options.selectedSkin])

  useEffect(() => {
    const selectedSkin = options.selectedSkin
    if (selectedSkin.kind !== 'solid') return
    const idx = SKIN_PALETTE_COLORS.findIndex(
      (color) => color.toLowerCase() === selectedSkin.color.toLowerCase(),
    )
    if (idx >= 0 && idx !== options.solidPaletteIndex) {
      options.setSolidPaletteIndex(idx)
    }
  }, [options.selectedSkin, options.solidPaletteIndex, options.setSolidPaletteIndex]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const resolved = resolveSelectedSkinColors(options.selectedSkin, options.skinDesigns)
    options.joinSkinColorsRef.current = resolved

    if (options.menuPhaseRef.current === 'preplay') {
      const socket = options.socketRef.current
      if (socket && socket.readyState === WebSocket.OPEN) {
        options.sendJoin(socket, true)
      }
    }
  }, [options.selectedSkin, options.skinDesigns]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    options.builderPatternRef.current = options.builderPattern
  }, [options.builderPattern, options.builderPatternRef])

  useEffect(() => {
    options.builderPaletteColorRef.current = options.builderPaletteColor
  }, [options.builderPaletteColor, options.builderPaletteColorRef])
}
