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
  skinColors?: string[]
}

const VERSION = 16

const TYPE_JOIN = 0x01
const TYPE_INPUT = 0x02
const TYPE_RESPAWN = 0x03
const TYPE_VIEW = 0x04

const TYPE_INIT = 0x10
const TYPE_STATE = 0x11
const TYPE_PLAYER_META = 0x12
const TYPE_PELLET_DELTA = 0x13
const TYPE_PELLET_RESET = 0x14
const TYPE_STATE_DELTA = 0x15
const TYPE_PELLET_LOCK = 0x16

const FLAG_JOIN_PLAYER_ID = 1 << 0
const FLAG_JOIN_NAME = 1 << 1
const FLAG_JOIN_DEFER_SPAWN = 1 << 2
const FLAG_JOIN_SKIN = 1 << 3

const FLAG_INPUT_AXIS = 1 << 0
const FLAG_INPUT_BOOST = 1 << 1

const FLAG_VIEW_CENTER = 1 << 0
const FLAG_VIEW_RADIUS = 1 << 1
const FLAG_VIEW_CAMERA_DISTANCE = 1 << 2

const SNAKE_DETAIL_FULL = 0
const SNAKE_DETAIL_WINDOW = 1
const SNAKE_DETAIL_STUB = 2

const MAX_STRING_BYTES = 255
const PELLET_NORMAL_MAX = 32767
const PELLET_SIZE_MIN = 0.55
const PELLET_SIZE_MAX = 2.85
const VIEW_RADIUS_MIN = 0.2
const VIEW_RADIUS_MAX = 1.4
const VIEW_CAMERA_DISTANCE_MIN = 4
const VIEW_CAMERA_DISTANCE_MAX = 10

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

export type DecodedMessage =
  | {
      type: 'init'
      playerId: string
      state: GameStateSnapshot
      environment: Environment
      tickMs: number
    }
  | { type: 'state'; state: GameStateSnapshot }
  | { type: 'pellet_reset'; now: number; seq: number; pellets: PelletSnapshot[] }
  | {
      type: 'pellet_delta'
      now: number
      seq: number
      adds: PelletSnapshot[]
      updates: PelletSnapshot[]
      removes: number[]
    }
  | {
      type: 'pellet_lock'
      now: number
      seq: number
      locks: Array<{ pelletId: number; targetNetId: number }>
    }
  | { type: 'meta' }

const DELTA_FRAME_KEYFRAME = 1 << 0

const DELTA_FIELD_FLAGS = 1 << 0
const DELTA_FIELD_SCORE = 1 << 1
const DELTA_FIELD_SCORE_FRACTION = 1 << 2
const DELTA_FIELD_OXYGEN = 1 << 3
const DELTA_FIELD_GIRTH = 1 << 4
const DELTA_FIELD_TAIL_EXT = 1 << 5
const DELTA_FIELD_SNAKE = 1 << 6
const DELTA_FIELD_DIGESTIONS = 1 << 7

const DELTA_SNAKE_REBASE = 0
const DELTA_SNAKE_SHIFT_HEAD = 1

type CachedPlayerState = {
  netId: number
  flags: number
  score: number
  scoreFraction: number
  oxygen: number
  girthScale: number
  tailExtension: number
  snakeDetail: PlayerSnapshot['snakeDetail']
  snakeStart: number
  snakeTotalLen: number
  snake: Point[]
  digestions: DigestionSnapshot[]
}

const deltaDecoderState: {
  initialized: boolean
  awaitKeyframe: boolean
  lastSeq: number | null
  players: Map<number, CachedPlayerState>
} = {
  initialized: false,
  awaitKeyframe: false,
  lastSeq: null,
  players: new Map(),
}

export function resetDeltaDecoderState() {
  deltaDecoderState.initialized = false
  deltaDecoderState.awaitKeyframe = false
  deltaDecoderState.lastSeq = null
  deltaDecoderState.players.clear()
}

