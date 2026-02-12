import * as THREE from 'three'
import type { PelletSnapshot } from '../../../../game/types'
import { clamp } from '../utils/math'

export type PelletGroundCacheEntry = {
  x: number
  y: number
  z: number
  radius: number
}

type CreatePelletSurfaceSamplerParams = {
  pelletGroundCache: Map<number, PelletGroundCacheEntry>
  getTerrainRadius: (normal: THREE.Vector3) => number
  pelletGroundCacheNormalEps: number
  pelletSizeMin: number
  pelletSizeMax: number
  pelletRadius: number
  pelletSurfaceClearance: number
}

export const createPelletSurfaceSampler = ({
  pelletGroundCache,
  getTerrainRadius,
  pelletGroundCacheNormalEps,
  pelletSizeMin,
  pelletSizeMax,
  pelletRadius,
  pelletSurfaceClearance,
}: CreatePelletSurfaceSamplerParams) => {
  const normalTemp = new THREE.Vector3()

  const getPelletTerrainRadius = (pellet: PelletSnapshot) => {
    const nx = pellet.x
    const ny = pellet.y
    const nz = pellet.z
    const cached = pelletGroundCache.get(pellet.id)
    if (cached) {
      const dx = cached.x - nx
      const dy = cached.y - ny
      const dz = cached.z - nz
      if (dx * dx + dy * dy + dz * dz <= pelletGroundCacheNormalEps) {
        return cached.radius
      }
    }
    normalTemp.set(nx, ny, nz)
    if (normalTemp.lengthSq() <= 1e-8) {
      normalTemp.set(0, 0, 1)
    } else {
      normalTemp.normalize()
    }
    const radius = getTerrainRadius(normalTemp)
    pelletGroundCache.set(pellet.id, {
      x: normalTemp.x,
      y: normalTemp.y,
      z: normalTemp.z,
      radius,
    })
    return radius
  }

  const getPelletSurfacePosition = (pellet: PelletSnapshot, out: THREE.Vector3) => {
    const radius = getPelletTerrainRadius(pellet)
    const pelletScale = clamp(
      Number.isFinite(pellet.size) ? pellet.size : 1,
      pelletSizeMin,
      pelletSizeMax,
    )
    const surfaceLift = pelletRadius * pelletScale + pelletSurfaceClearance
    out.set(pellet.x, pellet.y, pellet.z)
    if (out.lengthSq() <= 1e-8) {
      out.set(0, 0, 1)
    } else {
      out.normalize()
    }
    out.multiplyScalar(radius + surfaceLift)
    return out
  }

  const getPelletSurfacePositionFromNormal = (
    id: number,
    normal: THREE.Vector3,
    size: number,
    out: THREE.Vector3,
  ) => {
    const nx = normal.x
    const ny = normal.y
    const nz = normal.z
    const cached = pelletGroundCache.get(id)
    let radius: number
    if (cached) {
      const dx = cached.x - nx
      const dy = cached.y - ny
      const dz = cached.z - nz
      if (dx * dx + dy * dy + dz * dz <= pelletGroundCacheNormalEps) {
        radius = cached.radius
      } else {
        radius = getTerrainRadius(normal)
        pelletGroundCache.set(id, { x: nx, y: ny, z: nz, radius })
      }
    } else {
      radius = getTerrainRadius(normal)
      pelletGroundCache.set(id, { x: nx, y: ny, z: nz, radius })
    }
    const pelletScale = clamp(size, pelletSizeMin, pelletSizeMax)
    const surfaceLift = pelletRadius * pelletScale + pelletSurfaceClearance
    out.copy(normal).multiplyScalar(radius + surfaceLift)
    return out
  }

  return {
    getPelletTerrainRadius,
    getPelletSurfacePosition,
    getPelletSurfacePositionFromNormal,
  }
}
