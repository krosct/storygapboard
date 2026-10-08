import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Dev only: `npm run dev` proxies /api to a backend on BACKEND_URL
// (default: uvicorn on 127.0.0.1:8000, see AGENTS.md). Production serves the
// built files from the backend behind Caddy (deploy.conf, via devkit).
const BACKEND_URL = process.env.BACKEND_URL ?? 'http://127.0.0.1:8000'

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: { '/api': { target: BACKEND_URL, changeOrigin: false } },
  },
  build: {
    sourcemap: false,
    assetsInlineLimit: 0,
  },
})
