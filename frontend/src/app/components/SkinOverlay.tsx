import type { SelectedSkinV1, SnakeSkinDesignV1 } from '../../game/skins'

type SkinOverlayProps = {
  isExiting: boolean
  solidColor: string
  selected: SelectedSkinV1
  designs: SnakeSkinDesignV1[]
  onPreviewPointerDown: (event: React.PointerEvent<HTMLDivElement>) => void
  onPreviewPointerMove: (event: React.PointerEvent<HTMLDivElement>) => void
  onPreviewPointerUp: (event: React.PointerEvent<HTMLDivElement>) => void
  onPreviewPointerCancel: (event: React.PointerEvent<HTMLDivElement>) => void
  onPreviewPointerLeave: (event: React.PointerEvent<HTMLDivElement>) => void
  onSolidPrev: () => void
  onSolidNext: () => void
  onSelectSolid: (color: string) => void
  onSelectDesign: (id: string) => void
  onDeleteDesign: (id: string) => void
  onBuild: () => void
  onBack: () => void
}

const SwatchRow = ({ colors }: { colors: string[] }) => (
  <div className='skin-swatch-row' aria-hidden='true'>
    {colors.map((color, i) => (
      <span key={`${color}-${i}`} className='skin-swatch' style={{ background: color }} />
    ))}
  </div>
)

export function SkinOverlay({
  isExiting,
  solidColor,
  selected,
  designs,
  onPreviewPointerDown,
  onPreviewPointerMove,
  onPreviewPointerUp,
  onPreviewPointerCancel,
  onPreviewPointerLeave,
  onSolidPrev,
  onSolidNext,
  onSelectSolid,
  onSelectDesign,
  onDeleteDesign,
  onBuild,
  onBack,
}: SkinOverlayProps) {
  const solidSelected = selected.kind === 'solid'
  const selectedDesignName =
    selected.kind === 'design' ? designs.find((design) => design.id === selected.id)?.name ?? null : null
  const selectedLabel = solidSelected ? solidColor : selectedDesignName ?? 'Saved design'

  return (
    <div className='menu-overlay'>
      <div className='menu-hero menu-hero--skins'>
        <div className='menu-skin-title'>Skin</div>

        <div className='skin-screen'>
          <div
            className={`skin-preview-stage${isExiting ? ' skin-preview-stage--disabled' : ''}`}
            role='img'
            aria-label='3D skin preview'
            onPointerDown={onPreviewPointerDown}
            onPointerMove={onPreviewPointerMove}
            onPointerUp={onPreviewPointerUp}
            onPointerCancel={onPreviewPointerCancel}
            onPointerLeave={onPreviewPointerLeave}
          >
            <div className='skin-preview-selected'>
              <div className='skin-preview-selected-title'>Selected (in game)</div>
              <div className='skin-preview-selected-value'>{selectedLabel}</div>
            </div>
            <div className='skin-preview-hint'>Drag to rotate</div>
          </div>

          <div className='skin-controls'>
            <div className={`skin-panel${solidSelected ? ' skin-panel--active' : ''}`}>
              <div className='skin-panel-title-row'>
                <div className='skin-panel-title'>Solid color</div>
                {solidSelected && <div className='skin-selected-badge'>Selected</div>}
              </div>
              <div className='skin-solid-row'>
                <button
                  type='button'
                  className='skin-arrow'
                  onClick={() => {
                    if (isExiting) return
                    onSolidPrev()
                  }}
                  disabled={isExiting}
                  aria-label='Previous color'
                >
                  ←
                </button>
                <button
                  type='button'
                  className='skin-solid-chip'
                  disabled={isExiting}
                  onClick={() => {
                    if (isExiting) return
                    onSelectSolid(solidColor)
                  }}
                  aria-label='Select solid color'
                >
                  <span className='skin-solid-swatch' style={{ background: solidColor }} />
                  <span className='skin-solid-hex'>{solidColor}</span>
                </button>
                <button
                  type='button'
                  className='skin-arrow'
                  onClick={() => {
                    if (isExiting) return
                    onSolidNext()
                  }}
                  disabled={isExiting}
                  aria-label='Next color'
                >
                  →
                </button>
              </div>
            </div>

            <div className='skin-panel skin-panel--designs'>
              <div className='skin-panel-title'>Saved designs</div>
              {designs.length === 0 ? (
                <div className='skin-empty'>No saved designs yet.</div>
              ) : (
                <div className='skin-design-list'>
                  {designs.map((design) => {
                    const active = selected.kind === 'design' && selected.id === design.id
                    return (
                      <div
                        key={design.id}
                        className={`skin-design-row${active ? ' skin-design-row--active' : ''}`}
                      >
                        <button
                          type='button'
                          className='skin-design-select'
                          disabled={isExiting}
                          onClick={() => {
                            if (isExiting) return
                            onSelectDesign(design.id)
                          }}
                        >
                          <div className='skin-design-main'>
                            <div className='skin-design-name-row'>
                              <div className='skin-design-name'>{design.name}</div>
                              {active && <div className='skin-selected-badge'>Selected</div>}
                            </div>
                            <SwatchRow colors={design.colors} />
                          </div>
                        </button>
                        <button
                          type='button'
                          className='skin-design-delete'
                          disabled={isExiting}
                          onClick={(event) => {
                            event.preventDefault()
                            event.stopPropagation()
                            if (isExiting) return
                            onDeleteDesign(design.id)
                          }}
                        >
                          Delete
                        </button>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>

            <div className='skin-footer'>
              <button
                type='button'
                className='skin-secondary'
                disabled={isExiting}
                onClick={() => !isExiting && onBack()}
              >
                Back
              </button>
              <button
                type='button'
                className='skin-primary'
                disabled={isExiting}
                onClick={() => !isExiting && onBuild()}
              >
                Build a snake
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
