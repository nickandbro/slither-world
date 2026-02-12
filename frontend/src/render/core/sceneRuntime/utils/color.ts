import * as THREE from 'three'

export type Rgb8 = { r: number; g: number; b: number }

export const parseHexColor = (value: string): Rgb8 | null => {
  const trimmed = value.trim().toLowerCase()
  const match = /^#([0-9a-f]{6})$/.exec(trimmed)
  if (!match) return null
  const hex = match[1]
  const r = Number.parseInt(hex.slice(0, 2), 16)
  const g = Number.parseInt(hex.slice(2, 4), 16)
  const b = Number.parseInt(hex.slice(4, 6), 16)
  if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) return null
  return { r, g, b }
}

export const normalizeHexColor = (value: string) => {
  const rgb = parseHexColor(value)
  if (!rgb) return null
  const rr = rgb.r.toString(16).padStart(2, '0')
  const gg = rgb.g.toString(16).padStart(2, '0')
  const bb = rgb.b.toString(16).padStart(2, '0')
  return `#${rr}${gg}${bb}`
}

export const colorToCss = (color: THREE.Color) => {
  const r = Math.round(Math.min(1, Math.max(0, color.r)) * 255)
  const g = Math.round(Math.min(1, Math.max(0, color.g)) * 255)
  const b = Math.round(Math.min(1, Math.max(0, color.b)) * 255)
  return `rgb(${r}, ${g}, ${b})`
}
