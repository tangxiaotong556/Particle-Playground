import { defineConfig } from 'vite'

export default defineConfig({
  // base: './' 让产物以相对路径引用资源，构建后可直接部署到任意子目录
  base: './',
  server: {
    host: true,
    port: 5173,
  },
  build: {
    target: 'es2020',
    // three.js 本身体积较大，提高告警阈值以避免噪音
    chunkSizeWarningLimit: 900,
  },
})
