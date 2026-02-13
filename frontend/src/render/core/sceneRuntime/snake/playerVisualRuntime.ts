import * as THREE from 'three'
import type { PlayerSnapshot } from '../../../../game/types'
import type { SnakeVisual } from '../runtimeTypes'
import { SNAKE_STRIPE_DARK, SNAKE_STRIPE_EDGE, SNAKE_STRIPE_REPEAT } from '../constants'
import { clamp, smoothValue, smoothstep } from '../utils/math'
import { resolveSkinSlots } from '../utils/texture'

type SnakePlayerVisualRuntimeDeps = {
  webglShaderHooksEnabled: boolean
  world: THREE.Group
  camera: THREE.PerspectiveCamera
  headGeometry: THREE.SphereGeometry
  bowlGeometry: THREE.SphereGeometry
  tailGeometry: THREE.SphereGeometry
  eyeGeometry: THREE.SphereGeometry
  pupilGeometry: THREE.SphereGeometry
  eyeMaterial: THREE.MeshStandardMaterial
  pupilMaterial: THREE.MeshStandardMaterial
  boostBodyGlowTexture: THREE.Texture | null
  intakeConeGeometry: THREE.PlaneGeometry
  intakeConeTexture: THREE.Texture | null
  createNameplateTexture: (name: string) =>
    | { texture: THREE.CanvasTexture; canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D }
    | null
  nameplateWorldWidth: number
  nameplateWorldAspect: number
  headRadius: number
  constants: {
    boostBodyGlowFadeInRate: number
    boostBodyGlowFadeOutRate: number
    boostBodyGlowMinActiveOpacity: number
    boostBodyGlowTravelSpeed: number
    boostBodyGlowNodesPerWave: number
    boostBodyGlowMinWaveCount: number
    boostBodyGlowMaxWaveCount: number
    boostBodyGlowWaveCountRate: number
    boostBodyGlowWaveHalfWidth: number
    boostBodyGlowWaveFalloffPower: number
    boostBodyGlowWavePeakRatio: number
    boostBodyGlowWavePeakBoost: number
    boostBodyGlowWaveBaseline: number
    boostBodyGlowSpriteMinCount: number
    boostBodyGlowSpriteMaxCount: number
    boostBodyGlowSpritesPerNode: number
    boostBodyGlowSpriteScaleMult: number
    boostBodyGlowSpriteSurfaceOffsetMult: number
    boostBodyGlowSpriteOpacity: number
    boostBodyGlowSpriteColorBlend: number
    intakeConeDisengageHoldMs: number
    intakeConeViewMargin: number
    intakeConeFadeInRate: number
    intakeConeFadeOutRate: number
    intakeConeMaxOpacity: number
    intakeConeBaseLength: number
    intakeConeBaseWidth: number
    intakeConeLift: number
    deathVisibilityCutoff: number
  }
}

type UpdateIntakeConeArgs = {
  visual: SnakeVisual
  activeByLock: boolean
  headPosition: THREE.Vector3
  mouthPosition: THREE.Vector3
  headNormal: THREE.Vector3
  forward: THREE.Vector3
  right: THREE.Vector3
  headRadius: number
  snakeOpacity: number
  deltaSeconds: number
  nowMs: number
}

type UpdateBoostBodyGlowArgs = {
  visual: SnakeVisual
  player: PlayerSnapshot
  snakeLengthUnits: number
  curvePoints: THREE.Vector3[] | null
  snakeRadius: number
  snakeOpacity: number
  deltaSeconds: number
}

