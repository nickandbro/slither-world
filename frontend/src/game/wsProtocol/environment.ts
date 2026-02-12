import type { Environment } from '../types'
import { Reader } from './reader'

export function readEnvironment(reader: Reader): Environment | null {
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
