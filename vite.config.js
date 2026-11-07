import { defineConfig } from 'vite';

// The ClarityView mirror (src/clarityview/, byte-for-byte, never edited) imports its own
// HUD stylesheet (ahu3d.css: .a3-* rules for ClarityView's unit page). The twin never shows
// that HUD, so any CSS imported from the mirror resolves to an empty module instead.
const clarityviewNoCss = () => ({
  name: 'clarityview-no-css',
  enforce: 'pre',
  resolveId(id, importer) {
    if (importer && importer.replace(/\\/g, '/').includes('/src/clarityview/') && id.endsWith('.css')) return '\0cv-empty.css';
    return null;
  },
  load(id) {
    if (id === '\0cv-empty.css') return '';
    return null;
  },
});

export default defineConfig({
  plugins: [clarityviewNoCss()],
  server: {
    host: true,
    port: 5173,
  },
  build: {
    target: 'es2020',
    cssCodeSplit: true,
    sourcemap: false,
    // three.js lives in the lazily loaded twin chunks (~150 KB gz); it never blocks first paint
    chunkSizeWarningLimit: 800,
    rollupOptions: {
      output: {
        // three (core + the examples the twin uses) is shared by the twin app and the units
        // chunk: one named chunk for it, and the units chunk named for what it is
        manualChunks: (id) => (id.replace(/\\/g, '/').includes('/node_modules/three/') ? 'three' : undefined),
        chunkFileNames: (c) =>
          (c.facadeModuleId || '').replace(/\\/g, '/').endsWith('/src/twin/units/index.js') ? 'assets/units-[hash].js' : 'assets/[name]-[hash].js',
      },
    },
  },
});
