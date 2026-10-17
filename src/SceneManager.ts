import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'

/**
 * SceneManager 负责“一支镜头与一方舞台”：
 * - 创建渲染器、相机与轨道控制器（OrbitControls，带阻尼平滑）
 * - 一层静态远景星空，增强空间纵深
 * - 处理窗口尺寸变化，空闲时缓慢自动旋转
 * - 场景本身不含粒子：粒子由 ParticleSystem 创建后天放进 this.scene
 */
export class SceneManager {
  readonly scene = new THREE.Scene()
  readonly camera: THREE.PerspectiveCamera
  readonly renderer: THREE.WebGLRenderer
  readonly controls: OrbitControls
  readonly canvas: HTMLCanvasElement

  private readonly stars: THREE.Points
  /** 空闲计时：用户无操作若干秒后开启缓慢自动旋转，展示全景 */
  private idle = 0
  private readonly onResize = () => this.handleResize()
  private readonly onTouch = () => {
    this.idle = 0
  }

  constructor(
    canvas: HTMLCanvasElement,
    rendererParams: { antialias?: boolean; powerPreference?: 'default' | 'high-performance' } = {},
  ) {
    this.canvas = canvas

    // ---- 渲染器（参数由 boot 注入：失败时可换保守参数重试）----
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: rendererParams.antialias ?? true,
      powerPreference: rendererParams.powerPreference ?? 'high-performance',
    })
    // 限制像素比上限：高分屏下 4K 全屏渲染是常见的性能陷阱
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75))
    this.renderer.setSize(window.innerWidth, window.innerHeight)
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1.1

    // ---- 相机 ----
    this.camera = new THREE.PerspectiveCamera(
      60,
      window.innerWidth / window.innerHeight,
      0.1,
      500,
    )
    this.camera.position.set(0, 8, 32)

    // ---- 轨道控制器：左键拖拽旋转、滚轮缩放；enableDamping 让转动有“惯性”平滑感 ----
    this.controls = new OrbitControls(this.camera, canvas)
    this.controls.enableDamping = true
    this.controls.dampingFactor = 0.08
    this.controls.enablePan = false
    this.controls.minDistance = 12
    this.controls.maxDistance = 72
    this.controls.rotateSpeed = 0.6
    this.controls.autoRotate = false
    this.controls.autoRotateSpeed = 0.35
    // 用户按住鼠标/触摸即视为“正在观察”，自动旋转立即让位
    this.controls.addEventListener('start', this.onTouch)

    // ---- 远景星空（静态装饰，一次生成，把画面撑出深度）----
    this.stars = this.createStars()
    this.scene.add(this.stars)

    window.addEventListener('resize', this.onResize)
    canvas.addEventListener('pointermove', this.onTouch)
    canvas.addEventListener('wheel', this.onTouch, { passive: true })
    canvas.addEventListener('pointerdown', this.onTouch)
  }

  private createStars(): THREE.Points {
    const n = 420
    const positions = new Float32Array(n * 3)
    for (let i = 0; i < n; i++) {
      // 均匀方向 + 远距离球壳，形成围绕场景的远景
      const u = Math.random() * 2 - 1
      const theta = Math.random() * Math.PI * 2
      const r = 70 + Math.random() * 80
      const s = Math.sqrt(1 - u * u)
      positions[i * 3] = Math.cos(theta) * s * r
      positions[i * 3 + 1] = u * r * 0.7
      positions[i * 3 + 2] = Math.sin(theta) * s * r
    }
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    const material = new THREE.PointsMaterial({
      color: 0x8fb0ff,
      size: 0.7,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    })
    const points = new THREE.Points(geometry, material)
    points.frustumCulled = false
    return points
  }

  /** 主题切换时更换近黑背景色（低频操作，允许分配新对象） */
  setBackground(hex: string): void {
    this.scene.background = new THREE.Color(hex)
  }

  get pixelRatio(): number {
    return this.renderer.getPixelRatio()
  }

  /** 每帧调用：推进相机阻尼与星空缓慢转动，并处理空闲自动旋转 */
  update(dt: number): void {
    this.controls.update()
    this.stars.rotation.y += dt * 0.004

    // 空闲超过 12s 开启缓慢自转；任何交互（onTouch）都会清零计时并关闭
    this.idle += dt
    this.controls.autoRotate = this.idle > 12
  }

  render(): void {
    this.renderer.render(this.scene, this.camera)
  }

  private handleResize(): void {
    const w = window.innerWidth
    const h = window.innerHeight
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
    this.renderer.setSize(w, h)
  }

  /** 释放全部资源与监听，避免热更新/页面关闭时泄漏 WebGL 上下文 */
  dispose(): void {
    window.removeEventListener('resize', this.onResize)
    this.canvas.removeEventListener('pointermove', this.onTouch)
    this.canvas.removeEventListener('wheel', this.onTouch)
    this.canvas.removeEventListener('pointerdown', this.onTouch)
    this.controls.removeEventListener('start', this.onTouch)
    this.controls.dispose()
    this.stars.geometry.dispose()
    ;(this.stars.material as THREE.PointsMaterial).dispose()
    this.renderer.dispose()
  }
}
