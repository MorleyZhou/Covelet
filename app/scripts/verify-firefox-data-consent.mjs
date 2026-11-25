// Native Firefox smoke; never submits AMO, uses cloud credentials, or requests DAV.
// The isolated profile grants just one loopback origin and two declared data
// types through Firefox's permission store. Native consent-doorhanger acceptance
// is deliberately a separate boundary from this observable permission check.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { launchFirefoxMarionette, removeFirefoxProfile } from './lib/firefox-marionette-harness.mjs';

const appRoot = fileURLToPath(new URL('..', import.meta.url));
const output = path.resolve(appRoot, '../output/playwright/covelet/firefox/data-consent');
const expectedTypes = ['searchTerms', 'browsingActivity', 'websiteContent', 'authenticationInfo', 'personallyIdentifyingInfo', 'technicalAndInteraction'];
const readingTypes = ['browsingActivity', 'websiteContent'];
const receipt = { format: 'covelet-firefox-data-consent-verification', version: 1, startedAt: new Date().toISOString(),
  method: 'Unmodified official bundled Firefox through native Marionette, actual moz-extension page and production PrivacyCheckup UI.',
  instrumentation: 'An isolated extension copy adds only a test inspector. The manifest and product code are unchanged. Native ExtensionPermissions.add grants the loopback origin and declared reading data types; actual browser.permissions.remove revokes the types. Production storage, article extraction, fetch and permission checks run unchanged.',
  limitations: ['Permission-store grant is test instrumentation, not acceptance of Firefox native installation or permission doorhangers.',
    'Native automation is separate from human manual acceptance and Playwright. No AMO, authenticated cloud or WebDAV test is run.'],
  stages: [], checks: {} };
