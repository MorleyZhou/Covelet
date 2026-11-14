import { defineConfig } from '@playwright/test';
import base from '../playwright.config.mjs';
import { fileURLToPath } from 'node:url';

const browser = process.env.COVELET_NATIVE_BROWSER || 'chromium';
if (!['chromium', 'chrome', 'edge'].includes(browser)) throw Error('Unsupported regression browser.');
const shard = process.env.COVELET_QA_SHARD || '';
if (shard && !/^[1-3]$/u.test(shard)) throw Error('COVELET_QA_SHARD must be 1, 2 or 3.');
const output = fileURLToPath(new URL(`../../output/playwright/covelet/0.6.0-final/${browser}/${shard ? `shard-${shard}/` : ''}`, import.meta.url));
export default defineConfig(base, {
  testDir: './playwright',
  ...(shard ? { shard: { current: Number(shard), total: 3 } } : {}),
  outputDir: `${output}/test-results`,
  reporter: [['list'], ['json', { outputFile: `${output}/results.json` }]],
});
