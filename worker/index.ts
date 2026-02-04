import type { Env } from './env'
import { handleLeaderboard } from './api/leaderboard'
import { handleRoom } from './api/room'
import { jsonResponse } from './shared/http'
import { GameRoom } from './game/room'

export default {
  async fetch(request, env) {
    const url = new URL(request.url)

    if (url.pathname === '/api/leaderboard') {
      return handleLeaderboard(request, env, url)
    }

    if (url.pathname.startsWith('/api/room/')) {
      const room = decodeURIComponent(url.pathname.replace('/api/room/', '')) || 'default'
      return handleRoom(request, env, room)
    }

    if (url.pathname === '/api/health') {
      return jsonResponse({ ok: true })
    }

    if (url.pathname.startsWith('/api/')) {
      return jsonResponse({ ok: false, error: 'Unknown endpoint' }, { status: 404 })
    }

    return env.ASSETS.fetch(request)
  },
} satisfies ExportedHandler<Env>

export { GameRoom }
