import test from 'node:test';
import assert from 'node:assert/strict';
import { COMMONS_API_ORIGIN, commonsCatalogUrl, parseCommonsCatalog, validateCommonsMetadata } from './wallpaper-commons.js';

const page = (changes = {}) => ({ ns: 6, title: 'File:Lake_Mountain_Landscape.jpg', imageinfo: [{
  url: 'https://upload.wikimedia.org/wikipedia/commons/7/75/Lake_Mountain_Landscape.jpg?utm_source=commons.wikimedia.org&utm_campaign=imageinfo&utm_content=original',
  descriptionurl: 'https://commons.wikimedia.org/wiki/File:Lake_Mountain_Landscape.jpg',
  size: 2000000, width: 3840, height: 2160, mime: 'image/jpeg',
  extmetadata: {
    Artist: { value: '<a href="https://example.test/">Bonnie &amp; Moreland</a>' },
    LicenseShortName: { value: 'CC0' }, LicenseUrl: { value: 'http://creativecommons.org/publicdomain/zero/1.0/deed.en' },
    AttributionRequired: { value: 'false' }, Copyrighted: { value: 'True' },
  }, ...changes,
}] });
const catalog = pages => ({ batchcomplete: true, query: { pages } });
const parsed = () => parseCommonsCatalog(catalog([page()])).images[0];

test('Commons catalog requests one bounded CC0 landscape batch on the official API with numeric continuation', () => {
  const url = new URL(commonsCatalogUrl(40));
  assert.equal(url.origin, COMMONS_API_ORIGIN); assert.equal(url.pathname, '/w/api.php');
  assert.equal(url.searchParams.get('gsroffset'), '40'); assert.equal(url.searchParams.get('gsrlimit'), '40');
  assert.match(url.searchParams.get('gsrsearch'), /intitle:landscape/); assert.match(url.searchParams.get('gsrsearch'), /incategory:CC-Zero/);
  assert.equal(url.searchParams.has('iiurlwidth'), false, 'fetch only the validated original on upload.wikimedia.org');
  for (const offset of [-1, 10001, 1.5, '40', NaN]) assert.throws(() => commonsCatalogUrl(offset));
});

test('Commons catalog canonicalizes originals and licenses and converts creator markup to plain text', () => {
  const { images, nextOffset } = parseCommonsCatalog({ ...catalog([page(), page()]), continue: { gsroffset: 40, continue: 'gsroffset||' } });
  assert.equal(nextOffset, 40); assert.equal(images.length, 1);
  assert.deepEqual(images[0], {
    imageUrl: 'https://upload.wikimedia.org/wikipedia/commons/7/75/Lake_Mountain_Landscape.jpg',
    title: 'Lake Mountain Landscape', copyright: 'Bonnie & Moreland · CC0',
    copyrightUrl: 'https://commons.wikimedia.org/wiki/File:Lake_Mountain_Landscape.jpg',
    license: 'CC0', licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
  });
  assert.deepEqual(validateCommonsMetadata({ ...images[0], date: '20261112' }), { ...images[0], date: '20261112' });
  assert.deepEqual(parseCommonsCatalog({ batchcomplete: true }), { images: [], nextOffset: null });
});

test('Commons catalog ignores unsupported, huge, portrait and unlicensed records without losing the valid entry', () => {
  const invalid = [
    page({ size: 10 * 1024 * 1024 + 1 }), page({ size: 0 }), page({ size: '100' }), page({ width: 8193 }),
    page({ width: 8000, height: 6000 }), page({ width: 720, height: 1280 }), page({ height: 719 }), page({ mime: 'image/svg+xml' }),
    page({ extmetadata: {} }), page({ extmetadata: { ...page().imageinfo[0].extmetadata, LicenseShortName: { value: 'CC BY-SA 4.0' } } }),
    page({ extmetadata: { ...page().imageinfo[0].extmetadata, AttributionRequired: { value: 'true' } } }),
    page({ extmetadata: { ...page().imageinfo[0].extmetadata, LicenseUrl: { value: 'https://evil.test/publicdomain/zero/1.0/' } } }),
    page({ url: 'https://thumb.wikimedia.org/wikipedia/commons/thumb/7/75/Lake_Mountain_Landscape.jpg/1920px-Lake_Mountain_Landscape.jpg' }),
  ];
  assert.equal(parseCommonsCatalog(catalog([...invalid, page()])).images.length, 1);
});

