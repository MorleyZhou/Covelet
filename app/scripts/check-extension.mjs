#!/usr/bin/env node
import assert from "node:assert/strict";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."));
const extensionRoot = path.join(appRoot, "dist", "extension");
const sourceManifest = path.join(appRoot, "extension.manifest.json");
const builtManifest = path.join(extensionRoot, "manifest.json");
assert(existsSync(builtManifest), "Build dist/extension before running the extension checker.");
for (const directory of [path.join(appRoot, "dist"), extensionRoot]) {
  assert(!lstatSync(directory).isSymbolicLink(), `Output directory must not be a symlink: ${directory}`);
}
const manifest = JSON.parse(readFileSync(builtManifest, "utf8"));
assert.deepEqual(manifest, JSON.parse(readFileSync(sourceManifest, "utf8")), "Built manifest differs from the reviewed extension.manifest.json baseline.");
assert.equal(manifest.manifest_version, 3);
assert.equal(manifest.name, "Covelet");
assert.match(manifest.version, /^\d+\.\d+\.\d+$/, 'Extension version must use the package release version.');
assert.equal(manifest.minimum_chrome_version, "120");
assert.equal(manifest.default_locale, "en");
assert.equal(manifest.description, "__MSG_extensionDescription__");
for (const locale of ['en', 'zh_CN', 'zh_TW', 'ja', 'ko', 'de', 'fr', 'ru']) {
  const messages = JSON.parse(readFileSync(path.join(extensionRoot, '_locales', locale, 'messages.json'), 'utf8'));
  for (const key of ['extensionName', 'extensionDescription', 'actionTitle']) {
    assert.equal(typeof messages[key]?.message, 'string', `Missing ${locale} manifest message ${key}.`);
    assert(messages[key].message.trim(), `Empty ${locale} manifest message ${key}.`);
  }
}
assert.deepEqual(manifest.chrome_url_overrides, { newtab: "newtab.html" });
assert.deepEqual([...manifest.permissions].sort(), ["activeTab", "alarms", "favicon", "scripting", "search", "storage"]);
assert.deepEqual(manifest.optional_permissions, []);
assert.deepEqual(manifest.action, { default_title: '__MSG_actionTitle__', default_popup: 'popup.html' });
assert.deepEqual(manifest.background, { service_worker: 'background.js', type: 'module' });
assert.deepEqual(manifest.host_permissions, ["https://www.bing.com/*"], "Only the fixed Bing wallpaper host may be accessed.");
assert.deepEqual(manifest.optional_host_permissions, ["http://*/*", "https://*/*"], "Site recognition must use optional HTTP(S) host permissions, requested per selected origin.");
const expectedIcons = Object.fromEntries([16, 32, 48, 128].map((size) => [size, `icons/icon-${size}.png`]));
assert.deepEqual(manifest.icons, expectedIcons, "Release icons must use all four reviewed PNG sizes.");
const packageMetadata = JSON.parse(readFileSync(path.join(appRoot, "package.json"), "utf8"));
assert.equal(packageMetadata.name, "covelet", "Package branding must match Covelet.");
assert.equal(packageMetadata.version, manifest.version, "Package and extension versions must agree.");
for (const removed of ['src/components/apps', 'src/lib/app-catalog.js', 'src/lib/tab-snapshot-runtime.js', 'src/components/TabSnapshotsPopup.jsx']) {
  assert(!existsSync(path.join(appRoot, removed)), `Removed tool or tab runtime returned: ${removed}`);
}
const personalToolsSource = readFileSync(path.join(appRoot, 'src/lib/personal-tools.js'), 'utf8');
const backgroundSource = readFileSync(path.join(appRoot, 'entrypoints/background.js'), 'utf8');
assert(!/importBrowserReadingList|chrome\.readingList|captureTabSnapshot|restoreTabSnapshot|tab-snapshot-runtime/.test(personalToolsSource + backgroundSource), 'Removed browser capture/import runtime returned.');
assert(!hasToolDependencies(packageMetadata), 'Tool-only production dependencies returned.');
function hasToolDependencies(metadata) {
  return ['pdf-lib', 'pdfjs-dist', 'prettier', 'sql-formatter', 'react-markdown', 'remark-gfm', 'yaml'].some((name) => Object.hasOwn(metadata.dependencies || {}, name));
}

