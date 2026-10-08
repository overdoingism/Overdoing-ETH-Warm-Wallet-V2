import { defineConfig } from '@playwright/test';

// End-to-end tests drive the built single file (dist/oeww.html) through file:// in the
// installed Edge, against a local Hardhat chain.
export default defineConfig({
  testDir: 'test/e2e',
  timeout: 120_000,
  expect: { timeout: 20_000 },
  workers: 1,
  reporter: [['list']],
  globalSetup: './test/e2e/global-setup.mjs',
  use: {
    channel: 'msedge',
    headless: true,
    viewport: { width: 900, height: 1100 },
    acceptDownloads: true,
    launchOptions: { args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] },
  },
  webServer: {
    command: 'npx hardhat node --port 8545',
    port: 8545,
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
