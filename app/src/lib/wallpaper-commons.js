// Commons Action API documentation:
// https://www.mediawiki.org/wiki/API:Search
// https://www.mediawiki.org/wiki/API:Imageinfo
// https://commons.wikimedia.org/wiki/Commons:Machine-readable_data
// Metadata is an untrusted catalog, never HTML to render or a permission grant.
export const COMMONS_API_ORIGIN = 'https://commons.wikimedia.org';
const IMAGE_ORIGIN = 'https://upload.wikimedia.org';
const LIMIT = 40, MAX_OFFSET = 10000, MAX_IMAGE = 10 * 1024 * 1024;
const SEARCH = 'intitle:landscape filemime:image/jpeg incategory:CC-Zero -painting -map -museum -MET -drawing -print -sketch -art filew:>1279 fileh:>719';
const TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const invalid = () => { throw new TypeError('Invalid Wikimedia Commons wallpaper metadata.'); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const boundedText = (value, limit) => {
  if (typeof value !== 'string' || !value.trim() || value.length > limit || /[<>\u0000-\u001f\u007f]/.test(value)) invalid();
  return value.trim();
};

export function commonsCatalogUrl(offset = 0) {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > MAX_OFFSET) invalid();
  const params = new URLSearchParams({
    action: 'query', format: 'json', formatversion: '2', origin: '*',
    generator: 'search', gsrsearch: SEARCH, gsrnamespace: '6', gsrlimit: String(LIMIT), gsroffset: String(offset),
    prop: 'imageinfo', iiprop: 'url|size|mime|extmetadata',
    iiextmetadatafilter: 'Artist|LicenseShortName|LicenseUrl|Copyrighted|AttributionRequired',
  });
  return `${COMMONS_API_ORIGIN}/w/api.php?${params}`;
}

function checkedUrl(value, origin) {
  if (typeof value !== 'string' || value.length > 2048 || /[\\\u0000-\u0020\u007f]/.test(value)) invalid();
  let url; try { url = new URL(value); } catch { invalid(); }
  if (url.origin !== origin || url.username || url.password || url.hash) invalid();
  return url;
}

function imageUrl(value) {
  const url = checkedUrl(value, IMAGE_ORIGIN);
  const match = /^\/wikipedia\/commons\/([a-f0-9])\/([a-f0-9]{2})\/([^/]+\.(?:jpe?g|png|webp))$/i.exec(url.pathname);
  if (!match || match[2][0] !== match[1]) invalid();
  let filename; try { filename = decodeURIComponent(match[3]); } catch { invalid(); }
  if (/[\\/\u0000-\u001f\u007f]/.test(filename) || filename === '.' || filename === '..') invalid();
  // The official API adds UTM parameters to originals. Keep only the validated
  // immutable file path; no provider tracking or arbitrary query parameters.
  if ([...url.searchParams.keys()].some(key => !['utm_source', 'utm_campaign', 'utm_content'].includes(key))) invalid();
  url.search = '';
  return url.href;
}

function descriptionUrl(value) {
  const url = checkedUrl(value, COMMONS_API_ORIGIN);
  if (!url.pathname.startsWith('/wiki/File:') || url.pathname.length <= '/wiki/File:'.length || url.search) invalid();
  return url.href;
}

function license(value, address) {
  const name = boundedText(value, 80);
  if (typeof address !== 'string' || address.length > 300) invalid();
  let url; try { url = new URL(address); } catch { invalid(); }
  if (!['https:', 'http:'].includes(url.protocol) || url.hostname !== 'creativecommons.org' || url.port || url.username || url.password || url.search || url.hash) invalid();
  const cc0 = /^\/publicdomain\/zero\/1\.0(?:\/(?:deed(?:\.[a-zA-Z-]+)?)?)?\/?$/.test(url.pathname);
  const pd = /^\/publicdomain\/mark\/1\.0(?:\/(?:deed(?:\.[a-zA-Z-]+)?)?)?\/?$/.test(url.pathname);
  if (/^CC0(?: 1\.0)?$/.test(name) && cc0) return { license: 'CC0', licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/' };
  if (name === 'Public domain' && pd) return { license: name, licenseUrl: 'https://creativecommons.org/publicdomain/mark/1.0/' };
  invalid();
}

// Used on persisted metadata as well as new entries. Missing license evidence
// is rejected; the caller separately recognizes the four legacy fixed images.
export function validateCommonsMetadata(value) {
  if (!object(value)) invalid();
  const result = {
    imageUrl: imageUrl(value.imageUrl), title: boundedText(value.title, 200),
    copyright: boundedText(value.copyright, 600), copyrightUrl: descriptionUrl(value.copyrightUrl),
    ...license(value.license, value.licenseUrl),
  };
  if (value.date !== undefined) {
    if (typeof value.date !== 'string' || !/^\d{8}$/.test(value.date)) invalid();
    result.date = value.date;
  }
  return result;
}

function plainText(value, limit) {
  if (typeof value !== 'string' || value.length > 12000) invalid();
  const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  const text = value.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (_, entity) => {
      if (entity[0] !== '#') return entities[entity.toLowerCase()] || '';
      const number = entity[1]?.toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
      return number > 31 && number <= 0x10ffff && !(number >= 0xd800 && number <= 0xdfff) && number !== 127 ? String.fromCodePoint(number) : '';
    }).replace(/[<>\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
  return boundedText(text, limit);
}

export function parseCommonsCatalog(data) {
  if (!object(data) || data.error || data.query !== undefined && !object(data.query)) invalid();
  const pages = data.query?.pages ?? [];
  if (!Array.isArray(pages) || pages.length > LIMIT) invalid();
  let nextOffset = null;
  if (data.continue !== undefined) {
    if (!object(data.continue) || !Number.isSafeInteger(data.continue.gsroffset) || data.continue.gsroffset < 1 || data.continue.gsroffset > MAX_OFFSET) invalid();
    nextOffset = data.continue.gsroffset;
  }
  const images = [], seen = new Set();
  for (const page of pages) {
    try {
      if (!object(page) || page.ns !== 6 || page.missing || !Array.isArray(page.imageinfo) || page.imageinfo.length !== 1) continue;
      const info = page.imageinfo[0], metadata = info?.extmetadata;
      if (!object(info) || !object(metadata) || !TYPES.has(info.mime)
        || !Number.isSafeInteger(info.size) || info.size < 1 || info.size > MAX_IMAGE
        || !Number.isSafeInteger(info.width) || !Number.isSafeInteger(info.height) || info.width < 1280 || info.height < 720
        || info.width <= info.height || info.width > 8192 || info.height > 8192 || info.width * info.height > 40_000_000) continue;
      const evidence = license(metadata.LicenseShortName?.value, metadata.LicenseUrl?.value);
      if (String(metadata.AttributionRequired?.value).toLowerCase() !== 'false'
        || evidence.license === 'Public domain' && String(metadata.Copyrighted?.value).toLowerCase() !== 'false') continue;
      const creator = plainText(metadata.Artist?.value, 500);
      const title = plainText(page.title, 1000).replace(/^File:/, '').replace(/\.(?:jpe?g|png|webp)$/i, '').replaceAll('_', ' ').slice(0, 200).trim();
      const image = validateCommonsMetadata({ imageUrl: info.url, title, copyright: `${creator} · ${evidence.license}`,
        copyrightUrl: info.descriptionurl, ...evidence });
      if (!seen.has(image.imageUrl)) { seen.add(image.imageUrl); images.push(image); }
    } catch { /* A catalog may mix unsupported or unverifiable files. */ }
  }
  return { images, nextOffset };
}
