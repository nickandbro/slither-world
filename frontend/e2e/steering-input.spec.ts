import { expect, test } from '@playwright/test'
import { enterGame } from './helpers'

type TraceAxis = { x: number; y: number; z: number }

type SteeringTrace = {
  inputFrames: number
  inputWithAxis: number
  inputAxisSamples: TraceAxis[]
  planeAxisSamples: TraceAxis[]
}

const STORAGE_KEYS = {
  name: 'spherical_snake_player_name',
  best: 'spherical_snake_best_score',
  room: 'spherical_snake_room',
}

test('steering input turns the authoritative snake trajectory', async ({ page }) => {
  const room = `e2e-steer-${Date.now()}`

  await page.addInitScript(({ keys, room }) => {
    localStorage.setItem(keys.name, 'E2E Steering')
    localStorage.setItem(keys.best, '0')
    localStorage.setItem(keys.room, room)
  }, { keys: STORAGE_KEYS, room })

  await page.addInitScript(() => {
    const VERSION = 14
    const TYPE_INIT = 0x10
    const TYPE_STATE = 0x11
    const TYPE_INPUT = 0x02

    const FLAG_INPUT_AXIS = 1 << 0
    const PLAYER_FLAG_ALIVE = 1 << 0

    const PELLET_NORMAL_MAX = 32767

    const trace: SteeringTrace & {
      localNetId: number | null
      heads: { t: number; head: TraceAxis }[]
    } = {
      inputFrames: 0,
      inputWithAxis: 0,
      inputAxisSamples: [],
      planeAxisSamples: [],
      localNetId: null,
      heads: [],
    }

    ;(window as Window & { __STEERING_TRACE__?: SteeringTrace }).__STEERING_TRACE__ = trace

    const dot = (a: TraceAxis, b: TraceAxis) => a.x * b.x + a.y * b.y + a.z * b.z
    const cross = (a: TraceAxis, b: TraceAxis): TraceAxis => ({
      x: a.y * b.z - a.z * b.y,
      y: a.z * b.x - a.x * b.z,
      z: a.x * b.y - a.y * b.x,
    })
    const norm = (v: TraceAxis): TraceAxis | null => {
      const len = Math.hypot(v.x, v.y, v.z)
      if (!Number.isFinite(len) || len <= 1e-12) return null
      const inv = 1 / len
      return { x: v.x * inv, y: v.y * inv, z: v.z * inv }
    }

    const bytesToUuid = (bytes: Uint8Array): string => {
      const hex = Array.from(bytes)
        .map((value) => value.toString(16).padStart(2, '0'))
        .join('')
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
    }

    const decodeOctI16ToPoint = (xq: number, yq: number): TraceAxis => {
      const inv = 1 / PELLET_NORMAL_MAX
      let x = xq * inv
      let y = yq * inv
      let z = 1 - Math.abs(x) - Math.abs(y)
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

    class Reader {
      private view: DataView
      private offset = 0
      private textDecoder = new TextDecoder()

      constructor(buffer: ArrayBuffer) {
        this.view = new DataView(buffer)
      }

      private ensure(size: number) {
        return this.offset + size <= this.view.byteLength
      }

      readU8() {
        if (!this.ensure(1)) return null
        const value = this.view.getUint8(this.offset)
        this.offset += 1
        return value
      }

      readU16() {
        if (!this.ensure(2)) return null
        const value = this.view.getUint16(this.offset, true)
        this.offset += 2
        return value
      }

      readI16() {
        if (!this.ensure(2)) return null
        const value = this.view.getInt16(this.offset, true)
        this.offset += 2
        return value
      }

      readI32() {
        if (!this.ensure(4)) return null
        const value = this.view.getInt32(this.offset, true)
        this.offset += 4
        return value
      }

      readU32() {
        if (!this.ensure(4)) return null
        const value = this.view.getUint32(this.offset, true)
        this.offset += 4
        return value
      }

      readI64() {
        if (!this.ensure(8)) return null
        const value = this.view.getBigInt64(this.offset, true)
        this.offset += 8
        return Number(value)
      }

      readF32() {
        if (!this.ensure(4)) return null
        const value = this.view.getFloat32(this.offset, true)
        this.offset += 4
        return value
      }

      readBytes(length: number): Uint8Array | null {
        if (!this.ensure(length)) return null
        const bytes = new Uint8Array(this.view.buffer, this.offset, length)
        this.offset += length
        return bytes
      }

      readUuid() {
        const bytes = this.readBytes(16)
        if (!bytes) return null
        return bytesToUuid(bytes)
      }

      readString() {
        const length = this.readU8()
        if (length === null) return null
        const bytes = this.readBytes(length)
        if (!bytes) return null
        return this.textDecoder.decode(bytes)
      }

      skipSkinColors() {
        const len = this.readU8()
        if (len === null) return false
        if (len === 0) return true
        if (len > 8) return false
        const bytes = this.readBytes(len * 3)
        return !!bytes
      }
    }

    const decodeInitNetId = (reader: Reader) => {
      const playerId = reader.readUuid()
      const now = reader.readI64()
      const seq = reader.readU32()
      const tickMs = reader.readU16()
      const totalPlayers = reader.readU16()
      const metaCount = reader.readU16()
      if (
        playerId === null ||
        now === null ||
        seq === null ||
        tickMs === null ||
        totalPlayers === null ||
        metaCount === null
      ) {
        return
      }

      let localNetId: number | null = null
      for (let i = 0; i < metaCount; i += 1) {
        const netId = reader.readU16()
        const id = reader.readUuid()
        const name = reader.readString()
        const color = reader.readString()
        const skinOk = reader.skipSkinColors()
        if (netId === null || id === null || name === null || color === null || !skinOk) return
        if (id === playerId) localNetId = netId
      }

      trace.localNetId = localNetId
    }

    const decodeLocalHeadFromState = (reader: Reader): { head: TraceAxis; alive: boolean } | null => {
      const playerCount = reader.readU16()
      if (playerCount === null) return null
      const localNetId = trace.localNetId
      let localHead: TraceAxis | null = null
      let localAlive = false

      for (let i = 0; i < playerCount; i += 1) {
        const netId = reader.readU16()
        const flags = reader.readU8()
        const score = reader.readI32()
        const scoreFractionQ = reader.readU16()
        const oxygenQ = reader.readU16()
        const girthQ = reader.readU8()
        const tailExtQ = reader.readU8()
        const snakeDetail = reader.readU8()
        const snakeTotalLen = reader.readU16()
        if (
          netId === null ||
          flags === null ||
          score === null ||
          scoreFractionQ === null ||
          oxygenQ === null ||
          girthQ === null ||
          tailExtQ === null ||
          snakeDetail === null ||
          snakeTotalLen === null
        ) {
          return null
        }

        let snakeLen = 0
        if (snakeDetail === 0) {
          const fullLen = reader.readU16()
          if (fullLen === null) return null
          snakeLen = fullLen
        } else if (snakeDetail === 1) {
          const start = reader.readU16()
          const len = reader.readU16()
          if (start === null || len === null) return null
          snakeLen = len
        } else if (snakeDetail === 2) {
          snakeLen = 0
        } else {
          return null
        }

        for (let j = 0; j < snakeLen; j += 1) {
          const ox = reader.readI16()
          const oy = reader.readI16()
          if (ox === null || oy === null) return null
          if (j === 0 && localNetId !== null && netId === localNetId) {
            localHead = decodeOctI16ToPoint(ox, oy)
            localAlive = (flags & PLAYER_FLAG_ALIVE) !== 0
          }
        }

        const digestionsLen = reader.readU8()
        if (digestionsLen === null) return null
        for (let j = 0; j < digestionsLen; j += 1) {
          const digestionId = reader.readU32()
          const progress = reader.readF32()
          const strength = reader.readF32()
          if (digestionId === null || progress === null || strength === null) return null
        }
      }

      if (!localHead) return null
      return { head: localHead, alive: localAlive }
    }

    const maybeRecordPlaneAxis = () => {
      const heads = trace.heads
      const N = 10
      if (heads.length <= N) return
      const a = heads[heads.length - 1 - N]?.head
      const b = heads[heads.length - 1]?.head
      if (!a || !b) return
      const axis = norm(cross(a, b))
      if (!axis) return
      trace.planeAxisSamples.push(axis)
      if (trace.planeAxisSamples.length > 120) {
        trace.planeAxisSamples.splice(0, trace.planeAxisSamples.length - 120)
      }
    }

    const shouldInspectSocket = (ws: WebSocket) => ws.url.includes('/api/room/')

    const originalSend = WebSocket.prototype.send
    WebSocket.prototype.send = function (data) {
      try {
        if (data instanceof ArrayBuffer && shouldInspectSocket(this)) {
          const view = new DataView(data)
          if (view.byteLength >= 4 && view.getUint8(0) === VERSION && view.getUint8(1) === TYPE_INPUT) {
            trace.inputFrames += 1
            const flags = view.getUint16(2, true)
            if ((flags & FLAG_INPUT_AXIS) !== 0 && view.byteLength >= 16) {
              trace.inputWithAxis += 1
              const axis = {
                x: view.getFloat32(4, true),
                y: view.getFloat32(8, true),
                z: view.getFloat32(12, true),
              }
              if (
                Number.isFinite(axis.x) &&
                Number.isFinite(axis.y) &&
                Number.isFinite(axis.z)
              ) {
                trace.inputAxisSamples.push(axis)
                if (trace.inputAxisSamples.length > 80) {
                  trace.inputAxisSamples.splice(0, trace.inputAxisSamples.length - 80)
                }
              }
            }
          }
        }
      } catch {
        // ignore
      }
      return originalSend.call(this, data as never)
    }

    const originalAddEventListener = WebSocket.prototype.addEventListener
    WebSocket.prototype.addEventListener = function (type, listener, options) {
      if (type !== 'message') {
        return originalAddEventListener.call(this, type, listener as never, options)
      }

      const wrapped = function (this: WebSocket, event: MessageEvent) {
        try {
          if (event.data instanceof ArrayBuffer && shouldInspectSocket(this)) {
            const reader = new Reader(event.data)
            const version = reader.readU8()
            const messageType = reader.readU8()
            const flags = reader.readU16()
            if (version !== VERSION || messageType === null || flags === null) {
              // ignore
            } else if (messageType === TYPE_INIT) {
              decodeInitNetId(reader)
            } else if (messageType === TYPE_STATE) {
              const now = reader.readI64()
              const seq = reader.readU32()
              const totalPlayers = reader.readU16()
              if (now !== null && seq !== null && totalPlayers !== null) {
                const local = decodeLocalHeadFromState(reader)
                if (local && local.alive) {
                  trace.heads.push({ t: performance.now(), head: local.head })
                  if (trace.heads.length > 240) {
                    trace.heads.splice(0, trace.heads.length - 240)
                  }
                  maybeRecordPlaneAxis()
                }
              }
            }
          }
        } catch {
          // ignore decode errors
        }

        return (listener as (this: WebSocket, ev: MessageEvent) => unknown).call(this, event)
      }

      return originalAddEventListener.call(this, type, wrapped as never, options)
    }

    void dot
  })

  const viewport = page.viewportSize()
  expect(viewport).not.toBeNull()
  const width = viewport?.width ?? 900
  const height = viewport?.height ?? 700

  // Drive the pointer across the screen so the client produces varied steering axes.
  const path: Array<[number, number]> = [
    [0.2, 0.35],
    [0.84, 0.28],
    [0.78, 0.74],
    [0.26, 0.78],
    [0.62, 0.45],
  ]

  const captureMs = 3500
  const intervalMs = 120

  let trace: SteeringTrace | null = null
  let lastPlayVisible = false
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await page.goto('/?renderer=webgl')
    await enterGame(page)

    try {
      // Wait until we've seen a few alive snapshots so the render loop has a local head/camera.
      await page.waitForFunction(() => {
        const t = (window as any).__STEERING_TRACE__
        return !!t && t.localNetId !== null && Array.isArray(t.heads) && t.heads.length >= 12
      }, null, { timeout: 30_000 })
    } catch {
      continue
    }

    const start = Date.now()
    let step = 0
    while (Date.now() - start < captureMs) {
      const [xNorm, yNorm] = path[step % path.length] ?? [0.5, 0.5]
      await page.mouse.move(Math.floor(width * xNorm), Math.floor(height * yNorm))
      step += 1
      await page.waitForTimeout(intervalMs)
    }

    const collected = await page.evaluate(() => {
      const raw = (window as Window & { __STEERING_TRACE__?: SteeringTrace }).__STEERING_TRACE__
      return raw ?? null
    })

    lastPlayVisible = await page.getByRole('button', { name: /^Play( again)?$/ }).isVisible()
    if (lastPlayVisible) {
      continue
    }

    const inputAxes = collected?.inputAxisSamples ?? []
    const planeAxes = collected?.planeAxisSamples ?? []
    const baselineOk =
      (collected?.inputFrames ?? 0) > 10 &&
      (collected?.inputWithAxis ?? 0) > 8 &&
      inputAxes.length >= 6 &&
      planeAxes.length >= 10

    if (!baselineOk) {
      continue
    }

    trace = collected
    break
  }

  if (!trace) {
    throw new Error(`Failed to collect a stable steering trace (playVisible=${lastPlayVisible}).`)
  }

  const inputAxes = trace.inputAxisSamples ?? []
  const planeAxes = trace.planeAxisSamples ?? []

  const dot = (a: TraceAxis, b: TraceAxis) => a.x * b.x + a.y * b.y + a.z * b.z
  const absDot = (a: TraceAxis, b: TraceAxis) => Math.abs(dot(a, b))

  // Ensure we actually sent varied steering, but don't overfit to ordering (first/last can match).
  let minInputAbsDot = 1
  for (let i = 0; i < inputAxes.length; i += 1) {
    const a = inputAxes[i] as TraceAxis
    for (let j = i + 1; j < inputAxes.length; j += 1) {
      const b = inputAxes[j] as TraceAxis
      minInputAbsDot = Math.min(minInputAbsDot, absDot(a, b))
    }
  }
  expect(minInputAbsDot).toBeLessThan(0.995)

  const planeSpan = absDot(planeAxes[0] as TraceAxis, planeAxes[planeAxes.length - 1] as TraceAxis)
  const farStep = Math.min(30, Math.max(6, Math.floor(planeAxes.length / 3)))
  let minFarAbsDot = 1
  for (let i = 0; i + farStep < planeAxes.length; i += 1) {
    minFarAbsDot = Math.min(
      minFarAbsDot,
      absDot(planeAxes[i] as TraceAxis, planeAxes[i + farStep] as TraceAxis),
    )
  }

  // Without steering, the movement plane axis stays nearly constant (abs(dot) ~= 1).
  // With steering applied, it should deviate measurably over time.
  expect(planeSpan).toBeLessThan(0.999)
  expect(minFarAbsDot).toBeLessThan(0.999)
})
