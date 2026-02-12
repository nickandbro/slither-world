import * as THREE from 'three'
import { TERRAIN_CONTACT_EPS } from '../constants'
import { bucketIndexFromDirection } from '../utils/math'

export type TerrainContactTriangle = {
  ax: number
  ay: number
  az: number
  e1x: number
  e1y: number
  e1z: number
  e2x: number
  e2y: number
  e2z: number
}

export type TerrainContactSampler = {
  bands: number
  slices: number
  buckets: number[][]
  triangles: TerrainContactTriangle[]
}

export const createTerrainContactSampler = (
  geometry: THREE.BufferGeometry,
  bands: number,
  slices: number,
): TerrainContactSampler | null => {
  const positionAttr = geometry.getAttribute('position')
  if (!(positionAttr instanceof THREE.BufferAttribute)) return null
  const indexAttr = geometry.getIndex()
  const triCount = indexAttr
    ? Math.floor(indexAttr.count / 3)
    : Math.floor(positionAttr.count / 3)
  if (triCount <= 0) return null

  const buckets = Array.from({ length: bands * slices }, () => [] as number[])
  const triangles: TerrainContactTriangle[] = []
  const a = new THREE.Vector3()
  const b = new THREE.Vector3()
  const c = new THREE.Vector3()
  const edge1 = new THREE.Vector3()
  const edge2 = new THREE.Vector3()
  const cross = new THREE.Vector3()
  const centroid = new THREE.Vector3()

  const readVertex = (index: number, out: THREE.Vector3) => {
    out.set(positionAttr.getX(index), positionAttr.getY(index), positionAttr.getZ(index))
  }

  for (let tri = 0; tri < triCount; tri += 1) {
    const i0 = indexAttr ? indexAttr.getX(tri * 3) : tri * 3
    const i1 = indexAttr ? indexAttr.getX(tri * 3 + 1) : tri * 3 + 1
    const i2 = indexAttr ? indexAttr.getX(tri * 3 + 2) : tri * 3 + 2
    readVertex(i0, a)
    readVertex(i1, b)
    readVertex(i2, c)

    edge1.copy(b).sub(a)
    edge2.copy(c).sub(a)
    cross.copy(edge1).cross(edge2)
    if (cross.lengthSq() <= TERRAIN_CONTACT_EPS) continue

    centroid.copy(a).add(b).add(c).multiplyScalar(1 / 3)
    if (centroid.lengthSq() <= TERRAIN_CONTACT_EPS) continue
    centroid.normalize()
    const { band, slice } = bucketIndexFromDirection(centroid, bands, slices)
    const triIndex = triangles.length
    triangles.push({
      ax: a.x,
      ay: a.y,
      az: a.z,
      e1x: edge1.x,
      e1y: edge1.y,
      e1z: edge1.z,
      e2x: edge2.x,
      e2y: edge2.y,
      e2z: edge2.z,
    })
    buckets[band * slices + slice].push(triIndex)
  }

  if (triangles.length === 0) return null
  return { bands, slices, buckets, triangles }
}

export const sampleTerrainContactRadius = (
  sampler: TerrainContactSampler,
  direction: THREE.Vector3,
): number | null => {
  if (direction.lengthSq() <= TERRAIN_CONTACT_EPS) return null
  const { band, slice } = bucketIndexFromDirection(
    direction,
    sampler.bands,
    sampler.slices,
  )
  let bestT = Number.POSITIVE_INFINITY

  for (let bandOffset = -1; bandOffset <= 1; bandOffset += 1) {
    const sampleBand = band + bandOffset
    if (sampleBand < 0 || sampleBand >= sampler.bands) continue
    for (let sliceOffset = -1; sliceOffset <= 1; sliceOffset += 1) {
      let sampleSlice = slice + sliceOffset
      if (sampleSlice < 0) sampleSlice += sampler.slices
      if (sampleSlice >= sampler.slices) sampleSlice -= sampler.slices
      const bucket = sampler.buckets[sampleBand * sampler.slices + sampleSlice]
      if (!bucket || bucket.length === 0) continue

      for (let i = 0; i < bucket.length; i += 1) {
        const triangle = sampler.triangles[bucket[i]]
        if (!triangle) continue

        const hx = direction.y * triangle.e2z - direction.z * triangle.e2y
        const hy = direction.z * triangle.e2x - direction.x * triangle.e2z
        const hz = direction.x * triangle.e2y - direction.y * triangle.e2x
        const det = triangle.e1x * hx + triangle.e1y * hy + triangle.e1z * hz
        if (Math.abs(det) <= TERRAIN_CONTACT_EPS) continue
        const invDet = 1 / det

        const sx = -triangle.ax
        const sy = -triangle.ay
        const sz = -triangle.az
        const u = (sx * hx + sy * hy + sz * hz) * invDet
        if (u < 0 || u > 1) continue

        const qx = sy * triangle.e1z - sz * triangle.e1y
        const qy = sz * triangle.e1x - sx * triangle.e1z
        const qz = sx * triangle.e1y - sy * triangle.e1x
        const v = (direction.x * qx + direction.y * qy + direction.z * qz) * invDet
        if (v < 0 || u + v > 1) continue

        const t = (triangle.e2x * qx + triangle.e2y * qy + triangle.e2z * qz) * invDet
        if (t > TERRAIN_CONTACT_EPS && t < bestT) {
          bestT = t
        }
      }
    }
  }

  if (!Number.isFinite(bestT)) return null
  return bestT
}
