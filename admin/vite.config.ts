import path from 'path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { tanstackRouter } from '@tanstack/router-plugin/vite'

// 部署形态：网关把 /admin/* 指到本目录 dist/（产物随仓库提交，服务器不构建）
export default defineConfig({
  base: '/admin/',
  plugins: [
    tanstackRouter({
      target: 'react',
      autoCodeSplitting: true,
    }),
    react(),
    tailwindcss(),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  // 本地开发：vite 跑 5173，管理 API 打到本机网关（npm run gateway）
  server: {
    proxy: {
      '/admin/api': {
        target: 'http://127.0.0.1:8080',
        changeOrigin: false,
      },
    },
  },
})
