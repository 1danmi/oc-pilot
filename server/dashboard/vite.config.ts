import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Vite config for the OC Pilot telemetry dashboard.
 *
 * `base: '/'` and `outDir: 'dist'` so the FastAPI server can mount the build
 * output unchanged at its root path.
 *
 * In dev mode (`npm run dev`), Vite proxies /v1/* and /healthz to a local
 * FastAPI server on :8080 so the React app can call the real backend with
 * basic auth from the browser's credential cache.
 */
export default defineConfig({
  plugins: [react()],
  base: '/',
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/v1': {
        target: 'http://localhost:8080',
        changeOrigin: true,
      },
      '/healthz': {
        target: 'http://localhost:8080',
        changeOrigin: true,
      },
    },
  },
});
