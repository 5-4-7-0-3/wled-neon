import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // Relative paths so the same build loads from file:// (Electron) and the Android WebView
  base: './',
})
