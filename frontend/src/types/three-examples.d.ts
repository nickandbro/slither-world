declare module 'three/examples/jsm/geometries/ConvexGeometry' {
  import { BufferGeometry } from 'three'
  export class ConvexGeometry extends BufferGeometry {
    constructor(points: Array<{ x: number; y: number; z: number }>)
  }
}

declare module 'three/examples/jsm/utils/BufferGeometryUtils' {
  import { BufferGeometry } from 'three'
  export function mergeVertices(geometry: BufferGeometry, tolerance?: number): BufferGeometry
}
