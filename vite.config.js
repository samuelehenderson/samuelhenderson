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
    // three.js lives in the lazily loaded twin chunk (~180 KB gz); it never blocks first paint
    chunkSizeWarningLimit: 800,
  },
});
