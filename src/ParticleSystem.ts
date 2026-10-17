import * as THREE from 'three'
import { BURST, CLOUD, MOTION, MOUSE, RENDER, VORTEX } from './config'
import type { PointerInteraction } from './PointerInteraction'
import { sampleParticleColor } from './themes'
import type { MotionMode, ThemeName } from './types'

/**
 * 软圆点精灵着色器：GPU 只做“绘制”（透视尺寸衰减 + 柔边光晕 + 闪烁），
 * 所有运动都在 CPU 计算。属于“普通 Three.js 材质 + 自定义 GLSL”，
 * 不是 TSL / WGSL / 计算着色器——第一阶段优先保证清晰可控。
 */
const VERTEX_SHADER = /* glsl */ `
uniform float uTime;
uniform float uScale;

attribute float aSize;
attribute float aAlpha;
attribute float aPhase;
attribute vec3 aColor;

varying vec3 vColor;
varying float vAlpha;

void main() {
  vColor = aColor;
  vAlpha = aAlpha;

  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);

  // 亮度按各自相位缓慢呼吸（闪烁）——完全在 GPU 侧完成，CPU 零成本
  float twinkle = 0.8 + 0.2 * sin(uTime * 1.8 + aPhase);

  // 点精灵尺寸随透视距离衰减：近大远小；并限制像素上限防止近景全屏糊
  gl_PointSize = min(aSize * uScale * twinkle / -mvPosition.z, ${RENDER.maxPointSize}.0);
  gl_Position = projectionMatrix * mvPosition;
}
`

const FRAGMENT_SHADER = /* glsl */ `
varying vec3 vColor;
varying float vAlpha;

void main() {
  vec2 uv = gl_PointCoord - 0.5;
  float d = length(uv) * 2.0; // 0..1，圆心 0 边缘 1
  if (d > 1.0) discard;

  // 平方衰减的柔边光晕：中心最亮、边缘渐隐，加色混合后自然形成发光感
  float glow = pow(1.0 - d, 2.4);
  gl_FragColor = vec4(vColor * (0.5 + glow), glow * vAlpha);

  // 接入 Three 的输出色彩管线：色调映射 + sRGB，保证颜色与 CSS 视觉一致
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`

/** 热循环里用整数比较代替字符串比较 */
const MODE_CODE: Record<MotionMode, 0 | 1 | 2> = { float: 0, vortex: 1, burst: 2 }
const MOUSE_CODE: Record<string, 0 | 1 | 2> = { attract: 0, repel: 1, vortex: 2 }

/**
 * ParticleSystem：本项目第一阶段的核心。
 *
 * 数据布局（SoA 平行数组，无对象开销）：
 * - pos / vel / home: Float32Array(count*3) —— 位置、速度、归宿位；
 * - size / alpha / phase: Float32Array(count) —— 渲染表现属性；
 * - color: Float32Array(count*3) —— 逐粒子颜色（BufferAttribute aColor）。
 *
 * 每帧更新：自然模式力 + 鼠标力 → 阻尼 → 限速 → 积分位置。
 * 循环内全部是标量运算、不 new 任何对象——这是帧率稳定的关键。
 */
export class ParticleSystem {
  readonly points: THREE.Points
  count: number
  paused = false
  speed = 1
  mode: MotionMode = 'float'
  themeName: ThemeName

  private readonly material: THREE.ShaderMaterial
  private geometry: THREE.BufferGeometry

  private pos: Float32Array
  private vel: Float32Array
  private home: Float32Array
  private size: Float32Array
  private alpha: Float32Array
  private phase: Float32Array

  private posAttr!: THREE.BufferAttribute
  private colorAttr!: THREE.BufferAttribute

  private elapsed = 0
  private burstTimer: number = BURST.interval

