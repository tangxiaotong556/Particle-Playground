import * as THREE from 'three'
import { MOUSE } from './config'
import type { MouseMode } from './types'

/**
 * PointerInteraction 负责把“2D 鼠标坐标”翻译成“3D 空间中的影响点”，
 * 并把结果以“纯数字字段”暴露给 CPU 粒子循环直接读取（避免每帧分配对象）。
 *
 * 坐标转换原理（最核心的一步）：
 * 1. 浏览器给我们的只有 clientX/clientY（像素）→ 先换算成 NDC（-1..1 的标准设备坐标）；
 * 2. 用 NDC 从相机发出一条射线（Raycaster.setFromCamera）；
 * 3. 让射线与“过场景中心、且垂直于视线”的平面求交——
 *    该平面始终迎着相机，因此鼠标在屏幕上的任何位置都能得到一个有意义的 3D 点；
 * 4. 这个交点就是鼠标影响球心，粒子系统的力只作用于它周围 MOUSE.radius 内。
 *
 * 这个做法让鼠标的影响范围真正伸进 3D 场景：旋转相机后，
 * 影响点依旧贴着视线方向，而不是死板地钉在某个 z=0 平面上。
 */
export class PointerInteraction {
  /** 鼠标影响点（世界坐标，纯数字，供粒子循环无分配读取） */
  mouseX = 0
  mouseY = 0
  mouseZ = 0

  /** 影响平面的法线 ≈ 相机视线方向：鼠标“旋涡”围绕它旋转 */
  axisX = 0
  axisY = 1
  axisZ = 0

  /** 交互强度 0..1：进入画布平滑升起、离开或拖拽相机时平滑回落 */
  strength = 0

  mouseMode: MouseMode = 'attract'

  private readonly camera: THREE.PerspectiveCamera
  private readonly canvas: HTMLCanvasElement
  private readonly ndc = new THREE.Vector2()
  private readonly raycaster = new THREE.Raycaster()
  private readonly plane = new THREE.Plane()
  private readonly dir = new THREE.Vector3()
  private readonly hit = new THREE.Vector3()
  private readonly origin = new THREE.Vector3(0, 0, 0)

  private active = false
  private dragging = false

  constructor(camera: THREE.PerspectiveCamera, canvas: HTMLCanvasElement) {
    this.camera = camera
    this.canvas = canvas

    // 这些监听与 OrbitControls 共存：
    // 按下左键拖拽 → OrbitControls 旋转相机，同时本类把强度目标降到 0，互不打架
    canvas.addEventListener('pointermove', this.onMove)
    canvas.addEventListener('pointerenter', this.onEnter)
    canvas.addEventListener('pointerleave', this.onLeave)
    canvas.addEventListener('pointerdown', this.onDown)
    canvas.addEventListener('pointercancel', this.onCancel)
    window.addEventListener('pointerup', this.onUp)
  }

  setMouseMode(mode: MouseMode): void {
    this.mouseMode = mode
  }

  /** 每帧调用：更新强度渐变，并在指针有效时刷新 3D 交点 */
  update(dt: number): void {
    const target = this.active && !this.dragging ? 1 : 0
    // 指数平滑 0↔1：与帧率无关，也不会跳变
    this.strength += (target - this.strength) * (1 - Math.exp(-MOUSE.ramp * dt))
    if (this.active) this.project()
  }

  private project(): void {
    // 相机视线方向作为平面法线（随相机实时更新）
    this.camera.getWorldDirection(this.dir)
    this.plane.setFromNormalAndCoplanarPoint(this.dir, this.origin)
    this.raycaster.setFromCamera(this.ndc, this.camera)
    // 若射线恰好与平面平行（极端视角）则跳过本帧，沿用上一次坐标，保证稳定
    if (this.raycaster.ray.intersectPlane(this.plane, this.hit)) {
      this.mouseX = this.hit.x
      this.mouseY = this.hit.y
      this.mouseZ = this.hit.z
      this.axisX = this.dir.x
      this.axisY = this.dir.y
      this.axisZ = this.dir.z
    }
  }

  private onMove = (e: PointerEvent): void => {
    // 像素坐标 → NDC：先减元素偏移换到 0..1，再对称映射到 -1..1
    const rect = this.canvas.getBoundingClientRect()
    this.ndc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1
    this.ndc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1
    this.active = true
  }

  private onEnter = (): void => {
    this.active = true
  }

  private onLeave = (): void => {
    // 光标移出画布（包括移到控制面板上）→ 平滑关闭影响场
    this.active = false
  }

  private onDown = (e: PointerEvent): void => {
    // 左键按下交给 OrbitControls 旋转相机，此时停用粒子影响，避免“边转边吸”
    if (e.button === 0) this.dragging = true
  }

  private onUp = (): void => {
    this.dragging = false
  }

  private onCancel = (): void => {
    this.active = false
    this.dragging = false
  }

  dispose(): void {
    this.canvas.removeEventListener('pointermove', this.onMove)
    this.canvas.removeEventListener('pointerenter', this.onEnter)
    this.canvas.removeEventListener('pointerleave', this.onLeave)
    this.canvas.removeEventListener('pointerdown', this.onDown)
    this.canvas.removeEventListener('pointercancel', this.onCancel)
    window.removeEventListener('pointerup', this.onUp)
  }
}
