import * as THREE from 'three'
import type { ThemeName } from './types'

/** 单个颜色主题：影响粒子渐变色、点缀色、场景背景与 UI 强调色 */
export interface Theme {
  label: string
  /** 场景背景（近黑的深色） */
  background: string
  /** UI 强调色（同时写入 CSS 变量 --accent） */
  accent: string
  /** 粒子渐变起点（青蓝端） */
  from: string
  /** 粒子渐变终点（紫色端） */
  to: string
  /** 少量点缀色（粉色端） */
  sparkle: string
}

export const THEMES: Record<ThemeName, Theme> = {
  aurora: {
    label: '极光',
    background: '#04060e',
    accent: '#22d3ee',
    from: '#67e8f9',
    to: '#7c3aed',
    sparkle: '#f472b6',
  },
  nebula: {
    label: '星云',
    background: '#08030f',
    accent: '#a78bfa',
    from: '#a78bfa',
    to: '#3b82f6',
    sparkle: '#f9a8d4',
  },
  moon: {
    label: '月神',
    background: '#030810',
    accent: '#93c5fd',
    from: '#93c5fd',
    to: '#c084fc',
    sparkle: '#fb7185',
  },
}

/** 缓存每个主题解析好的 THREE.Color，避免每次采样重复解析 hex 字符串 */
const parsedCache = new Map<ThemeName, { a: THREE.Color; b: THREE.Color; s: THREE.Color }>()

function parsed(themeName: ThemeName): { a: THREE.Color; b: THREE.Color; s: THREE.Color } {
  let entry = parsedCache.get(themeName)
  if (!entry) {
    const t = THEMES[themeName]
    entry = {
      a: new THREE.Color(t.from),
      b: new THREE.Color(t.to),
      s: new THREE.Color(t.sparkle),
    }
    parsedCache.set(themeName, entry)
  }
  return entry
}

/**
 * 为粒子采样颜色：
 * - t：0..1，由粒子到中心的距离与随机抖动决定，形成中心青蓝、外圈紫色的空间渐变；
 * - sparkle：约 8% 的粒子取粉色点缀色，让画面有“跳出”的高光。
 */
export function sampleParticleColor(themeName: ThemeName, t: number, sparkle: boolean): THREE.Color {
  const { a, b, s } = parsed(themeName)
  const out = new THREE.Color()
  if (sparkle) {
    out.copy(s)
  } else {
    // lerpColors 之间做线性插值得到渐变
    out.copy(a).lerp(b, THREE.MathUtils.clamp(t, 0, 1))
  }
  // 亮度乘个随机系数，让同色粒子也有明暗层次
  out.multiplyScalar((0.75 + Math.random() * 0.45) * (sparkle ? 1.15 : 1))
  return out
}
