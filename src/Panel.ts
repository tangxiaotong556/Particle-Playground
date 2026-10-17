/**
 * Panel：把 index.html 里控制面板/HUD 的静态元素接到回调上。
 * 面板自己只负责“采集 UI 意图 + 展示状态”，业务动作全部交给 main.ts 注入的回调，
 * 因此 UI 与粒子系统互不耦合。
 */
import { THEMES } from './themes'
import type { MotionMode, MouseMode, ThemeName } from './types'

export interface PanelCallbacks {
  onModeChange(mode: MotionMode): void
  onMouseModeChange(mode: MouseMode): void
  onThemeChange(theme: ThemeName): void
  onCountChange(count: number): void
  onSpeedChange(speed: number): void
  onPauseToggle(): void
  onReset(): void
}

/** querySelector 帮手：找不到元素直接抛错，早失败好排错 */
function $<T extends Element>(selector: string): T {
  const el = document.querySelector<T>(selector)
  if (!el) throw new Error(`找不到元素 ${selector}`)
  return el
}

export class Panel {
  private readonly modeContainer = $<HTMLElement>('#mode-buttons')
  private readonly mouseContainer = $<HTMLElement>('#mouse-buttons')
  private readonly themeContainer = $<HTMLElement>('#theme-buttons')
  private readonly countSelect = $<HTMLSelectElement>('#count-select')
  private readonly speedRange = $<HTMLInputElement>('#speed-range')
  private readonly speedValue = $<HTMLElement>('#speed-value')
  private readonly pauseBtn = $<HTMLButtonElement>('#pause-btn')
  private readonly fpsEl = $<HTMLElement>('#hud-fps')
  private readonly countEl = $<HTMLElement>('#hud-count')
  private readonly statusEl = $<HTMLElement>('#hud-status')

  constructor(callbacks: PanelCallbacks) {
    // —— 运动模式按钮组 / 鼠标作用按钮组（同一个按钮组绑定逻辑）——
    this.bindSegment(this.modeContainer, (value, active) => {
      this.setActive(this.modeContainer, active)
      callbacks.onModeChange(value as MotionMode)
    })
    this.bindSegment(this.mouseContainer, (value, active) => {
      this.setActive(this.mouseContainer, active)
      callbacks.onMouseModeChange(value as MouseMode)
    })
    this.bindSegment(this.themeContainer, (value, active) => {
      this.setActive(this.themeContainer, active)
      // UI 强调色同步为主题 accent（CSS 变量驱动整套面板高亮）
      document.documentElement.style.setProperty('--accent', THEMES[value as ThemeName].accent)
      callbacks.onThemeChange(value as ThemeName)
    })

    // —— 粒子数量下拉框 ——
    this.countSelect.addEventListener('change', () => {
      const n = parseInt(this.countSelect.value, 10)
      if (!Number.isNaN(n) && n > 0) callbacks.onCountChange(n)
    })

    // —— 速度滑杆：拖动即时生效并更新 ×1.00 标签 ——
    this.speedRange.addEventListener('input', () => {
      const f = Math.min(3, Math.max(0.1, parseFloat(this.speedRange.value) || 1))
      this.speedValue.textContent = `×${f.toFixed(2)}`
      callbacks.onSpeedChange(f)
    })

    // —— 暂停 / 重置 ——
    this.pauseBtn.addEventListener('click', () => callbacks.onPauseToggle())
    $<HTMLButtonElement>('#reset-btn').addEventListener('click', () => callbacks.onReset())
  }

  /** 让 main.ts 在启动时把系统真实状态回填到 UI（数量/速度/暂停状态） */
  syncInitial(count: number, speed: number, paused: boolean): void {
    this.countSelect.value = String(count)
    this.speedRange.value = String(speed)
    this.speedValue.textContent = `×${speed.toFixed(2)}`
    this.countEl.textContent = count.toLocaleString('en-US')
    this.setPaused(paused)
  }

  /** 定时刷新 HUD：FPS / 粒子数 / 暂停状态（真实运行数据，绝不写死） */
  updateStats(fps: number | null, count: number, paused: boolean): void {
    if (fps !== null) {
      this.fpsEl.textContent = String(fps)
    }
    this.countEl.textContent = count.toLocaleString('en-US')
    this.setPaused(paused)
  }

  private setPaused(paused: boolean): void {
    this.pauseBtn.textContent = paused ? '继续' : '暂停'
    this.statusEl.textContent = paused ? '已暂停' : '运行中'
    this.statusEl.classList.toggle('hud-running', !paused)
    this.statusEl.classList.toggle('hud-paused', paused)
  }

  /** 按钮组通用绑定：点击 → 高亮新选中项 → 触发回调（dataset 取模式名） */
  private bindSegment(
    container: HTMLElement,
    fire: (value: string, button: HTMLElement) => void,
  ): void {
    const buttons = Array.from(container.querySelectorAll('button')) as HTMLElement[]
    buttons.forEach((btn) => {
      btn.addEventListener('click', () => {
        const value = btn.dataset.mode ?? btn.dataset.mouse ?? btn.dataset.theme
        if (!value) return
        fire(value, btn)
      })
    })
  }

  /** 在某个按钮组内把 active 类切到指定 value 的按钮上 */
  private setActive(container: HTMLElement, active: HTMLElement): void {
    const buttons = Array.from(container.querySelectorAll('button')) as HTMLElement[]
    buttons.forEach((btn) => btn.classList.toggle('active', btn === active))
  }
}
