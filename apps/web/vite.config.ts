import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Same-origin in development and preview, so the session cookie behaves exactly
// as it does in production behind a single hostname.
const apiProxy = {
  '/api': {
    target: process.env.API_ORIGIN ?? 'http://localhost:4000',
    changeOrigin: false,
  },
};

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: apiProxy,
  },
  // `vite preview` serves the built bundle. The end-to-end suite drives this
  // rather than the dev server, so what the browser tests is the artefact that
  // would actually be deployed.
  preview: {
    port: 5174,
    proxy: apiProxy,
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
