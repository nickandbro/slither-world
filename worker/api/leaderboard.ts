import type { Env } from '../env'
import { jsonResponse } from '../shared/http'
import { sanitizePlayerName } from '../shared/names'

const MAX_SCORE = 1000000
const DEFAULT_LIMIT = 10
const MAX_LIMIT = 50

export async function handleLeaderboard(request: Request, env: Env, url: URL) {
  if (request.method === 'GET') {
    const limitParam = Number(url.searchParams.get('limit'))
    const limit = Number.isFinite(limitParam)
      ? Math.min(Math.max(Math.floor(limitParam), 1), MAX_LIMIT)
      : DEFAULT_LIMIT

    const { results } = await env.DB.prepare(
      'SELECT name, score, created_at FROM scores ORDER BY score DESC, created_at ASC LIMIT ?',
    )
      .bind(limit)
      .all()

    return jsonResponse({ scores: results ?? [] })
  }

  if (request.method === 'POST') {
    let body: { name?: string; score?: number } | undefined
    try {
      body = (await request.json()) as { name?: string; score?: number }
    } catch {
      return jsonResponse({ ok: false, error: 'Invalid JSON' }, { status: 400 })
    }

    const rawName = typeof body?.name === 'string' ? body.name : 'Player'
    const name = sanitizePlayerName(rawName)
    const scoreValue = Number(body?.score)

    if (!Number.isFinite(scoreValue)) {
      return jsonResponse({ ok: false, error: 'Score must be a number' }, { status: 400 })
    }

    const score = Math.floor(scoreValue)
    if (score < 0 || score > MAX_SCORE) {
      return jsonResponse({ ok: false, error: 'Score out of range' }, { status: 400 })
    }

    const id = crypto.randomUUID()
    const createdAt = Date.now()

    await env.DB.prepare(
      'INSERT INTO scores (id, name, score, created_at) VALUES (?, ?, ?, ?)',
    )
      .bind(id, name, score, createdAt)
      .run()

    return jsonResponse({ ok: true })
  }

  return new Response('Method not allowed', { status: 405 })
}