export function encodeJoin(
  name: string | null,
  playerId: string | null,
  deferSpawn = false,
  skinColors: string[] | null = null,
): ArrayBuffer {
  const idBytes = playerId ? uuidToBytes(playerId) : null
  const nameBytes = name !== null ? encodeString(name) : null
  const skinBytes = skinColors ? encodeSkinColors(skinColors) : null
  let flags = 0
  if (idBytes) flags |= FLAG_JOIN_PLAYER_ID
  if (nameBytes) flags |= FLAG_JOIN_NAME
  if (deferSpawn) flags |= FLAG_JOIN_DEFER_SPAWN
  if (skinBytes) flags |= FLAG_JOIN_SKIN

  const length =
    4 +
    (idBytes ? 16 : 0) +
    (nameBytes ? 1 + nameBytes.length : 0) +
    (skinBytes ? 1 + skinBytes.length : 0)
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
  if (skinBytes) {
    view.setUint8(offset, skinBytes.length / 3)
    offset += 1
    new Uint8Array(buffer, offset, skinBytes.length).set(skinBytes)
    offset += skinBytes.length
  }
  return buffer
}

export function encodeInputFast(axis: Point | null, boost: boolean): ArrayBuffer {
  const hasAxis = !!axis

  let flags = 0
  if (hasAxis) flags |= FLAG_INPUT_AXIS
  if (boost) flags |= FLAG_INPUT_BOOST

  const length = 4 + (hasAxis ? 4 : 0)
  const buffer = new ArrayBuffer(length)
  const view = new DataView(buffer)
  let offset = 0
  offset = writeHeader(view, offset, TYPE_INPUT, flags)
  if (axis) {
    const [ox, oy] = encodePointOctI16(axis)
    view.setInt16(offset, ox, true)
    view.setInt16(offset + 2, oy, true)
    offset += 4
  }
  return buffer
}

export function encodeView(
  viewCenter: Point | null,
  viewRadius: number | null,
  cameraDistance: number | null,
): ArrayBuffer {
  const hasViewCenter = !!viewCenter
  const hasViewRadius = Number.isFinite(viewRadius)
  const hasCameraDistance = Number.isFinite(cameraDistance)

  let flags = 0
  if (hasViewCenter) flags |= FLAG_VIEW_CENTER
  if (hasViewRadius) flags |= FLAG_VIEW_RADIUS
  if (hasCameraDistance) flags |= FLAG_VIEW_CAMERA_DISTANCE

  const length = 4 + (hasViewCenter ? 4 : 0) + (hasViewRadius ? 2 : 0) + (hasCameraDistance ? 2 : 0)
  const buffer = new ArrayBuffer(length)
  const view = new DataView(buffer)
  let offset = 0
  offset = writeHeader(view, offset, TYPE_VIEW, flags)
  if (viewCenter) {
    const [ox, oy] = encodePointOctI16(viewCenter)
    view.setInt16(offset, ox, true)
    view.setInt16(offset + 2, oy, true)
    offset += 4
  }
  if (hasViewRadius) {
    const q = quantizeU16Range(viewRadius as number, VIEW_RADIUS_MIN, VIEW_RADIUS_MAX)
    view.setUint16(offset, q, true)
    offset += 2
  }
  if (hasCameraDistance) {
    const q = quantizeU16Range(
      cameraDistance as number,
      VIEW_CAMERA_DISTANCE_MIN,
      VIEW_CAMERA_DISTANCE_MAX,
    )
    view.setUint16(offset, q, true)
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
  idByNetId: Map<number, string>,
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
      return decodeInit(reader, meta, idByNetId)
    case TYPE_STATE:
      return decodeState(reader, meta, idByNetId)
    case TYPE_STATE_DELTA:
      return decodeStateDelta(reader, meta, idByNetId)
    case TYPE_PLAYER_META:
      decodeMeta(reader, meta, idByNetId)
      return { type: 'meta' }
    case TYPE_PELLET_RESET:
      return decodePelletReset(reader)
    case TYPE_PELLET_DELTA:
      return decodePelletDelta(reader)
    case TYPE_PELLET_LOCK:
      return decodePelletLock(reader)
    default:
      return null
  }
}

