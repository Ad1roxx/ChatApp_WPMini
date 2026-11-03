import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // Prepare the app's modules when the dev server starts, rather than on the first
  // page load, which took over 30 s on a fresh demo start (BUILD_NOTES Entry 80).
  server: { warmup: { clientFiles: ['./src/main.jsx'] } },
})
