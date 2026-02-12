export type Rgb8 = {
  r: number
  g: number
  b: number
}

const HEX_COLOR_PATTERN = /^#([0-9a-f]{6})$/

export const parseHexColor = (value: string): Rgb8 | null => {
  const trimmed = value.trim().toLowerCase()
  const match = HEX_COLOR_PATTERN.exec(trimmed)
  if (!match) return null
  const hex = match[1]
  const r = Number.parseInt(hex.slice(0, 2), 16)
  const g = Number.parseInt(hex.slice(2, 4), 16)
  const b = Number.parseInt(hex.slice(4, 6), 16)
  if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) return null
  return { r, g, b }
}

export const normalizeHexColor = (value: unknown): string | null => {
  if (typeof value !== 'string') return null
  const rgb = parseHexColor(value)
  if (!rgb) return null
  const rr = rgb.r.toString(16).padStart(2, '0')
  const gg = rgb.g.toString(16).padStart(2, '0')
  const bb = rgb.b.toString(16).padStart(2, '0')
  return `#${rr}${gg}${bb}`
}

export const rgbToHexColor = (rgb: Rgb8): string => {
  const rr = Math.max(0, Math.min(255, Math.round(rgb.r))).toString(16).padStart(2, '0')
  const gg = Math.max(0, Math.min(255, Math.round(rgb.g))).toString(16).padStart(2, '0')
  const bb = Math.max(0, Math.min(255, Math.round(rgb.b))).toString(16).padStart(2, '0')
  return `#${rr}${gg}${bb}`
}

export const bytesToHexColor = (r: number, g: number, b: number): string =>
  rgbToHexColor({ r, g, b })
