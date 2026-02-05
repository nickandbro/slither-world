import type { GameStateSnapshot, PlayerSnapshot, Point } from './types'

export type PlayerMeta = {
  name: string
  color: string
}

const VERSION = 1

const TYPE_JOIN = 0x01
const TYPE_INPUT = 0x02
const TYPE_RESPAWN = 0x03

const TYPE_INIT = 0x10
const TYPE_STATE = 0x11
const TYPE_PLAYER_META = 0x12

const FLAG_JOIN_PLAYER_ID = 1 << 0
const FLAG_JOIN_NAME = 1 << 1

const FLAG_INPUT_AXIS = 1 << 0
const FLAG_INPUT_BOOST = 1 << 1

const MAX_STRING_BYTES = 255

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

export type DecodedMessage =
  | { type: 'init'; playerId: string; state: GameStateSnapshot }
  | { type: 'state'; state: GameStateSnapshot }
  | { type: 'meta' }

export function encodeJoin(name: string | null, playerId: string | null): ArrayBuffer {
  const idBytes = playerId ? uuidToBytes(playerId) : null
  const nameBytes = name !== null ? encodeString(name) : null
  let flags = 0
  if (idBytes) flags |= FLAG_JOIN_PLAYER_ID
  if (nameBytes) flags |= FLAG_JOIN_NAME

  const length = 4 + (idBytes ? 16 : 0) + (nameBytes ? 1 + nameBytes.length : 0)
  const buffer = new ArrayBuffer(length)
  const view = new DataView(buffer)
  let offset = 0
  offset = writeHeader(view, offset, TYPE_JOIN, flags)
  if (idBytes) {
    new Uint8Array(buffer, offset, 16).set(idBytes)
    offset += 16
  }
  if (nameBytes) {
    view.setUint8(offset, nameBytes.length)
    offset += 1
    new Uint8Array(buffer, offset, nameBytes.length).set(nameBytes)
    offset += nameBytes.length
  }
  return buffer
}

export function encodeInput(axis: Point | null, boost: boolean): ArrayBuffer {
  let flags = 0
  if (axis) flags |= FLAG_INPUT_AXIS
  if (boost) flags |= FLAG_INPUT_BOOST

  const length = 4 + (axis ? 12 : 0)
  const buffer = new ArrayBuffer(length)
  const view = new DataView(buffer)
  let offset = 0
  offset = writeHeader(view, offset, TYPE_INPUT, flags)
  if (axis) {
    view.setFloat32(offset, axis.x, true)
    view.setFloat32(offset + 4, axis.y, true)
    view.setFloat32(offset + 8, axis.z, true)
  }
  return buffer
}

export function encodeRespawn(): ArrayBuffer {
  const buffer = new ArrayBuffer(4)
  const view = new DataView(buffer)
  writeHeader(view, 0, TYPE_RESPAWN, 0)
  return buffer
}

export function decodeServerMessage(
  buffer: ArrayBuffer,
  meta: Map<string, PlayerMeta>,
): DecodedMessage | null {
  const reader = new Reader(buffer)
  const version = reader.readU8()
  if (version === null || version !== VERSION) return null
  const messageType = reader.readU8()
  if (messageType === null) return null
  const flags = reader.readU16()
  if (flags === null) return null

  switch (messageType) {
    case TYPE_INIT:
      return decodeInit(reader, meta)
    case TYPE_STATE:
      return decodeState(reader, meta)
    case TYPE_PLAYER_META:
      decodeMeta(reader, meta)
      return { type: 'meta' }
    default:
      return null
  }
}

function decodeInit(reader: Reader, meta: Map<string, PlayerMeta>): DecodedMessage | null {
  const playerId = reader.readUuid()
  const now = reader.readI64()
  const pelletsCount = reader.readU16()
  if (playerId === null || now === null || pelletsCount === null) return null

  const pellets = readPoints(reader, pelletsCount)
  if (!pellets) return null

  const metaCount = reader.readU16()
  if (metaCount === null) return null
  for (let i = 0; i < metaCount; i += 1) {
    const id = reader.readUuid()
    const name = reader.readString()
    const color = reader.readString()
    if (id === null || name === null || color === null) return null
    meta.set(id, { name, color })
  }

  const players = readPlayerStates(reader, meta)
  if (!players) return null

  return {
    type: 'init',
    playerId,
    state: { now, pellets, players },
  }
}

function decodeState(reader: Reader, meta: Map<string, PlayerMeta>): DecodedMessage | null {
  const now = reader.readI64()
  const pelletsCount = reader.readU16()
  if (now === null || pelletsCount === null) return null

  const pellets = readPoints(reader, pelletsCount)
  if (!pellets) return null

  const players = readPlayerStates(reader, meta)
  if (!players) return null

  return {
    type: 'state',
    state: { now, pellets, players },
  }
}

