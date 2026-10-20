/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5180,
    proxy: { '/api': 'http://localhost:3000' },
  },
  test: {
    environment: 'happy-dom',
  },
});
