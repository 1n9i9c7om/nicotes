/// <reference types="vitest/config" />
import { cpSync, existsSync, readFileSync } from 'node:fs';
import { join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

/**
 * Excalidraw (canvas pages) loads its fonts from EXCALIDRAW_ASSET_PATH, else from a CDN that
 * the CSP blocks: they are served from /excalidraw/fonts instead. Browsers fetch only the
 * subsets the text needs (see CanvasEditor), so the large CJK font costs disk space only.
 */
function excalidrawFonts(): Plugin {
  const fonts = ['../../node_modules', 'node_modules']
    .map((dir) => fileURLToPath(new URL(`${dir}/@excalidraw/excalidraw/dist/prod/fonts`, import.meta.url)))
    .find((dir) => existsSync(dir));
  if (!fonts) throw new Error('@excalidraw/excalidraw is not installed');
  let outDir = 'dist';
  return {
    name: 'nicotes-excalidraw-fonts',
    configResolved(config) {
      outDir = config.build.outDir;
    },
    configureServer(server) {
      server.middlewares.use('/excalidraw/fonts', (req, res, next) => {
        const file = normalize(join(fonts, decodeURIComponent((req.url ?? '').split('?')[0]!)));
        if (!file.startsWith(fonts) || !existsSync(file) || !file.endsWith('.woff2')) return next();
        res.setHeader('Content-Type', 'font/woff2');
        res.end(readFileSync(file));
      });
    },
    writeBundle() {
      cpSync(fonts, join(outDir, 'excalidraw/fonts'), { recursive: true });
    },
  };
}

export default defineConfig({
  plugins: [
    react(),
    excalidrawFonts(),
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
        // Shows task reminders that arrive as push messages (public/push-sw.js).
        importScripts: ['push-sw.js'],
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
  resolve: {
    // One React, also should npm ever nest a second copy for a dependency's peer range
    // (Excalidraw's Radix tabs ask for React 18; see docs/DEVELOPMENT.md).
    dedupe: ['react', 'react-dom'],
  },
  server: {
    port: 5180,
    proxy: { '/api': 'http://localhost:3000' },
  },
  test: {
    environment: 'happy-dom',
  },
});
