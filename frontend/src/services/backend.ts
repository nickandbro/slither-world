const rawBackendUrl = (import.meta.env.VITE_BACKEND_URL as string | undefined) ?? ''
const trimmedBackendUrl = rawBackendUrl.replace(/\/+$/, '')

export function resolveApiUrl(path: string) {
  const normalized = path.startsWith('/') ? path : `/${path}`
  if (!trimmedBackendUrl) return normalized
  return `${trimmedBackendUrl}${normalized}`
}

export function resolveWebSocketUrl(path: string) {
  const normalized = path.startsWith('/') ? path : `/${path}`
  if (trimmedBackendUrl) {
    const url = new URL(trimmedBackendUrl)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    return `${url.origin}${normalized}`
  }
  const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws'
  return `${protocol}://${window.location.host}${normalized}`
}