function decodeInit(
  reader: Reader,
  meta: Map<string, PlayerMeta>,
  idByNetId: Map<number, string>,
): DecodedMessage | null {
  const playerId = reader.readUuid()
  const now = reader.readI64()
  const seq = reader.readU32()
  const tickMs = reader.readU16()
  if (playerId === null || now === null || seq === null || tickMs === null) return null
  const totalPlayers = reader.readU16()
  const metaCount = reader.readU16()
  if (totalPlayers === null || metaCount === null) return null
  for (let i = 0; i < metaCount; i += 1) {
    const netId = reader.readU16()
    const id = reader.readUuid()
    const name = reader.readString()
    const color = reader.readString()
    const skinColors = readSkinColors(reader)
    if (netId === null || id === null || name === null || color === null || skinColors === null) return null
    idByNetId.set(netId, id)
    meta.set(id, { name, color, skinColors: skinColors ?? undefined })
  }

  const players = readPlayerStates(reader, meta, idByNetId)
  if (!players) return null
  const environment = readEnvironment(reader)
  if (!environment) return null

  return {
    type: 'init',
    playerId,
    tickMs,
    state: { now, seq, pellets: [], players, totalPlayers },
    environment,
  }
}

function decodeState(
  reader: Reader,
  meta: Map<string, PlayerMeta>,
  idByNetId: Map<number, string>,
): DecodedMessage | null {
  const now = reader.readI64()
  const seq = reader.readU32()
  const totalPlayers = reader.readU16()
  if (now === null || seq === null || totalPlayers === null) return null
  const players = readPlayerStates(reader, meta, idByNetId)
  if (!players) return null

  return {
    type: 'state',
    state: { now, seq, pellets: [], players, totalPlayers },
  }
}

function decodeStateDelta(
  reader: Reader,
  meta: Map<string, PlayerMeta>,
  idByNetId: Map<number, string>,
): DecodedMessage | null {
  const now = reader.readI64()
  const seq = reader.readU32()
  const totalPlayers = reader.readU16()
  const frameFlags = reader.readU8()
  const playerCount = reader.readU16()
  if (now === null || seq === null || totalPlayers === null || frameFlags === null || playerCount === null) {
    return null
  }

  const keyframe = (frameFlags & DELTA_FRAME_KEYFRAME) !== 0
  if (!keyframe) {
    if (!deltaDecoderState.initialized || deltaDecoderState.awaitKeyframe) {
      deltaDecoderState.awaitKeyframe = true
      return null
    }
    if (deltaDecoderState.lastSeq !== null && seq !== ((deltaDecoderState.lastSeq + 1) >>> 0)) {
      deltaDecoderState.awaitKeyframe = true
      return null
    }
  }

  const prevPlayers = deltaDecoderState.players
  const nextPlayers = new Map<number, CachedPlayerState>()
  const orderedNetIds: number[] = []
  for (let i = 0; i < playerCount; i += 1) {
    const netId = reader.readU16()
    const fieldMask = reader.readU16()
    if (netId === null || fieldMask === null) return null
    const previous = prevPlayers.get(netId)

    const flags = readDeltaFlags(reader, fieldMask, previous)
    const score = readDeltaScore(reader, fieldMask, previous)
    const scoreFraction = readDeltaQ8(reader, fieldMask, DELTA_FIELD_SCORE_FRACTION, previous?.scoreFraction)
    const oxygen = readDeltaQ8(reader, fieldMask, DELTA_FIELD_OXYGEN, previous?.oxygen)
    const girthQ = readDeltaQ8AsRaw(reader, fieldMask, DELTA_FIELD_GIRTH, previous?.girthScale)
    const tailExt = readDeltaQ8(reader, fieldMask, DELTA_FIELD_TAIL_EXT, previous?.tailExtension)
    if (
      flags === null ||
      score === null ||
      scoreFraction === null ||
      oxygen === null ||
      girthQ === null ||
      tailExt === null
    ) {
      deltaDecoderState.awaitKeyframe = true
      return null
    }

    const snakeState = readDeltaSnakeState(reader, fieldMask, previous)
    if (!snakeState) {
      deltaDecoderState.awaitKeyframe = true
      return null
    }

    const digestions = readDeltaDigestions(reader, fieldMask, previous?.digestions)
    if (!digestions) {
      deltaDecoderState.awaitKeyframe = true
      return null
    }

    nextPlayers.set(netId, {
      netId,
      flags,
      score,
      scoreFraction,
      oxygen,
      girthScale: 1 + (girthQ / 255) * 1,
      tailExtension: tailExt,
      snakeDetail: snakeState.snakeDetail,
      snakeStart: snakeState.snakeStart,
      snakeTotalLen: snakeState.snakeTotalLen,
      snake: snakeState.snake,
      digestions,
    })
    orderedNetIds.push(netId)
  }

  deltaDecoderState.players = nextPlayers
  deltaDecoderState.lastSeq = seq
  deltaDecoderState.initialized = true
  deltaDecoderState.awaitKeyframe = false

  const players = orderedNetIds
    .map((netId) => {
      const cached = nextPlayers.get(netId)
      if (!cached) return null
      return cachedPlayerToSnapshot(cached, meta, idByNetId)
    })
    .filter((player): player is PlayerSnapshot => player !== null)

  return {
    type: 'state',
    state: { now, seq, pellets: [], players, totalPlayers },
  }
}