  constructor(initialCount: number, themeName: ThemeName) {
    this.themeName = themeName
    this.count = initialCount

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uScale: { value: RENDER.sizeScale },
      },
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      transparent: true,
      depthWrite: false, // 加色混合不写深度：粒子互不遮挡、始终叠加发光
      blending: THREE.AdditiveBlending, // 加色混合 = 低成本的柔和发光
    })

    this.pos = new Float32Array(0)
    this.vel = new Float32Array(0)
    this.home = new Float32Array(0)
    this.size = new Float32Array(0)
    this.alpha = new Float32Array(0)
    this.phase = new Float32Array(0)
    this.geometry = new THREE.BufferGeometry()

    this.rebuild(initialCount)

    this.points = new THREE.Points(this.geometry, this.material)
    // 粒子每帧移动而包围球不重算：关闭视锥剔除，防止整体被误裁剪消失
    this.points.frustumCulled = false
  }

  /**
   * （重）建粒子：分配 SoA 数组 → 随机播种 → 写入 BufferAttribute。
   * 改粒子数量时保留同一个 THREE.Points 对象，只替换 geometry。
   */
  private rebuild(count: number): void {
    // 若已有几何体（换数量场景），先释放旧 VRAM 资源
    if (this.geometry.getAttribute('position')) this.geometry.dispose()
    this.geometry = new THREE.BufferGeometry()
    this.count = count

    this.pos = new Float32Array(count * 3)
    this.vel = new Float32Array(count * 3)
    this.home = new Float32Array(count * 3)
    this.size = new Float32Array(count)
    this.alpha = new Float32Array(count)
    this.phase = new Float32Array(count)

    this.seed()

    // position 每帧都写 → 声明动态用途，提示驱动端按高频更新优化
    this.posAttr = new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage)
    const colorArray = new Float32Array(count * 3)
    this.colorAttr = new THREE.BufferAttribute(colorArray, 3)
    this.geometry.setAttribute('position', this.posAttr)
    this.geometry.setAttribute('aColor', this.colorAttr)
    this.geometry.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1))
    this.geometry.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1))
    this.geometry.setAttribute('aPhase', new THREE.BufferAttribute(this.phase, 1))

    this.applyThemeColors()
  }

  /**
   * 随机播种初始状态：
   * - 归宿位 home 分布在“扁椭球盘”里（sqrt 随机保证盘面均匀、中间密外圈稀）；
   * - 初始位置略偏离归宿、速度极小，开局即有微妙的生命感。
   */
  private seed(): void {
    const { pos, vel, home, size, alpha, phase } = this
    for (let i = 0; i < this.count; i++) {
      const i3 = i * 3
      const r = CLOUD.radius * Math.sqrt(Math.random())
      const angle = Math.random() * Math.PI * 2
      // 三段均匀随机之和近似正态分布，营造有“云团手感”的厚度
      const y = (Math.random() + Math.random() + Math.random() - 1.5) * CLOUD.height

      home[i3] = Math.cos(angle) * r
      home[i3 + 1] = y * 0.8
      home[i3 + 2] = Math.sin(angle) * r

      pos[i3] = home[i3] + (Math.random() - 0.5) * 2.4
      pos[i3 + 1] = home[i3 + 1] + (Math.random() - 0.5) * 2.4
      pos[i3 + 2] = home[i3 + 2] + (Math.random() - 0.5) * 2.4

      vel[i3] = (Math.random() - 0.5) * 0.4
      vel[i3 + 1] = (Math.random() - 0.5) * 0.4
      vel[i3 + 2] = (Math.random() - 0.5) * 0.4

      size[i] = 0.55 + Math.random() ** 2 * 1.15
      alpha[i] = 0.4 + Math.random() ** 1.5 * 0.6
      phase[i] = Math.random() * Math.PI * 2
    }
  }

  /** 把当前主题的空间渐变色写进 aColor（低频操作，允许临时对象） */
  private applyThemeColors(): void {
    const colorArray = this.colorAttr.array as Float32Array
    for (let i = 0; i < this.count; i++) {
      const i3 = i * 3
      // t = 水平离心率 + 高度 + 少量随机，形成中心青蓝、外圈紫的空间渐变
      const t =
        (Math.hypot(this.home[i3], this.home[i3 + 2]) / CLOUD.radius) * 0.75 +
        (this.home[i3 + 1] / CLOUD.height) * 0.15 +
        Math.random() * 0.3
      const c = sampleParticleColor(this.themeName, t, Math.random() < 0.08)
      colorArray[i3] = c.r
      colorArray[i3 + 1] = c.g
      colorArray[i3 + 2] = c.b
    }
    this.colorAttr.needsUpdate = true
  }

  // ------------- 公开 API（控制面板经由这里真正驱动系统） -------------

  setCount(count: number): void {
    if (count === this.count) return
    this.rebuild(count)
    this.points.geometry = this.geometry
  }

  setTheme(themeName: ThemeName): void {
    if (themeName === this.themeName) return
    this.themeName = themeName
    this.applyThemeColors()
  }

  setSpeed(speed: number): void {
    this.speed = THREE.MathUtils.clamp(speed, 0.1, 3)
  }

  setMode(mode: MotionMode): void {
    if (mode === this.mode) return
    this.mode = mode
    // 切入爆发模式时把计时器置满 → 下一帧立即触发一次脉冲；
    // 因为脉冲只改速度不改位置，切换瞬间不会有任何跳变
    this.burstTimer = mode === 'burst' ? BURST.interval : 0
  }

  togglePause(): void {
    this.paused = !this.paused
  }

  /** 重置：重新播种位置/速度/归宿并重上色，模式与主题保持不变 */
  reset(): void {
    this.seed()
    this.applyThemeColors()
    const attrs = this.geometry.attributes
    for (const key in attrs) {
      const attr = attrs[key] as THREE.BufferAttribute
      attr.needsUpdate = true
    }
    this.burstTimer = BURST.interval
  }

  resizePixelRatio(pixelRatio: number): void {
    this.material.uniforms.uScale.value = RENDER.sizeScale * pixelRatio
  }

  // ------------- 每帧更新 -------------

  /**
   * 主更新入口。
   * @param dt 已限幅的真实帧间隔（秒）
   * @param interaction 鼠标影响场：3D 影响点坐标、平面法线轴、0..1 平滑强度
   */
  update(dt: number, interaction: PointerInteraction): void {
    if (this.paused || dt <= 0) return // 暂停时不推进任何状态，恢复后无缝衔接
    this.elapsed += dt
    this.material.uniforms.uTime.value = this.elapsed

    const { pos, vel, home, phase } = this
    const n = this.count
    const mode = MODE_CODE[this.mode]
    const mouseCode = MOUSE_CODE[interaction.mouseMode]

    // 把所有每帧不变的量提前算好，热循环里只留标量计算
    const damp = Math.exp(-MOTION.damping * dt) // 帧率无关的指数阻尼
    const speed = this.speed
    const maxSpeed2 = MOTION.maxSpeed * MOTION.maxSpeed
    const time = this.elapsed

    // 鼠标影响场参数
    const gain = interaction.strength
    const hasMouse = gain > 0.02
    const mx = interaction.mouseX
    const my = interaction.mouseY
    const mz = interaction.mouseZ
    const ax = interaction.axisX
    const ay = interaction.axisY
    const az = interaction.axisZ
    const mouseR2 = MOUSE.radius * MOUSE.radius

    // 爆发模式的自动节拍（每 interval 秒再脉冲一次）
    if (mode === 2) {
      this.burstTimer += dt
      if (this.burstTimer >= BURST.interval) {
        this.burstTimer = 0
        this.triggerBurst()
      }
    }

    for (let i = 0; i < n; i++) {
      const i3 = i * 3

      // —— 读取当前状态（直接读数组下标，不创建 Vector3）——
      let px = pos[i3]
      let py = pos[i3 + 1]
      let pz = pos[i3 + 2]
      let vx = vel[i3]
      let vy = vel[i3 + 1]
      let vz = vel[i3 + 2]
      const hx = home[i3]
      const hy = home[i3 + 1]
      const hz = home[i3 + 2]
      const ph = phase[i]

      // ============ 1) 自然模式力 ============
      if (mode === 0) {
        // 漂浮：弱弹簧拴住归宿 + 绕归宿缓慢公转（像萤火虫一样游动）
        const k = MOTION.spring.float * speed
        vx += (hx - px) * k * dt
        vy += (hy - py) * k * dt
        vz += (hz - pz) * k * dt

        const dx = px - hx
        const dz = pz - hz
        const dl = Math.sqrt(dx * dx + dz * dz) + 1e-3
        const wob = Math.sin(time * 0.7 + ph) * MOTION.drift * speed
        vx += (-dz / dl) * wob * dt // 切向 = 半径方向旋转 90°
        vz += (dx / dl) * wob * dt
        vy += Math.cos(time * 0.55 + ph * 1.37) * MOTION.drift * speed * 0.5 * dt
      } else if (mode === 1) {
        // 漩涡：绕世界 Y 轴旋转，越靠里线速度越快（星系手感）
        const r = Math.sqrt(px * px + pz * pz) + 1e-4
        const vt = (VORTEX.strength * speed * VORTEX.inner) / (r + VORTEX.inner)
        vx += (-pz / r) * vt * dt * 1.2 // 切向方向 = (-z, 0, x)
        vz += (px / r) * vt * dt * 1.2
        // 轻微向心汇聚 + 上下起伏，形成流动的螺旋盘
        vx += (-px / r) * VORTEX.sink * speed * dt
        vz += (-pz / r) * VORTEX.sink * speed * dt
        vy += Math.cos(time * 1.2 + ph) * VORTEX.wobble * dt
        // 弱弹簧维持盘面形状
        const k = MOTION.spring.vortex * speed
        vx += (hx - px) * k * dt
        vy += (hy - py) * k * dt
        vz += (hz - pz) * k * dt
      } else {
        // 爆发（回复段）：弹簧从外围把粒子拉回归宿，阻尼负责减速
        const k = MOTION.spring.burst * speed
        vx += (hx - px) * k * dt
        vy += (hy - py) * k * dt
        vz += (hz - pz) * k * dt
      }

      // ============ 2) 鼠标交互力 ============
      if (hasMouse) {
        const dx = px - mx
        const dy = py - my
        const dz = pz - mz
        const d2 = dx * dx + dy * dy + dz * dz
        if (d2 < mouseR2 && d2 > 1e-6) {
          // smoothstep 衰减：靠近鼠标力最大，半径边缘平滑归零（避免硬边跳变）
          const x = d2 / mouseR2 // 0..1
          const fall = 1 - x * x * (3 - 2 * x)
          const invD = 1 / (Math.sqrt(d2) + 0.6) // 防止距离为 0 时力无限大
          if (mouseCode === 0) {
            // 吸引：朝鼠标方向推
            const f = gain * fall * MOUSE.attract * speed * dt
            vx -= dx * invD * f
            vy -= dy * invD * f
            vz -= dz * invD * f
          } else if (mouseCode === 1) {
            // 排斥：朝远离鼠标方向推
            const f = gain * fall * MOUSE.repel * speed * dt
            vx += dx * invD * f
            vy += dy * invD * f
            vz += dz * invD * f
          } else {
            // 鼠标旋涡：绕“相机视线轴”的切向力 → 屏幕空间里的漩涡圈
            // 切向 = 视线轴 × (粒子 - 鼠标)
            const tx = ay * dz - az * dy
            const ty = az * dx - ax * dz
            const tz = ax * dy - ay * dx
            const tl = Math.sqrt(tx * tx + ty * ty + tz * tz) + 0.35
            const f = (gain * fall * MOUSE.vortex * speed * dt) / tl
            vx += tx * f
            vy += ty * f
            vz += tz * f
            // 轻微向心，让漩涡抱团而不是完全散开
            const inF = gain * fall * MOUSE.vortex * 0.12 * speed * invD * dt
            vx -= dx * inF
            vy -= dy * inF
            vz -= dz * inF
          }
        }
      }

      // ============ 3) 阻尼 → 限速 → 积分位置 ============
      vx *= damp
      vy *= damp
      vz *= damp
      const v2 = vx * vx + vy * vy + vz * vz
      if (v2 > maxSpeed2) {
        const s = MOTION.maxSpeed / Math.sqrt(v2)
        vx *= s
        vy *= s
        vz *= s
      }
      px += vx * dt
      py += vy * dt
      pz += vz * dt

      // —— 写回并行数组（下帧继续用，全程无内存分配）——
      pos[i3] = px
      pos[i3 + 1] = py
      pos[i3 + 2] = pz
      vel[i3] = vx
      vel[i3 + 1] = vy
      vel[i3 + 2] = vz
    }

    // 告诉 Three：position 数据变了，下次渲染前上传 GPU
    this.posAttr.needsUpdate = true
  }

  /**
   * 爆发脉冲：只给“速度”注入径向初速，绝不动位置——
   * 因此无论切换模式还是连续爆发，粒子都不会瞬移；
   * 它们自然飞出 → 阻尼减速 → 被 burst 弹簧拉回，形成“呼吸”循环。
   */
  private triggerBurst(): void {
    const { pos, vel } = this
    for (let i = 0; i < this.count; i++) {
      const i3 = i * 3
      let dx = pos[i3]
      let dy = pos[i3 + 1]
      let dz = pos[i3 + 2]
      const len = Math.sqrt(dx * dx + dy * dy + dz * dz)
      if (len < 0.001) {
        dx = Math.random() - 0.5
        dy = Math.random() - 0.5
        dz = Math.random() - 0.5
      } else {
        dx /= len
        dy /= len
        dz /= len
      }
      const s = BURST.speed * (0.65 + Math.random() * 0.55) * this.speed
      vel[i3] = dx * s + (Math.random() - 0.5) * BURST.jitter
      vel[i3 + 1] = dy * s + (Math.random() - 0.5) * BURST.jitter
      vel[i3 + 2] = dz * s + (Math.random() - 0.5) * BURST.jitter
    }
  }

  dispose(): void {
    this.geometry.dispose()
    this.material.dispose()
  }
}