assert.deepEqual(Object.keys(manifest).sort(), [
  "chrome_url_overrides", "content_security_policy", "default_locale", "description", "icons", "manifest_version",
  "minimum_chrome_version", "name", "permissions", "host_permissions", "optional_host_permissions", "optional_permissions", "action", "background", "version",
].sort(), "Unexpected manifest capability: review host access, settings overrides, background or peripheral integrations.");

const csp = new Map();
assert.deepEqual(Object.keys(manifest.content_security_policy), ["extension_pages"], "Unexpected CSP context.");
for (const directive of manifest.content_security_policy.extension_pages.split(";")) {
  const [name, ...values] = directive.trim().split(/\s+/);
  if (!name) continue;
  assert(!csp.has(name), `Duplicate CSP directive: ${name}`);
  csp.set(name, values.sort());
}
const expectedCsp = {
  "default-src": ["'self'"],
  "script-src": ["'self'", "'wasm-unsafe-eval'"],
  "worker-src": ["'self'"],
  "object-src": ["'none'"],
  // CSP permits these schemes; optional host permissions and the site provider
  // separately constrain user-approved metadata requests to one exact origin.
  "connect-src": ["'self'", "blob:", "http:", "https:"],
  "img-src": ["'self'", "blob:", "data:", "http:", "https:"],
  "style-src": ["'self'", "'unsafe-inline'"],
  "font-src": ["'self'"],
  "base-uri": ["'none'"],
  "frame-src": ["'none'"],
  "media-src": ["'self'", "blob:"],
  "form-action": ["'none'"],
};
assert.equal(csp.size, Object.keys(expectedCsp).length, "Unexpected CSP directive.");
for (const [name, values] of Object.entries(expectedCsp)) {
  assert.deepEqual(csp.get(name), values.sort(), `Unexpected CSP ${name}.`);
}

const files = [];
function collect(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    assert(!entry.isSymbolicLink(), `Symlink in extension output: ${absolute}`);
    if (entry.isDirectory()) collect(absolute);
    else {
      assert(entry.isFile(), `Unsupported extension entry: ${absolute}`);
      files.push(absolute);
    }
  }
}
collect(extensionRoot);
assert(files.some((file) => file === path.join(extensionRoot, manifest.chrome_url_overrides.newtab)), "Missing manifest-referenced new tab page.");
assert(files.some((file) => /\.js$/.test(file)), "No packaged JavaScript found.");
assert(!files.some((file) => /\.map$/i.test(file)), "Source maps must not be included in the release package.");
const wasmFiles = files.filter((file) => /\.wasm$/i.test(file));
assert.equal(wasmFiles.length, 4, "Expected the packaged visual, sync, GitHub and tools WASM cores. The retired clock is not shipped.");
const reviewedWasm = ['visual-core', 'sync-core', 'github-core', 'tools-core'].map(name => ({ name, bytes: readFileSync(path.join(appRoot, 'src', 'wasm', `${name}.wasm`)) }));
for (const core of reviewedWasm) {
  const matches = wasmFiles.filter(file => readFileSync(file).equals(core.bytes));
  assert.equal(matches.length, 1, `Missing or duplicated reviewed ${core.name} module.`);
  assert(core.bytes.length < 128 * 1024, `Unexpectedly large ${core.name} module.`);
  assert(core.bytes.subarray(0, 8).equals(Buffer.from('0061736d01000000', 'hex')), 'Invalid packaged WASM header.');
  assert.equal(WebAssembly.Module.imports(new WebAssembly.Module(core.bytes)).length, 0, 'Packaged WASM must have no host imports.');
}
assert(readFileSync(path.join(extensionRoot, 'SYNC_WASM_LICENSES.txt')).equals(readFileSync(path.join(appRoot, 'wasm', 'sync-core', 'LICENSES.txt'))), 'Missing or stale bundled sync dependency licenses.');
assert(files.some((file) => /visual-worker[^/]*\.js$/i.test(file)), "Missing packaged visual worker.");