function cachedPlayerToSnapshot(
  cached: CachedPlayerState,
  meta: Map<string, PlayerMeta>,
  idByNetId: Map<number, string>,
): PlayerSnapshot {
  const id = idByNetId.get(cached.netId) ?? `net:${cached.netId}`
  const metaEntry = meta.get(id)
  return {
    id,
    name: metaEntry?.name ?? 'Player',
    color: metaEntry?.color ?? '#ffffff',
    skinColors: metaEntry?.skinColors,
    score: cached.score,
    scoreFraction: cached.scoreFraction,
    oxygen: cached.oxygen,
    isBoosting: (cached.flags & 0x02) !== 0,
    girthScale: cached.girthScale,
    tailExtension: cached.tailExtension,
    alive: (cached.flags & 0x01) !== 0,
    snakeDetail: cached.snakeDetail,
    snakeStart: cached.snakeStart,
    snakeTotalLen: cached.snakeTotalLen,
    snake: cached.snake,
    digestions: cached.digestions,
  }
}

function readDeltaFlags(
  reader: Reader,
  fieldMask: number,
  previous: CachedPlayerState | undefined,
): number | null {
  if ((fieldMask & DELTA_FIELD_FLAGS) !== 0) {
    return reader.readU8()
  }
  return previous?.flags ?? null
}

function readDeltaScore(
  reader: Reader,
  fieldMask: number,
  previous: CachedPlayerState | undefined,
): number | null {
  if ((fieldMask & DELTA_FIELD_SCORE) !== 0) {
    return reader.readVarI32()
  }
  return previous?.score ?? null
}

function readDeltaQ8(
  reader: Reader,
  fieldMask: number,
  bit: number,
  previous: number | undefined,
): number | null {
  if ((fieldMask & bit) !== 0) {
    const value = reader.readU8()
    if (value === null) return null
    return value / 255
  }
  return previous ?? null
}

function readDeltaQ8AsRaw(
  reader: Reader,
  fieldMask: number,
  bit: number,
  previousScale: number | undefined,
): number | null {
  if ((fieldMask & bit) !== 0) {
    return reader.readU8()
  }
  if (previousScale === undefined) return null
  const q = Math.round((previousScale - 1) * 255)
  return Math.max(0, Math.min(255, q))
}

