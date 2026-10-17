/**
 * 全局调参中心：所有可感知的手感参数都集中在这里。
 * 学习者可以随手改数值并刷新页面立即观察差异，不用翻散落在各处的魔数。
 */

/** 粒子云的几何分布（具有空间深度的扁椭球体） */
export const CLOUD = {
  radius: 14, // 粒子盘水平半径（世界单位）
  height: 6, // 粒子盘垂直半高度
} as const

/** 自然运动的受力参数 */
export const MOTION = {
  damping: 1.15, // 全局阻尼：速度每秒按 e^-damping 指数衰减，让运动收敛、不抖
  maxSpeed: 40, // 速度上限，防止鼠标交互瞬间把粒子打飞
  spring: {
    float: 0.55, // 漂浮模式：回归个人“归宿位置”的弹簧刚度（越弱越自由）
    vortex: 0.5, // 漩涡模式：较弱的弹簧，保持盘面形状
    burst: 0.9, // 爆发模式：较强的弹簧，把粒子从外围拉回来
  },
  drift: 0.9, // 漂浮模式：围绕归宿缓慢公转的力量（营造萤火虫般的游动）
} as const

/** 漩涡模式：绕世界 Y 轴整体旋转的星系感 */
export const VORTEX = {
  strength: 6.5, // 切向推力
  inner: 9, // 越靠中心线速度越强的衰减半径
  sink: 0.4, // 轻微向中心汇聚，产生流动的螺旋感
  wobble: 0.5, // Y 轴上下轻微起伏
} as const

/** 爆发模式：速度脉冲 + 阻尼减速 + 弹簧回位，形成“呼吸”节律 */
export const BURST = {
  speed: 19, // 每次爆发的初速
  jitter: 1.4, // 初速的随机扰动幅度
  interval: 2.6, // 每隔多少秒自动再爆一次
} as const

/** 鼠标交互 */
export const MOUSE = {
  radius: 6, // 影响半径（世界单位）
  attract: 26, // 吸引强度
  repel: 34, // 排斥强度
  vortex: 30, // 鼠标旋涡强度（绕相机视线转）
  ramp: 6, // 强度 0↔1 指数平滑速率（越大渐入越快）
} as const

/** 渲染 */
export const RENDER = {
  sizeScale: 150, // 点精灵基础放大倍率（配合相机距离做透视衰减）
  maxPointSize: 96, // 点精灵像素上限，防止近距离变成大色块
} as const

/** 控制面板可选粒子数量 */
export const COUNT_OPTIONS = [2000, 5000, 8000, 12000] as const

/**
 * 根据简易设备能力推断默认粒子数：
 * 触屏/核数少的设备用较小规模，保证流畅为第一优先级。
 */
export function suggestDefaultCount(): number {
  const cores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 4 : 4
  const coarseTouch = typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches
  return cores >= 4 && !coarseTouch ? 5000 : 2000
}
