import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import legacy from '@vitejs/plugin-legacy'

// https://vitejs.dev/config/
export default defineConfig({
  base: '/',
  plugins: [
    react(),
    legacy({
      targets: ['defaults', 'not IE 11', 'android >= 10'],
    })
  ],
  server: {
    proxy: {
      '/api': 'http://localhost:8000',
      '/webdav': 'http://localhost:8000'
    }
  },
  build: {
    minify: false,
    chunkSizeWarningLimit: 1600,
    rollupOptions: {
      output: {
        // manualChunks removed to fix initialization error
      }
    }
  }
})
