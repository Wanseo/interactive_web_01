// 새 이미지를 추가하려면 public/glasses 또는 public/stickers에 파일을 넣고
// 아래 배열에 항목을 한 줄 추가하세요. 투명 배경 PNG/SVG를 권장합니다.

export type GlassesOption = {
  id: string
  name: string
  src: string
  armColor: string
  aspectRatio?: number
  fitScale?: number
  lensSrc?: string
  templeSrc?: string
  templeSourceRightCrop?: number
  templeAspectRatio?: number
  templeYOffset?: number
  templeHingeOverlap?: number
  templeHingePosition?: number
  templeMinWidth?: number
  templeMaxWidth?: number
  templePivotY?: number
}

export type StickerOption = {
  id: string
  name: string
  src: string
  color: string
}

export const GLASSES: GlassesOption[] = [
  {
    id: 'amber-cat-eye',
    name: '프라다 젠틀몬스터 3 L2',
    src: '/glasses/amber-cat-eye-transparent.png',
    armColor: '#c7c9ca',
    aspectRatio: 2.4,
    templeSrc: '/glasses/amber-cat-eye-temple-left-v2.png',
    templeSourceRightCrop: 0.055,
    templeAspectRatio: 3,
    templeYOffset: -0.17,
    templeHingeOverlap: 0.018,
    templePivotY: 0.334,
  },
  {
    id: 'silver-square',
    name: '사가 02',
    src: '/glasses/silver-square.png',
    armColor: '#b9c0c5',
    aspectRatio: 4.01,
    templeSrc: '/glasses/silver-square-temple-left.png',
    templeAspectRatio: 5.15,
    templePivotY: 0.135,
  },
  {
    id: 'black-square',
    name: '자스민 01(BL)',
    src: '/glasses/black-square.png',
    lensSrc: '/glasses/black-square-blue-lens.svg',
    armColor: '#111111',
    aspectRatio: 3.13,
    templeSrc: '/glasses/black-square-temple-left-thick.png',
    templeAspectRatio: 3.4,
    templeYOffset: -0.4,
    templeHingeOverlap: 0.045,
    templePivotY: 0.217,
  },
  {
    id: 'silver-point-square',
    name: '메종 마르지엘라 - MM202 G14(SM)',
    src: '/glasses/mm202-g14-front.png',
    armColor: '#8d929a',
    aspectRatio: 2.75,
    templeSrc: '/glasses/mm202-g14-temple-left-v2.png',
    templeSourceRightCrop: 0.095,
    templeAspectRatio: 3,
    templeYOffset: -0.22,
    templeHingeOverlap: 0.015,
    templeHingePosition: 0.9,
    templeMinWidth: 0.4,
    templeMaxWidth: 0.7,
    templePivotY: 0.44,
  },
  {
    id: 'cherry-oval',
    name: '바닐라 R6',
    src: '/glasses/cherry-oval.png',
    armColor: '#9e0e22',
    aspectRatio: 2.6,
    fitScale: 1.2,
    templeSrc: '/glasses/cherry-oval-temple-left.png',
    templeAspectRatio: 3,
    templeYOffset: -0.24,
    templeHingeOverlap: 0.06,
    templeHingePosition: 0.86,
    templeMinWidth: 0.46,
    templeMaxWidth: 0.75,
    templePivotY: 0.423,
  },
]

export const STICKERS: StickerOption[] = [
  { id: 'coral', name: '레드 별', src: '/stickers/star-coral-material.png', color: '#e84b5f' },
  { id: 'yellow', name: '노랑 별', src: '/stickers/star-yellow-material.png', color: '#ffd12f' },
  { id: 'mint', name: '라임 별', src: '/stickers/star-lime-material.png', color: '#75d334' },
  { id: 'blue', name: '하늘 별', src: '/stickers/star-blue-material.png', color: '#28b9df' },
  { id: 'pink', name: '버건디 별', src: '/stickers/star-burgundy-material.png', color: '#8f294b' },
]