test('Commons cached metadata rejects foreign origins, executable URLs, forged licenses and unknown image queries', () => {
  const image = parsed();
  for (const changes of [
    { imageUrl: 'https://evil.test/wikipedia/commons/7/75/Lake_Mountain_Landscape.jpg' },
    { imageUrl: 'http://upload.wikimedia.org/wikipedia/commons/7/75/Lake_Mountain_Landscape.jpg' },
    { imageUrl: image.imageUrl + '?redirect=https://evil.test' }, { imageUrl: image.imageUrl + '#hash' },
    { imageUrl: 'https://upload.wikimedia.org/wikipedia/commons/7/75/%2fsecret.jpg' },
    { imageUrl: 'https://upload.wikimedia.org/wikipedia/commons/7/75/%5csecret.jpg' },
    { imageUrl: 'https://upload.wikimedia.org/wikipedia/commons/7/85/Lake_Mountain_Landscape.jpg' },
    { copyrightUrl: 'javascript:alert(1)' }, { copyrightUrl: 'https://commons.wikimedia.org/w/api.php?action=edit' },
    { copyrightUrl: 'https://commons.wikimedia.org/wiki/File:Lake.jpg?redirect=1' }, { copyright: '<img src=x onerror=alert(1)>' },
    { title: '\u0000bad' }, { title: 'a'.repeat(201) }, { license: 'CC BY 4.0' },
    { license: undefined }, { licenseUrl: 'https://creativecommons.org.evil.test/publicdomain/zero/1.0/' },
    { licenseUrl: 'https://user:pass@creativecommons.org/publicdomain/zero/1.0/' }, { date: 'tomorrow' },
  ]) assert.throws(() => validateCommonsMetadata({ ...image, ...changes }), JSON.stringify(changes));
});

test('Commons creator text never executes markup, removes scripts and bounds malformed metadata', () => {
  const artist = value => page({ extmetadata: { ...page().imageinfo[0].extmetadata, Artist: { value } } });
  const { images } = parseCommonsCatalog(catalog([
    artist('<script>secret()</script><b>Author</b> &#38; &#x4e2d;'),
    artist('a'.repeat(12001)), artist('a'.repeat(501)),
  ]));
  assert.equal(images.length, 1); assert.equal(images[0].copyright, 'Author & 中 · CC0');
});

test('Commons public-domain entries require matching license URL and non-copyrighted evidence', () => {
  const metadata = { ...page().imageinfo[0].extmetadata, LicenseShortName: { value: 'Public domain' },
    LicenseUrl: { value: 'https://creativecommons.org/publicdomain/mark/1.0/' }, Copyrighted: { value: 'False' } };
  const result = parseCommonsCatalog(catalog([page({ extmetadata: metadata })]));
  assert.equal(result.images[0].license, 'Public domain');
  assert.equal(parseCommonsCatalog(catalog([page({ extmetadata: { ...metadata, Copyrighted: { value: 'True' } } })])).images.length, 0);
});

test('Commons catalog rejects excessive batches, API errors and invalid continuation rather than following provider URLs', () => {
  for (const data of [null, [], { error: { code: 'badquery' } }, { query: [] }, { query: { pages: {} } }, catalog(Array.from({ length: 41 }, () => page())),
    ...[-1, 0, 1.2, 10001, '40'].map(gsroffset => ({ ...catalog([page()]), continue: { gsroffset } })),
    { ...catalog([page()]), continue: { next: 'https://evil.test' } },
  ]) assert.throws(() => parseCommonsCatalog(data));
});
