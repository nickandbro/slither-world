import * as THREE from 'three'
import type { PlayerSnapshot } from '../../../../game/types'
import type { SnakeVisual } from '../runtimeTypes'
import { clamp, smoothValue } from '../utils/math'
import type { BoostDraftMaterialUserData } from './visual'
import { hideBoostDraft } from './visual'

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
  tongueBaseGeometry: THREE.CylinderGeometry
  tongueForkGeometry: THREE.CylinderGeometry
  tongueMaterial: THREE.MeshStandardMaterial
  boostDraftGeometry: THREE.SphereGeometry
  boostDraftTexture: THREE.Texture | null
  intakeConeGeometry: THREE.PlaneGeometry
  intakeConeTexture: THREE.Texture | null
  createNameplateTexture: (name: string) =>
    | { texture: THREE.CanvasTexture; canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D }
    | null
  nameplateWorldWidth: number
  nameplateWorldAspect: number
  headRadius: number
  constants: {
    boostDraftEdgeFadeStart: number
    boostDraftEdgeFadeEnd: number
    boostDraftColorA: THREE.Color
    boostDraftColorB: THREE.Color
    boostDraftColorShiftSpeed: number
    boostDraftPulseSpeed: number
    boostDraftOpacity: number
    boostDraftFadeInRate: number
    boostDraftFadeOutRate: number
    boostDraftMinActiveOpacity: number
    boostDraftBaseRadius: number
    boostDraftFrontOffset: number
    boostDraftLift: number
    boostDraftLocalForwardAxis: THREE.Vector3
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

type UpdateBoostDraftArgs = {
  visual: SnakeVisual
  player: PlayerSnapshot
  headPosition: THREE.Vector3
  headNormal: THREE.Vector3
  forward: THREE.Vector3
  headRadius: number
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
    tongueBaseGeometry,
    tongueForkGeometry,
    tongueMaterial,
    boostDraftGeometry,
    boostDraftTexture,
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
  const tempQuat = new THREE.Quaternion()

  const createBoostDraftMaterial = () => {
    const materialParams: THREE.MeshBasicMaterialParameters = {
      color: constants.boostDraftColorA,
      transparent: true,
      opacity: 0,
      side: THREE.FrontSide,
      blending: THREE.NormalBlending,
    }
    if (!webglShaderHooksEnabled && boostDraftTexture) {
      // CanvasTexture alpha lives in the alpha channel; `alphaMap` samples the green channel.
      materialParams.map = boostDraftTexture
    }
    const material = new THREE.MeshBasicMaterial(materialParams)
    material.depthWrite = false
    material.depthTest = true
    material.alphaTest = 0
    const materialUserData = material.userData as BoostDraftMaterialUserData
    if (webglShaderHooksEnabled) {
      material.onBeforeCompile = (shader) => {
        const timeUniform = { value: 0 }
        const opacityUniform = { value: 0 }
        materialUserData.timeUniform = timeUniform
        materialUserData.opacityUniform = opacityUniform
        shader.uniforms.boostDraftTime = timeUniform
        shader.uniforms.boostDraftOpacity = opacityUniform
        shader.vertexShader = shader.vertexShader
          .replace(
            '#include <common>',
            '#include <common>\nvarying vec3 vBoostDraftLocalPos;',
          )
          .replace(
            '#include <begin_vertex>',
            '#include <begin_vertex>\n  vBoostDraftLocalPos = position;',
          )
        shader.fragmentShader = shader.fragmentShader
          .replace(
            '#include <common>',
            '#include <common>\nvarying vec3 vBoostDraftLocalPos;\nuniform float boostDraftTime;\nuniform float boostDraftOpacity;',
          )
          .replace(
            '#include <color_fragment>',
            `#include <color_fragment>
vec3 boostLocal = normalize(vBoostDraftLocalPos);
float boostRim = length(boostLocal.xz);
float boostEdgeFade =
  1.0 - smoothstep(${constants.boostDraftEdgeFadeStart.toFixed(3)}, ${constants.boostDraftEdgeFadeEnd.toFixed(3)}, boostRim);
float boostNoiseA = sin((boostLocal.x * 9.5) + (boostLocal.z * 8.2) + boostDraftTime * 3.7) * 0.5 + 0.5;
float boostNoiseB = sin((boostLocal.z * 11.3) - (boostLocal.x * 7.6) - boostDraftTime * 2.9) * 0.5 + 0.5;
float boostColorMix = clamp(0.28 + 0.72 * (boostNoiseA * 0.58 + boostNoiseB * 0.42), 0.0, 1.0);
vec3 boostColor = mix(vec3(0.337, 0.851, 1.0), vec3(1.0), boostColorMix);
diffuseColor.rgb = boostColor;
diffuseColor.a *= boostDraftOpacity * boostEdgeFade;`,
          )
      }
    }
    return material
  }

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
    const tongueMaterialLocal = tongueMaterial.clone()
    const eyeLeft = new THREE.Mesh(eyeGeometry, eyeMaterialLocal)
    const eyeRight = new THREE.Mesh(eyeGeometry, eyeMaterialLocal)
    const pupilLeft = new THREE.Mesh(pupilGeometry, pupilMaterialLocal)
    const pupilRight = new THREE.Mesh(pupilGeometry, pupilMaterialLocal)
    const tongue = new THREE.Group()
    const tongueBase = new THREE.Mesh(tongueBaseGeometry, tongueMaterialLocal)
    const tongueForkLeft = new THREE.Mesh(tongueForkGeometry, tongueMaterialLocal)
    const tongueForkRight = new THREE.Mesh(tongueForkGeometry, tongueMaterialLocal)
    tongueForkLeft.rotation.z = 0.55
    tongueForkRight.rotation.z = -0.55
    tongue.add(tongueBase)
    tongue.add(tongueForkLeft)
    tongue.add(tongueForkRight)
    tongue.visible = false
    group.add(eyeLeft)
    group.add(eyeRight)
    group.add(pupilLeft)
    group.add(pupilRight)
    group.add(tongue)

    const boostDraftMaterial = createBoostDraftMaterial()
    const boostDraft = new THREE.Mesh(boostDraftGeometry, boostDraftMaterial)
    boostDraft.visible = false
    boostDraft.renderOrder = 2
    group.add(boostDraft)

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
      tongue,
      tongueBase,
      tongueForkLeft,
      tongueForkRight,
      bowl,
      bowlMaterial,
      bowlCrackUniform,
      boostDraft,
      boostDraftMaterial,
      boostDraftPhase: 0,
      boostDraftIntensity: 0,
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

  const updateBoostDraft = ({
    visual,
    player,
    headPosition,
    headNormal,
    forward,
    headRadius,
    snakeOpacity,
    deltaSeconds,
  }: UpdateBoostDraftArgs) => {
    const active =
      player.alive &&
      player.isBoosting &&
      snakeOpacity > constants.boostDraftMinActiveOpacity
    const safeDelta = Math.max(0, deltaSeconds)
    visual.boostDraftPhase =
      (visual.boostDraftPhase + safeDelta * constants.boostDraftPulseSpeed) % (Math.PI * 2)
    const targetIntensity = active ? 1 : 0
    visual.boostDraftIntensity = smoothValue(
      visual.boostDraftIntensity,
      targetIntensity,
      safeDelta,
      constants.boostDraftFadeInRate,
      constants.boostDraftFadeOutRate,
    )
    const intensity = clamp(visual.boostDraftIntensity, 0, 1)
    if (intensity <= constants.boostDraftMinActiveOpacity) {
      hideBoostDraft(visual)
      return
    }

    const radius = constants.boostDraftBaseRadius * (headRadius / baseHeadRadius)
    visual.boostDraft.position
      .copy(headPosition)
      .addScaledVector(forward, constants.boostDraftFrontOffset + radius * 0.58)
      .addScaledVector(headNormal, constants.boostDraftLift)
    visual.boostDraft.scale.setScalar(radius)
    tempQuat.setFromUnitVectors(constants.boostDraftLocalForwardAxis, forward)
    visual.boostDraft.quaternion.copy(tempQuat)
    visual.boostDraft.visible = true

    const colorT =
      0.5 +
      0.5 *
        Math.sin(
          visual.boostDraftPhase *
            (constants.boostDraftColorShiftSpeed / constants.boostDraftPulseSpeed),
        )
    visual.boostDraftMaterial.color
      .copy(constants.boostDraftColorA)
      .lerp(constants.boostDraftColorB, colorT)
    const opacity = constants.boostDraftOpacity * snakeOpacity * intensity
    visual.boostDraftMaterial.opacity = opacity
    const userData = visual.boostDraftMaterial.userData as BoostDraftMaterialUserData
    if (userData.timeUniform) {
      userData.timeUniform.value = visual.boostDraftPhase
    }
    if (userData.opacityUniform) {
      userData.opacityUniform.value = opacity
    }
  }

  return {
    createBoostDraftMaterial,
    createSnakeVisual,
    updateIntakeCone,
    updateBoostDraft,
  }
}
