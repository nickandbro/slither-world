import * as THREE from 'three'

export type PelletSpriteBucket = {
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

export type CreatePelletBucketManagerParams = {
  pelletBuckets: Array<PelletSpriteBucket | null>
  pelletsGroup: THREE.Group
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

  const createPelletBucket = (bucketIndex: number, capacity: number): PelletSpriteBucket => {
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

  const ensurePelletBucketCapacity = (bucketIndex: number, required: number): PelletSpriteBucket => {
    const targetCapacity = Math.max(1, required)
    let bucket = pelletBuckets[bucketIndex]
    if (!bucket) {
      let capacity = 1
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

    const geometry = new THREE.BufferGeometry()
    const positionArray = new Float32Array(nextCapacity * 3)
    const opacityArray = new Float32Array(nextCapacity)
    const positionAttribute = new THREE.BufferAttribute(positionArray, 3)
    const opacityAttribute = new THREE.BufferAttribute(opacityArray, 1)
    positionAttribute.setUsage(THREE.DynamicDrawUsage)
    opacityAttribute.setUsage(THREE.DynamicDrawUsage)
    geometry.setAttribute('position', positionAttribute)
    geometry.setAttribute('pelletOpacity', opacityAttribute)
    geometry.setDrawRange(0, 0)

    const previousGeometry = bucket.corePoints.geometry
    bucket.shadowPoints.geometry = geometry
    bucket.corePoints.geometry = geometry
    bucket.innerGlowPoints.geometry = geometry
    bucket.glowPoints.geometry = geometry
    previousGeometry.dispose()

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
