import './style.css'
import * as THREE from 'three'
import { suggestDefaultCount } from './config'
import { THEMES } from './themes'
import type { ThemeName } from './types'
import { Panel } from './Panel'
import { ParticleSystem } from './ParticleSystem'
import { PointerInteraction } from './PointerInteraction'
import { SceneManager } from './SceneManager'

/** WebGL 初始化失败时给出人话提示 + 真实错误详情，不让用户面对莫名的黑屏 */
function showFallback(err: unknown): void {
  console.error('[Particle Playground] 启动失败：', err)
  const el = document.getElementById('fallback')
  if (el) el.hidden = false
  const detail = document.getElementById('fallback-detail')
  if (detail) {
    detail.hidden = false
    detail.textContent = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
  }
}

/**
 * WebGL 能力探测：在临时画布上试拿上下文。
 * three.js r163 起仅支持 WebGL2，所以这里区分出 webgl2 / webgl1 / 不可用三种情况，
 * 给出针对性的提示（而不是笼统地说“不支持”）。
 */
function probeWebGL(): 'webgl2' | 'webgl1' | null {
  const probe = document.createElement('canvas')
  if (probe.getContext('webgl2')) return 'webgl2'
  if (probe.getContext('webgl')) return 'webgl1'
  return null
}

function getStageCanvas(): HTMLCanvasElement {
  const canvas = document.querySelector<HTMLCanvasElement>('#stage')
  if (!canvas) throw new Error('找不到 #stage 画布')
  return canvas
}

/**
 * WebGL 上下文有个坑：getContext 创建失败的那个画布会被“定型”，
 * 同一画布上后续的 getContext 也只会返回 null。
 * 所以降级重试必须换一个新画布（替换掉 DOM 里的旧节点）。
 */
function replaceStageCanvas(): HTMLCanvasElement {
  const fresh = document.createElement('canvas')
  fresh.id = 'stage'
  getStageCanvas().replaceWith(fresh)
  return fresh
}

function boot(): void {
  // —— 第 0 步：能力探测，先给结论 ——
  const capability = probeWebGL()
  if (capability === null) {
    throw new Error(
      '浏览器无法创建 WebGL 上下文。请检查：1) 浏览器设置中“硬件加速”是否开启；'
        + '2) chrome://gpu 里 WebGL 是否为 Hardware accelerated；3) GPU 驱动是否正常。',
    )
  }
  if (capability === 'webgl1') {
    throw new Error(
      '当前浏览器只有 WebGL1，而本项目所用 three.js 版本需要 WebGL2。请更新浏览器（Chrome/Edge 90+）。',
    )
  }

  // —— 第 1 步：创建渲染器，失败则换新画布 + 保守参数重试一次 ——
  const attempts = [
    { antialias: true, powerPreference: 'high-performance' as const },
    { antialias: false, powerPreference: 'default' as const },
  ]
  let sceneManager: SceneManager | null = null
  let lastError: unknown
  for (let i = 0; i < attempts.length && !sceneManager; i++) {
    try {
      sceneManager = new SceneManager(i === 0 ? getStageCanvas() : replaceStageCanvas(), attempts[i])
    } catch (err) {
      lastError = err
    }
  }
  if (!sceneManager) {
    throw lastError instanceof Error
      ? new Error(`WebGL 渲染器创建失败（已尝试降级重试）。原始错误：${lastError.name}: ${lastError.message}`)
      : new Error(`WebGL 渲染器创建失败（已尝试降级重试）。原始错误：${String(lastError)}`)
  }
  // 收窄类型：后续箭头函数闭包里不再做可空判断
  const stage: SceneManager = sceneManager

  // —— 第 2 步：组装粒子系统 / 鼠标交互 / 控制面板 ——
  const themeName: ThemeName = 'aurora'
  const system = new ParticleSystem(suggestDefaultCount(), themeName)
  stage.scene.add(system.points)
  stage.setBackground(THEMES[themeName].background)
  system.resizePixelRatio(stage.pixelRatio)

  // 鼠标监听挂到最终生效的画布上（降级重试后可能是替换出来的新画布）
  const interaction = new PointerInteraction(stage.camera, stage.canvas)

  // —— 面板回调：UI 意图 → 粒子系统（真正的接线，不是摆设）——
  const panel = new Panel({
    onModeChange: (m) => system.setMode(m),
    onMouseModeChange: (m) => interaction.setMouseMode(m),
    onThemeChange: (t) => {
      system.setTheme(t)
      stage.setBackground(THEMES[t].background)
    },
    onCountChange: (n) => system.setCount(n),
    onSpeedChange: (f) => system.setSpeed(f),
    onPauseToggle: () => system.togglePause(),
    onReset: () => system.reset(),
  })

  // 把系统当前真实状态回填给面板（数量/速度/暂停/主题高亮）
  panel.syncInitial(system.count, system.speed, system.paused)
  document.documentElement.style.setProperty('--accent', THEMES[themeName].accent)

  // —— 主循环：交互 → 粒子物理 → 相机/星空 → 渲染 → 真实 FPS 统计 ——
  const clock = new THREE.Clock()
  let frames = 0
  let fpsAccum = 0

  function tick(): void {
    requestAnimationFrame(tick)
    // 取真实帧间隔：getDelta 自上一次调用以来的秒数
    const raw = clock.getDelta()
    // 限幅：切后台再回来时 dt 可能巨大，直接限到 50ms，避免粒子一次飞出天际
    const dt = Math.min(raw, 0.05)

    // FPS 统计（用真实帧计数，每 0.5 秒结算一次）
    frames += 1
    fpsAccum += Math.min(raw, 1)
    if (fpsAccum >= 0.5) {
      panel.updateStats(Math.round(frames / fpsAccum), system.count, system.paused)
      frames = 0
      fpsAccum = 0
    }

    interaction.update(dt) // 1. 鼠标探针：像素坐标 → NDC → 射线 → 3D 平面交点
    system.update(dt, interaction) // 2. CPU 粒子物理：力 → 阻尼 → 限速 → 积分
    stage.update(dt) // 3. 相机阻尼 / 星空缓转 / 空闲自转
    stage.render() // 4. 渲染
  }
  requestAnimationFrame(tick)

  // —— 资源清理：页面隐藏或热更新时释放 GL 上下文与监听，防内存泄漏 ——
  function cleanup(): void {
    system.dispose()
    interaction.dispose()
    stage.dispose()
  }
  window.addEventListener('pagehide', cleanup, { once: true })
  if (import.meta.hot) import.meta.hot.dispose(cleanup)
}

try {
  boot()
} catch (err) {
  showFallback(err)
}
