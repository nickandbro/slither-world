import { resolveApiUrl } from './backend'

export type LeaderboardEntry = {
  name: string
  score: number
  created_at: number
}

export async function fetchLeaderboard() {
  const res = await fetch(resolveApiUrl('/api/leaderboard'))
  const data = (await res.json()) as { scores?: LeaderboardEntry[] }
  return data.scores ?? []
}

export async function submitBestScore(name: string, score: number) {
  const res = await fetch(resolveApiUrl('/api/leaderboard'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name,
      score,
    }),
  })

  let data: { ok?: boolean; error?: string } = {}
  try {
    data = (await res.json()) as { ok?: boolean; error?: string }
  } catch {
    data = {}
  }

  if (!res.ok || !data.ok) {
    return { ok: false, error: data.error ?? 'Submission failed' }
  }

  return { ok: true }
}
