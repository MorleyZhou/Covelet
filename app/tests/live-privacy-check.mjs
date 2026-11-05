import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

// Exercise a real failed locator assertion: Playwright can attach a form ARIA
// snapshot through matcherResult, separately from its fallback page snapshot.
// The child receives fake values only and cannot load the local live config.
const app = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(app, '../output/playwright/covelet');
await mkdir(output, { recursive: true });
const directory = await mkdtemp(join(output, 'privacy-guard-'));
const asModule = path => JSON.stringify(pathToFileURL(path).href);
const config = `import base from ${asModule(join(app, 'tests/playwright-live.config.mjs'))};
export default {...base, testDir: '.', testMatch: 'privacy.spec.mjs', outputDir: 'results',
  timeout: 15000, expect: {timeout: 200}, reporter: [['list']]};
`;
const html = '<form><label>Credential<input></label><label>Password<input type="password"></label><p>Not the expected text</p></form>';
const source = `import {test, expect, chromium} from ${asModule(join(app, 'node_modules/@playwright/test/index.mjs'))};
import {fillSecret, safeLiveError} from ${asModule(join(app, 'tests/live/live-session.mjs'))};
test('synthetic failure must not retain credential fields', async () => {
  const browser = await chromium.launch({headless: true});
  try {
    const page = await browser.newPage();
    await page.setContent(${JSON.stringify(html)});
    await fillSecret(page, 'Credential', process.env.COVELET_SYNTHETIC_SECRET);
    await fillSecret(page, 'Password', process.env.COVELET_SYNTHETIC_SECRET);
    try { await expect(page.locator('form')).toContainText('expected success marker'); }
    catch (error) { throw safeLiveError(error); }
  } finally { await browser.close(); }
});
`;
await writeFile(join(directory, 'config.mjs'), config);
await writeFile(join(directory, 'privacy.spec.mjs'), source);
const sentinel = `QA-ONLY-${randomUUID()}`;
let log = '', status = 0;
try {
  log = execFileSync(process.execPath, [join(app, 'node_modules/playwright/cli.js'), 'test', '--config', join(directory, 'config.mjs')], {
    cwd: app, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, COVELET_QA_CONFIG: '', COVELET_SYNTHETIC_SECRET: sentinel },
  });
} catch (error) {
  status = error.status;
  log = `${error.stdout || ''}\n${error.stderr || ''}`;
}
await writeFile(join(directory, 'run.log'), log);
if (status !== 1 || !log.includes('toContainText') || !log.includes('1 failed')) throw Error('Privacy check did not reach its intentional assertion failure.');
async function check(path) {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const target = join(path, entry.name);
    if (entry.isDirectory()) await check(target);
    else if ((await readFile(target, 'utf8')).includes(sentinel)) throw Error('Live failure diagnostics retained a synthetic credential.');
  }
}
await check(directory);
console.log('Live privacy check passed: failed text assertion recorded no credential sentinel.');
