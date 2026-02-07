import type { MenuPhase } from '../core/menuCamera'

type MenuOverlayProps = {
  playerName: string
  connectionStatus: string
  menuPhase: MenuPhase
  onPlayerNameChange: (value: string) => void
  onPlay: () => void
}

export function MenuOverlay({
  playerName,
  connectionStatus,
  menuPhase,
  onPlayerNameChange,
  onPlay,
}: MenuOverlayProps) {
  return (
    <div className='menu-overlay'>
      <div className='menu-hero'>
        <div className='menu-title menu-title--logo-o' aria-label='Slither World'>
          <span>Slither W</span>
          <img
            src='/images/menu-snake-logo.png'
            alt=''
            aria-hidden='true'
            className='menu-title-o-logo'
            loading='lazy'
            decoding='async'
          />
          <span>rld</span>
        </div>

        <div className='menu-input-row'>
          <input
            id='player-name'
            value={playerName}
            onChange={(event) => onPlayerNameChange(event.target.value)}
            placeholder='Leave blank for random'
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                onPlay()
              }
            }}
          />
        </div>

        <button
          type='button'
          className='menu-play-button'
          disabled={connectionStatus !== 'Connected' || menuPhase === 'spawning'}
          onClick={onPlay}
        >
          Play
        </button>
      </div>
    </div>
  )
}
