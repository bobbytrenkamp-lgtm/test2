import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Same-origin in development and preview, so the session cookie behaves exactly
// as it does in production behind a single hostname.
//
// The default target is an address, not the name "localhost". The API binds to
// 0.0.0.0, which is the IPv4 wildcard only; on a host that resolves "localhost"
// to ::1 first, a proxy aimed at the name would find nothing listening.
const apiProxy = {
  '/api': {
    target: process.env.API_ORIGIN ?? 'http://127.0.0.1:4000',
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
    // Bound to the IPv4 loopback address rather than the name "localhost".
    // Resolution of that name is not the same everywhere: a GitHub runner
    // answers with ::1 first, so a server bound by name listens on IPv6 while
    // the test harness knocks on 127.0.0.1 and waits until it times out. An
    // address resolves to itself.
    host: '127.0.0.1',
    port: 5174,
    // Fail rather than quietly moving to the next free port. A silent shift
    // would leave the harness waiting on an address nothing is serving, which
    // reads as a hang and says nothing about its cause.
    strictPort: true,
    proxy: apiProxy,
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
