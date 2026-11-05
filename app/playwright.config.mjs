import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const output = fileURLToPath(new URL('../output/playwright/covelet/', import.meta.url));
export default defineConfig({
  testDir: './tests/playwright',
  testMatch: '**/*.spec.mjs',
  outputDir: `${output}/test-results`,
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  reporter: [
    ['list'],
    ['html', { outputFolder: `${output}/report`, open: 'never' }],
    ['json', { outputFile: `${output}/results.json` }],
  ],
  use: { headless: true, viewport: { width: 1280, height: 900 }, locale: 'zh-CN', timezoneId: 'Asia/Shanghai', actionTimeout: 10_000, navigationTimeout: 20_000 },
  projects: [{ name: 'chromium-extension' }],
});
