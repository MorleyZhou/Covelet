import { defineConfig } from '@playwright/test';

// Live tests deliberately omit traces, videos, HTML/JSON attachments and request
// logs: browser form values contain real credentials supplied on this machine.
export default defineConfig({
  testDir: './live', testMatch: '*.spec.mjs', workers: 1, fullyParallel: false,
  timeout: 300_000, expect: { timeout: 15_000 }, retries: 0,
  outputDir: '../../output/playwright/covelet/live-results',
  reporter: [['list']], use: { trace: 'off', screenshot: 'off', video: 'off' },
});