function checkLocalResource(value, owner, allowImageData = false) {
  const resource = value.trim();
  if (allowImageData && /^(?:data:|blob:)/i.test(resource)) return;
  if (resource.startsWith("#")) return;
  assert(!/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(resource), `External resource in ${owner}: ${resource}`);
  assert(!/[\\]/.test(resource), `Backslash resource path in ${owner}: ${resource}`);
  const filePart = decodeURIComponent(resource.split(/[?#]/, 1)[0]);
  assert(filePart, `Empty resource path in ${owner}.`);
  // WXT relocates entrypoint HTML to the extension root and emits paths such
  // as /chunks/newtab.js. A single leading slash resolves within this package;
  // protocol-relative URLs and filesystem traversal are still rejected.
  const resolved = filePart.startsWith("/")
    ? path.resolve(extensionRoot, `.${filePart}`)
    : path.resolve(path.dirname(owner), filePart);
  const relative = path.relative(extensionRoot, resolved);
  assert(relative && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative), `Resource escapes extension directory: ${resource}`);
  assert(existsSync(resolved) && lstatSync(resolved).isFile(), `Missing packaged resource in ${owner}: ${resource}`);
}

for (const [size, resource] of Object.entries(expectedIcons)) {
  checkLocalResource(resource, builtManifest);
  const bytes = readFileSync(path.join(extensionRoot, resource));
  assert(bytes.length >= 33 && bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")), `Icon must be a PNG: ${resource}`);
  assert.equal(bytes.readUInt32BE(8), 13, `Invalid PNG IHDR length: ${resource}`);
  assert.equal(bytes.subarray(12, 16).toString("ascii"), "IHDR", `Missing PNG IHDR: ${resource}`);
  assert.equal(bytes.readUInt32BE(16), Number(size), `Icon width must be ${size}px: ${resource}`);
  assert.equal(bytes.readUInt32BE(20), Number(size), `Icon height must be ${size}px: ${resource}`);
}

let htmlCount = 0;
let jsCount = 0;
let cssCount = 0;
for (const file of files) {
  if (!/\.(?:html|[cm]?js|css)$/i.test(file)) continue;
  const source = readFileSync(file, "utf8");
  assert(!/sourceMappingURL\s*=/.test(source), `Source map directive in ${file}`);
  if (/\.html$/i.test(file)) {
    htmlCount++;
    if (file === path.join(extensionRoot, manifest.chrome_url_overrides.newtab)) {
      assert.match(source, /<title>\s*Covelet (?:New Tab|新标签页)\s*<\/title>/u, "New tab title must use Covelet branding.");
    }
    for (const tag of source.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
      assert(/\bsrc\s*=/.test(tag[1]), `Inline script in ${file}`);
      assert(!tag[2].trim(), `Inline script body in ${file}`);
    }
    assert(!/\bon\w+\s*=/i.test(source), `Inline event handler in ${file}`);
    assert(!/<(?:iframe|object|embed)\b/i.test(source), `Embedded external surface in ${file}`);
    for (const attribute of source.matchAll(/\b(?:src|href)\s*=\s*(["'])(.*?)\1/gi)) {
      checkLocalResource(attribute[2], file);
    }
  } else if (/\.[cm]?js$/i.test(file)) {
    jsCount++;
    assert(!/\b(?:eval\s*\(|new\s+Function\s*\(|importScripts\s*\()/i.test(source), `Dynamic code execution pattern in ${file}`);
    assert(!/\b(?:XMLHttpRequest|WebSocket|EventSource)\b/.test(source), `Unexpected network API pattern in ${file}`);
    // Vite keeps this member access readable. All shipped fetch bridges are
    // checked against their source below; this is a static gate, not a sandbox.
    const fetchCalls = [...source.matchAll(/(?:(?<![\w$.])fetch\s*\(|\bglobalThis\s*\.\s*fetch\s*\()/g)];
    assert(fetchCalls.length <= 14 && fetchCalls.every((match) => /^globalThis\s*\.\s*fetch/.test(match[0])), `Unexpected fetch bridge in ${file}`);
    assert(!/(?:\bimport\s*\(\s*|\bfrom\s*)(["'])(?:https?:)?\/\//i.test(source), `Remote JavaScript import in ${file}`);
    assert(!/(?:\.\s*src\s*=|\bsrc\s*:)\s*(["'])(?:https?:)?\/\//i.test(source), `External source resource in ${file}`);
  } else {
    cssCount++;
    assert(!/@import\s+(?:url\(\s*)?["']?(?:https?:)?\/\//i.test(source), `Remote CSS import in ${file}`);
    for (const resource of source.matchAll(/url\(\s*(?:(["'])(.*?)\1|([^\s)]+))\s*\)/gi)) {
      checkLocalResource(resource[2] ?? resource[3], file, true);
    }
  }
}

// Inspect the readable execution bridge, rather than relying on Vite's minified
// variable names. Custom provider templates belong in configuration, not here.
const searchBridge = path.join(appRoot, "src", "lib", "search.js");
assert(existsSync(searchBridge), "Missing readable search execution bridge: src/lib/search.js");
const searchSource = readFileSync(searchBridge, "utf8");
assert(/\bchrome\s*(?:\?\.|\.)\s*search\s*(?:\?\.|\.)\s*query\s*\(/.test(searchSource), "Search bridge must explicitly call chrome.search.query.");
assert(!/https?:\/\//i.test(searchSource), "Search execution bridge must not contain a hard-coded engine URL or default URL fallback.");
assert(!/chrome_settings_overrides|search_provider/.test(searchSource), "Search bridge must not alter browser search settings.");

const wallpaperBridge = path.join(appRoot, "src", "lib", "wallpaper.js");
assert(existsSync(wallpaperBridge), "Missing Bing wallpaper provider.");
const wallpaperSource = readFileSync(wallpaperBridge, "utf8");
assert(wallpaperSource.includes("https://www.bing.com/HPImageArchive.aspx?format=js&idx=0&n=1&mkt=zh-CN"), "Daily wallpaper metadata endpoint must remain fixed.");
assert.match(wallpaperSource, /credentials:\s*'omit'/, "Wallpaper requests must omit cookies.");
assert.match(wallpaperSource, /referrerPolicy:\s*'no-referrer'/, "Wallpaper requests must omit referrers.");
assert.match(wallpaperSource, /redirect:\s*'error'/, "Wallpaper requests must reject redirects.");
assert.match(wallpaperSource, /url\.origin\s*!==\s*BING_ORIGIN/, "Wallpaper URL validation must constrain the origin.");
const siteInfoBridge = path.join(appRoot, "src", "lib", "site-info.js");
assert(existsSync(siteInfoBridge), "Missing optional site metadata provider.");
const siteInfoSource = readFileSync(siteInfoBridge, "utf8");
assert.match(siteInfoSource, /api\.permissions\.request\(\{ origins: \[hostPattern\(input\)\] \}\)/, "Site recognition must request only its selected origin.");
assert.match(siteInfoSource, /if \(!await canReadSite\(input, \{ api \}\)\)/, "Site metadata must check host access before network activity.");
assert.match(siteInfoSource, /credentials:\s*'omit'/, "Site metadata requests must omit cookies.");
assert.match(siteInfoSource, /referrerPolicy:\s*'no-referrer'/, "Site metadata requests must omit referrers.");
assert.match(siteInfoSource, /redirect:\s*'error'/, "Site metadata requests must reject redirects.");
assert.match(siteInfoSource, /url\.origin\s*!==\s*origin/, "Site icon validation must constrain the origin.");
assert(!/DOMParser|innerHTML|createElement\(['"](?:script|iframe)['"]\)/.test(siteInfoSource.replace(/\/\/[^\n]*/g, "")), "Remote metadata must remain text-parsed without active document insertion.");
let sourceFetchCalls = 0;
const visualImageBridge = path.join(appRoot, 'src', 'lib', 'visual-processing.js');
const visualWasmBridge = path.join(appRoot, 'src', 'lib', 'visual-worker.js');
const visualImageSource = readFileSync(visualImageBridge, 'utf8');
const visualWasmSource = readFileSync(visualWasmBridge, 'utf8');
assert.match(visualImageSource, /validateLocalVisualUrl\(url/, 'Local visual image reads must validate their input URL.');
assert.match(visualImageSource, /credentials:\s*'omit'/, 'Local visual image reads must omit cookies.');
assert.match(visualImageSource, /referrerPolicy:\s*'no-referrer'/, 'Local visual image reads must omit referrers.');
assert.match(visualImageSource, /redirect:\s*'error'/, 'Local visual image reads must reject redirects.');
assert.match(visualImageSource, /new Worker\(new URL\('\.\/visual-worker\.js', import\.meta\.url\)/, 'Visual worker must be bundled.');
assert.match(visualWasmSource, /new URL\('\.\.\/wasm\/visual-core\.wasm', import\.meta\.url\)/, 'WASM must load only from its fixed bundled resource.');
assert(!/https?:\/\//.test(visualWasmSource), 'WASM loader must not include remote origins.');
const cloudBridge = path.join(appRoot, 'src', 'lib', 'cloud-providers.js');
const webdavBridge = path.join(appRoot, 'src', 'lib', 'cloud-webdav.js');
const syncWasmBridge = path.join(appRoot, 'src', 'lib', 'sync-wasm.js');
const faviconBridge = path.join(appRoot, 'src', 'lib', 'browser-favicon.js');
const cloudSource = readFileSync(cloudBridge, 'utf8');
const webdavSource = readFileSync(webdavBridge, 'utf8');
const syncWasmSource = readFileSync(syncWasmBridge, 'utf8');
const faviconSource = readFileSync(faviconBridge, 'utf8');
const githubBridge = path.join(appRoot, 'src', 'lib', 'github-contributions.js');
const githubWasmBridge = path.join(appRoot, 'src', 'lib', 'github-wasm.js');
const githubSource = readFileSync(githubBridge, 'utf8');
const githubWasmSource = readFileSync(githubWasmBridge, 'utf8');
const clockWasmBridge = path.join(appRoot, 'src', 'lib', 'clock-core.js');
const hdIconBridge = path.join(appRoot, 'src', 'lib', 'site-icon-discovery.js');
const navigationIconBridge = path.join(appRoot, 'src', 'lib', 'navigation-icon-cache.js');
const toolsWasmBridge = path.join(appRoot, 'src', 'lib', 'tools-core.js');
const navigationIconSource = readFileSync(navigationIconBridge, 'utf8'), toolsWasmSource = readFileSync(toolsWasmBridge, 'utf8');
assert.match(toolsWasmSource, /import binaryUrl from '\.\.\/wasm\/tools-core\.wasm\?url'/, 'Tools WASM must use only the packaged binary.');
assert(!/https?:\/\//.test(toolsWasmSource), 'Tools WASM loader must not accept remote origins.');
for (const [name, source] of [['navigation image', navigationIconSource], ['tools WASM', toolsWasmSource]]) {
  assert.match(source, /credentials:\s*'omit'/, `${name} reads must omit cookies.`);
  assert.match(source, /referrerPolicy:\s*'no-referrer'/, `${name} reads must omit referrers.`);
  if (name === 'navigation image') {
    assert.match(source, /redirect:\s*'follow'/, 'Explicit image acquisition must support ordinary redirects.');
    assert.match(source, /normalizeIconAddress\(response\.url\)/, 'The final image address must still be validated.');
  } else assert.match(source, /redirect:\s*'error'/, `${name} reads must reject redirects.`);
}
assert.match(navigationIconSource, /normalizeIconAddress\(/, 'Navigation cache inputs must validate HTTP(S) image addresses.');
assert.match(navigationIconSource, /if \(!force\) return readCachedNavigationIcon\(url\)/, 'Normal icon lookups must be strictly cache-only.');
const bundledIconSource = readFileSync(path.join(appRoot, 'src', 'lib', 'bundled-navigation-icons.js'), 'utf8');
assert.match(bundledIconSource, /url\.protocol === 'chrome-extension:'/u, 'Default icon seeds must use the extension scheme.');
assert.match(bundledIconSource, /url\.host === api\.runtime\.id/u, 'Default icon seeds must belong to the current extension.');
assert.match(bundledIconSource, /assets\/default-sites\//u, 'Default icon seeds must use their fixed packaged directory.');
for (const file of ['google.png', 'youtube.png', 'github.png', 'x.png', 'chatgpt.webp', 'grok.png']) {
  const relative = path.join('assets', 'default-sites', file);
  assert.deepEqual(readFileSync(path.join(extensionRoot, relative)), readFileSync(path.join(appRoot, 'public', relative)), `Missing or changed packaged default icon: ${file}`);
}
const iconHookSource = readFileSync(path.join(appRoot, 'src', 'lib', 'use-navigation-icon.js'), 'utf8');
assert(!/\bnavigationIcon\s*\(/u.test(iconHookSource), 'Rendering an icon must not call the remote acquisition API.');
const artworkSource = readFileSync(path.join(appRoot, 'src', 'components', 'IconArtwork.jsx'), 'utf8');
assert.match(artworkSource, /if \(!src\.startsWith\('blob:'\)\)/u, 'Navigation artwork must reject direct remote image sources.');
assert(!/permissions\s*\.\s*request/.test(navigationIconSource), 'Display cache must not request new site permissions.');
assert(githubSource.includes("'https://github.com'"), 'GitHub calendar requests must use their fixed origin.');
assert.match(githubSource, /if \(!await canRead\(\)\)/, 'GitHub calendar requests must check exact-origin access.');
assert(!/DOMParser|innerHTML|createElement\(/.test(githubSource), 'GitHub calendar HTML must remain inert text.');
assert.match(githubWasmSource, /new URL\('\.\.\/wasm\/github-core\.wasm', import\.meta\.url\)/, 'GitHub WASM must load only its packaged core.');
assert(!/https?:\/\//.test(githubWasmSource), 'GitHub WASM must not accept a remote origin.');
for (const source of [githubSource, githubWasmSource]) {
  assert.match(source, /credentials:\s*'omit'/, 'GitHub bridges must omit cookies.');
  assert.match(source, /referrerPolicy:\s*'no-referrer'/, 'GitHub bridges must omit referrers.');
  assert.match(source, /redirect:\s*'error'/, 'GitHub bridges must reject redirects.');
}
for (const [name, source] of [['cloud', cloudSource], ['WebDAV', webdavSource], ['sync WASM', syncWasmSource]]) {
  assert.match(source, /credentials:\s*'omit'/, `${name} requests must omit cookies.`);
  assert.match(source, /referrerPolicy:\s*'no-referrer'/, `${name} requests must omit referrers.`);
  assert.match(source, /redirect:\s*'error'/, `${name} requests must reject redirects.`);
}
assert.match(cloudSource, /url\.origin\s*!==\s*origin/, 'Cloud requests must enforce the selected exact origin.');
assert.match(syncWasmSource, /new URL\('\.\.\/wasm\/sync-core\.wasm', import\.meta\.url\)/, 'Sync WASM must load only its fixed bundled module.');
assert(!/https?:\/\//.test(syncWasmSource), 'Sync WASM loader must not include remote origins.');
assert(!/permissions\s*\.\s*request/.test(faviconSource), 'Browser favicon reads must not request site access.');
assert(faviconSource.includes('/_favicon/'), 'Browser favicon bridge must use the native resource.');
assert.match(faviconSource, /url\.protocol\s*!==\s*'chrome-extension:'/u, 'Favicon resources must use the native extension scheme.');
assert.match(faviconSource, /url\.hostname\s*!==\s*id/u, 'Favicon resources must belong to this exact extension.');
assert.match(faviconSource, /url\.pathname\s*!==\s*'\/_favicon\/'/u, 'Favicon resources must use only the fixed native path.');
function checkSourceNetworking(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) checkSourceNetworking(absolute);
    else if (/\.[cm]?jsx?$/.test(entry.name) && !/\.test\./.test(entry.name)) {
      const source = readFileSync(absolute, "utf8");
      assert(!/\b(?:XMLHttpRequest|WebSocket|EventSource)\b/.test(source), `Unexpected source network API in ${absolute}`);
      const calls = [...source.matchAll(/(?:(?<![\w$.])fetch\s*\(|\bglobalThis\s*\.\s*fetch\s*\()/g)];
      if (calls.length) {
        assert([wallpaperBridge, siteInfoBridge, visualImageBridge, visualWasmBridge, cloudBridge, webdavBridge, syncWasmBridge, faviconBridge, githubBridge, githubWasmBridge, clockWasmBridge, hdIconBridge, navigationIconBridge, toolsWasmBridge].includes(absolute), `Fetch must remain in reviewed network or fixed local-resource bridges: ${absolute}`);
        assert(calls.every((match) => /^globalThis\s*\.\s*fetch/.test(match[0])), "Only the reviewed globalThis.fetch bridge is allowed.");
        sourceFetchCalls += calls.length;
      }
    }
  }
}
checkSourceNetworking(path.join(appRoot, "src"));
assert.equal(sourceFetchCalls, 15, 'Expected fifteen reviewed fetch call sites after removing the tool-pack provider bridge.');

console.log(`Extension static checks passed: ${files.length} files, ${htmlCount} HTML, ${jsCount} JS, ${cssCount} CSS.`);
console.log("Checked Covelet branding/version, four PNG icon sizes, manifest scope, fixed Bing host, optional per-site access/CSP, packaged resources, common remote-code/network patterns and source search/wallpaper/site metadata bridges.");
console.log("Static checks do not prove runtime behavior, arbitrary dynamic URL safety, full data recovery, accessibility, performance, or Web Store approval.");
