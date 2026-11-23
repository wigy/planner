import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const apiPort = process.env.PORT ?? '8920'

export default defineConfig({
  plugins: [react()],
  build: { chunkSizeWarningLimit: 1000 },
  server: {
    host: true,
    proxy: { '/api': `http://localhost:${apiPort}`, '/auth': `http://localhost:${apiPort}` },
  },
})
