import {
  FaceLandmarker,
  FilesetResolver,
  HandLandmarker,
  type FaceLandmarkerResult,
  type HandLandmarkerResult,
  type NormalizedLandmark,
} from '@mediapipe/tasks-vision'
import { GLASSES, STICKERS, type StickerOption } from './options'
import './style.css'

const WASM_PATH = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm'
const FACE_MODEL =
  'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/latest/face_landmarker.task'
const HAND_MODEL =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task'

document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
  <main class="experience">
    <video id="camera" playsinline muted aria-hidden="true"></video>
    <canvas id="scene" aria-label="카메라와 가상 안경 미리보기"></canvas>
    <div class="ambient" aria-hidden="true"></div>

    <section class="intro-screen" id="intro-screen" aria-label="Gentle Monster 가상 안경 체험 시작 화면">
      <span class="intro-side-copy">TRY ON GLASSES</span>
      <div class="intro-center">
        <h1 class="intro-logo">GENTLE MONSTER</h1>
        <button class="intro-enter" id="intro-enter" type="button" aria-label="가상 안경 체험 시작">
          <span aria-hidden="true"></span>
        </button>
      </div>
    </section>

    <section class="glasses-panel" aria-label="안경 선택">
      <div class="glasses-list" id="glasses-list">
        ${Array.from({ length: 3 }, () => GLASSES.map(
          (item) => `
              <button class="glasses-card" type="button" data-glasses="${item.id}" aria-label="${item.name} 안경 써보기">
                <img src="${item.src}" alt="" draggable="false" />
                <span class="item-name">${item.name}</span>
              </button>`,
        ).join('')).join('')}
      </div>
    </section>

    <aside class="sticker-panel" aria-label="별 스티커 선택">
      <div class="sticker-heading">
        <span class="eyebrow">FACE DECO</span>
      </div>
      <div class="sticker-list" id="sticker-list">
        ${STICKERS.map(
          (item) => `
            <button class="sticker-card" type="button" data-sticker="${item.id}" aria-label="${item.name} 스티커 집기">
              <img src="${item.src}" alt="" draggable="false" />
            </button>`,
        ).join('')}
      </div>
      <p class="pinch-hint"><span>🤏</span> 집어서 얼굴에<br />톡— 놓아주세요</p>
    </aside>

    <div class="hand-cursor" id="hand-cursor" aria-hidden="true">
      <span class="cursor-core"></span>
      <span class="cursor-label">검지</span>
    </div>

    <div class="toast" id="toast" role="status" aria-live="polite"></div>
  </main>