function readDeltaSnakeState(
  reader: Reader,
  fieldMask: number,
  previous: CachedPlayerState | undefined,
):
  | {
      snakeDetail: PlayerSnapshot['snakeDetail']
      snakeStart: number
      snakeTotalLen: number
      snake: Point[]
    }
  | null {
  if ((fieldMask & DELTA_FIELD_SNAKE) === 0) {
    if (!previous) return null
    return {
      snakeDetail: previous.snakeDetail,
      snakeStart: previous.snakeStart,
      snakeTotalLen: previous.snakeTotalLen,
      snake: previous.snake,
    }
  }

  const op = reader.readU8()
  if (op === null) return null
  if (op === DELTA_SNAKE_REBASE) {
    const snakeDetailRaw = reader.readU8()
    const snakeTotalLen = reader.readU16()
    if (snakeDetailRaw === null || snakeTotalLen === null) return null
    let snakeDetail: PlayerSnapshot['snakeDetail'] = 'full'
    let snakeStart = 0
    let snakeLen = 0
    if (snakeDetailRaw === SNAKE_DETAIL_FULL) {
      const fullLen = reader.readU16()
      if (fullLen === null) return null
      snakeLen = fullLen
      snakeDetail = 'full'
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
    if (snakeStart + snakeLen > snakeTotalLen) return null
    const snake = readOctPoints(reader, snakeLen)
    if (!snake) return null
    return { snakeDetail, snakeStart, snakeTotalLen, snake }
  }
  if (op === DELTA_SNAKE_SHIFT_HEAD) {
    if (!previous || previous.snake.length === 0 || previous.snakeDetail === 'stub') return null
    const ox = reader.readI16()
    const oy = reader.readI16()
    if (ox === null || oy === null) return null
    const head = decodeOctI16ToPoint(ox, oy)
    const shifted = [head, ...previous.snake.slice(0, previous.snake.length - 1)]
    return {
      snakeDetail: previous.snakeDetail,
      snakeStart: previous.snakeStart,
      snakeTotalLen: previous.snakeTotalLen,
      snake: shifted,
    }
  }
  return null
}

function readDeltaDigestions(
  reader: Reader,
  fieldMask: number,
  previous: DigestionSnapshot[] | undefined,
): DigestionSnapshot[] | null {
  if ((fieldMask & DELTA_FIELD_DIGESTIONS) === 0) {
    return previous ?? []
  }
  const digestLen = reader.readU8()
  if (digestLen === null) return null
  const digestions: DigestionSnapshot[] = []
  for (let i = 0; i < digestLen; i += 1) {
    const id = reader.readU32()
    const progressQ = reader.readU16()
    const strengthQ = reader.readU8()
    if (id === null || progressQ === null || strengthQ === null) return null
    digestions.push({
      id,
      progress: progressQ / 65535,
      strength: strengthQ / 255,
    })
  }
  return digestions
}

function decodeMeta(reader: Reader, meta: Map<string, PlayerMeta>, idByNetId: Map<number, string>) {
  const metaCount = reader.readU16()
  if (metaCount === null) return
  for (let i = 0; i < metaCount; i += 1) {
    const netId = reader.readU16()
    const id = reader.readUuid()
    const name = reader.readString()
    const color = reader.readString()
    const skinColors = readSkinColors(reader)
    if (netId === null || id === null || name === null || color === null || skinColors === null) return
    idByNetId.set(netId, id)
    meta.set(id, { name, color, skinColors: skinColors ?? undefined })
  }
}

function decodePelletReset(reader: Reader): DecodedMessage | null {
  const now = reader.readI64()
  const seq = reader.readU32()
  const pelletCount = reader.readU16()
  if (now === null || seq === null || pelletCount === null) return null
  const pellets = readPellets(reader, pelletCount)
  if (!pellets) return null
  return { type: 'pellet_reset', now, seq, pellets }
}

function decodePelletDelta(reader: Reader): DecodedMessage | null {
  const now = reader.readI64()
  const seq = reader.readU32()
  const addCount = reader.readU16()
  if (now === null || seq === null || addCount === null) return null
  const adds = readPellets(reader, addCount)
  if (!adds) return null
  const updateCount = reader.readU16()
  if (updateCount === null) return null
  const updates = readPellets(reader, updateCount)
  if (!updates) return null
  const removeCount = reader.readU16()
  if (removeCount === null) return null
  const removes: number[] = []
  for (let i = 0; i < removeCount; i += 1) {
    const id = reader.readU32()
    if (id === null) return null
    removes.push(id)
  }
  return { type: 'pellet_delta', now, seq, adds, updates, removes }
}

function decodePelletLock(reader: Reader): DecodedMessage | null {
  const now = reader.readI64()
  const seq = reader.readU32()
  const lockCount = reader.readU16()
  if (now === null || seq === null || lockCount === null) return null
  const locks: Array<{ pelletId: number; targetNetId: number }> = []
  for (let i = 0; i < lockCount; i += 1) {
    const pelletId = reader.readU32()
    const targetNetId = reader.readU16()
    if (pelletId === null || targetNetId === null) return null
    locks.push({ pelletId, targetNetId })
  }
  return { type: 'pellet_lock', now, seq, locks }
}

function readPlayerStates(
  reader: Reader,
  meta: Map<string, PlayerMeta>,
  idByNetId: Map<number, string>,
): PlayerSnapshot[] | null {
  const playerCount = reader.readU16()
  if (playerCount === null) return null

  const players: PlayerSnapshot[] = []
  for (let i = 0; i < playerCount; i += 1) {
    const netId = reader.readU16()
    const flags = reader.readU8()
    const score = reader.readI32()
    const scoreFractionQ = reader.readU16()
    const oxygenQ = reader.readU16()
    const girthQ = reader.readU8()
    const tailExtQ = reader.readU8()
    const snakeDetailRaw = reader.readU8()
    const snakeTotalLen = reader.readU16()
    if (
      netId === null ||
      flags === null ||
      score === null ||
      scoreFractionQ === null ||
      oxygenQ === null ||
      girthQ === null ||
      tailExtQ === null ||
      snakeDetailRaw === null ||
      snakeTotalLen === null
    ) {
      return null
    }

    const id = idByNetId.get(netId) ?? `net:${netId}`
    const alive = (flags & 0x01) !== 0
    const isBoosting = (flags & 0x02) !== 0
    const scoreFraction = Math.min(0.999_999, Math.max(0, scoreFractionQ / 65535))
    const oxygen = Math.min(1, Math.max(0, oxygenQ / 65535))
    const girthScale = 1 + (girthQ / 255) * 1
    const tailExtension = Math.min(1, Math.max(0, tailExtQ / 255))

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

    const snake = readOctPoints(reader, snakeLen)
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
      skinColors: metaEntry?.skinColors,
      score,
      scoreFraction,
      oxygen,
      isBoosting,
      girthScale,
      tailExtension,
      alive,
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

function decodeOctI16ToPoint(xq: number, yq: number): Point {
  const inv = 1 / PELLET_NORMAL_MAX
  let x = xq * inv
  let y = yq * inv
  const z = 1 - Math.abs(x) - Math.abs(y)
  const t = Math.max(-z, 0)
  x += x >= 0 ? -t : t
  y += y >= 0 ? -t : t
  // Important: do NOT add `t` to `z` here.
  // The octahedral fold for the negative hemisphere is inverted by adjusting x/y only while
  // keeping the negative z value. Adding `t` collapses all negative-z vectors onto z=0.
  const len = Math.hypot(x, y, z)
  if (!Number.isFinite(len) || len <= 1e-6) return { x: 0, y: 0, z: 1 }
  const invLen = 1 / len
  return { x: x * invLen, y: y * invLen, z: z * invLen }
}

function encodePointOctI16(point: Point): [number, number] {
  const len = Math.hypot(point.x, point.y, point.z)
  if (!Number.isFinite(len) || len <= 1e-6) return [0, 0]
  const nx = point.x / len
  const ny = point.y / len
  const nz = point.z / len
  const l1 = Math.abs(nx) + Math.abs(ny) + Math.abs(nz)
  if (!(l1 > 1e-9)) return [0, 0]
  let ox = nx / l1
  let oy = ny / l1
  if (nz < 0) {
    const oldX = ox
    const oldY = oy
    ox = (1 - Math.abs(oldY)) * (oldX >= 0 ? 1 : -1)
    oy = (1 - Math.abs(oldX)) * (oldY >= 0 ? 1 : -1)
  }
  return [quantizeI16Unit(ox), quantizeI16Unit(oy)]
}

function quantizeI16Unit(value: number) {
  const clamped = Math.max(-1, Math.min(1, value))
  return Math.round(clamped * PELLET_NORMAL_MAX)
}

function quantizeU16Range(value: number, min: number, max: number) {
  if (!(max > min)) return 0
  const t = (value - min) / (max - min)
  const clamped = Math.max(0, Math.min(1, t))
  return Math.round(clamped * 65535)
}

function readOctPoints(reader: Reader, count: number): Point[] | null {
  const points: Point[] = []
  for (let i = 0; i < count; i += 1) {
    const x = reader.readI16()
    const y = reader.readI16()
    if (x === null || y === null) return null
    points.push(decodeOctI16ToPoint(x, y))
  }
  return points
}

function readPellets(reader: Reader, count: number): PelletSnapshot[] | null {
  const pellets: PelletSnapshot[] = []
  for (let i = 0; i < count; i += 1) {
    const id = reader.readU32()
    const ox = reader.readI16()
    const oy = reader.readI16()
    const colorIndex = reader.readU8()
    const sizeQ = reader.readU8()
    if (id === null || ox === null || oy === null || colorIndex === null || sizeQ === null) {
      return null
    }
    const point = decodeOctI16ToPoint(ox, oy)
    const sizeT = sizeQ / 255
    pellets.push({
      id,
      x: point.x,
      y: point.y,
      z: point.z,
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

function parseHexColor(value: string): [number, number, number] | null {
  const trimmed = value.trim().toLowerCase()
  const match = /^#([0-9a-f]{6})$/.exec(trimmed)
  if (!match) return null
  const hex = match[1]
  const r = Number.parseInt(hex.slice(0, 2), 16)
  const g = Number.parseInt(hex.slice(2, 4), 16)
  const b = Number.parseInt(hex.slice(4, 6), 16)
  if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) return null
  return [r, g, b]
}

function encodeSkinColors(colors: string[]): Uint8Array | null {
  const clampedLen = Math.max(0, Math.min(8, colors.length))
  if (clampedLen <= 0) return null
  const bytes = new Uint8Array(clampedLen * 3)
  for (let i = 0; i < clampedLen; i += 1) {
    const parsed = parseHexColor(colors[i] ?? '')
    if (!parsed) return null
    const offset = i * 3
    bytes[offset] = parsed[0]
    bytes[offset + 1] = parsed[1]
    bytes[offset + 2] = parsed[2]
  }
  return bytes
}

function bytesToHexColor(r: number, g: number, b: number) {
  const rr = r.toString(16).padStart(2, '0')
  const gg = g.toString(16).padStart(2, '0')
  const bb = b.toString(16).padStart(2, '0')
  return `#${rr}${gg}${bb}`
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

function readSkinColors(reader: Reader): string[] | undefined | null {
  const skinLen = reader.readU8()
  if (skinLen === null) return null
  if (skinLen === 0) return undefined
  if (skinLen > 8) return null
  const out: string[] = []
  for (let i = 0; i < skinLen; i += 1) {
    const r = reader.readU8()
    const g = reader.readU8()
    const b = reader.readU8()
    if (r === null || g === null || b === null) return null
    out.push(bytesToHexColor(r, g, b))
  }
  return out
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

  readVarU32(): number | null {
    let result = 0
    let shift = 0
    for (let i = 0; i < 5; i += 1) {
      const byte = this.readU8()
      if (byte === null) return null
      result |= (byte & 0x7f) << shift
      if ((byte & 0x80) === 0) return result >>> 0
      shift += 7
    }
    return null
  }

  readVarI32(): number | null {
    const raw = this.readVarU32()
    if (raw === null) return null
    return (raw >>> 1) ^ -(raw & 1)
  }

  private ensure(size: number) {
    return this.offset + size <= this.view.byteLength
  }
}
