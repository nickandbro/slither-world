import * as THREE from 'three'
import { PointsNodeMaterial } from 'three/webgpu'
import { instancedDynamicBufferAttribute, materialOpacity } from 'three/tsl'

export type PelletSpriteBucketPoints = {
  kind: 'points'
  shadowPoints: THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial>
  corePoints: THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial>
  innerGlowPoints: THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial>
  glowPoints: THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial>
  shadowMaterial: THREE.PointsMaterial
  coreMaterial: THREE.PointsMaterial
  innerGlowMaterial: THREE.PointsMaterial
  glowMaterial: THREE.PointsMaterial
  positionAttribute: THREE.BufferAttribute
  opacityAttribute: THREE.BufferAttribute
  capacity: number
  baseShadowSize: number
  baseCoreSize: number
  baseInnerGlowSize: number
  baseGlowSize: number
  colorBucketIndex: number
  sizeTierIndex: number
}

export type PelletSpriteBucketSprites = {
  kind: 'sprites'
  shadowSprite: THREE.Sprite
  coreSprite: THREE.Sprite
  innerGlowSprite: THREE.Sprite
  glowSprite: THREE.Sprite
  shadowMaterial: PointsNodeMaterial
  coreMaterial: PointsNodeMaterial
  innerGlowMaterial: PointsNodeMaterial
  glowMaterial: PointsNodeMaterial
  positionAttribute: THREE.InstancedBufferAttribute
  opacityAttribute: THREE.InstancedBufferAttribute
  capacity: number
  baseShadowSize: number
  baseCoreSize: number
  baseInnerGlowSize: number
  baseGlowSize: number
  colorBucketIndex: number
  sizeTierIndex: number
}

export type PelletSpriteBucket = PelletSpriteBucketPoints | PelletSpriteBucketSprites

export type CreatePelletBucketManagerParams = {
  pelletBuckets: Array<PelletSpriteBucket | null>
  pelletsGroup: THREE.Group
  pelletsUseSprites: boolean
  pelletSpriteBucketMinCapacity: number
  pelletColorBucketCount: number
  pelletSizeTierMultipliers: number[]
  pelletSizeTierMediumMin: number
  pelletSizeTierLargeMin: number
  pelletShadowPointSize: number
  pelletCorePointSize: number
  pelletInnerGlowPointSize: number
  pelletGlowPointSize: number
  pelletShadowTexture: THREE.Texture | null
  pelletCoreTexture: THREE.Texture | null
  pelletInnerGlowTexture: THREE.Texture | null
  pelletGlowTexture: THREE.Texture | null
  pelletColors: string[]
  pelletShadowOpacityBase: number
  pelletCoreOpacityBase: number
  pelletInnerGlowOpacityBase: number
  pelletGlowOpacityBase: number
}

export type PelletBucketManager = {
  pelletBucketIndex: (colorIndex: number, size: number) => number
  ensurePelletBucketCapacity: (bucketIndex: number, required: number) => PelletSpriteBucket
}

const applyPelletOpacityAttributeToPointsMaterial = (material: THREE.PointsMaterial) => {
  material.customProgramCacheKey = () => 'pellet-opacity-v1'
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\nattribute float pelletOpacity;\nvarying float vPelletOpacity;',
      )
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\n  vPelletOpacity = pelletOpacity;',
      )
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vPelletOpacity;')
      .replace(
        '#include <color_fragment>',
        '#include <color_fragment>\n  diffuseColor.a *= clamp(vPelletOpacity, 0.0, 1.0);',
      )
  }
}

