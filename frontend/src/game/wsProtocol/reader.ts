import { bytesToHexColor } from '@shared/color/hex'

const textDecoder = new TextDecoder()

function bytesToUuid(bytes: Uint8Array): string {
  const hex = Array.from(bytes)
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export class Reader {
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

export function readSkinColors(reader: Reader): string[] | undefined | null {
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
