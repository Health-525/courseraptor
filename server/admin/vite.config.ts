import path from 'path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { tanstackRouter } from '@tanstack/router-plugin/vite'

// 构建产物由 server/app.mjs 托管在 /admin 子路径下，base 必须与之对齐。
export default defineConfig({
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
  base: '/admin/',
  server: {
    proxy: {
      '/admin/api': 'http://127.0.0.1:8787',
      '/publish': 'http://127.0.0.1:8787',
    },
  },
})
