/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      // Registered from main.tsx (virtual:pwa-register), which also reloads the page once an
      // updated version takes over; a bare registerSW.js would keep running the old code.
      injectRegister: false,
      includeAssets: ['favicon.svg', 'icons/apple-touch-icon.png'],
      manifest: {
        name: 'Nicotes',
        short_name: 'Nicotes',
        description: 'Notes that are easy to group and link',
        lang: 'en',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        background_color: '#0a0e16',
        theme_color: '#0a0e16',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
        // Android's share sheet: links shared to Nicotes open the importer.
        share_target: {
          action: '/share',
          method: 'GET',
          enctype: 'application/x-www-form-urlencoded',
          params: { title: 'title', text: 'text', url: 'url' },
        },
      },
      workbox: {
        // Precache only the app shell so it starts instantly; lazily loaded chunks (editor
        // language modes, font subsets) are cached the first time they are used. Data
        // always comes from the server.
        globPatterns: ['index.html', 'assets/index-*.{js,css}', 'favicon.svg', 'icons/*.png'],
        // A new version takes over at once instead of waiting until every Nicotes tab is
        // closed (the old app code would otherwise keep talking to the new server).
        skipWaiting: true,
        clientsClaim: true,
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api\//],
        maximumFileSizeToCacheInBytes: 3 * 1024 * 1024,
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.pathname.startsWith('/assets/'),
            handler: 'CacheFirst',
            options: { cacheName: 'nicotes-assets', expiration: { maxEntries: 300, maxAgeSeconds: 365 * 24 * 3600 } },
          },
        ],
      },
    }),
  ],
  server: {
    port: 5180,
    proxy: { '/api': 'http://localhost:3000' },
  },
  test: {
    environment: 'happy-dom',
  },
});
