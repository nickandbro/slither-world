import { MAX_SAVED_SKIN_DESIGNS, SNAKE_PATTERN_LEN } from '../../game/skins'

type SkinBuilderOverlayProps = {
  isExiting: boolean
  paletteColor: string
  pattern: Array<string | null>
  designName: string
  designsCount: number
  onPreviewPointerDown: (event: React.PointerEvent<HTMLDivElement>) => void
  onPreviewPointerMove: (event: React.PointerEvent<HTMLDivElement>) => void
  onPreviewPointerUp: (event: React.PointerEvent<HTMLDivElement>) => void
  onPreviewPointerCancel: (event: React.PointerEvent<HTMLDivElement>) => void
  onPreviewPointerLeave: (event: React.PointerEvent<HTMLDivElement>) => void
  onPalettePrev: () => void
  onPaletteNext: () => void
  onPalettePick: (color: string) => void
  onAddColor: () => void
  onPaintSlot: (index: number) => void
  onDesignNameChange: (value: string) => void
  onSave: () => void
  onBack: () => void
  onCancel: () => void
}

const PatternSlots = ({
  pattern,
  onPaintSlot,
  disabled,
}: {
  pattern: Array<string | null>
  disabled: boolean
  onPaintSlot: (index: number) => void
}) => (
  <div className='skin-pattern-row' role='group' aria-label='Snake pattern slots'>
    {Array.from({ length: SNAKE_PATTERN_LEN }).map((_, i) => {
      const color = pattern[i] ?? null
      return (
        <button
          key={i}
          type='button'
          className={`skin-pattern-slot${color ? '' : ' skin-pattern-slot--empty'}`}
          disabled={disabled}
          onClick={() => !disabled && onPaintSlot(i)}
          aria-label={color ? `Slot ${i + 1}` : `Empty slot ${i + 1}`}
          style={color ? { background: color } : undefined}
        />
      )
    })}
  </div>
)

export function SkinBuilderOverlay({
  isExiting,
  paletteColor,
  pattern,
  designName,
  designsCount,
  onPreviewPointerDown,
  onPreviewPointerMove,
  onPreviewPointerUp,
  onPreviewPointerCancel,
  onPreviewPointerLeave,
  onPalettePrev,
  onPaletteNext,
  onPalettePick,
  onAddColor,
  onPaintSlot,
  onDesignNameChange,
  onSave,
  onBack,
  onCancel,
}: SkinBuilderOverlayProps) {
  const filled = pattern.filter((c) => !!c).length
  const atMax = designsCount >= MAX_SAVED_SKIN_DESIGNS
  const full = filled >= SNAKE_PATTERN_LEN
  const canSave = filled > 0 && !atMax && designName.trim().length > 0 && !isExiting

  return (
    <div className='menu-overlay'>
      <div className='menu-hero menu-hero--skins'>
        <div className='menu-skin-title'>Build a snake</div>

        <div className='skin-screen'>
          <div
            className={`skin-preview-stage${isExiting ? ' skin-preview-stage--disabled' : ''}`}
            role='img'
            aria-label='3D snake preview'
            onPointerDown={onPreviewPointerDown}
            onPointerMove={onPreviewPointerMove}
            onPointerUp={onPreviewPointerUp}
            onPointerCancel={onPreviewPointerCancel}
            onPointerLeave={onPreviewPointerLeave}
          >
            <div className='skin-preview-selected'>
              <div className='skin-preview-selected-title'>Preview (spawn length 8)</div>
              <div className='skin-preview-selected-value'>
                {filled > 0 ? `Seed ${filled}/8 (repeats)` : 'Pick a color to start'}
              </div>
            </div>
            <div className='skin-preview-hint'>Drag to rotate</div>
          </div>

          <div className='skin-controls'>
            <div className='skin-panel'>
              <div className='skin-panel-title'>Pick a color</div>
              <div className='skin-solid-row'>
                <button
                  type='button'
                  className='skin-arrow'
                  onClick={() => !isExiting && onPalettePrev()}
                  disabled={isExiting}
                  aria-label='Previous color'
                >
                  ←
                </button>
                <div className='skin-solid-chip skin-solid-chip--static' aria-label='Current color'>
                  <label className='skin-color-picker' aria-label='Open color picker'>
                    <input
                      type='color'
                      value={paletteColor}
                      disabled={isExiting}
                      onChange={(event) => !isExiting && onPalettePick(event.target.value)}
                    />
                    <span className='skin-solid-swatch' style={{ background: paletteColor }} />
                  </label>
                  <span className='skin-solid-hex'>{paletteColor}</span>
                </div>
                <button
                  type='button'
                  className='skin-arrow'
                  onClick={() => !isExiting && onPaletteNext()}
                  disabled={isExiting}
                  aria-label='Next color'
                >
                  →
                </button>
              </div>

              <div className='skin-builder-actions'>
                <button
                  type='button'
                  className='skin-primary'
                  disabled={isExiting || full}
                  onClick={() => !isExiting && !full && onAddColor()}
                >
                  Add color
                </button>
                <div className='skin-builder-hint'>
                  {filled === 0
                    ? 'Pick 1+ colors. Your seed repeats to fill spawn length 8.'
                    : full
                      ? 'Seed full (8). Tap a slot to repaint.'
                      : `Seed ${filled}/8 (repeats)`}
                </div>
              </div>
            </div>

            <div className='skin-panel skin-panel--designs'>
              <div className='skin-panel-title'>Pattern seed</div>
              <PatternSlots pattern={pattern} onPaintSlot={onPaintSlot} disabled={isExiting} />
            </div>

            <div className='skin-panel'>
              <div className='skin-panel-title'>Design name</div>
              <input
                className='skin-design-name-input'
                value={designName}
                disabled={isExiting}
                onChange={(e) => onDesignNameChange(e.target.value)}
                placeholder='e.g. Sunset'
              />
              {atMax && (
                <div className='skin-empty'>Max designs reached (5). Delete one to save a new design.</div>
              )}
            </div>

            <div className='skin-footer skin-footer--builder'>
              <button
                type='button'
                className='skin-secondary'
                disabled={isExiting}
                onClick={() => !isExiting && onCancel()}
              >
                Cancel
              </button>
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
                disabled={!canSave}
                onClick={() => canSave && onSave()}
              >
                Save design
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