let device, artifact, server, origin, stage = 'prepare';
const requests = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const at = value => { stage = value; receipt.stages.push(value); console.log(JSON.stringify({ stage: value })); };
async function until(page, predicate, arg, label, timeout = 15000) {
  const deadline = Date.now() + timeout;
  do { if (await page.evaluate(predicate, arg)) return; await delay(100); } while (Date.now() < deadline);
  throw Object.assign(Error(`Firefox consent check timed out: ${label}`), { code: 'CONSENT_UI_TIMEOUT' });
}
async function call(method, args = []) {
  const result = await device.command('WebDriver:ExecuteAsyncScript', { script: `const input=arguments[0],done=arguments[arguments.length-1];const receive=event=>{const result=JSON.parse(event.detail);if(result.id!==input.id)return;document.removeEventListener('covelet:consent-result',receive);done(result)};document.addEventListener('covelet:consent-result',receive);document.dispatchEvent(new CustomEvent('covelet:consent-request',{detail:JSON.stringify(input)}));`, args: [{ id: randomUUID(), method, args }], newSandbox: false }, 45000);
  if (!result.ok) throw Object.assign(Error(result.code), { code: result.code, diagnostic: result.diagnostic });
  return result.value;
}
async function nativeGrant({ origins = [], data_collection = [] }) {
  await device.command('Marionette:SetContext', { value: 'chrome' });
  try {
    return await device.command('WebDriver:ExecuteScript', { script: `return (async()=>{const {ExtensionPermissions}=ChromeUtils.importESModule('resource://gre/modules/ExtensionPermissions.sys.mjs');const policy=WebExtensionPolicy.getByID(arguments[0]);await ExtensionPermissions.add(arguments[0],arguments[1],policy.extension);return true})()`, args: [device.addonId, { permissions: [], origins, data_collection }] });
  } finally { await device.command('Marionette:SetContext', { value: 'content' }); }
}
async function prepare() {
  await mkdir(output, { recursive: true });
  artifact = await mkdtemp(path.join(output, 'firefox-consent-extension-'));
  await cp(path.join(appRoot, 'dist/extension-firefox'), artifact, { recursive: true });
  // The source inspector's import.meta.url resolves this fixed local kernel;
  // production's already bundled resources remain unchanged.
  await mkdir(path.join(artifact, 'wasm'), { recursive: true });
  await cp(path.join(appRoot, 'src/wasm/sync-core.wasm'), path.join(artifact, 'wasm/sync-core.wasm'));
  const manifest = JSON.parse(await readFile(path.join(artifact, 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest.browser_specific_settings.gecko.data_collection_permissions.required, ['none']);
  assert.deepEqual([...manifest.browser_specific_settings.gecko.data_collection_permissions.optional].sort(), [...expectedTypes].sort());
  receipt.manifest = { version: manifest.version, geckoId: manifest.browser_specific_settings.gecko.id, dataCollection: manifest.browser_specific_settings.gecko.data_collection_permissions };
  const source = `import {getFirefoxDataConsent} from ${JSON.stringify(path.join(appRoot, 'src/lib/firefox-data-consent.js'))};
    import {extractReadingArticle} from ${JSON.stringify(path.join(appRoot, 'src/lib/reading-extraction.js'))};
    import {localData} from ${JSON.stringify(path.join(appRoot, 'src/lib/local-data.js'))};
    import {saveNote,loadPersonalToolsSnapshot} from ${JSON.stringify(path.join(appRoot, 'src/lib/personal-tools.js'))};
    const methods={
      language:()=>localData.set({'covelet.language.v1':'zh-CN'}),
      consent:()=>getFirefoxDataConsent(),
      async read(url){const article=await extractReadingArticle({url,title:'Firefox consent local article'});return {title:article.title,containsSentinel:article.text.includes('firefoxconsentsentinel')}} ,
      async local(){const title='Firefox consent local note',body='Local notes stay usable without any data collection grant.';const note=await saveNote({title,body,pinned:false});const loaded=await loadPersonalToolsSnapshot();return {persisted:loaded.notes.some(item=>item.id===note.id&&item.title===title&&item.body===body)}}
    };
    document.addEventListener('covelet:consent-request',async event=>{const {id,method,args}=JSON.parse(event.detail);let result;try{if(!Object.hasOwn(methods,method))throw Error();result={id,ok:true,value:await methods[method](...args)}}catch(error){const message=String(error.message||'');result={id,ok:false,code:error.code||'CONSENT_OPERATION_FAILED',diagnostic:{name:['TypeError','ReferenceError','SyntaxError','NetworkError','SecurityError'].includes(error.name)?error.name:'Error',network:/NetworkError|fetch|network/i.test(message),parser:/DOMParser|createDocument|querySelector/.test(message)}}}document.dispatchEvent(new CustomEvent('covelet:consent-result',{detail:JSON.stringify(result)}))});
    document.documentElement.dataset.consentInspector='ready';`;
  await build({ stdin: { contents: source, resolveDir: appRoot }, outfile: path.join(artifact, 'consent-inspector.js'), bundle: true,
    format: 'esm', platform: 'browser', target: 'firefox140', define: { 'import.meta.env': '{}' }, logLevel: 'silent',
    plugins: [{ name: 'consent-local-wasm', setup(plugin) {
      plugin.onResolve({ filter: /\.wasm\?url$/ }, args => ({ path: path.resolve(args.resolveDir, args.path.split('?')[0]), namespace: 'consent-wasm' }));
      plugin.onLoad({ filter: /.*/, namespace: 'consent-wasm' }, async args => { const name = `consent-${path.basename(args.path)}`; await cp(args.path, path.join(artifact, name)); return { contents: `export default browser.runtime.getURL(${JSON.stringify(name)})`, loader: 'js' }; });
    } }] });
}
async function loadInspector(page) {
  await page.evaluate(async () => { await new Promise((resolve, reject) => { const script = document.createElement('script'); script.type = 'module'; script.src = browser.runtime.getURL('consent-inspector.js'); script.onload = () => resolve(); script.onerror = () => reject(Error('Inspector failed')); document.head.append(script); }); });
  await until(page, () => document.documentElement.dataset.consentInspector === 'ready', null, 'inspector');
}
async function inspectEncrypted(page) {
  return page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => { const request = indexedDB.open('covelet.encrypted.local.v1'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    try {
      const tx = db.transaction(['records', 'keys'], 'readonly'), read = request => new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
      const [records, key] = await Promise.all([read(tx.objectStore('records').getAll()), read(tx.objectStore('keys').get('device-key-v1'))]);
      return { records: records.length, ciphertextOnly: records.every(record => Object.keys(record).sort().join(',') === 'ciphertext,id,iv,space,version'), extractable: key.extractable, algorithm: key.algorithm.name };
    } finally { db.close(); }
  });
}
try {
  await prepare();
  server = createServer((request, response) => {
    requests.push({ method: request.method, article: request.url === '/article', hasCookie: !!request.headers.cookie, hasAuthorization: !!request.headers.authorization, hasReferrer: !!request.headers.referer });
    if (request.method !== 'GET' || request.url !== '/article') { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><title>Firefox consent local article</title><article><h1>Native consent</h1><p>This loopback article has enough local readable text for actual article extraction and includes firefoxconsentsentinel. Permission revocation must block the next request before it leaves the extension.</p></article>');
  });
  // Firefox match patterns cannot express a port. Use the default HTTP port
  // for this consent test; if occupied, fail instead of touching that service.
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(80, '127.0.0.1', resolve); }); origin = 'http://127.0.0.1';
  at('launch-native-firefox');
  device = await launchFirefoxMarionette({ extensionRoot: artifact, output, headless: process.env.COVELET_FIREFOX_HEADED !== '1' });
  assert.equal(device.acceptInsecureCerts, false); receipt.browserVersion = device.browserVersion;
  const page = await device.newtab(); await page.waitFor('.owntab'); await loadInspector(page);
  await call('language'); await page.goto(await page.url()); await page.waitFor('.owntab'); await loadInspector(page);
  await until(page, () => document.documentElement.lang === 'zh-CN', null, 'Chinese UI');
  const initial = await page.evaluate(() => browser.permissions.getAll());
  assert(Array.isArray(initial.data_collection)); assert(!initial.data_collection.some(value => expectedTypes.includes(value)));
  receipt.initialDataCollection = initial.data_collection;
  assert.deepEqual(await call('consent'), { firefox: true, supported: true, granted: [], missing: expectedTypes });
  receipt.checks.nativeDataCollectionApiAvailable = true;
  at('local-works-and-http-denied-before-consent');
  // Firefox host match patterns omit ports; the fixture itself remains bound
  // to loopback and never exposes a non-loopback listener.
  await nativeGrant({ origins: ['http://127.0.0.1/*'] });
  assert.equal(await page.evaluate(origin => browser.permissions.contains({ origins: [`${origin}/*`] }), origin), true);
  assert.equal((await call('local')).persisted, true);
  let denied; try { await call('read', [`${origin}/article`]); } catch (error) { denied = error.code; }
  assert.equal(denied, 'FIREFOX_DATA_CONSENT_REQUIRED'); assert.equal(requests.length, 0);
  receipt.checks.localNotesWorkWithoutConsent = true; receipt.checks.unauthorizedHttpRequests = 0;
  at('production-privacy-ui');
  await page.waitFor('.firefox-data-notice button'); await page.click('.firefox-data-notice button');
  await page.waitFor('.privacy-checkup .firefox-data-consent');
  await until(page, () => document.querySelectorAll('.firefox-data-group').length === 5 && !document.querySelector('.firefox-data-group[data-purpose="reading"] button')?.disabled, null, 'ungranted reading button');
  receipt.checks.productionPrivacyCheckupAndFivePurposeControls = true;
  at('grant-declared-reading-types-in-native-test-profile');
  await nativeGrant({ data_collection: readingTypes });
  await until(page, () => document.querySelector('.firefox-data-group[data-purpose="reading"] button')?.disabled && document.querySelector('.firefox-data-group[data-purpose="reading"] button')?.textContent.includes('已允许'), null, 'UI observed native grant');
  const granted = await page.evaluate(() => browser.permissions.getAll());
  assert.deepEqual(granted.data_collection.filter(value => expectedTypes.includes(value)).sort(), [...readingTypes].sort());
  receipt.grantedDataCollection = granted.data_collection;
  receipt.testOriginPermission = await page.evaluate(origin => browser.permissions.contains({ origins: [`${origin}/*`] }), origin);
  at('authorized-production-article-read');
  assert.equal((await call('read', [`${origin}/article`])).containsSentinel, true); assert.equal(requests.length, 1);
  assert.deepEqual(requests[0], { method: 'GET', article: true, hasCookie: false, hasAuthorization: false, hasReferrer: false });
  receipt.checks.authorizedProductionArticleRead = true; receipt.checks.onlyReadingTypesGranted = true;
  at('revoke-actual-browser-permission-and-deny-next-request');
  assert.equal(await page.evaluate(types => browser.permissions.remove({ data_collection: types }), readingTypes), true);
  await until(page, () => { const button = document.querySelector('.firefox-data-group[data-purpose="reading"] button'); return Boolean(button) && !button.disabled && !button.textContent.includes('已允许'); }, null, 'UI observed revoke');
  const after = await call('consent'); assert.equal(after.granted.length, 0);
  denied = null; try { await call('read', [`${origin}/article`]); } catch (error) { denied = error.code; }
  assert.equal(denied, 'FIREFOX_DATA_CONSENT_REQUIRED'); assert.equal(requests.length, 1);
  assert.equal((await call('local')).persisted, true);
  receipt.encryptedIndexedDB = await inspectEncrypted(page);
  assert.equal(receipt.encryptedIndexedDB.ciphertextOnly, true); assert.equal(receipt.encryptedIndexedDB.extractable, false); assert.equal(receipt.encryptedIndexedDB.algorithm, 'AES-GCM');
  receipt.checks.revocationBlocksNextHttpRequest = true; receipt.checks.localEncryptedPersistenceAfterRevocation = true;
  await page.screenshot(path.join(output, 'privacy-consent.png'));
  receipt.http = { totalRequests: requests.length, originOnlyTestPermission: true, omittedCookiesCredentialsAndReferrer: true };
  receipt.result = 'passed'; at('passed');
} catch (error) {
  receipt.result = 'failed'; receipt.failureStage = stage;
  receipt.failureCode = error instanceof assert.AssertionError ? 'ASSERTION_FAILED' : typeof error.code === 'string' ? error.code : 'FIREFOX_CONSENT_SMOKE_FAILED';
  if (error.diagnostic) receipt.diagnostic = error.diagnostic;
  if (error instanceof assert.AssertionError) receipt.assertion = String(error.message).slice(0, 1800);
  console.error(JSON.stringify({ stage, code: receipt.failureCode })); process.exitCode = 1;
} finally {
  receipt.observedLoopbackRequests = requests.length;
  if (device) { try { await device.close(); await removeFirefoxProfile(device.profile, output); } catch { (receipt.cleanup ||= []).push('PROFILE_CLEANUP_FAILED'); } }
  if (server?.listening) await new Promise(resolve => server.close(resolve));
  if (artifact) {
    try { const actual = await realpath(artifact), relative = path.relative(await realpath(output), actual); if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !path.basename(actual).startsWith('firefox-consent-extension-')) throw Error('Unsafe test cleanup'); await rm(actual, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
    catch { (receipt.cleanup ||= []).push('TEST_COPY_CLEANUP_FAILED'); }
  }
  receipt.finishedAt = new Date().toISOString(); await mkdir(output, { recursive: true }); await writeFile(path.join(output, 'native-consent.json'), `${JSON.stringify(receipt, null, 2)}\n`);
}
