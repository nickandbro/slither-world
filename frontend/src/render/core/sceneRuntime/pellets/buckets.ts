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
  colorAttribute: THREE.BufferAttribute
  capacity: number
  baseShadowSize: number
  baseCoreSize: number
  baseInnerGlowSize: number
  baseGlowSize: number
  pulseBucketIndex: number
  sizeTierIndex: number
  bucketIndex: number
}

export type CreatePelletBucketManagerParams = {
  pelletBuckets: Array<PelletSpriteBucket | null>
  pelletsGroup: THREE.Group
  pelletPulseBucketCount: number
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
  pelletShadowOpacityBase: number
  pelletCoreOpacityBase: number
  pelletInnerGlowOpacityBase: number
  pelletGlowOpacityBase: number
}

export type PelletBucketManager = {
  pelletBucketIndex: (pelletId: number, size: number) => number
  ensurePelletBucketCapacity: (bucketIndex: number, required: number) => PelletSpriteBucket
}

const applyPelletAttributesToPointsMaterial = (
  material: THREE.PointsMaterial,
  useColorAttribute: boolean,
) => {
  material.customProgramCacheKey = () =>
    useColorAttribute ? 'pellet-attrs-v2-color' : 'pellet-attrs-v2-opacity'
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        useColorAttribute
          ? '#include <common>\nattribute float pelletOpacity;\nattribute vec3 pelletColor;\nvarying float vPelletOpacity;\nvarying vec3 vPelletColor;'
          : '#include <common>\nattribute float pelletOpacity;\nvarying float vPelletOpacity;',
      )
      .replace(
        '#include <begin_vertex>',
        useColorAttribute
          ? '#include <begin_vertex>\n  vPelletOpacity = pelletOpacity;\n  vPelletColor = pelletColor;'
          : '#include <begin_vertex>\n  vPelletOpacity = pelletOpacity;',
      )

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        useColorAttribute
          ? '#include <common>\nvarying float vPelletOpacity;\nvarying vec3 vPelletColor;'
          : '#include <common>\nvarying float vPelletOpacity;',
      )
      .replace(
        '#include <color_fragment>',
        useColorAttribute
          ? '#include <color_fragment>\n  diffuseColor.a *= clamp(vPelletOpacity, 0.0, 1.0);\n  diffuseColor.rgb *= clamp(vPelletColor, vec3(0.0), vec3(1.0));'
          : '#include <color_fragment>\n  diffuseColor.a *= clamp(vPelletOpacity, 0.0, 1.0);',
      )
  }
}

export const createPelletBucketManager = ({
  pelletBuckets,
  pelletsGroup,
  pelletPulseBucketCount,
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
  pelletShadowOpacityBase,
  pelletCoreOpacityBase,
  pelletInnerGlowOpacityBase,
  pelletGlowOpacityBase,
}: CreatePelletBucketManagerParams): PelletBucketManager => {
  const sizeTierCount = Math.max(1, pelletSizeTierMultipliers.length)
  const pulseBucketCount = Math.max(1, Math.floor(pelletPulseBucketCount))
  const bucketCount = sizeTierCount * pulseBucketCount

  const pelletSizeTierIndex = (size: number) => {
    if (!Number.isFinite(size) || sizeTierCount <= 1) return 0
    if (sizeTierCount >= 3 && size >= pelletSizeTierLargeMin) return 2
    if (size >= pelletSizeTierMediumMin) return 1
    return 0
  }

  const pelletPulseBucketIndex = (pelletId: number) => {
    if (pulseBucketCount <= 1 || !Number.isFinite(pelletId)) {
      return 0
    }
    const bucket = Math.trunc(pelletId) % pulseBucketCount
    return bucket >= 0 ? bucket : bucket + pulseBucketCount
  }

  const pelletBucketIndex = (pelletId: number, size: number) => {
    const tierIndex = pelletSizeTierIndex(size)
    const pulseIndex = pelletPulseBucketIndex(pelletId)
    const bucketIndex = tierIndex * pulseBucketCount + pulseIndex
    return Math.max(0, Math.min(bucketCount - 1, bucketIndex))
  }

  const createBucketGeometry = (capacity: number) => {
    const geometry = new THREE.BufferGeometry()
    const positionArray = new Float32Array(capacity * 3)
    const opacityArray = new Float32Array(capacity)
    const colorArray = new Float32Array(capacity * 3)
    const positionAttribute = new THREE.BufferAttribute(positionArray, 3)
    const opacityAttribute = new THREE.BufferAttribute(opacityArray, 1)
    const colorAttribute = new THREE.BufferAttribute(colorArray, 3)
    positionAttribute.setUsage(THREE.DynamicDrawUsage)
    opacityAttribute.setUsage(THREE.DynamicDrawUsage)
    colorAttribute.setUsage(THREE.DynamicDrawUsage)
    geometry.setAttribute('position', positionAttribute)
    geometry.setAttribute('pelletOpacity', opacityAttribute)
    geometry.setAttribute('pelletColor', colorAttribute)
    geometry.setDrawRange(0, 0)
    return { geometry, positionAttribute, opacityAttribute, colorAttribute }
  }

  const createPelletBucket = (bucketIndex: number, capacity: number): PelletSpriteBucket => {
    const clampedBucketIndex = Math.max(0, Math.min(bucketCount - 1, bucketIndex))
    const sizeTierIndex = Math.max(
      0,
      Math.min(sizeTierCount - 1, Math.floor(clampedBucketIndex / pulseBucketCount)),
    )
    const pulseBucketIndex = clampedBucketIndex % pulseBucketCount
    const sizeMultiplier = pelletSizeTierMultipliers[sizeTierIndex] ?? 1
    const baseShadowSize = pelletShadowPointSize * sizeMultiplier
    const baseCoreSize = pelletCorePointSize * sizeMultiplier
    const baseInnerGlowSize = pelletInnerGlowPointSize * sizeMultiplier
    const baseGlowSize = pelletGlowPointSize * sizeMultiplier

    const { geometry, positionAttribute, opacityAttribute, colorAttribute } =
      createBucketGeometry(capacity)

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
      color: '#ffffff',
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
      color: '#ffffff',
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
      color: '#ffffff',
      transparent: true,
      opacity: pelletGlowOpacityBase,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
      sizeAttenuation: true,
      toneMapped: false,
    })

    applyPelletAttributesToPointsMaterial(shadowMaterial, false)
    applyPelletAttributesToPointsMaterial(coreMaterial, true)
    applyPelletAttributesToPointsMaterial(innerGlowMaterial, true)
    applyPelletAttributesToPointsMaterial(glowMaterial, true)

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
      colorAttribute,
      capacity,
      baseShadowSize,
      baseCoreSize,
      baseInnerGlowSize,
      baseGlowSize,
      pulseBucketIndex,
      sizeTierIndex,
      bucketIndex: clampedBucketIndex,
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

    const {
      geometry,
      positionAttribute,
      opacityAttribute,
      colorAttribute,
    } = createBucketGeometry(nextCapacity)

    const previousGeometry = bucket.corePoints.geometry
    bucket.shadowPoints.geometry = geometry
    bucket.corePoints.geometry = geometry
    bucket.innerGlowPoints.geometry = geometry
    bucket.glowPoints.geometry = geometry
    previousGeometry.dispose()

    bucket.positionAttribute = positionAttribute
    bucket.opacityAttribute = opacityAttribute
    bucket.colorAttribute = colorAttribute
    bucket.capacity = nextCapacity
    return bucket
  }

  return {
    pelletBucketIndex,
    ensurePelletBucketCapacity,
  }
}
