import type { DayNightDebugMode } from '../../render/webglScene'

type ControlPanelProps = {
  roomInput: string
  playerName: string
  debugUiEnabled: boolean
  mountainDebug: boolean
  lakeDebug: boolean
  treeDebug: boolean
  terrainTessellationDebug: boolean
  dayNightDebugMode: DayNightDebugMode
  onRoomInputChange: (value: string) => void
  onPlayerNameChange: (value: string) => void
  onJoinRoom: () => void
  onUpdatePlayerName: () => void
  onMountainDebugChange: (value: boolean) => void
  onLakeDebugChange: (value: boolean) => void
  onTreeDebugChange: (value: boolean) => void
  onTerrainTessellationDebugChange: (value: boolean) => void
  onDayNightDebugModeChange: (mode: DayNightDebugMode) => void
}

export function ControlPanel({
  roomInput,
  playerName,
  debugUiEnabled,
  mountainDebug,
  lakeDebug,
  treeDebug,
  terrainTessellationDebug,
  dayNightDebugMode,
  onRoomInputChange,
  onPlayerNameChange,
  onJoinRoom,
  onUpdatePlayerName,
  onMountainDebugChange,
  onLakeDebugChange,
  onTreeDebugChange,
  onTerrainTessellationDebugChange,
  onDayNightDebugModeChange,
}: ControlPanelProps) {
  return (
    <div className='control-panel'>
      <div className='control-row'>
        <label className='control-label' htmlFor='room-name'>
          Room
        </label>
        <input
          id='room-name'
          value={roomInput}
          onChange={(event) => onRoomInputChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              onJoinRoom()
            }
          }}
        />
        <button type='button' onClick={onJoinRoom}>
          Join
        </button>
      </div>
      <div className='control-row'>
        <label className='control-label' htmlFor='player-name'>
          Pilot name
        </label>
        <input
          id='player-name'
          value={playerName}
          onChange={(event) => onPlayerNameChange(event.target.value)}
          onBlur={onUpdatePlayerName}
        />
        <button type='button' onClick={onUpdatePlayerName}>
          Update
        </button>
      </div>
      {debugUiEnabled && (
        <div className='control-row debug-controls'>
          <label className='control-label'>Debug</label>
          <div className='debug-options' role='group' aria-label='Debug toggles'>
            <label className='debug-option'>
              <input
                type='checkbox'
                checked={mountainDebug}
                onChange={(event) => onMountainDebugChange(event.target.checked)}
              />
              Mountain outlines
            </label>
            <label className='debug-option'>
              <input
                type='checkbox'
                checked={lakeDebug}
                onChange={(event) => onLakeDebugChange(event.target.checked)}
              />
              Lake collider
            </label>
            <label className='debug-option'>
              <input
                type='checkbox'
                checked={treeDebug}
                onChange={(event) => onTreeDebugChange(event.target.checked)}
              />
              Cactus colliders
            </label>
            <label className='debug-option'>
              <input
                type='checkbox'
                checked={terrainTessellationDebug}
                onChange={(event) => onTerrainTessellationDebugChange(event.target.checked)}
              />
              Terrain wireframe
            </label>
            <div className='debug-option debug-option--select'>
              <label htmlFor='day-night-mode'>Cycle speed</label>
              <select
                id='day-night-mode'
                className='debug-select'
                value={dayNightDebugMode}
                onChange={(event) =>
                  onDayNightDebugModeChange(event.target.value as DayNightDebugMode)
                }
              >
                <option value='auto'>Normal (8 min)</option>
                <option value='accelerated'>Accelerated (30s)</option>
              </select>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
