import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'web',
  base: '/ui/',
  plugins: [react()],
  build: {
    outDir: '../dist/web',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/health': 'http://127.0.0.1:3000',
      '/system': 'http://127.0.0.1:3000',
      '/timeline': 'http://127.0.0.1:3000',
      '/tags': 'http://127.0.0.1:3000',
      '/events': 'http://127.0.0.1:3000',
      '/recordings': 'http://127.0.0.1:3000',
      '/conversation': 'http://127.0.0.1:3000',
      '/audio': 'http://127.0.0.1:3000',
      '/cameras': 'http://127.0.0.1:3000',
    },
  },
});
