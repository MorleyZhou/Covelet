import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const target = process.env.COVELET_UPGRADE_TARGET === 'release' ? 'upgrade-release' : 'upgrade';
const output = fileURLToPath(new URL('../../output/playwright/covelet/' + target + '/', import.meta.url));
export default defineConfig({
  testDir: './upgrade', testMatch: '**/*.spec.mjs',
  outputDir: output + 'test-results', fullyParallel: false, workers: 1,
  forbidOnly: Boolean(process.env.CI), retries: 0, timeout: 180_000,
  expect: { timeout: 10_000 },
  reporter: [['list'], ['html', { outputFolder: output + 'report', open: 'never' }], ['json', { outputFile: output + 'results.json' }]],
  use: { headless: true, viewport: { width: 1280, height: 900 }, locale: 'zh-CN', timezoneId: 'Asia/Shanghai', actionTimeout: 10_000, navigationTimeout: 20_000 },
  projects: [{ name: 'chromium-upgrade' }],
});
