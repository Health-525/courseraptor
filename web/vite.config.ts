import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// GitHub Pages 部署在 /courseraptor/ 子路径，构建时注入 PAGES_BASE；
// qmuse 导入等根路径场景不设置该变量，保持默认 '/'。
// https://vite.dev/config/
export default defineConfig({
  base: process.env.PAGES_BASE ?? '/',
  plugins: [react()],
})
