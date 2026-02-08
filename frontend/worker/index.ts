import type { Env } from './env'

type RoomTokenClaims = {
  roomId: string
  origin: string
  exp: number
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    if (url.pathname === '/api/matchmake') {
      return proxyMatchmake(request, env)
    }
    if (url.pathname.startsWith('/api/room/')) {
      return proxyRoomWebSocket(request, env, url)
    }
    return env.ASSETS.fetch(request)
  },
} satisfies ExportedHandler<Env>

async function proxyMatchmake(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 })
  }
  if (!env.CONTROL_PLANE_ORIGIN) {
    return new Response('CONTROL_PLANE_ORIGIN not configured', { status: 500 })
  }
  const upstreamUrl = new URL('/api/matchmake', env.CONTROL_PLANE_ORIGIN).toString()
  const upstreamRequest = new Request(upstreamUrl, request)
  return fetch(upstreamRequest)
}

async function proxyRoomWebSocket(request: Request, env: Env, url: URL): Promise<Response> {
  if (!env.ROOM_TOKEN_SECRET || !env.ROOM_PROXY_SECRET) {
    return new Response('Worker secrets not configured', { status: 500 })
  }
  if (request.method !== 'GET') {
    return new Response('Method Not Allowed', { status: 405 })
  }
  const upgrade = request.headers.get('Upgrade')
  if (!upgrade || upgrade.toLowerCase() !== 'websocket') {
    return new Response('Expected Upgrade: websocket', { status: 426 })
  }

  const roomId = decodeURIComponent(url.pathname.slice('/api/room/'.length))
  if (!roomId) {
    return new Response('Missing room ID', { status: 400 })
  }
  const token = url.searchParams.get('rt')
  if (!token) {
    return new Response('Missing room token', { status: 401 })
  }

  const claims = await verifyRoomToken(token, env.ROOM_TOKEN_SECRET)
  if (!claims || claims.exp <= Date.now()) {
    return new Response('Invalid room token', { status: 401 })
  }
  if (claims.roomId !== roomId) {
    return new Response('Room token mismatch', { status: 401 })
  }

  const normalizedOrigin = normalizeRoomOrigin(claims.origin)
  const upstreamUrl = new URL(
    `/api/room/${encodeURIComponent(roomId)}`,
    normalizedOrigin.endsWith('/') ? normalizedOrigin : `${normalizedOrigin}/`,
  )
  const upstreamRequest = new Request(upstreamUrl.toString(), request)
  upstreamRequest.headers.set('x-room-proxy-secret', env.ROOM_PROXY_SECRET)

  try {
    return await fetch(upstreamRequest)
  } catch (error) {
    console.error('ws_proxy_fetch_error', error)
    return new Response('Upstream websocket connect failed', { status: 502 })
  }
}

async function verifyRoomToken(token: string, secret: string): Promise<RoomTokenClaims | null> {
  const parts = token.split('.')
  if (parts.length !== 2) return null
  const [payloadB64, signatureB64] = parts
  if (!payloadB64 || !signatureB64) return null

  const expectedSignature = await signPayload(payloadB64, secret)
  if (!constantTimeEqual(signatureB64, expectedSignature)) {
    return null
  }

  let payloadJson = ''
  try {
    payloadJson = new TextDecoder().decode(base64UrlDecode(payloadB64))
  } catch {
    return null
  }

  let claims: unknown
  try {
    claims = JSON.parse(payloadJson)
  } catch {
    return null
  }
  if (!isRoomTokenClaims(claims)) {
    return null
  }
  return claims
}

function isRoomTokenClaims(value: unknown): value is RoomTokenClaims {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<RoomTokenClaims>
  return (
    typeof candidate.roomId === 'string' &&
    typeof candidate.origin === 'string' &&
    typeof candidate.exp === 'number'
  )
}

async function signPayload(payloadB64: string, secret: string): Promise<string> {
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(payloadB64))
  return base64UrlEncode(new Uint8Array(signature))
}

function base64UrlEncode(data: Uint8Array): string {
  let binary = ''
  for (const byte of data) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function base64UrlDecode(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=')
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return diff === 0
}

function normalizeRoomOrigin(origin: string): string {
  let parsed: URL
  try {
    parsed = new URL(origin)
  } catch {
    return origin
  }

  if (isIpv4Address(parsed.hostname)) {
    const reversed = parsed.hostname.split('.').reverse().join('.')
    parsed.hostname = `static.${reversed}.clients.your-server.de`
  }
  return parsed.toString()
}

function isIpv4Address(hostname: string): boolean {
  const parts = hostname.split('.')
  if (parts.length !== 4) return false
  return parts.every((part) => {
    if (!/^\d+$/.test(part)) return false
    const value = Number(part)
    return Number.isInteger(value) && value >= 0 && value <= 255
  })
}
