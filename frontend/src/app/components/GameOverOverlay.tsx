type GameOverOverlayProps = {
  onRespawn: () => void
}

export function GameOverOverlay({ onRespawn }: GameOverOverlayProps) {
  return (
    <div className='overlay'>
      <div className='overlay-title'>Good game!</div>
      <div className='overlay-subtitle'>Your trail is still glowing.</div>
      <button type='button' onClick={onRespawn}>
        Play again
      </button>
    </div>
  )
}
