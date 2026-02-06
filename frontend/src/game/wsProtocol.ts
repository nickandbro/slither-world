import type {
  DigestionSnapshot,
  Environment,
  GameStateSnapshot,
  PelletSnapshot,
  PlayerSnapshot,
  Point,
} from './types'

export type PlayerMeta = {
  name: string
  color: string
}

const VERSION = 6

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
const FLAG_INPUT_VIEW_CENTER = 1 << 2
const FLAG_INPUT_VIEW_RADIUS = 1 << 3
const FLAG_INPUT_CAMERA_DISTANCE = 1 << 4

const SNAKE_DETAIL_FULL = 0
const SNAKE_DETAIL_WINDOW = 1
const SNAKE_DETAIL_STUB = 2

const MAX_STRING_BYTES = 255
const PELLET_NORMAL_MAX = 32767
const PELLET_SIZE_MIN = 0.55
const PELLET_SIZE_MAX = 1.75

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

export type DecodedMessage =
  | { type: 'init'; playerId: string; state: GameStateSnapshot; environment: Environment }
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

export function encodeInput(
  axis: Point | null,
  boost: boolean,
  viewCenter: Point | null = null,
  viewRadius: number | null = null,
  cameraDistance: number | null = null,
): ArrayBuffer {
  const hasAxis = !!axis
  const hasViewCenter = !!viewCenter
  const hasViewRadius = Number.isFinite(viewRadius)
  const hasCameraDistance = Number.isFinite(cameraDistance)

  let flags = 0
  if (hasAxis) flags |= FLAG_INPUT_AXIS
  if (boost) flags |= FLAG_INPUT_BOOST
  if (hasViewCenter) flags |= FLAG_INPUT_VIEW_CENTER
  if (hasViewRadius) flags |= FLAG_INPUT_VIEW_RADIUS
  if (hasCameraDistance) flags |= FLAG_INPUT_CAMERA_DISTANCE

  const length =
    4 +
    (hasAxis ? 12 : 0) +
    (hasViewCenter ? 12 : 0) +
    (hasViewRadius ? 4 : 0) +
    (hasCameraDistance ? 4 : 0)
  const buffer = new ArrayBuffer(length)
  const view = new DataView(buffer)
  let offset = 0
  offset = writeHeader(view, offset, TYPE_INPUT, flags)
  if (axis) {
    view.setFloat32(offset, axis.x, true)
    view.setFloat32(offset + 4, axis.y, true)
    view.setFloat32(offset + 8, axis.z, true)
    offset += 12
  }
  if (viewCenter) {
    view.setFloat32(offset, viewCenter.x, true)
    view.setFloat32(offset + 4, viewCenter.y, true)
    view.setFloat32(offset + 8, viewCenter.z, true)
    offset += 12
  }
  if (hasViewRadius) {
    view.setFloat32(offset, viewRadius as number, true)
    offset += 4
  }
  if (hasCameraDistance) {
    view.setFloat32(offset, cameraDistance as number, true)
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

  const pellets = readPellets(reader, pelletsCount)
  if (!pellets) return null

  const totalPlayers = reader.readU16()
  const metaCount = reader.readU16()
  if (totalPlayers === null || metaCount === null) return null
  for (let i = 0; i < metaCount; i += 1) {
    const id = reader.readUuid()
    const name = reader.readString()
    const color = reader.readString()
    if (id === null || name === null || color === null) return null
    meta.set(id, { name, color })
  }

  const players = readPlayerStates(reader, meta)
  if (!players) return null
  const environment = readEnvironment(reader)
  if (!environment) return null

  return {
    type: 'init',
    playerId,
    state: { now, pellets, players, totalPlayers },
    environment,
  }
}

function decodeState(reader: Reader, meta: Map<string, PlayerMeta>): DecodedMessage | null {
  const now = reader.readI64()
  const pelletsCount = reader.readU16()
  if (now === null || pelletsCount === null) return null

  const pellets = readPellets(reader, pelletsCount)
  if (!pellets) return null

  const totalPlayers = reader.readU16()
  if (totalPlayers === null) return null
  const players = readPlayerStates(reader, meta)
  if (!players) return null

  return {
    type: 'state',
    state: { now, pellets, players, totalPlayers },
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
    const oxygen = reader.readF32()
    const snakeDetailRaw = reader.readU8()
    const snakeTotalLen = reader.readU16()
    if (
      id === null ||
      aliveRaw === null ||
      score === null ||
      stamina === null ||
      oxygen === null ||
      snakeDetailRaw === null ||
      snakeTotalLen === null
    ) {
      return null
    }

    let snakeDetail: PlayerSnapshot['snakeDetail'] = 'full'
    let snakeStart = 0
    let snakeLen = 0
    if (snakeDetailRaw === SNAKE_DETAIL_FULL) {
      const fullLen = reader.readU16()
      if (fullLen === null) return null
      snakeLen = fullLen
      snakeDetail = 'full'
      snakeStart = 0
    } else if (snakeDetailRaw === SNAKE_DETAIL_WINDOW) {
      const start = reader.readU16()
      const length = reader.readU16()
      if (start === null || length === null) return null
      snakeDetail = 'window'
      snakeStart = start
      snakeLen = length
    } else if (snakeDetailRaw === SNAKE_DETAIL_STUB) {
      snakeDetail = 'stub'
      snakeStart = 0
      snakeLen = 0
    } else {
      return null
    }

    if (snakeStart + snakeLen > snakeTotalLen) {
      return null
    }

    const snake = readPoints(reader, snakeLen)
    if (!snake) return null

    const digestionsLen = reader.readU8()
    if (digestionsLen === null) return null
    const digestions: DigestionSnapshot[] = []
    for (let j = 0; j < digestionsLen; j += 1) {
      const digestionId = reader.readU32()
      const progress = reader.readF32()
      const strength = reader.readF32()
      if (digestionId === null || progress === null || strength === null) return null
      digestions.push({ id: digestionId, progress, strength })
    }

    const metaEntry = meta.get(id)
    players.push({
      id,
      name: metaEntry?.name ?? 'Player',
      color: metaEntry?.color ?? '#ffffff',
      score,
      stamina,
      oxygen,
      alive: aliveRaw === 1,
      snakeDetail,
      snakeStart,
      snakeTotalLen,
      snake,
      digestions,
    })
  }

  return players
}

function readEnvironment(reader: Reader): Environment | null {
  const lakeCount = reader.readU16()
  if (lakeCount === null) return null
  const lakes: Environment['lakes'] = []
  for (let i = 0; i < lakeCount; i += 1) {
    const centerX = reader.readF32()
    const centerY = reader.readF32()
    const centerZ = reader.readF32()
    const radius = reader.readF32()
    const depth = reader.readF32()
    const shelfDepth = reader.readF32()
    const edgeFalloff = reader.readF32()
    const noiseAmplitude = reader.readF32()
    const noiseFrequency = reader.readF32()
    const noiseFrequencyB = reader.readF32()
    const noiseFrequencyC = reader.readF32()
    const noisePhase = reader.readF32()
    const noisePhaseB = reader.readF32()
    const noisePhaseC = reader.readF32()
    const warpAmplitude = reader.readF32()
    const surfaceInset = reader.readF32()
    if (
      centerX === null ||
      centerY === null ||
      centerZ === null ||
      radius === null ||
      depth === null ||
      shelfDepth === null ||
      edgeFalloff === null ||
      noiseAmplitude === null ||
      noiseFrequency === null ||
      noiseFrequencyB === null ||
      noiseFrequencyC === null ||
      noisePhase === null ||
      noisePhaseB === null ||
      noisePhaseC === null ||
      warpAmplitude === null ||
      surfaceInset === null
    ) {
      return null
    }
    lakes.push({
      center: { x: centerX, y: centerY, z: centerZ },
      radius,
      depth,
      shelfDepth,
      edgeFalloff,
      noiseAmplitude,
      noiseFrequency,
      noiseFrequencyB,
      noiseFrequencyC,
      noisePhase,
      noisePhaseB,
      noisePhaseC,
      warpAmplitude,
      surfaceInset,
    })
  }

  const treeCount = reader.readU16()
  if (treeCount === null) return null
  const trees: Environment['trees'] = []
  for (let i = 0; i < treeCount; i += 1) {
    const nx = reader.readF32()
    const ny = reader.readF32()
    const nz = reader.readF32()
    const widthScale = reader.readF32()
    const heightScale = reader.readF32()
    const twist = reader.readF32()
    if (
      nx === null ||
      ny === null ||
      nz === null ||
      widthScale === null ||
      heightScale === null ||
      twist === null
    ) {
      return null
    }
    trees.push({
      normal: { x: nx, y: ny, z: nz },
      widthScale,
      heightScale,
      twist,
    })
  }

  const mountainCount = reader.readU16()
  if (mountainCount === null) return null
  const mountains: Environment['mountains'] = []
  for (let i = 0; i < mountainCount; i += 1) {
    const nx = reader.readF32()
    const ny = reader.readF32()
    const nz = reader.readF32()
    const radius = reader.readF32()
    const height = reader.readF32()
    const variant = reader.readU8()
    const twist = reader.readF32()
    const outlineLen = reader.readU16()
    if (
      nx === null ||
      ny === null ||
      nz === null ||
      radius === null ||
      height === null ||
      variant === null ||
      twist === null ||
      outlineLen === null
    ) {
      return null
    }
    const outline: number[] = []
    for (let j = 0; j < outlineLen; j += 1) {
      const value = reader.readF32()
      if (value === null) return null
      outline.push(value)
    }
    mountains.push({
      normal: { x: nx, y: ny, z: nz },
      radius,
      height,
      variant,
      twist,
      outline,
    })
  }

  return { lakes, trees, mountains }
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

function readPellets(reader: Reader, count: number): PelletSnapshot[] | null {
  const pellets: PelletSnapshot[] = []
  for (let i = 0; i < count; i += 1) {
    const id = reader.readU32()
    const qx = reader.readI16()
    const qy = reader.readI16()
    const qz = reader.readI16()
    const colorIndex = reader.readU8()
    const sizeQ = reader.readU8()
    if (
      id === null ||
      qx === null ||
      qy === null ||
      qz === null ||
      colorIndex === null ||
      sizeQ === null
    ) {
      return null
    }
    const x = qx / PELLET_NORMAL_MAX
    const y = qy / PELLET_NORMAL_MAX
    const z = qz / PELLET_NORMAL_MAX
    const len = Math.hypot(x, y, z)
    const invLen = Number.isFinite(len) && len > 1e-6 ? 1 / len : 0
    const sizeT = sizeQ / 255
    pellets.push({
      id,
      x: invLen > 0 ? x * invLen : 0,
      y: invLen > 0 ? y * invLen : 0,
      z: invLen > 0 ? z * invLen : 1,
      colorIndex,
      size: PELLET_SIZE_MIN + (PELLET_SIZE_MAX - PELLET_SIZE_MIN) * sizeT,
    })
  }
  return pellets
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

  readI16(): number | null {
    if (!this.ensure(2)) return null
    const value = this.view.getInt16(this.offset, true)
    this.offset += 2
    return value
  }

  readI32(): number | null {
    if (!this.ensure(4)) return null
    const value = this.view.getInt32(this.offset, true)
    this.offset += 4
    return value
  }

  readU32(): number | null {
    if (!this.ensure(4)) return null
    const value = this.view.getUint32(this.offset, true)
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