export const createPelletBucketManager = ({
  pelletBuckets,
  pelletsGroup,
  pelletsUseSprites,
  pelletSpriteBucketMinCapacity,
  pelletColorBucketCount,
  pelletSizeTierMultipliers,
  pelletSizeTierMediumMin,
  pelletSizeTierLargeMin,
  pelletShadowPointSize,
  pelletCorePointSize,
  pelletInnerGlowPointSize,
  pelletGlowPointSize,
  pelletShadowTexture,
  pelletCoreTexture,
  pelletInnerGlowTexture,
  pelletGlowTexture,
  pelletColors,
  pelletShadowOpacityBase,
  pelletCoreOpacityBase,
  pelletInnerGlowOpacityBase,
  pelletGlowOpacityBase,
}: CreatePelletBucketManagerParams): PelletBucketManager => {
  const normalizePelletColorIndex = (colorIndex: number) => {
    if (pelletColorBucketCount <= 0) return 0
    const mod = colorIndex % pelletColorBucketCount
    return mod >= 0 ? mod : mod + pelletColorBucketCount
  }

  const pelletSizeTierIndex = (size: number) => {
    if (!Number.isFinite(size)) return 0
    if (size >= pelletSizeTierLargeMin) return 2
    if (size >= pelletSizeTierMediumMin) return 1
    return 0
  }

  const pelletBucketIndex = (colorIndex: number, size: number) => {
    const colorBucketIndex = normalizePelletColorIndex(colorIndex)
    const tierIndex = pelletSizeTierIndex(size)
    return tierIndex * pelletColorBucketCount + colorBucketIndex
  }

  const createPelletBucketPoints = (
    bucketIndex: number,
    capacity: number,
  ): PelletSpriteBucketPoints => {
    const sizeTierIndex = Math.floor(bucketIndex / pelletColorBucketCount)
    const colorBucketIndex = bucketIndex % pelletColorBucketCount
    const sizeMultiplier = pelletSizeTierMultipliers[sizeTierIndex] ?? 1
    const baseShadowSize = pelletShadowPointSize * sizeMultiplier
    const baseCoreSize = pelletCorePointSize * sizeMultiplier
    const baseInnerGlowSize = pelletInnerGlowPointSize * sizeMultiplier
    const baseGlowSize = pelletGlowPointSize * sizeMultiplier
    const geometry = new THREE.BufferGeometry()
    const positionArray = new Float32Array(capacity * 3)
    const opacityArray = new Float32Array(capacity)
    const positionAttribute = new THREE.BufferAttribute(positionArray, 3)
    const opacityAttribute = new THREE.BufferAttribute(opacityArray, 1)
    positionAttribute.setUsage(THREE.DynamicDrawUsage)
    opacityAttribute.setUsage(THREE.DynamicDrawUsage)
    geometry.setAttribute('position', positionAttribute)
    geometry.setAttribute('pelletOpacity', opacityAttribute)
    geometry.setDrawRange(0, 0)

    const shadowMaterial = new THREE.PointsMaterial({
      size: baseShadowSize,
      map: pelletShadowTexture ?? undefined,
      alphaMap: pelletShadowTexture ?? undefined,
      color: '#000000',
      transparent: true,
      opacity: pelletShadowOpacityBase,
      depthWrite: false,
      depthTest: true,
      blending: THREE.NormalBlending,
      sizeAttenuation: true,
      toneMapped: false,
    })
    const coreMaterial = new THREE.PointsMaterial({
      size: baseCoreSize,
      map: pelletCoreTexture ?? undefined,
      alphaMap: pelletCoreTexture ?? undefined,
      color: pelletColors[colorBucketIndex] ?? '#ffd166',
      transparent: true,
      opacity: pelletCoreOpacityBase,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
      sizeAttenuation: true,
      toneMapped: false,
    })
    const innerGlowMaterial = new THREE.PointsMaterial({
      size: baseInnerGlowSize,
      map: pelletInnerGlowTexture ?? undefined,
      alphaMap: pelletInnerGlowTexture ?? undefined,
      color: pelletColors[colorBucketIndex] ?? '#ffd166',
      transparent: true,
      opacity: pelletInnerGlowOpacityBase,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
      sizeAttenuation: true,
      toneMapped: false,
    })
    const glowMaterial = new THREE.PointsMaterial({
      size: baseGlowSize,
      map: pelletGlowTexture ?? undefined,
      alphaMap: pelletGlowTexture ?? undefined,
      color: pelletColors[colorBucketIndex] ?? '#ffd166',
      transparent: true,
      opacity: pelletGlowOpacityBase,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
      sizeAttenuation: true,
      toneMapped: false,
    })
    applyPelletOpacityAttributeToPointsMaterial(shadowMaterial)
    applyPelletOpacityAttributeToPointsMaterial(coreMaterial)
    applyPelletOpacityAttributeToPointsMaterial(innerGlowMaterial)
    applyPelletOpacityAttributeToPointsMaterial(glowMaterial)
    const shadowPoints = new THREE.Points(geometry, shadowMaterial)
    const glowPoints = new THREE.Points(geometry, glowMaterial)
    const innerGlowPoints = new THREE.Points(geometry, innerGlowMaterial)
    const corePoints = new THREE.Points(geometry, coreMaterial)
    shadowPoints.visible = false
    glowPoints.visible = false
    innerGlowPoints.visible = false
    corePoints.visible = false
    shadowPoints.frustumCulled = false
    glowPoints.frustumCulled = false
    innerGlowPoints.frustumCulled = false
    corePoints.frustumCulled = false
    shadowPoints.renderOrder = 1.2
    glowPoints.renderOrder = 1.3
    innerGlowPoints.renderOrder = 1.4
    corePoints.renderOrder = 1.5
    pelletsGroup.add(shadowPoints)
    pelletsGroup.add(glowPoints)
    pelletsGroup.add(innerGlowPoints)
    pelletsGroup.add(corePoints)
    return {
      kind: 'points',
      shadowPoints,
      corePoints,
      innerGlowPoints,
      glowPoints,
      shadowMaterial,
      coreMaterial,
      innerGlowMaterial,
      glowMaterial,
      positionAttribute,
      opacityAttribute,
      capacity,
      baseShadowSize,
      baseCoreSize,
      baseInnerGlowSize,
      baseGlowSize,
      colorBucketIndex,
      sizeTierIndex,
    }
  }

  const createPelletBucketSprites = (
    bucketIndex: number,
    capacity: number,
  ): PelletSpriteBucketSprites => {
    const sizeTierIndex = Math.floor(bucketIndex / pelletColorBucketCount)
    const colorBucketIndex = bucketIndex % pelletColorBucketCount
    const sizeMultiplier = pelletSizeTierMultipliers[sizeTierIndex] ?? 1
    const baseShadowSize = pelletShadowPointSize * sizeMultiplier
    const baseCoreSize = pelletCorePointSize * sizeMultiplier
    const baseInnerGlowSize = pelletInnerGlowPointSize * sizeMultiplier
    const baseGlowSize = pelletGlowPointSize * sizeMultiplier

    // WebGPU sprite instancing expects an InstancedBufferAttribute. A plain BufferAttribute will
    // be treated as per-vertex, which breaks `sprite.count` and can trip TSL/node builds.
    const positionArray = new Float32Array(capacity * 3)
    const opacityArray = new Float32Array(capacity)
    const positionAttribute = new THREE.InstancedBufferAttribute(positionArray, 3)
    const opacityAttribute = new THREE.InstancedBufferAttribute(opacityArray, 1)
    positionAttribute.setUsage(THREE.DynamicDrawUsage)
    opacityAttribute.setUsage(THREE.DynamicDrawUsage)
    const positionNode = instancedDynamicBufferAttribute(positionAttribute, 'vec3')
    const opacityNode = instancedDynamicBufferAttribute(opacityAttribute, 'float')

    const createMaterial = (params: ConstructorParameters<typeof PointsNodeMaterial>[0]) => {
      const material = new PointsNodeMaterial(params)
      material.positionNode = positionNode
      material.opacityNode = materialOpacity.mul(opacityNode)
      return material
    }

    const shadowMaterial = createMaterial({
      size: baseShadowSize,
      map: pelletShadowTexture ?? undefined,
      color: '#000000',
      transparent: true,
      opacity: pelletShadowOpacityBase,
      depthWrite: false,
      depthTest: true,
      blending: THREE.NormalBlending,
      sizeAttenuation: true,
      toneMapped: false,
    })
    const coreMaterial = createMaterial({
      size: baseCoreSize,
      map: pelletCoreTexture ?? undefined,
      color: pelletColors[colorBucketIndex] ?? '#ffd166',
      transparent: true,
      opacity: pelletCoreOpacityBase,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
      sizeAttenuation: true,
      toneMapped: false,
    })
    const innerGlowMaterial = createMaterial({
      size: baseInnerGlowSize,
      map: pelletInnerGlowTexture ?? undefined,
      color: pelletColors[colorBucketIndex] ?? '#ffd166',
      transparent: true,
      opacity: pelletInnerGlowOpacityBase,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
      sizeAttenuation: true,
      toneMapped: false,
    })
    const glowMaterial = createMaterial({
      size: baseGlowSize,
      map: pelletGlowTexture ?? undefined,
      color: pelletColors[colorBucketIndex] ?? '#ffd166',
      transparent: true,
      opacity: pelletGlowOpacityBase,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
      sizeAttenuation: true,
      toneMapped: false,
    })

    const shadowSprite = new THREE.Sprite(shadowMaterial as unknown as THREE.SpriteMaterial)
    const glowSprite = new THREE.Sprite(glowMaterial as unknown as THREE.SpriteMaterial)
    const innerGlowSprite = new THREE.Sprite(innerGlowMaterial as unknown as THREE.SpriteMaterial)
    const coreSprite = new THREE.Sprite(coreMaterial as unknown as THREE.SpriteMaterial)

    shadowSprite.visible = false
    glowSprite.visible = false
    innerGlowSprite.visible = false
    coreSprite.visible = false
    shadowSprite.frustumCulled = false
    glowSprite.frustumCulled = false
    innerGlowSprite.frustumCulled = false
    coreSprite.frustumCulled = false
    shadowSprite.renderOrder = 1.2
    glowSprite.renderOrder = 1.3
    innerGlowSprite.renderOrder = 1.4
    coreSprite.renderOrder = 1.5
    shadowSprite.count = 0
    glowSprite.count = 0
    innerGlowSprite.count = 0
    coreSprite.count = 0

    pelletsGroup.add(shadowSprite)
    pelletsGroup.add(glowSprite)
    pelletsGroup.add(innerGlowSprite)
    pelletsGroup.add(coreSprite)

    return {
      kind: 'sprites',
      shadowSprite,
      coreSprite,
      innerGlowSprite,
      glowSprite,
      shadowMaterial,
      coreMaterial,
      innerGlowMaterial,
      glowMaterial,
      positionAttribute,
      opacityAttribute,
      capacity,
      baseShadowSize,
      baseCoreSize,
      baseInnerGlowSize,
      baseGlowSize,
      colorBucketIndex,
      sizeTierIndex,
    }
  }

  const createPelletBucket = (bucketIndex: number, capacity: number): PelletSpriteBucket => {
    return pelletsUseSprites
      ? createPelletBucketSprites(bucketIndex, capacity)
      : createPelletBucketPoints(bucketIndex, capacity)
  }

  const ensurePelletBucketCapacity = (bucketIndex: number, required: number): PelletSpriteBucket => {
    const targetCapacity = Math.max(1, required)
    let bucket = pelletBuckets[bucketIndex]
    if (!bucket) {
      let capacity = pelletsUseSprites ? pelletSpriteBucketMinCapacity : 1
      while (capacity < targetCapacity) {
        capacity *= 2
      }
      bucket = createPelletBucket(bucketIndex, capacity)
      pelletBuckets[bucketIndex] = bucket
      return bucket
    }
    if (bucket.capacity >= targetCapacity) {
      return bucket
    }

    let nextCapacity = Math.max(1, bucket.capacity)
    while (nextCapacity < targetCapacity) {
      nextCapacity *= 2
    }
    const positionArray = new Float32Array(nextCapacity * 3)
    const opacityArray = new Float32Array(nextCapacity)
    const positionAttribute =
      bucket.kind === 'sprites'
        ? new THREE.InstancedBufferAttribute(positionArray, 3)
        : new THREE.BufferAttribute(positionArray, 3)
    const opacityAttribute =
      bucket.kind === 'sprites'
        ? new THREE.InstancedBufferAttribute(opacityArray, 1)
        : new THREE.BufferAttribute(opacityArray, 1)
    positionAttribute.setUsage(THREE.DynamicDrawUsage)
    opacityAttribute.setUsage(THREE.DynamicDrawUsage)

    if (bucket.kind === 'points') {
      const geometry = new THREE.BufferGeometry()
      geometry.setAttribute('position', positionAttribute)
      geometry.setAttribute('pelletOpacity', opacityAttribute)
      geometry.setDrawRange(0, 0)

      const previousGeometry = bucket.corePoints.geometry
      bucket.shadowPoints.geometry = geometry
      bucket.corePoints.geometry = geometry
      bucket.innerGlowPoints.geometry = geometry
      bucket.glowPoints.geometry = geometry
      previousGeometry.dispose()
    } else {
      const positionNode = instancedDynamicBufferAttribute(positionAttribute, 'vec3')
      const opacityNode = instancedDynamicBufferAttribute(opacityAttribute, 'float')
      bucket.shadowMaterial.positionNode = positionNode
      bucket.shadowMaterial.opacityNode = materialOpacity.mul(opacityNode)
      bucket.coreMaterial.positionNode = positionNode
      bucket.coreMaterial.opacityNode = materialOpacity.mul(opacityNode)
      bucket.innerGlowMaterial.positionNode = positionNode
      bucket.innerGlowMaterial.opacityNode = materialOpacity.mul(opacityNode)
      bucket.glowMaterial.positionNode = positionNode
      bucket.glowMaterial.opacityNode = materialOpacity.mul(opacityNode)
      // Changing node graphs requires bumping the material version so Three recreates the
      // internal render object and bindings. Without this, WebGPU can keep the old GPU buffer
      // bound and then fail when `sprite.count` grows beyond the previous capacity.
      bucket.shadowMaterial.needsUpdate = true
      bucket.coreMaterial.needsUpdate = true
      bucket.innerGlowMaterial.needsUpdate = true
      bucket.glowMaterial.needsUpdate = true
    }

    bucket.positionAttribute = positionAttribute
    bucket.opacityAttribute = opacityAttribute
    bucket.capacity = nextCapacity
    return bucket
  }

  return {
    pelletBucketIndex,
    ensurePelletBucketCapacity,
  }
}
