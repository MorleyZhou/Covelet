// Explicit maintainer asset preparation, never run by a build or extension.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const root = new URL('../public/assets/default-sites/', import.meta.url);
await mkdir(root, { recursive: true });
const sources = [
  ['google', 'png', 'https://www.google.com/images/branding/googleg/2x/googleg_standard_color_128dp.png'],
  ['youtube', 'png', 'https://www.youtube.com/s/desktop/2fe123f7/img/favicon_144x144.png'],
  ['github', 'png', 'https://github.githubassets.com/images/modules/logos_page/GitHub-Mark.png'],
  ['x', 'png', 'https://abs.twimg.com/responsive-web/client-web/icon-default-large.9ab12c3ecc9e8133a.png'],
  ['chatgpt', 'webp', 'https://cdn.oaistatic.com/assets/apple-touch-icon-mz9nytnj.webp'],
  ['grok', 'png', 'https://grok.com/images/android-chrome-monochrome-512x512.png'],
];
await Promise.all(sources.map(async ([name, extension, source]) => {
  let bytes;
  if (['google', 'youtube', 'grok'].includes(name)) {
    try { bytes = new Uint8Array(await readFile(new URL(`../../output/playwright/site-icons/${name}.png`, import.meta.url))); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  if (!bytes) {
    const response = await fetch(source, { credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(20000) });
    if (!response.ok || !response.headers.get('content-type')?.startsWith('image/')) throw Error(`${name}: ${response.status}`);
    bytes = new Uint8Array(await response.arrayBuffer());
  }
  if (!bytes.length || bytes.length > 1024 * 1024) throw Error(`Invalid ${name} size`);
  await writeFile(new URL(`${name}.${extension}`, root), bytes);
  console.log(`${name}: ${bytes.length} bytes, sha256 ${createHash('sha256').update(bytes).digest('hex')}`);
}));
