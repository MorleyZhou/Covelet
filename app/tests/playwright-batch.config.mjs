import { defineConfig } from '@playwright/test';
import base from '../playwright.config.mjs';
import { fileURLToPath } from 'node:url';

const output = fileURLToPath(new URL('../../output/playwright/covelet/0.6-batches/', import.meta.url));
export default defineConfig(base, {
  testDir: './playwright',
  testMatch: /command-query\.spec\.mjs$/,
  outputDir: `${output}/test-results`,
  timeout: 120_000,
  reporter: [
    ['list'],
    ['json', { outputFile: `${output}/results.json` }],
  ],
});
