import { defineConfig } from '@playwright/test';
import base from '../playwright.config.mjs';
import { fileURLToPath } from 'node:url';

const batch = process.env.COVELET_QA_BATCH || '';
if (batch && !/^\d+\.\d+\.\d+(?:-(?:chromium|chrome|edge))?$/u.test(batch)) throw Error('COVELET_QA_BATCH must be a version-shaped batch name with an optional browser suffix.');
const output = fileURLToPath(new URL(`../../output/playwright/covelet/0.6-batches/${batch ? `${batch}/` : ''}`, import.meta.url));
export default defineConfig(base, {
  testDir: './playwright',
  testMatch: /(?:command-query|note-workflows|widget-pins)\.spec\.mjs$/,
  outputDir: `${output}/test-results`,
  timeout: 120_000,
  reporter: [
    ['list'],
    ['json', { outputFile: `${output}/results.json` }],
  ],
});
