// Build metadata only. Runtime behavior remains shared under src/.
export const FIREFOX_ID = 'covelet@morleyzhou.github.io';
export const FIREFOX_MIN_VERSION = '140.0';
export function extensionBrowser(args = []) {
  const choices = [];
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--browser') choices.push(args[++index]);
    else if (args[index].startsWith('--browser=')) choices.push(args[index].slice('--browser='.length));
  }
  if (choices.length > 1 || choices.some(value => !['chrome', 'firefox'].includes(value))) throw Error('Choose exactly one supported extension browser: chrome or firefox.');
  return choices[0] || 'chrome';
}
export function extensionDirectory(browser) {
  if (browser === 'chrome') return 'extension';
  if (browser === 'firefox') return 'extension-firefox';
  throw Error('Unsupported extension browser.');
}
export function extensionOutputDirectory(browser, mode = 'production') {
  const directory = extensionDirectory(browser);
  // WXT clears this directory before building. Never let a custom mode become
  // a path segment or resolve onto the other browser's installed extension.
  if (typeof mode !== 'string' || !/^[a-z\d][a-z\d_-]{0,63}$/iu.test(mode)) throw Error('Unsafe extension build mode.');
  return `${directory}${mode === 'production' ? '' : mode === 'development' ? '-dev' : `-${mode}`}`;
}
export function extensionManifest(baseline, browser) {
  extensionDirectory(browser);
  if (baseline?.manifest_version !== 3) throw Error('Covelet requires Manifest V3.');
  const manifest = structuredClone(baseline);
  if (browser === 'firefox') {
    delete manifest.minimum_chrome_version;
    manifest.permissions = manifest.permissions.filter(permission => permission !== 'favicon');
    manifest.background = { scripts: ['background.js'], type: 'module' };
    manifest.browser_specific_settings = { gecko: { id: FIREFOX_ID, strict_min_version: FIREFOX_MIN_VERSION } };
    // This unsigned compatibility package is not an AMO submission. Do not
    // invent a "none" data-transmission declaration for user-enabled networks.
  }
  return manifest;
}
