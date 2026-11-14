import { defineConfig } from '@playwright/test';
import base from '../playwright.config.mjs';
import { fileURLToPath } from 'node:url';

const browser = process.env.COVELET_NATIVE_BROWSER || 'chromium';
if (!['chromium', 'chrome', 'edge'].includes(browser)) throw Error('Unsupported regression browser.');
const output = fileURLToPath(new URL(`../../output/playwright/covelet/0.6.0-final/${browser}/`, import.meta.url));
export default defineConfig(base, {
  testDir: './playwright',
  outputDir: `${output}/test-results`,
  reporter: [['list'], ['json', { outputFile: `${output}/results.json` }]],
});
