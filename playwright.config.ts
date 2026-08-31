import { defineConfig, devices } from '@playwright/test'

// E2E tests run against the real dev server talking to the live Supabase
// project (see docs/system-design.md "End-to-end tests run against the live
// database" for why: RLS is `using(true)` everywhere already, so a test
// account is no more exposed than any other row, and this is the only way to
// exercise real multi-actor flows — Realtime propagation between browser
// contexts included). Every identity a test creates must be handed to the
// `manifest` fixture (see e2e/fixtures.ts) so it gets deleted afterward.
export default defineConfig({
  testDir: './e2e',
  // Each test writes real rows to a shared database; keep runs serial so
  // failures are easy to attribute and cleanup never races another test.
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'retain-on-failure',
  },
  webServer: {
    // Dev server, not a production build/preview: vite-plugin-pwa only
    // registers a service worker in production, and a cached SW between
    // test runs is the last thing this suite needs.
    command: 'npm run dev -- --port 5173 --strictPort',
    url: 'http://localhost:5173',
    reuseExistingServer: !process.env.CI,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
})
