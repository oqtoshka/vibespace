import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';
export default defineConfig({
  plugins: [react()],
  publicDir: false,
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  build: { outDir: 'dist-native-viewer', emptyOutDir: true, assetsInlineLimit: 20 * 1024 * 1024,
    lib: { entry: 'src/native-viewer/main.tsx', name: 'MissionControlFileViewer', formats: ['iife'], fileName: () => 'viewer.js' },
    rollupOptions: { output: { inlineDynamicImports: true, assetFileNames: '[name][extname]' } },
  },
});
