// Preserve the requested Playwright check as an explicit unsupported result.
// It must never silently substitute a normal website or native automation pass.
import { firefox } from 'playwright';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync, strFromU8 } from 'fflate';

const appRoot = fileURLToPath(new URL('..', import.meta.url)), output = path.resolve(appRoot, '../output/playwright/covelet/firefox');
const executable = firefox.executablePath(), receipt = {
  format: 'covelet-firefox-playwright-core-verification', version: 1, startedAt: new Date().toISOString(),
  method: 'Official bundled Firefox, unchanged by this task; installed Juggler automation support preflight.',
  result: 'blocked', code: 'PLAYWRIGHT_FIREFOX_EXTENSIONS_UNSUPPORTED',
  webdav: { result: 'waived', reason: 'User explicitly deferred all WebDAV testing.' },
  nativeFallback: 'npm run test:firefox:native; separate native Marionette acceptance, not a Playwright pass.',
};
try {
  const archive = unzipSync(await readFile(path.join(path.dirname(executable), 'omni.ja')));
  const entry = 'chrome/juggler/content/content/JugglerFrameChild.jsm', source = archive[entry] && strFromU8(archive[entry]);
  receipt.stockBrowserGuardConfirmed = Boolean(source && /if\s*\(this\.document\.documentURI\.startsWith\(['"]moz-extension:\/\/['"]\)\)\s*return/u.test(source));
  receipt.evidence = { archive: 'Firefox omni.ja', entry,
    source: 'https://github.com/microsoft/playwright/blob/main/browser_patches/firefox/juggler/content/JugglerFrameChild.jsm' };
  receipt.reason = receipt.stockBrowserGuardConfirmed
    ? 'Installed Playwright Firefox explicitly skips initializing its page agent for moz-extension:// documents. Real temporary-addon navigation reproduced a timeout; no core UI case is counted as passed.'
    : 'This harness has no verified stock Playwright Firefox extension-page agent. Re-evaluate native extension support before enabling UI cases.';
} catch (error) { receipt.code = error.code === 'ENOENT' ? 'FIREFOX_TEST_ENVIRONMENT_MISSING' : receipt.code; receipt.reason = 'The stock Firefox automation support preflight could not complete.'; }
finally {
  receipt.finishedAt = new Date().toISOString(); await mkdir(output, { recursive: true });
  await writeFile(path.join(output, 'playwright-core.json'), JSON.stringify(receipt, null, 2));
  console.error(JSON.stringify({ result: receipt.result, code: receipt.code, stockBrowserGuardConfirmed: receipt.stockBrowserGuardConfirmed, webdav: 'waived' }));
  process.exitCode = 1;
}
