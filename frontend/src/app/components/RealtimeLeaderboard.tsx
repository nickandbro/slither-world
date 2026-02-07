export type RealtimeLeaderboardEntry = {
  id: string
  name: string
  score: number
}

type RealtimeLeaderboardProps = {
  entries: RealtimeLeaderboardEntry[]
}

export function RealtimeLeaderboard({ entries }: RealtimeLeaderboardProps) {
  return (
    <aside className='leaderboard' aria-label='Realtime leaderboard'>
      <h2>Leaderboard</h2>
      <ol>
        {entries.length === 0 && (
          <li className='leaderboard-empty'>No active snakes</li>
        )}
        {entries.map((entry, index) => {
          const rank = index + 1
          return (
            <li
              key={entry.id}
              className={`leaderboard-row ${rank <= 3 ? `leaderboard-row--top-${rank}` : ''}`}
            >
              <span className='leaderboard-rank'>
                #{rank}
                {rank === 1 && (
                  <span className='leaderboard-crown' aria-hidden='true'>
                    <svg viewBox='0 0 24 24' focusable='false'>
                      <path d='M3 18h18l-1.6-9.4-4.8 3.7-2.6-6.1-2.6 6.1-4.8-3.7L3 18z' />
                    </svg>
                  </span>
                )}
              </span>
              <span className='leaderboard-name'>{entry.name}</span>
              <span className='leaderboard-score'>{entry.score}</span>
            </li>
          )
        })}
      </ol>
    </aside>
  )
}