function decodeMeta(reader: Reader, meta: Map<string, PlayerMeta>) {
  const metaCount = reader.readU16()
  if (metaCount === null) return
  for (let i = 0; i < metaCount; i += 1) {
    const id = reader.readUuid()
    const name = reader.readString()
    const color = reader.readString()
    if (id === null || name === null || color === null) return
    meta.set(id, { name, color })
  }
}

function readPlayerStates(reader: Reader, meta: Map<string, PlayerMeta>): PlayerSnapshot[] | null {
  const playerCount = reader.readU16()
  if (playerCount === null) return null

  const players: PlayerSnapshot[] = []
  for (let i = 0; i < playerCount; i += 1) {
    const id = reader.readUuid()
    const aliveRaw = reader.readU8()
    const score = reader.readI32()
    const stamina = reader.readF32()
    const snakeLen = reader.readU16()
    if (id === null || aliveRaw === null || score === null || stamina === null || snakeLen === null) {
      return null
    }

    const snake = readPoints(reader, snakeLen)
    if (!snake) return null

    const digestionsLen = reader.readU8()
    if (digestionsLen === null) return null
    const digestions: number[] = []
    for (let j = 0; j < digestionsLen; j += 1) {
      const value = reader.readF32()
      if (value === null) return null
      digestions.push(value)
    }

    const metaEntry = meta.get(id)
    players.push({
      id,
      name: metaEntry?.name ?? 'Player',
      color: metaEntry?.color ?? '#ffffff',
      score,
      stamina,
      alive: aliveRaw === 1,
      snake,
      digestions,
    })
  }

  return players
}

function readPoints(reader: Reader, count: number): Point[] | null {
  const points: Point[] = []
  for (let i = 0; i < count; i += 1) {
    const x = reader.readF32()
    const y = reader.readF32()
    const z = reader.readF32()
    if (x === null || y === null || z === null) return null
    points.push({ x, y, z })
  }
  return points
}

function writeHeader(view: DataView, offset: number, messageType: number, flags: number) {
  view.setUint8(offset, VERSION)
  view.setUint8(offset + 1, messageType)
  view.setUint16(offset + 2, flags, true)
  return offset + 4
}

function encodeString(value: string): Uint8Array {
  const raw = textEncoder.encode(value)
  if (raw.length <= MAX_STRING_BYTES) return raw

  let result = ''
  let used = 0
  for (const ch of value) {
    const chunk = textEncoder.encode(ch)
    if (used + chunk.length > MAX_STRING_BYTES) break
    result += ch
    used += chunk.length
  }
  return textEncoder.encode(result)
}

function uuidToBytes(uuid: string): Uint8Array | null {
  const hex = uuid.replace(/-/g, '').toLowerCase()
  if (!/^[0-9a-f]{32}$/.test(hex)) return null
  const bytes = new Uint8Array(16)
  for (let i = 0; i < 16; i += 1) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return bytes
}

function bytesToUuid(bytes: Uint8Array): string {
  const hex = Array.from(bytes)
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

class Reader {
  private view: DataView
  private offset = 0

  constructor(buffer: ArrayBuffer) {
    this.view = new DataView(buffer)
  }

  readU8(): number | null {
    if (!this.ensure(1)) return null
    const value = this.view.getUint8(this.offset)
    this.offset += 1
    return value
  }

  readU16(): number | null {
    if (!this.ensure(2)) return null
    const value = this.view.getUint16(this.offset, true)
    this.offset += 2
    return value
  }

  readI32(): number | null {
    if (!this.ensure(4)) return null
    const value = this.view.getInt32(this.offset, true)
    this.offset += 4
    return value
  }

  readI64(): number | null {
    if (!this.ensure(8)) return null
    const value = this.view.getBigInt64(this.offset, true)
    this.offset += 8
    return Number(value)
  }

  readF32(): number | null {
    if (!this.ensure(4)) return null
    const value = this.view.getFloat32(this.offset, true)
    this.offset += 4
    return value
  }

  readUuid(): string | null {
    if (!this.ensure(16)) return null
    const bytes = new Uint8Array(this.view.buffer, this.offset, 16)
    this.offset += 16
    return bytesToUuid(bytes)
  }

  readString(): string | null {
    const length = this.readU8()
    if (length === null) return null
    if (!this.ensure(length)) return null
    const bytes = new Uint8Array(this.view.buffer, this.offset, length)
    this.offset += length
    return textDecoder.decode(bytes)
  }

  private ensure(size: number) {
    return this.offset + size <= this.view.byteLength
  }
}
