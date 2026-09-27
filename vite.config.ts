import { defineConfig } from 'vite';
import path from 'node:path';

export default defineConfig({
  root: path.resolve(__dirname, 'app'),
  publicDir: path.resolve(__dirname, 'public'),
  base: './',
  build: {
    outDir: path.resolve(__dirname, 'dist/web'),
    emptyOutDir: true,
    target: 'es2022',
    chunkSizeWarningLimit: 4096
  },
  server: {
    port: 5173,
    host: '127.0.0.1'
  },
  preview: {
    port: 4173,
    host: '127.0.0.1'
  }
});