export const createSnakePlayerVisualRuntime = (deps: SnakePlayerVisualRuntimeDeps) => {
  const {
    webglShaderHooksEnabled,
    world,
    camera,
    headGeometry,
    bowlGeometry,
    tailGeometry,
    eyeGeometry,
    pupilGeometry,
    eyeMaterial,
    pupilMaterial,
    boostBodyGlowTexture,
    intakeConeGeometry,
    intakeConeTexture,
    createNameplateTexture,
    nameplateWorldWidth,
    nameplateWorldAspect,
    headRadius: baseHeadRadius,
    constants,
  } = deps

  const intakeConeClipTemp = new THREE.Vector3()
  const intakeConeOrientationMatrix = new THREE.Matrix4()
  const boostBodyGlowTintTemp = new THREE.Color()
  const boostBodyGlowSamplePointTemp = new THREE.Vector3()
  const boostBodyGlowNormalTemp = new THREE.Vector3()
  const boostBodyGlowWhite = new THREE.Color('#ffffff')

  const createSnakeVisual = (
    primaryColor: string,
    skinKey: string,
    skinTexture: THREE.CanvasTexture,
  ): SnakeVisual => {
    const group = new THREE.Group()

    const tubeMaterial = new THREE.MeshStandardMaterial({
      color: '#ffffff',
      roughness: 0.35,
      metalness: 0.1,
      flatShading: false,
    })
    tubeMaterial.map = skinTexture
    tubeMaterial.emissiveMap = skinTexture
    tubeMaterial.emissive = new THREE.Color('#ffffff')
    // Keep tube + glow sharing the same geometry so updates are single-buffer writes.
    const tubeGeometry = new THREE.BufferGeometry()
    const tube = new THREE.Mesh(tubeGeometry, tubeMaterial)
    group.add(tube)

    const boostBodyGlowGroup = new THREE.Group()
    boostBodyGlowGroup.visible = false
    group.add(boostBodyGlowGroup)

    const selfOverlapGlowMaterial = new THREE.MeshBasicMaterial({
      color: primaryColor,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      vertexColors: true,
    })
    selfOverlapGlowMaterial.depthWrite = false
    selfOverlapGlowMaterial.depthTest = true
    const selfOverlapGlow = new THREE.Mesh(tubeGeometry, selfOverlapGlowMaterial)
    selfOverlapGlow.visible = false
    selfOverlapGlow.renderOrder = 1
    group.add(selfOverlapGlow)

    const headMaterial = new THREE.MeshStandardMaterial({
      color: primaryColor,
      roughness: 0.25,
      metalness: 0.1,
    })
    const head = new THREE.Mesh(headGeometry, headMaterial)
    group.add(head)

    const bowlCrackUniform = { value: 0 }
    const bowlMaterial = new THREE.MeshPhysicalMaterial({
      color: '#cfefff',
      roughness: 0.08,
      metalness: 0.0,
      transmission: 0.7,
      thickness: 0.35,
      clearcoat: 1,
      clearcoatRoughness: 0.1,
      transparent: true,
      opacity: 0.45,
    })
    bowlMaterial.depthWrite = false
    if (webglShaderHooksEnabled) {
      bowlMaterial.onBeforeCompile = (shader) => {
        shader.uniforms.crackAmount = bowlCrackUniform
        shader.fragmentShader = `uniform float crackAmount;\n${shader.fragmentShader}`
        shader.fragmentShader = shader.fragmentShader.replace(
          '#include <dithering_fragment>',
          `
          float crackMask = 0.0;
          vec3 crackPos = normalize(vNormal);
          float lineA = abs(sin(crackPos.x * 24.0) * sin(crackPos.y * 21.0));
          float lineB = abs(sin(crackPos.y * 17.0 + crackPos.z * 11.0));
          float lineC = abs(sin(crackPos.z * 19.0 - crackPos.x * 13.0));
          float lines = max(lineA, max(lineB, lineC));
          crackMask = smoothstep(0.92, 0.985, lines) * crackAmount;
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.1, 0.16, 0.2), crackMask);
          diffuseColor.a = max(diffuseColor.a, crackMask * 0.6);
          #include <dithering_fragment>
          `,
        )
      }
    }
    const bowl = new THREE.Mesh(bowlGeometry, bowlMaterial)
    bowl.renderOrder = 3
    bowl.visible = false
    group.add(bowl)

    const tail = new THREE.Mesh(tailGeometry, tubeMaterial)
    group.add(tail)

    const eyeMaterialLocal = eyeMaterial.clone()
    const pupilMaterialLocal = pupilMaterial.clone()
    const eyeLeft = new THREE.Mesh(eyeGeometry, eyeMaterialLocal)
    const eyeRight = new THREE.Mesh(eyeGeometry, eyeMaterialLocal)
    const pupilLeft = new THREE.Mesh(pupilGeometry, pupilMaterialLocal)
    const pupilRight = new THREE.Mesh(pupilGeometry, pupilMaterialLocal)
    group.add(eyeLeft)
    group.add(eyeRight)
    group.add(pupilLeft)
    group.add(pupilRight)

    const intakeConeMaterial = new THREE.MeshBasicMaterial({
      color: '#d6f5ff',
      map: intakeConeTexture ?? undefined,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
      blending: THREE.NormalBlending,
      toneMapped: false,
    })
    const intakeCone = new THREE.Mesh(intakeConeGeometry, intakeConeMaterial)
    intakeCone.visible = false
    intakeCone.renderOrder = 2.1
    group.add(intakeCone)

    const nameplateTarget = createNameplateTexture('Player')
    const nameplateMaterial = new THREE.SpriteMaterial({
      map: nameplateTarget?.texture ?? null,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      depthTest: true,
      fog: false,
    })
    const nameplate = new THREE.Sprite(nameplateMaterial)
    nameplate.visible = false
    nameplate.renderOrder = 4
    nameplate.scale.set(nameplateWorldWidth, nameplateWorldWidth / nameplateWorldAspect, 1)
    group.add(nameplate)

    return {
      group,
      tube,
      selfOverlapGlow,
      selfOverlapGlowMaterial,
      head,
      tail,
      eyeLeft,
      eyeRight,
      pupilLeft,
      pupilRight,
      bowl,
      bowlMaterial,
      bowlCrackUniform,
      boostBodyGlowGroup,
      boostBodyGlowSprites: [],
      boostBodyGlowPhase: 0,
      boostBodyGlowIntensity: 0,
      boostBodyGlowWaveCount: 1,
      boostBodyGlowMode: 'off',
      intakeCone,
      intakeConeMaterial,
      intakeConeIntensity: 0,
      intakeConeHoldUntilMs: 0,
      nameplate,
      nameplateMaterial,
      nameplateTexture: nameplateTarget?.texture ?? null,
      nameplateCanvas: nameplateTarget?.canvas ?? null,
      nameplateCtx: nameplateTarget?.ctx ?? null,
      nameplateText: '',
      color: primaryColor,
      skinKey,
    }
  }

  const updateIntakeCone = ({
    visual,
    activeByLock,
    headPosition,
    mouthPosition,
    headNormal,
    forward,
    right,
    headRadius,
    snakeOpacity,
    deltaSeconds,
    nowMs,
  }: UpdateIntakeConeArgs) => {
    if (activeByLock) {
      visual.intakeConeHoldUntilMs = nowMs + constants.intakeConeDisengageHoldMs
    }
    intakeConeClipTemp.copy(headPosition).applyQuaternion(world.quaternion).project(camera)
    const headInView =
      Number.isFinite(intakeConeClipTemp.x) &&
      Number.isFinite(intakeConeClipTemp.y) &&
      Number.isFinite(intakeConeClipTemp.z) &&
      intakeConeClipTemp.z >= -1 &&
      intakeConeClipTemp.z <= 1 &&
      Math.abs(intakeConeClipTemp.x) <= 1 + constants.intakeConeViewMargin &&
      Math.abs(intakeConeClipTemp.y) <= 1 + constants.intakeConeViewMargin
    const holdActive = nowMs < visual.intakeConeHoldUntilMs
    const targetActive =
      snakeOpacity > constants.deathVisibilityCutoff &&
      headInView &&
      (activeByLock || holdActive)
    const safeDelta = Math.max(0, deltaSeconds)
    visual.intakeConeIntensity = smoothValue(
      visual.intakeConeIntensity,
      targetActive ? 1 : 0,
      safeDelta,
      constants.intakeConeFadeInRate,
      constants.intakeConeFadeOutRate,
    )
    const intensity = clamp(visual.intakeConeIntensity, 0, 1)
    if (intensity <= 0.01) {
      if (!targetActive) {
        visual.intakeConeHoldUntilMs = 0
      }
      visual.intakeCone.visible = false
      visual.intakeConeMaterial.opacity = 0
      return
    }

    const coneScale = clamp(headRadius / baseHeadRadius, 0.9, 1.45)
    const coneLength = constants.intakeConeBaseLength * coneScale
    const coneWidth = constants.intakeConeBaseWidth * coneScale
    visual.intakeCone.position.copy(mouthPosition).addScaledVector(headNormal, constants.intakeConeLift)
    intakeConeOrientationMatrix.makeBasis(right, forward, headNormal)
    visual.intakeCone.quaternion.setFromRotationMatrix(intakeConeOrientationMatrix)
    visual.intakeCone.scale.set(coneWidth, coneLength, 1)
    visual.intakeConeMaterial.opacity = constants.intakeConeMaxOpacity * snakeOpacity * intensity
    visual.intakeCone.visible = true
  }

  const createBoostBodyGlowSprite = () => {
    const material = new THREE.SpriteMaterial({
      map: boostBodyGlowTexture ?? undefined,
      color: '#ffffff',
      transparent: true,
      opacity: 0,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    })
    const sprite = new THREE.Sprite(material)
    sprite.visible = false
    sprite.renderOrder = 1.6
    return sprite
  }

  const ensureBoostBodyGlowSpriteCount = (visual: SnakeVisual, count: number) => {
    const target = Math.max(0, Math.floor(count))
    while (visual.boostBodyGlowSprites.length < target) {
      const sprite = createBoostBodyGlowSprite()
      visual.boostBodyGlowSprites.push(sprite)
      visual.boostBodyGlowGroup.add(sprite)
    }
    while (visual.boostBodyGlowSprites.length > target) {
      const sprite = visual.boostBodyGlowSprites.pop()
      if (!sprite) continue
      visual.boostBodyGlowGroup.remove(sprite)
      sprite.material.dispose()
    }
  }

  const repeatWaveDistance = (value: number) => {
    const wrapped = ((value % 1) + 1) % 1
    return Math.abs(wrapped - 0.5)
  }

  const updateBoostBodyGlow = ({
    visual,
    player,
    snakeLengthUnits,
    curvePoints,
    snakeRadius,
    snakeOpacity,
    deltaSeconds,
  }: UpdateBoostBodyGlowArgs) => {
    const hasVisibleBody = visual.group.visible && visual.tube.visible
    const hasCurve = !!curvePoints && curvePoints.length > 1
    const active =
      hasVisibleBody &&
      hasCurve &&
      player.alive &&
      player.isBoosting &&
      snakeOpacity > constants.boostBodyGlowMinActiveOpacity &&
      snakeLengthUnits > 0
    const safeDelta = Math.max(0, deltaSeconds)
    visual.boostBodyGlowIntensity = smoothValue(
      visual.boostBodyGlowIntensity,
      active ? 1 : 0,
      safeDelta,
      constants.boostBodyGlowFadeInRate,
      constants.boostBodyGlowFadeOutRate,
    )
    const intensity = clamp(visual.boostBodyGlowIntensity, 0, 1)
    const targetWaveCount = clamp(
      Math.floor(Math.max(0, snakeLengthUnits) / Math.max(1, constants.boostBodyGlowNodesPerWave)),
      constants.boostBodyGlowMinWaveCount,
      constants.boostBodyGlowMaxWaveCount,
    )
    visual.boostBodyGlowWaveCount = smoothValue(
      visual.boostBodyGlowWaveCount,
      targetWaveCount,
      safeDelta,
      constants.boostBodyGlowWaveCountRate,
      constants.boostBodyGlowWaveCountRate,
    )
    const waveCount = clamp(
      visual.boostBodyGlowWaveCount,
      constants.boostBodyGlowMinWaveCount,
      constants.boostBodyGlowMaxWaveCount,
    )
    if (intensity > constants.boostBodyGlowMinActiveOpacity) {
      visual.boostBodyGlowPhase =
        (visual.boostBodyGlowPhase + safeDelta * constants.boostBodyGlowTravelSpeed) % 1
    } else {
      visual.boostBodyGlowPhase = 0
    }

    const intensityWithOpacity = intensity * snakeOpacity
    if (intensityWithOpacity <= constants.boostBodyGlowMinActiveOpacity || !curvePoints) {
      visual.boostBodyGlowGroup.visible = false
      visual.boostBodyGlowMode = 'off'
      for (const sprite of visual.boostBodyGlowSprites) {
        sprite.visible = false
        sprite.material.opacity = 0
      }
      return
    }

    const targetSpriteCount = clamp(
      Math.round(Math.max(
        constants.boostBodyGlowSpriteMinCount,
        snakeLengthUnits * constants.boostBodyGlowSpritesPerNode,
        waveCount * 42,
      )),
      constants.boostBodyGlowSpriteMinCount,
      constants.boostBodyGlowSpriteMaxCount,
    )
    ensureBoostBodyGlowSpriteCount(visual, targetSpriteCount)
    visual.boostBodyGlowMode = 'sprite-wave'
    visual.boostBodyGlowGroup.visible = true
    const skinSource =
      player.skinColors && player.skinColors.length > 0 ? player.skinColors : [player.color]
    const skinSlots = resolveSkinSlots(skinSource)
    const stripeDark = clamp(SNAKE_STRIPE_DARK, 0, 1)
    const stripeEdge = clamp(SNAKE_STRIPE_EDGE, 0.001, 0.49)
    const stripeRepeat = Math.max(1, Math.floor(SNAKE_STRIPE_REPEAT))
    const colorBlend = clamp(constants.boostBodyGlowSpriteColorBlend, 0, 1)
    const safeSnakeStart = Number.isFinite(player.snakeStart) ? Math.max(0, player.snakeStart) : 0
    const safeSnakeSpan = Number.isFinite(snakeLengthUnits) ? Math.max(0, snakeLengthUnits) : 0
    const safeRadius = Math.max(0.001, snakeRadius)
    const spriteSurfaceOffset = safeRadius * constants.boostBodyGlowSpriteSurfaceOffsetMult
    const spriteBaseScale = safeRadius * constants.boostBodyGlowSpriteScaleMult
    for (let i = 0; i < visual.boostBodyGlowSprites.length; i += 1) {
      const sprite = visual.boostBodyGlowSprites[i]
      const progress =
        visual.boostBodyGlowSprites.length <= 1
          ? 0
          : i / (visual.boostBodyGlowSprites.length - 1)
      const waveCoord = (progress - visual.boostBodyGlowPhase) * waveCount
      const waveDistance = repeatWaveDistance(waveCoord)
      const waveSpan = Math.max(0.001, constants.boostBodyGlowWaveHalfWidth)
      const peakSpan = Math.max(0.001, waveSpan * clamp(constants.boostBodyGlowWavePeakRatio, 0.1, 1))
      const spanNorm = waveDistance / waveSpan
      const peakNorm = waveDistance / peakSpan
      const broadMask = Math.exp(
        -Math.pow(spanNorm, 2) * Math.max(0.1, constants.boostBodyGlowWaveFalloffPower),
      )
      const peakMask = Math.exp(-Math.pow(peakNorm, 2) * 2.2)
      const waveMask = clamp(
        broadMask * (1 + peakMask * Math.max(0, constants.boostBodyGlowWavePeakBoost)),
        clamp(constants.boostBodyGlowWaveBaseline, 0, 0.3),
        1,
      )
      const alpha =
        intensityWithOpacity *
        constants.boostBodyGlowSpriteOpacity *
        waveMask
      if (alpha <= constants.boostBodyGlowMinActiveOpacity) {
        sprite.visible = false
        sprite.material.opacity = 0
        continue
      }
      const curveIndex = progress * (curvePoints.length - 1)
      const pointIndexA = clamp(Math.floor(curveIndex), 0, curvePoints.length - 1)
      const pointIndexB = clamp(pointIndexA + 1, 0, curvePoints.length - 1)
      const pointA = curvePoints[pointIndexA]
      const pointB = curvePoints[pointIndexB]
      if (!pointA || !pointB) {
        sprite.visible = false
        sprite.material.opacity = 0
        continue
      }
      boostBodyGlowSamplePointTemp.copy(pointA).lerp(pointB, curveIndex - pointIndexA)
      boostBodyGlowNormalTemp.copy(boostBodyGlowSamplePointTemp).normalize()
      // Keep sprite centers slightly inside the body so depth testing preserves snake-over-glow layering.
      sprite.position
        .copy(boostBodyGlowSamplePointTemp)
        .addScaledVector(boostBodyGlowNormalTemp, spriteSurfaceOffset)
      const scale = spriteBaseScale * (0.88 + waveMask * 0.28)
      sprite.scale.setScalar(scale)
      const globalIndex = safeSnakeStart + progress * safeSnakeSpan
      const slotWrapped = ((globalIndex % 8) + 8) % 8
      const slotIndex = clamp(Math.floor(slotWrapped), 0, 7)
      const slotColor = skinSlots[slotIndex] ?? visual.color
      const u = globalIndex / 8
      const stripeWave = Math.cos(u * Math.PI * 2 * stripeRepeat)
      const stripeMix = smoothstep(-stripeEdge, stripeEdge, stripeWave)
      const stripeValue = stripeDark + (1 - stripeDark) * stripeMix
      boostBodyGlowTintTemp.set(slotColor).multiplyScalar(stripeValue)
      if (colorBlend > 0) {
        boostBodyGlowTintTemp.lerp(boostBodyGlowWhite, colorBlend)
      }
      sprite.material.color.copy(boostBodyGlowTintTemp)
      sprite.material.opacity = alpha
      sprite.visible = true
    }
  }

  return {
    createSnakeVisual,
    updateIntakeCone,
    updateBoostBodyGlow,
  }
}
