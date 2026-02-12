import { normalizeHexColor } from '@shared/color/hex'
import {
  readLocalStorageJson,
  writeLocalStorage,
} from '@shared/storage/localStorage'

export const SKIN_PALETTE_COLORS = [
  '#ff5f6d',
  '#ffc857',
  '#5cff8d',
  '#5dc9ff',
  '#9f7bff',
  '#ff7bcb',
  '#ffd86b',
  '#6bffea',
  '#8be15b',
  '#ff9642',
  '#6f8bff',
  '#f9ff6b',
]

const STORAGE_SKINS_KEY = 'spherical_snake_skins_v1'
const STORAGE_SELECTED_KEY = 'spherical_snake_selected_skin_v1'

export const MAX_SAVED_SKIN_DESIGNS = 5
export const SNAKE_PATTERN_LEN = 8

export type SnakeSkinDesignV1 = {
  id: string
  name: string
  // Exactly SNAKE_PATTERN_LEN colors, `#rrggbb`.
  colors: string[]
  createdAt: number
}

export type SelectedSkinV1 =
  | { kind: 'solid'; color: string }
  | { kind: 'design'; id: string }

export const DEFAULT_SOLID_SKIN: SelectedSkinV1 = {
  kind: 'solid',
  color: SKIN_PALETTE_COLORS[0] ?? '#ffffff',
}

const randomId = () => {
  try {
    return crypto.randomUUID()
  } catch {
    return `${Date.now()}-${Math.floor(Math.random() * 1e9)}`
  }
}

export const normalizeSkinColors = (colors: unknown): string[] | null => {
  if (!Array.isArray(colors)) return null
  const out: string[] = []
  for (const entry of colors) {
    const normalized = normalizeHexColor(entry)
    if (!normalized) return null
    out.push(normalized)
  }
  if (out.length !== SNAKE_PATTERN_LEN) return null
  return out
}

export const getSavedSkinDesigns = (): SnakeSkinDesignV1[] => {
  const parsed = readLocalStorageJson<unknown>(STORAGE_SKINS_KEY)
  if (!Array.isArray(parsed)) return []
  const designs: SnakeSkinDesignV1[] = []
  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object') continue
    const obj = entry as Record<string, unknown>
    const id = typeof obj.id === 'string' ? obj.id : null
    const name = typeof obj.name === 'string' ? obj.name : null
    const createdAt = typeof obj.createdAt === 'number' ? obj.createdAt : null
    const colors = normalizeSkinColors(obj.colors)
    if (!id || !name || !createdAt || !colors) continue
    designs.push({ id, name, createdAt, colors })
    if (designs.length >= MAX_SAVED_SKIN_DESIGNS) break
  }
  // Stable sort so UI is consistent even if storage is unordered.
  designs.sort((a, b) => (b.createdAt - a.createdAt) || a.name.localeCompare(b.name))
  return designs
}

const storeSavedSkinDesigns = (designs: SnakeSkinDesignV1[]) => {
  const clamped = designs.slice(0, MAX_SAVED_SKIN_DESIGNS)
  writeLocalStorage(STORAGE_SKINS_KEY, JSON.stringify(clamped))
}

export const getSelectedSkin = (): SelectedSkinV1 => {
  const parsed = readLocalStorageJson<unknown>(STORAGE_SELECTED_KEY)
  if (!parsed || typeof parsed !== 'object') return DEFAULT_SOLID_SKIN
  const obj = parsed as Record<string, unknown>
  const kind = obj.kind
  if (kind === 'solid') {
    const color = normalizeHexColor(obj.color)
    return color ? { kind: 'solid', color } : DEFAULT_SOLID_SKIN
  }
  if (kind === 'design') {
    const id = typeof obj.id === 'string' ? obj.id : null
    return id ? { kind: 'design', id } : DEFAULT_SOLID_SKIN
  }
  return DEFAULT_SOLID_SKIN
}

export const storeSelectedSkin = (selected: SelectedSkinV1) => {
  writeLocalStorage(STORAGE_SELECTED_KEY, JSON.stringify(selected))
}

export const resolveSelectedSkinColors = (
  selected: SelectedSkinV1,
  designs: SnakeSkinDesignV1[],
): string[] => {
  if (selected.kind === 'solid') {
    const color = normalizeHexColor(selected.color) ?? (DEFAULT_SOLID_SKIN as { color: string }).color
    return new Array(SNAKE_PATTERN_LEN).fill(color)
  }
  const design = designs.find((d) => d.id === selected.id) ?? null
  if (!design) {
    return new Array(SNAKE_PATTERN_LEN).fill((DEFAULT_SOLID_SKIN as { color: string }).color)
  }
  return design.colors.slice(0, SNAKE_PATTERN_LEN)
}

export const createSkinDesign = (name: string, colors: string[]): SnakeSkinDesignV1 | null => {
  const trimmed = name.trim()
  if (!trimmed) return null
  const normalized = normalizeSkinColors(colors)
  if (!normalized) return null
  return {
    id: randomId(),
    name: trimmed,
    colors: normalized,
    createdAt: Date.now(),
  }
}

export const saveSkinDesign = (design: SnakeSkinDesignV1): { ok: true } | { ok: false; error: string } => {
  if (typeof window === 'undefined') return { ok: false, error: 'unavailable' }
  const existing = getSavedSkinDesigns()
  if (existing.length >= MAX_SAVED_SKIN_DESIGNS) {
    return { ok: false, error: 'max' }
  }
  const next = [design, ...existing].slice(0, MAX_SAVED_SKIN_DESIGNS)
  storeSavedSkinDesigns(next)
  return { ok: true }
}

export const deleteSkinDesign = (id: string) => {
  if (typeof window === 'undefined') return
  const existing = getSavedSkinDesigns()
  const next = existing.filter((d) => d.id !== id)
  if (next.length === existing.length) return
  storeSavedSkinDesigns(next)
}
