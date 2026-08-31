/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    vue(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg'],
      manifest: {
        name: 'whisper-z',
        short_name: 'whisper-z',
        description: 'An end-to-end encrypted two-person messaging app',
        theme_color: '#ffffff',
        background_color: '#ffffff',
        display: 'standalone',
        orientation: 'portrait-primary',
        icons: [
          {
            src: 'logo-192.png',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'any',
          },
          {
            src: 'logo-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any maskable',
          },
        ],
      },
      workbox: {
        cleanupOutdatedCaches: true,
      },
    }),
  ],
  define: {
    __BUILD_ID__: JSON.stringify(process.env.VITE_BUILD_ID || 'dev'),
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },
  test: {
    // Plain Node by default — fast, and matches how the pure lib/ functions
    // already got verified all along (standalone Node scripts using
    // webcrypto). Files that touch `window` (route.ts's hashchange listener,
    // eventually component tests) opt into jsdom individually via a
    // `// @vitest-environment jsdom` docblock at the top of that file.
    environment: 'node',
    // Confined to src/ so Vitest never picks up e2e/*.spec.ts — those are
    // Playwright tests (a different `test`/`expect`, a live dev server and
    // database, run via `npm run test:e2e`), not Vitest's.
    include: ['src/**/*.{test,spec}.ts'],
  },
})