`

const video = document.querySelector<HTMLVideoElement>('#camera')!
const canvas = document.querySelector<HTMLCanvasElement>('#scene')!
const context = canvas.getContext('2d', { alpha: false })!
const glassesList = document.querySelector<HTMLDivElement>('#glasses-list')!
const cursor = document.querySelector<HTMLDivElement>('#hand-cursor')!
const toast = document.querySelector<HTMLDivElement>('#toast')!
const introScreen = document.querySelector<HTMLElement>('#intro-screen')!
const introEnter = document.querySelector<HTMLButtonElement>('#intro-enter')!

type Point = { x: number; y: number }
type FaceFrame = {
  center: Point
  xAxis: Point
  yAxis: Point
  leftTemple: Point
  rightTemple: Point
  width: number
  angle: number
  yaw: number
  templeTurn: number
}
type PlacedSticker = {
  id: number
  stickerId: string
  u: number
  v: number
  createdAt: number
}
type DragState = { sticker: StickerOption; point: Point } | null

let faceLandmarker: FaceLandmarker | null = null
let handLandmarker: HandLandmarker | null = null
let stream: MediaStream | null = null
let running = false
let starting = false
let lastVideoTime = -1
let lastInferenceAt = 0
let latestFace: FaceLandmarkerResult | null = null
let latestHands: HandLandmarkerResult | null = null
let faceFrame: FaceFrame | null = null
let stabilizingFaceFrame: FaceFrame | null = null
let faceStableFrames = 0
let faceMissingFrames = 0
let smoothedIndexPoint: Point | null = null
let smoothedThumbPoint: Point | null = null
let selectedGlassesId: string | null = null
let placedStickers: PlacedSticker[] = []
let stickerSequence = 0
let dragState: DragState = null
let pendingStickerRemovalId: number | null = null
let wasPinching = false
let pinchReleaseFrames = 0
let lastHandSeenAt = 0
let lastStickerRemovedAt = 0
let hoveredGlasses: { id: string; since: number } | null = null
let handCarouselState: { x: number; time: number; moved: boolean; lastMoveAt: number } | null = null
let carouselSelectionBlockedUntil = 0
let pointerCarouselState: { id: number; x: number; time: number; moved: boolean } | null = null
let carouselVelocity = 0
let carouselSnapPosition: number | null = null
let lastCarouselAnimationAt = 0
let glassesPinchActive = false
let gestureStage: 'idle' | 'open' | 'fist' = 'idle'
let gestureCandidate = ''
let gestureCandidateFrames = 0
let gestureDeadline = 0
let toastTimer = 0

const imageCache = new Map<string, HTMLImageElement>()
for (const asset of [...GLASSES, ...STICKERS]) {
  const image = new Image()
  image.src = asset.src
  imageCache.set(asset.src, image)
}
for (const glasses of GLASSES) {
  for (const source of [glasses.lensSrc, glasses.templeSrc]) {
    if (!source) continue
    const image = new Image()
    image.src = source
    imageCache.set(source, image)
  }
}

function showToast(message: string) {
  window.clearTimeout(toastTimer)
  toast.textContent = message
  toast.classList.add('is-visible')
  toastTimer = window.setTimeout(() => toast.classList.remove('is-visible'), 2100)
}

function distance(a: Point, b: Point) {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

function distanceToSegment(point: Point, start: Point, end: Point) {
  const dx = end.x - start.x
  const dy = end.y - start.y
  const lengthSquared = dx * dx + dy * dy
  if (lengthSquared === 0) return distance(point, start)
  const progress = clamp(((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared, 0, 1)
  return distance(point, { x: start.x + dx * progress, y: start.y + dy * progress })
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.max(minimum, Math.min(maximum, value))
}

function normalize(point: Point): Point {
  const length = Math.hypot(point.x, point.y) || 1
  return { x: point.x / length, y: point.y / length }
}

function add(a: Point, b: Point): Point {
  return { x: a.x + b.x, y: a.y + b.y }
}

function multiply(point: Point, scale: number): Point {
  return { x: point.x * scale, y: point.y * scale }
}

function average(...points: Point[]): Point {
  return {
    x: points.reduce((sum, point) => sum + point.x, 0) / points.length,
    y: points.reduce((sum, point) => sum + point.y, 0) / points.length,
  }
}

function videoLayout() {
  const videoWidth = video.videoWidth || 1280
  const videoHeight = video.videoHeight || 720
  const scale = Math.max(window.innerWidth / videoWidth, window.innerHeight / videoHeight)
  const width = videoWidth * scale
  const height = videoHeight * scale
  return { width, height, x: (window.innerWidth - width) / 2, y: (window.innerHeight - height) / 2 }
}

function mapLandmark(landmark: NormalizedLandmark): Point {
  const layout = videoLayout()
  return {
    x: layout.x + (1 - landmark.x) * layout.width,
    y: layout.y + landmark.y * layout.height,
  }
}

function calculateFaceFrame(
  landmarks: NormalizedLandmark[],
  transformationMatrix?: FaceLandmarkerResult['facialTransformationMatrixes'][number],
): FaceFrame {
  const eyeAOuter = mapLandmark(landmarks[33])
  const eyeAInner = mapLandmark(landmarks[133])
  const eyeBOuter = mapLandmark(landmarks[362])
  const eyeBInner = mapLandmark(landmarks[263])
  const eyeA = average(eyeAOuter, eyeAInner)
  const eyeB = average(eyeBOuter, eyeBInner)
  const leftEye = eyeA.x < eyeB.x ? eyeA : eyeB
  const rightEye = eyeA.x < eyeB.x ? eyeB : eyeA
  const leftEyeWidth = eyeA.x < eyeB.x ? distance(eyeAOuter, eyeAInner) : distance(eyeBOuter, eyeBInner)
  const rightEyeWidth = eyeA.x < eyeB.x ? distance(eyeBOuter, eyeBInner) : distance(eyeAOuter, eyeAInner)
  const eyeVector = { x: rightEye.x - leftEye.x, y: rightEye.y - leftEye.y }
  const xAxis = normalize(eyeVector)
  const yAxis = { x: -xAxis.y, y: xAxis.x }
  const eyeDistance = distance(leftEye, rightEye)
  const faceLeft = mapLandmark(landmarks[234])
  const faceRight = mapLandmark(landmarks[454])
  const templeA = mapLandmark(landmarks[127])
  const templeB = mapLandmark(landmarks[356])
  const leftTemple = templeA.x < templeB.x ? templeA : templeB
  const rightTemple = templeA.x < templeB.x ? templeB : templeA
  const faceWidth = Math.max(eyeDistance * 2.05, distance(faceLeft, faceRight))
  const nose = mapLandmark(landmarks[1])
  const noseBridge = mapLandmark(landmarks[168])
  const eyeCenter = average(leftEye, rightEye)
  const baseCenter = add(eyeCenter, multiply(yAxis, eyeDistance * 0.08))
  const projectX = (point: Point) =>
    (point.x - baseCenter.x) * xAxis.x + (point.y - baseCenter.y) * xAxis.y
  const contourA = projectX(faceLeft)
  const contourB = projectX(faceRight)
  const leftContour = Math.min(contourA, contourB)
  const rightContour = Math.max(contourA, contourB)
  const contourWidth = Math.max(rightContour - leftContour, 1)
  const silhouetteTurn = (projectX(nose) - (leftContour + rightContour) / 2) / contourWidth
  const eyeSizeTurn = (leftEyeWidth - rightEyeWidth) / Math.max(leftEyeWidth + rightEyeWidth, 1)
  // 코가 화면 오른쪽으로 이동하고 왼쪽 눈이 더 크게 보이면 화면 왼쪽 관자놀이가 노출된 상태다.
  const yaw = clamp(silhouetteTurn * 4.2 + eyeSizeTurn * 1.4, -1, 1)
  const matrix = transformationMatrix?.data
  const matrixYaw = matrix && matrix.length >= 11
    ? Math.abs(Math.atan2(matrix[8], matrix[10]))
    : 0
  // 표정과 눈 크기의 영향을 받지 않는 실제 3D 머리 회전각으로 다리 표시를 제어한다.
  const templeTurn = clamp((matrixYaw - 0.35) / 0.22, 0, 1)
  // 측면에서는 추정 이동값 대신 실제 코 윗부분에 브리지 중심을 직접 맞춘다.
  const bridgeFollow = clamp((Math.abs(yaw) - 0.02) / 0.3, 0, 1)
  const bridgeOffset =
    (noseBridge.x - baseCenter.x) * xAxis.x + (noseBridge.y - baseCenter.y) * xAxis.y
  const center = add(baseCenter, multiply(xAxis, bridgeOffset * bridgeFollow))
  return {
    center,
    xAxis,
    yAxis,
    leftTemple,
    rightTemple,
    width: faceWidth,
    angle: Math.atan2(xAxis.y, xAxis.x),
    yaw,
    templeTurn,
  }
}

function smoothFaceFrame(previous: FaceFrame | null, next: FaceFrame): FaceFrame {
  if (!previous) return next
  // Small landmark fluctuations are heavily damped, while deliberate head
  // movements still catch up quickly enough to avoid a delayed feeling.
  const centerMovement = distance(previous.center, next.center)
  const follow = clamp(0.2 + centerMovement / 75, 0.2, 0.5)
  const keep = 1 - follow
  const xAxis = normalize({
    x: previous.xAxis.x * keep + next.xAxis.x * follow,
    y: previous.xAxis.y * keep + next.xAxis.y * follow,
  })
  return {
    center: {
      x: previous.center.x * keep + next.center.x * follow,
      y: previous.center.y * keep + next.center.y * follow,
    },
    xAxis,
    yAxis: { x: -xAxis.y, y: xAxis.x },
    leftTemple: {
      x: previous.leftTemple.x * keep + next.leftTemple.x * follow,
      y: previous.leftTemple.y * keep + next.leftTemple.y * follow,
    },
    rightTemple: {
      x: previous.rightTemple.x * keep + next.rightTemple.x * follow,
      y: previous.rightTemple.y * keep + next.rightTemple.y * follow,
    },
    width: previous.width * keep + next.width * follow,
    angle: Math.atan2(xAxis.y, xAxis.x),
    yaw: previous.yaw * keep + next.yaw * follow,
    templeTurn: previous.templeTurn * keep + next.templeTurn * follow,
  }
}

function faceToScreen(frame: FaceFrame, u: number, v: number): Point {
  return add(frame.center, add(multiply(frame.xAxis, u * frame.width), multiply(frame.yAxis, v * frame.width)))
}

function screenToFace(frame: FaceFrame, point: Point) {
  const delta = { x: point.x - frame.center.x, y: point.y - frame.center.y }
  return {
    u: (delta.x * frame.xAxis.x + delta.y * frame.xAxis.y) / frame.width,
    v: (delta.x * frame.yAxis.x + delta.y * frame.yAxis.y) / frame.width,
  }
}

function resizeCanvas() {
  const ratio = Math.min(window.devicePixelRatio || 1, 2)
  canvas.width = Math.round(window.innerWidth * ratio)
  canvas.height = Math.round(window.innerHeight * ratio)
  canvas.style.width = `${window.innerWidth}px`
  canvas.style.height = `${window.innerHeight}px`
  context.setTransform(ratio, 0, 0, ratio, 0, 0)
}

function drawCamera() {
  context.save()
  context.fillStyle = '#e8ddd2'
  context.fillRect(0, 0, window.innerWidth, window.innerHeight)
  if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
    const layout = videoLayout()
    context.translate(window.innerWidth, 0)
    context.scale(-1, 1)
    context.drawImage(video, layout.x, layout.y, layout.width, layout.height)
  }
  context.restore()
}

function projectGlassesPlane(normalizedX: number, yaw: number, width: number) {
  const rotation = yaw * 0.78
  const depth = normalizedX * Math.sin(rotation)
  const perspective = 2.8 / (2.8 + depth)
  const farSideExpansion = normalizedX * yaw > 0 ? 1 + Math.abs(yaw) * 0.12 : 1
  return {
    x: normalizedX * Math.cos(rotation) * perspective * farSideExpansion * (width / 2),
    scale: 1 + (perspective - 1) * 0.58,
  }
}

function drawPerspectiveGlasses(image: HTMLImageElement, width: number, height: number, yaw: number) {
  const slices = 72
  const sourceWidth = image.naturalWidth
  const sourceHeight = image.naturalHeight

  for (let index = 0; index < slices; index += 1) {
    const ratioStart = index / slices
    const ratioEnd = (index + 1) / slices
    const normalizedStart = ratioStart * 2 - 1
    const normalizedEnd = ratioEnd * 2 - 1
    const normalizedMiddle = (normalizedStart + normalizedEnd) / 2
    const start = projectGlassesPlane(normalizedStart, yaw, width)
    const end = projectGlassesPlane(normalizedEnd, yaw, width)
    const middle = projectGlassesPlane(normalizedMiddle, yaw, width)
    const destinationHeight = height * middle.scale
    const sourceX = ratioStart * sourceWidth
    const sliceWidth = sourceWidth / slices
    const destinationX = Math.min(start.x, end.x)
    const destinationWidth = Math.abs(end.x - start.x)

    // 반투명 렌즈 조각이 겹치면서 세로선이 생기지 않도록 각 조각의 영역을 분리한다.
    context.save()
    context.beginPath()
    context.rect(destinationX, -height * 1.5, destinationWidth, height * 3)
    context.clip()
    context.drawImage(
      image,
      sourceX,
      0,
      sliceWidth + 0.5,
      sourceHeight,
      start.x - 0.35,
      -destinationHeight / 2,
      end.x - start.x + 0.7,
      destinationHeight,
    )
    context.restore()
  }
}

function drawGlasses(frame: FaceFrame) {
  if (!selectedGlassesId) return
  const option = GLASSES.find((item) => item.id === selectedGlassesId)
  if (!option) return
  const image = imageCache.get(option.src)
  const headTurn = clamp(Math.abs(frame.yaw) / 0.45, 0, 1)
  const width = frame.width * (1.03 + headTurn * 0.14) * (option.fitScale ?? 1)
  const height = width / (option.aspectRatio ?? 2.44)
  const nearSide = frame.yaw >= 0 ? -1 : 1
  const sideTurnProgress = frame.templeTurn
  const sideTurn = sideTurnProgress * sideTurnProgress * (3 - 2 * sideTurnProgress)

  context.save()
  context.translate(frame.center.x, frame.center.y + frame.width * 0.035 * headTurn)
  context.rotate(frame.angle)

  if (sideTurn > 0) {
    const side = nearSide
    const templeImage = option.templeSrc ? imageCache.get(option.templeSrc) : null
    if (templeImage?.complete && templeImage.naturalWidth > 0) {
      context.globalAlpha = 0.9 * sideTurn
      const templeTarget = side === -1 ? frame.leftTemple : frame.rightTemple
      const templeDelta = {
        x: templeTarget.x - frame.center.x,
        y: templeTarget.y - frame.center.y,
      }
      const targetX = templeDelta.x * frame.xAxis.x + templeDelta.y * frame.xAxis.y
      const targetY = templeDelta.x * frame.yAxis.x + templeDelta.y * frame.yAxis.y
      const hinge = projectGlassesPlane(side * (option.templeHingePosition ?? 0.96), frame.yaw, width)
      const earInset = side * width * 0.22
      const templeReach = Math.abs(hinge.x - (targetX + earInset))
      const templeWidth = clamp(
        templeReach * 1.18,
        width * (option.templeMinWidth ?? 0.36),
        width * (option.templeMaxWidth ?? 0.66),
      )
      const templeHeight = (templeWidth / (option.templeAspectRatio ?? 5.61)) * hinge.scale
      const sourceLeftCrop = 0.02
      const sourceRightCrop = option.templeSourceRightCrop ?? 0
      const sourceX = templeImage.naturalWidth * sourceLeftCrop
      const sourceWidth = templeImage.naturalWidth * (1 - sourceLeftCrop - sourceRightCrop)
      const templeY = height * (option.templeYOffset ?? -0.1) - templeHeight * 0.24
      const hingeOverlap = width * (option.templeHingeOverlap ?? 0.012)
      context.save()
      if (side === 1) context.scale(-1, 1)
      const localHingeX = side === 1 ? -hinge.x : hinge.x
      // 귀 앞까지만 직선 다리를 노출하고, 아래로 굽은 팁은 귀 뒤에 완전히 숨긴다.
      const visibleTempleRatio = 0.49
      const localEarOcclusionX = localHingeX - templeWidth * visibleTempleRatio
      // 귀 바깥쪽으로 넘어간 다리 끝을 숨겨 귀 뒤로 들어가는 것처럼 보이게 한다.
      context.beginPath()
      context.rect(localEarOcclusionX, -height * 1.5, width * 2, height * 3)
      context.clip()
      const hingePivotX = localHingeX + hingeOverlap
      const hingePivotY = templeY + templeHeight * (option.templePivotY ?? 0.25)
      const angleToEar = Math.atan2(targetY - hingePivotY, -templeWidth * visibleTempleRatio) - Math.PI
      const templeRotation = clamp(Math.atan2(Math.sin(angleToEar), Math.cos(angleToEar)), -0.32, 0.32)
      context.translate(hingePivotX, hingePivotY)
      context.rotate(templeRotation)
      context.translate(-hingePivotX, -hingePivotY)
      context.drawImage(
        templeImage,
        sourceX,
        0,
        sourceWidth,
        templeImage.naturalHeight,
        localHingeX - templeWidth + hingeOverlap,
        templeY,
        templeWidth,
        templeHeight,
      )
      context.restore()
    }
  }

  context.globalAlpha = 1
  const lensImage = option.lensSrc ? imageCache.get(option.lensSrc) : null
  if (lensImage?.complete && lensImage.naturalWidth > 0) {
    drawPerspectiveGlasses(lensImage, width, height, frame.yaw)
  }
  if (image?.complete && image.naturalWidth > 0) drawPerspectiveGlasses(image, width, height, frame.yaw)
  context.restore()
}

function drawStarFallback(point: Point, radius: number, color: string) {
  context.save()
  context.translate(point.x, point.y)
  context.beginPath()
  for (let index = 0; index < 10; index += 1) {
    const angle = -Math.PI / 2 + (index * Math.PI) / 5
    const length = index % 2 === 0 ? radius : radius * 0.45
    context.lineTo(Math.cos(angle) * length, Math.sin(angle) * length)
  }
  context.closePath()
  context.fillStyle = color
  context.fill()
  context.restore()
}

function drawSticker(sticker: StickerOption, point: Point, size: number, rotation = 0) {
  const image = imageCache.get(sticker.src)
  context.save()
  context.translate(point.x, point.y)
  context.rotate(rotation)
  context.shadowColor = 'rgba(48, 22, 15, .22)'
  context.shadowBlur = 10
  context.shadowOffsetY = 4
  if (image?.complete) context.drawImage(image, -size / 2, -size / 2, size, size)
  else drawStarFallback({ x: 0, y: 0 }, size / 2, sticker.color)
  context.restore()
}

function stickerSizeForFace(frame: FaceFrame) {
  return clamp(frame.width * 0.11, 22, 50)
}

function drawPlacedStickers(frame: FaceFrame | null) {
  if (!frame) return
  const size = stickerSizeForFace(frame)
  for (const placed of placedStickers) {
    const option = STICKERS.find((item) => item.id === placed.stickerId)
    if (option) drawSticker(option, faceToScreen(frame, placed.u, placed.v), size, frame.angle)
  }
}

function drawScene() {
  drawCamera()
  drawPlacedStickers(faceFrame)
  if (faceFrame) drawGlasses(faceFrame)
  if (dragState) drawSticker(dragState.sticker, dragState.point, 42, -0.08)
}

function getPrimaryHand() {
  return latestHands?.landmarks[0] ?? null
}

function classifyHand(hand: NormalizedLandmark[]) {
  const wrist = hand[0]
  const extended = [
    distance(hand[8], wrist) > distance(hand[6], wrist) * 1.12,
    distance(hand[12], wrist) > distance(hand[10], wrist) * 1.12,
    distance(hand[16], wrist) > distance(hand[14], wrist) * 1.12,
    distance(hand[20], wrist) > distance(hand[18], wrist) * 1.12,
  ]
  const thumbOpen = distance(hand[4], hand[5]) > distance(hand[3], hand[5]) * 1.25
  if (extended.every(Boolean) && thumbOpen) return 'open'
  if (extended.filter(Boolean).length === 0 && distance(hand[4], wrist) < distance(hand[9], wrist) * 1.15) return 'fist'
  return 'other'
}

function updateClearGesture(hand: NormalizedLandmark[], now: number) {
  const current = classifyHand(hand)
  if (current === gestureCandidate) gestureCandidateFrames += 1
  else {
    gestureCandidate = current
    gestureCandidateFrames = 1
  }
  if (gestureCandidateFrames !== 5) return

  if (gestureStage === 'idle' && current === 'open') {
    gestureStage = 'open'
    gestureDeadline = now + 2800
  } else if (gestureStage === 'open' && current === 'fist' && now < gestureDeadline) {
    gestureStage = 'fist'
    gestureDeadline = now + 2800
  } else if (gestureStage === 'fist' && current === 'open' && now < gestureDeadline) {
    selectedGlassesId = null
    document.querySelectorAll('.glasses-card').forEach((card) => card.classList.remove('is-selected'))
    gestureStage = 'idle'
    showToast('안경을 벗었어요 · 맨얼굴 모드')
  }
  if (now > gestureDeadline) gestureStage = 'idle'
}

function elementAtPoint<T extends HTMLElement>(selector: string, point: Point): T | null {
  for (const element of document.querySelectorAll<T>(selector)) {
    const rect = element.getBoundingClientRect()
    if (point.x >= rect.left && point.x <= rect.right && point.y >= rect.top && point.y <= rect.bottom) return element
  }
  return null
}

function elementNearPinch<T extends HTMLElement>(selector: string, thumb: Point, index: Point): T | null {
  const pinchPoint = average(thumb, index)
  let nearest: { element: T; distance: number } | null = null
  for (const element of document.querySelectorAll<T>(selector)) {
    const rect = element.getBoundingClientRect()
    const center = { x: (rect.left + rect.right) / 2, y: (rect.top + rect.bottom) / 2 }
    const insideExpandedArea =
      pinchPoint.x >= rect.left - 24 && pinchPoint.x <= rect.right + 24 &&
      pinchPoint.y >= rect.top - 24 && pinchPoint.y <= rect.bottom + 24
    const eitherFingerTouches = [thumb, index].some((point) =>
      point.x >= rect.left - 10 && point.x <= rect.right + 10 &&
      point.y >= rect.top - 10 && point.y <= rect.bottom + 10,
    )
    if (!insideExpandedArea && !eitherFingerTouches) continue
    const centerDistance = distance(pinchPoint, center)
    if (!nearest || centerDistance < nearest.distance) nearest = { element, distance: centerDistance }
  }
  return nearest?.element ?? null
}

function centerSelectedGlasses(id: string, preferredCard?: HTMLButtonElement) {
  const listCenter = glassesList.scrollLeft + glassesList.clientWidth / 2
  const candidates = Array.from(
    glassesList.querySelectorAll<HTMLButtonElement>(`.glasses-card[data-glasses="${id}"]`),
  )
  const card = preferredCard ?? candidates.reduce<HTMLButtonElement | null>((nearest, candidate) => {
    if (!nearest) return candidate
    const candidateDistance = Math.abs(candidate.offsetLeft + candidate.offsetWidth / 2 - listCenter)
    const nearestDistance = Math.abs(nearest.offsetLeft + nearest.offsetWidth / 2 - listCenter)
    return candidateDistance < nearestDistance ? candidate : nearest
  }, null)
  if (!card) return
  carouselVelocity = 0
  carouselSnapPosition = null
  glassesList.scrollLeft = card.offsetLeft - (glassesList.clientWidth - card.offsetWidth) / 2
  wrapGlassesCarousel()
  updateCarouselCenterCard()
}

function selectGlasses(id: string, card?: HTMLButtonElement) {
  selectedGlassesId = id
  centerSelectedGlasses(id, card)
  document.querySelectorAll<HTMLButtonElement>('.glasses-card').forEach((card) => {
    card.classList.toggle('is-selected', card.dataset.glasses === id)
  })
  const option = GLASSES.find((item) => item.id === id)
  showToast(`${option?.name ?? '안경'}을 써봤어요`)
}

function updateGlassesHover(pointer: Point, isPinching: boolean, now: number) {
  const card = isPinching || now < carouselSelectionBlockedUntil
    ? null
    : elementAtPoint<HTMLButtonElement>('.glasses-card', pointer)
  const id = card?.dataset.glasses ?? null
  document.querySelectorAll<HTMLButtonElement>('.glasses-card').forEach((item) => {
    item.classList.toggle('is-hovered', item.dataset.glasses === id)
  })
  if (!id) {
    hoveredGlasses = null
    return
  }
  if (hoveredGlasses?.id !== id) hoveredGlasses = { id, since: now }
}

function updateGlassesPinchSelection(thumb: Point, index: Point, isPinching: boolean) {
  if (!isPinching || wasPinching) return false
  const pinchPoint = average(thumb, index)
  const card =
    elementAtPoint<HTMLButtonElement>('.glasses-card', pinchPoint) ??
    elementAtPoint<HTMLButtonElement>('.glasses-card', index)
  if (!card) return false
  selectGlasses(card.dataset.glasses!, card)
  return true
}

function wrapGlassesCarousel() {
  const cards = glassesList.querySelectorAll<HTMLElement>('.glasses-card')
  const groupWidth = cards[GLASSES.length]
    ? cards[GLASSES.length].offsetLeft - cards[0].offsetLeft
    : glassesList.scrollWidth / 3
  if (!groupWidth) return
  if (glassesList.scrollLeft < groupWidth * 0.45) glassesList.scrollLeft += groupWidth
  else if (glassesList.scrollLeft > groupWidth * 1.55) glassesList.scrollLeft -= groupWidth
}

function updateCarouselCenterCard() {
  const listCenter = glassesList.scrollLeft + glassesList.clientWidth / 2
  const cards = Array.from(glassesList.querySelectorAll<HTMLElement>('.glasses-card'))
  const cardStep = cards[1] ? cards[1].offsetLeft - cards[0].offsetLeft : cards[0]?.offsetWidth + 7 || 1
  let nearestIndex = -1
  let nearestDistance = Number.POSITIVE_INFINITY
  cards.forEach((card, index) => {
    const center = card.offsetLeft + card.offsetWidth / 2
    const centerDistance = Math.abs(center - listCenter)
    if (centerDistance < nearestDistance) {
      nearestIndex = index
      nearestDistance = centerDistance
    }
  })

  cards.forEach((card, index) => {
    const center = card.offsetLeft + card.offsetWidth / 2
    const positionFromCenter = (center - listCenter) / cardStep
    // A continuous position prevents cards from jumping when the centered
    // item changes. The 0.62 curve keeps both resting side cards at the size
    // of the previously larger right-hand card.
    const circularPosition = clamp(positionFromCenter * 0.62, -2.6, 2.6)
    const circularDistance = Math.abs(circularPosition)
    const rotation = clamp(circularPosition * -38, -72, 72)
    const depth = 145 - circularDistance * 150
    const scale = Math.max(0.48, 1.25 - circularDistance * 0.43)
    const verticalPosition = Math.max(0, 12 - circularDistance * 9)
    const opacity = circularDistance > 2.45 ? 0 : Math.max(0.28, 1 - circularDistance * 0.37)
    card.style.setProperty('--carousel-rotate', `${rotation}deg`)
    card.style.setProperty('--carousel-depth', `${depth}px`)
    card.style.setProperty('--carousel-scale', `${scale}`)
    card.style.setProperty('--carousel-y', `${verticalPosition}px`)
    card.style.opacity = `${opacity}`
    card.style.pointerEvents = circularDistance > 1.55 ? 'none' : 'auto'
    card.style.zIndex = `${Math.max(1, 30 - Math.round(circularDistance * 10))}`
    const isCenter = index === nearestIndex
    card.classList.toggle('is-carousel-center', isCenter)
    card.style.setProperty('--carousel-magnet-x', '0px')
    if (isCenter) card.style.zIndex = '40'
  })
}

function updateGlassesCarousel(pointer: Point, isPinching: boolean, now: number) {
  const rect = glassesList.getBoundingClientRect()
  const isInside =
    pointer.x >= rect.left && pointer.x <= rect.right && pointer.y >= rect.top - 12 && pointer.y <= rect.bottom + 12
  if (!isInside || isPinching) {
    handCarouselState = null
    return
  }
  if (!handCarouselState) {
    handCarouselState = { x: pointer.x, time: now, moved: false, lastMoveAt: now }
    carouselVelocity = 0
    return
  }
  const movement = pointer.x - handCarouselState.x
  const elapsed = clamp(now - handCarouselState.time, 16, 80)
  handCarouselState.x = pointer.x
  handCarouselState.time = now
  // Ignore landmark noise; only a deliberate horizontal flick moves the rail.
  const movementSpeed = Math.abs(movement) / elapsed
  if (Math.abs(movement) > 6 && movementSpeed > 0.16) {
    const scrollMovement = -movement * 1.1
    glassesList.scrollLeft += scrollMovement
    const flickVelocity = scrollMovement / elapsed
    carouselVelocity = clamp(carouselVelocity * 0.25 + flickVelocity * 0.75, -2.4, 2.4)
    carouselSnapPosition = null
    wrapGlassesCarousel()
    handCarouselState.moved = true
    handCarouselState.lastMoveAt = now
    carouselSelectionBlockedUntil = now + 240
    hoveredGlasses = null
  } else if (handCarouselState.moved && now - handCarouselState.lastMoveAt > 220) {
    handCarouselState.moved = false
  }
}

function nearestCarouselScrollPosition() {
  let nearestPosition = glassesList.scrollLeft
  let nearestDistance = Number.POSITIVE_INFINITY
  for (const card of glassesList.querySelectorAll<HTMLElement>('.glasses-card')) {
    const position = card.offsetLeft - (glassesList.clientWidth - card.offsetWidth) / 2
    const positionDistance = Math.abs(position - glassesList.scrollLeft)
    if (positionDistance < nearestDistance) {
      nearestPosition = position
      nearestDistance = positionDistance
    }
  }
  return nearestPosition
}

function animateGlassesCarousel(now: number) {
  const elapsed = lastCarouselAnimationAt ? Math.min(now - lastCarouselAnimationAt, 34) : 16
  lastCarouselAnimationAt = now
  const handIsMoving = handCarouselState && now - handCarouselState.lastMoveAt < 65
  if (pointerCarouselState || handIsMoving) return
  if (Math.abs(carouselVelocity) >= 0.18) {
    glassesList.scrollLeft += carouselVelocity * elapsed
    wrapGlassesCarousel()
    carouselVelocity *= Math.pow(0.9, elapsed / 16.67)
    carouselSnapPosition = null
    carouselSelectionBlockedUntil = now + 120
    hoveredGlasses = null
    return
  }
  carouselVelocity = 0
  if (carouselSnapPosition === null) carouselSnapPosition = nearestCarouselScrollPosition()
  const snapDistance = carouselSnapPosition - glassesList.scrollLeft
  if (Math.abs(snapDistance) <= 0.35) {
    glassesList.scrollLeft = carouselSnapPosition
    carouselSnapPosition = null
    return
  }
  const snapFollow = 1 - Math.exp(-elapsed / 72)
  glassesList.scrollLeft += snapDistance * snapFollow
  carouselSelectionBlockedUntil = now + 100
  hoveredGlasses = null
}

function updateStickerInteraction(thumb: Point, index: Point, isPinching: boolean, now: number) {
  const pinchPoint = average(thumb, index)
  // 별에 닿기 직전에 이미 손가락이 붙었더라도 메뉴 위에서 바로 집히도록 계속 탐색한다.
  if (isPinching && !dragState) {
    const card = elementNearPinch<HTMLButtonElement>('.sticker-card', thumb, index)
    const option = STICKERS.find((item) => item.id === card?.dataset.sticker)
    if (option) {
      dragState = { sticker: option, point: pinchPoint }
      card?.classList.add('is-grabbed')
    }
  }

  // 손가락이 이미 붙은 채 별 쪽으로 이동해도 삭제 대상으로 바로 잡는다.
  if (isPinching && !dragState && pendingStickerRemovalId === null) {
    if (faceFrame && now - lastStickerRemovedAt > 500) {
      const size = stickerSizeForFace(faceFrame)
      const hitRadius = Math.max(28, size * 1.2)
      const touchedIndex = placedStickers.findIndex((placed) => {
        if (now - placed.createdAt < 500) return false
        const starPoint = faceToScreen(faceFrame!, placed.u, placed.v)
        return distanceToSegment(starPoint, thumb, index) < hitRadius
      })
      if (touchedIndex >= 0) {
        pendingStickerRemovalId = placedStickers[touchedIndex].id
      }
    }
  }

  if (isPinching && dragState) {
    const follow = 0.36
    dragState.point = {
      x: dragState.point.x * (1 - follow) + pinchPoint.x * follow,
      y: dragState.point.y * (1 - follow) + pinchPoint.y * follow,
    }
  }

  if (!isPinching && wasPinching && dragState) {
    document.querySelectorAll('.sticker-card').forEach((card) => card.classList.remove('is-grabbed'))
    if (faceFrame) {
      const local = screenToFace(faceFrame, dragState.point)
      const insideFace = Math.abs(local.u) < 0.55 && local.v > -0.6 && local.v < 0.72
      if (insideFace) {
        placedStickers.push({
          id: stickerSequence++,
          stickerId: dragState.sticker.id,
          u: local.u,
          v: local.v,
          createdAt: now,
        })
        showToast('별이 얼굴에 착!')
      } else showToast('얼굴 위에 별을 놓아주세요')
    }
    dragState = null
  }

  if (!isPinching && wasPinching && pendingStickerRemovalId !== null) {
    const touchedIndex = placedStickers.findIndex((placed) => placed.id === pendingStickerRemovalId)
    if (touchedIndex >= 0) {
      placedStickers.splice(touchedIndex, 1)
      lastStickerRemovedAt = now
      showToast('별 스티커를 지웠어요')
    }
    pendingStickerRemovalId = null
  }

  wasPinching = isPinching
}

function updateHandUI(now: number) {
  const hand = getPrimaryHand()
  if (!hand) {
    cursor.classList.remove('is-visible', 'is-pinching')
    hoveredGlasses = null
    handCarouselState = null
    smoothedIndexPoint = null
    smoothedThumbPoint = null
    glassesPinchActive = false
    if ((dragState || pendingStickerRemovalId !== null) && now - lastHandSeenAt < 500) return
    if (dragState) {
      document.querySelectorAll('.sticker-card').forEach((card) => card.classList.remove('is-grabbed'))
      dragState = null
    }
    pendingStickerRemovalId = null
    wasPinching = false
    pinchReleaseFrames = 0
    return
  }
  lastHandSeenAt = now
  const rawThumb = mapLandmark(hand[4])
  const rawIndex = mapLandmark(hand[8])
  const smoothPoint = (previous: Point | null, next: Point) => previous
    ? { x: previous.x * 0.62 + next.x * 0.38, y: previous.y * 0.62 + next.y * 0.38 }
    : next
  smoothedThumbPoint = smoothPoint(smoothedThumbPoint, rawThumb)
  smoothedIndexPoint = smoothPoint(smoothedIndexPoint, rawIndex)
  const thumb = smoothedThumbPoint
  const index = smoothedIndexPoint
  const palmWidth = distance(mapLandmark(hand[5]), mapLandmark(hand[17]))
  const palmLength = distance(mapLandmark(hand[0]), mapLandmark(hand[9]))
  const handScale = Math.max(palmWidth, palmLength * 0.9)
  const closeThreshold = Math.max(24, handScale * 0.5)
  const releaseThreshold = Math.max(32, handScale * 0.64)
  const pinchDetected = distance(thumb, index) < (wasPinching || dragState ? releaseThreshold : closeThreshold)
  let isPinching = pinchDetected
  if (pinchDetected) pinchReleaseFrames = 0
  // 별을 옮기는 중에는 손가락이 벌어진 첫 프레임에 바로 얼굴에 놓는다.
  else if (dragState || pendingStickerRemovalId !== null) {
    pinchReleaseFrames = 0
    isPinching = false
  }
  else if ((wasPinching || dragState) && pinchReleaseFrames < 7) {
    pinchReleaseFrames += 1
    isPinching = true
  } else pinchReleaseFrames = 0

  const cursorPoint = isPinching ? average(thumb, index) : index
  cursor.style.transform = `translate3d(${cursorPoint.x}px, ${cursorPoint.y}px, 0)`
  cursor.classList.add('is-visible')
  cursor.classList.toggle('is-pinching', isPinching)
  updateGlassesCarousel(index, isPinching, now)
  updateGlassesHover(index, isPinching, now)
  const glassesSelected = updateGlassesPinchSelection(thumb, index, isPinching)
  if (glassesSelected) glassesPinchActive = true
  if (!isPinching) glassesPinchActive = false
  if (glassesPinchActive) wasPinching = isPinching
  else updateStickerInteraction(thumb, index, isPinching, now)
  updateClearGesture(hand, now)
}

async function createTrackers() {
  const vision = await FilesetResolver.forVisionTasks(WASM_PATH)
  const create = async (delegate: 'GPU' | 'CPU') => {
    const face = await FaceLandmarker.createFromOptions(vision, {
      baseOptions: { modelAssetPath: FACE_MODEL, delegate },
      runningMode: 'VIDEO',
      numFaces: 1,
      minFaceDetectionConfidence: 0.55,
      minFacePresenceConfidence: 0.55,
      minTrackingConfidence: 0.55,
      outputFacialTransformationMatrixes: true,
      canvas: document.createElement('canvas'),
    })
    try {
      const hand = await HandLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetPath: HAND_MODEL, delegate },
        runningMode: 'VIDEO',
        numHands: 1,
        minHandDetectionConfidence: 0.5,
        minHandPresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
        canvas: document.createElement('canvas'),
      })
      return { face, hand }
    } catch (error) {
      face.close()
      throw error
    }
  }

  try {
    return await create('GPU')
  } catch (error) {
    console.warn('GPU 초기화에 실패해 CPU 모드로 전환합니다.', error)
    return create('CPU')
  }
}

async function startExperience() {
  if (running || starting) return
  starting = true
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    })
    video.srcObject = stream
    await video.play()
    const trackers = await createTrackers()
    faceLandmarker = trackers.face
    handLandmarker = trackers.hand
    faceFrame = null
    stabilizingFaceFrame = null
    faceStableFrames = 0
    faceMissingFrames = 0
    smoothedIndexPoint = null
    smoothedThumbPoint = null
    running = true
    starting = false
    showToast('준비됐어요! 안경을 검지로 가리켜 보세요')
    requestAnimationFrame(renderLoop)
  } catch (error) {
    console.error(error)
    starting = false
    stream?.getTracks().forEach((track) => track.stop())
    stream = null
    video.srcObject = null
    showToast('카메라 권한과 인터넷 연결을 확인해 주세요')
  }
}

function renderLoop(now: number) {
  if (!running) return
  animateGlassesCarousel(now)
  if (video.currentTime !== lastVideoTime && now - lastInferenceAt >= 42 && faceLandmarker && handLandmarker) {
    lastVideoTime = video.currentTime
    lastInferenceAt = now
    latestFace = faceLandmarker.detectForVideo(video, now)
    latestHands = handLandmarker.detectForVideo(video, now)
    const landmarks = latestFace.faceLandmarks[0]
    const transformationMatrix = latestFace.facialTransformationMatrixes[0]
    if (landmarks) {
      const nextFaceFrame = calculateFaceFrame(landmarks, transformationMatrix)
      stabilizingFaceFrame = smoothFaceFrame(stabilizingFaceFrame, nextFaceFrame)
      faceStableFrames += 1
      faceMissingFrames = 0
      // Do not expose noisy detector warm-up frames to the rendered overlay.
      if (faceStableFrames >= 4) faceFrame = smoothFaceFrame(faceFrame, stabilizingFaceFrame)
    } else {
      faceStableFrames = 0
      stabilizingFaceFrame = null
      faceMissingFrames += 1
      // A single missed detection must not make the glasses blink or jump.
      if (faceMissingFrames > 6) faceFrame = null
    }
    updateHandUI(now)
  }
  drawScene()
  requestAnimationFrame(renderLoop)
}

for (const card of document.querySelectorAll<HTMLButtonElement>('.glasses-card')) {
  card.addEventListener('click', () => {
    if (performance.now() < carouselSelectionBlockedUntil) return
    selectGlasses(card.dataset.glasses!, card)
  })
}

glassesList.addEventListener('pointerdown', (event) => {
  pointerCarouselState = { id: event.pointerId, x: event.clientX, time: performance.now(), moved: false }
  carouselVelocity = 0
  carouselSnapPosition = null
  glassesList.setPointerCapture(event.pointerId)
})
glassesList.addEventListener('pointermove', (event) => {
  if (!pointerCarouselState || pointerCarouselState.id !== event.pointerId) return
  const movement = event.clientX - pointerCarouselState.x
  const now = performance.now()
  const elapsed = clamp(now - pointerCarouselState.time, 8, 80)
  pointerCarouselState.x = event.clientX
  pointerCarouselState.time = now
  if (Math.abs(movement) < 1) return
  const scrollMovement = -movement * 0.9
  glassesList.scrollLeft += scrollMovement
  const flickVelocity = scrollMovement / elapsed
  carouselVelocity = clamp(carouselVelocity * 0.25 + flickVelocity * 0.75, -2.4, 2.4)
  carouselSnapPosition = null
  wrapGlassesCarousel()
  if (Math.abs(movement) > 2) pointerCarouselState.moved = true
  if (pointerCarouselState.moved) carouselSelectionBlockedUntil = performance.now() + 220
})
const finishPointerCarousel = (event: PointerEvent) => {
  if (!pointerCarouselState || pointerCarouselState.id !== event.pointerId) return
  if (pointerCarouselState.moved) carouselSelectionBlockedUntil = performance.now() + 220
  pointerCarouselState = null
}
glassesList.addEventListener('pointerup', finishPointerCarousel)
glassesList.addEventListener('pointercancel', finishPointerCarousel)
glassesList.addEventListener('scroll', updateCarouselCenterCard, { passive: true })

for (const card of document.querySelectorAll<HTMLButtonElement>('.sticker-card')) {
  card.addEventListener('click', () => {
    const option = STICKERS.find((item) => item.id === card.dataset.sticker)
    if (!option || !faceFrame) {
      showToast('카메라를 켜고 얼굴을 보여주세요')
      return
    }
    const count = placedStickers.filter((item) => item.stickerId === option.id).length
    placedStickers.push({ id: stickerSequence++, stickerId: option.id, u: count % 2 ? 0.28 : -0.28, v: -0.05 + count * 0.1, createdAt: performance.now() })
    showToast('별이 얼굴에 착!')
  })
}

introEnter.addEventListener('click', () => {
  introScreen.classList.add('is-hidden')
  window.setTimeout(() => introScreen.remove(), 650)
  if (!running && !starting) void startExperience()
})

window.addEventListener('resize', () => {
  resizeCanvas()
  drawScene()
  updateCarouselCenterCard()
})

resizeCanvas()
drawScene()
requestAnimationFrame(() => {
  const cards = glassesList.querySelectorAll<HTMLElement>('.glasses-card')
  const centerCard = cards[GLASSES.length]
  glassesList.scrollLeft = centerCard
    ? centerCard.offsetLeft - (glassesList.clientWidth - centerCard.offsetWidth) / 2
    : glassesList.scrollWidth / 3
  updateCarouselCenterCard()
})
