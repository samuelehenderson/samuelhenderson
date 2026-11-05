import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    host: true,
    port: 5173,
  },
  build: {
    target: 'es2020',
    cssCodeSplit: true,
    sourcemap: false,
    // three.js lives in the lazily loaded twin chunk (~180 KB gz); it never blocks first paint
    chunkSizeWarningLimit: 800,
  },
});
