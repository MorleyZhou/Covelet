import { tr, getLocale } from "../i18n/index.js";

// Only image addresses travel with navigation. Local asset IDs and browser
// extension URLs are never valid remote addresses on another device.
export function normalizeIconAddress(input) {
  if (typeof input !== 'string' || !input.trim() || input.length > 4096 || /[\s\u0000-\u001f\u007f]/u.test(input)) throw Error(tr("请填写有效的图标地址。"));
  let url;
  try { url = new URL(input); } catch { throw Error(tr("请填写完整的 HTTP 或 HTTPS 图标地址。")); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !url.hostname) throw Error(tr("图标只支持 HTTP 或 HTTPS 地址。"));
  url.hash = '';
  return url.href;
}

// Portable theme variants contain addresses and fit only, never image bytes,
// local asset IDs, media expressions or arbitrary presentation instructions.
export function normalizeIconVariants(input) {
  const fail = () => { throw Error(tr("图标显示方式无效")); };
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 2
    || Object.keys(input).some((key) => !['light', 'dark'].includes(key))) fail();
  return Object.fromEntries(['light', 'dark'].map((scheme) => {
    const variant = input[scheme];
    if (!variant || typeof variant !== 'object' || Array.isArray(variant) || Object.keys(variant).some((key) => !['url', 'fit'].includes(key))
      || !['contain', 'cover'].includes(variant.fit)) fail();
    return [scheme, { url: normalizeIconAddress(variant.url), fit: variant.fit }];
  }));
}

export function withDiscoveredIcon(entry, result) {
  const next = { ...entry, iconUrl: result.url, iconFit: result.fit || guessIconFit(result.url) };
  delete next.iconVariants;
  if (result.variants) next.iconVariants = normalizeIconVariants(result.variants);
  return next;
}

export function faviconAddress(input) {
  try {
    const url = new URL(/^https?:\/\//i.test(input) ? input : `https://${input}`);
    return normalizeIconAddress(`${url.origin}/favicon.ico`);
  } catch { return ''; }
}

export function siteIconAddress(entry) {
  if (entry?.type !== 'site') return '';
  try {
    const address = entry.iconUrl || (entry.icon?.kind === 'url' ? entry.icon.value : '');
    return normalizeIconAddress(!address || address === faviconAddress(entry.url) ? preferredIconAddress(entry.url) : address);
  }
  catch { return faviconAddress(entry.url); }
}

export function preferredIconAddress(input) { return faviconAddress(input); }
export function guessIconFit(address) {
  if (/monochrome/i.test(address)) return 'contain';
  return /apple-touch|maskable|(?:android-chrome|icon)[^/?]*(?:192|512)/i.test(address) ? 'cover' : 'contain';
}
