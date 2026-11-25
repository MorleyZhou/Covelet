import { tr } from '../i18n/index.js';
import { localData } from './local-data.js';
import { extractReadingArticle, safeReadingUrl } from './reading-extraction.js';
export { fetchReadingImage, readerSearchText, readingArticleMarkdown } from './reading-extraction.js';

export const READING_LIBRARY_KEY = 'covelet.reading-library.v1';
export const READING_LIBRARY_LIMITS = Object.freeze({ totalBytes: 32 * 1024 * 1024, articleBytes: 256 * 1024, articles: 500, highlights: 100, quoteLength: 6000, noteLength: 2000 });
const TOOLS = 'covelet.tools.v1', PREFERENCES = 'covelet.content.preferences.v1';
const encoder = new TextEncoder(), copy = (value) => structuredClone(value);
const object = (value) => value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const fields = (value, names) => object(value) && Object.keys(value).length === names.length && Object.keys(value).every((key) => names.includes(key));
const id = (value) => typeof value === 'string' && /^[a-z\d-]{1,100}$/iu.test(value);
const time = (value) => Number.isSafeInteger(value) && value >= 0 && value <= 8640000000000000;
const revision = (value) => Number.isSafeInteger(value) && value >= 1;
const text = (value, limit) => typeof value === 'string' && value.length <= limit && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value);
function fail(code = 'READING_LIBRARY_INVALID') {
  const message = code === 'READING_LIBRARY_CAPACITY' ? tr('本地阅读内容已达到容量上限，请先导出并清理内容。')
    : code === 'READING_STALE' ? tr('阅读内容已在其他页面更新，请重新打开后重试。')
      : code === 'PRIVACY_LOCKED' ? tr('请先输入密码解除隐藏。')
        : code === 'READING_ARTICLE_CHANGED' ? tr('网页正文已变化，现有高亮已保留。请先导出或移除高亮后重试。')
          : tr('本地阅读数据无效，原有内容已保留。');
  throw Object.assign(Error(message), { code });
}
export function createEmptyReadingLibrary() { return { version: 1, revision: 0, articles: {}, settings: { fontSize: 18, lineHeight: 1.8, theme: 'system' } }; }
function checkSettings(value) {
  if (!fields(value, ['fontSize', 'lineHeight', 'theme']) || !Number.isInteger(value.fontSize) || value.fontSize < 14 || value.fontSize > 28
    || !Number.isFinite(value.lineHeight) || value.lineHeight < 1.3 || value.lineHeight > 2.4 || !['system', 'light', 'dark', 'sepia'].includes(value.theme)) fail();
}
export function validateReadingArticle(article, expectedId = article?.id) {
  if (!fields(article, ['id', 'url', 'title', 'text', 'blocks', 'highlights', 'revision', 'createdAt', 'updatedAt']) || !id(article.id) || article.id !== expectedId
    || !safeReadingUrl(article.url) || safeReadingUrl(article.url) !== article.url || !text(article.title, 200) || !article.title.trim() || !text(article.text, READING_LIBRARY_LIMITS.articleBytes)
    || !revision(article.revision) || !time(article.createdAt) || !time(article.updatedAt) || article.updatedAt < article.createdAt
    || !Array.isArray(article.blocks) || !article.blocks.length || article.blocks.length > 4000 || !Array.isArray(article.highlights)) fail();
  if (encoder.encode(article.text).length > READING_LIBRARY_LIMITS.articleBytes || article.highlights.length > READING_LIBRARY_LIMITS.highlights) fail('READING_LIBRARY_CAPACITY');
  let content = '', blockCount = 0, imageCount = 0;
  for (const block of article.blocks) {
    const allowed = ['type', 'text', 'start', 'end', ...(block?.type === 'heading' ? ['level'] : block?.type === 'image' ? ['url'] : [])];
    if (!fields(block, allowed) || !['paragraph', 'heading', 'list-item', 'quote', 'image'].includes(block.type) || !text(block.text, READING_LIBRARY_LIMITS.articleBytes)
      || block.type !== 'image' && !block.text.trim() || block.type === 'heading' && (!Number.isInteger(block.level) || block.level < 1 || block.level > 6)
      || block.type === 'image' && (!safeReadingUrl(block.url) || safeReadingUrl(block.url) !== block.url)) fail();
    if (block.type === 'image' && ++imageCount > 100) fail('READING_LIBRARY_CAPACITY');
    const start = content.length + (blockCount ? 2 : 0);
    if (block.start !== start || block.end !== start + block.text.length) fail();
    content += `${blockCount ? '\n\n' : ''}${block.text}`; blockCount++;
  }
  if (article.text !== content) fail();
  const ids = new Set();
  for (const item of article.highlights) {
    if (!fields(item, ['id', 'start', 'end', 'quote', 'note', 'revision', 'createdAt', 'updatedAt']) || !id(item.id) || ids.has(item.id)
      || !Number.isInteger(item.start) || !Number.isInteger(item.end) || item.start < 0 || item.end <= item.start || item.end > article.text.length
      || !text(item.quote, READING_LIBRARY_LIMITS.quoteLength) || item.quote !== article.text.slice(item.start, item.end) || !text(item.note, READING_LIBRARY_LIMITS.noteLength)
      || !revision(item.revision) || !time(item.createdAt) || !time(item.updatedAt) || item.updatedAt < item.createdAt) fail();
    ids.add(item.id);
  }
  return copy(article);
}
export function validateReadingLibrary(input) {
  const value = input == null ? createEmptyReadingLibrary() : input;
  if (!fields(value, ['version', 'revision', 'articles', 'settings']) || value.version !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 0 || !object(value.articles)) fail();
  if (Object.keys(value.articles).length > READING_LIBRARY_LIMITS.articles) fail('READING_LIBRARY_CAPACITY');
  checkSettings(value.settings);
  for (const [key, article] of Object.entries(value.articles)) validateReadingArticle(article, key);
  if (encoder.encode(JSON.stringify(value)).length > READING_LIBRARY_LIMITS.totalBytes) fail('READING_LIBRARY_CAPACITY');
  return copy(value);
}
const nextRevision = (value) => { if (value >= Number.MAX_SAFE_INTEGER) fail('READING_LIBRARY_CAPACITY'); return value + 1; };
function liveReading(values, readingId, options = {}, incoming) {
  const reading = values[TOOLS]?.reading?.find((record) => record.id === readingId), prefs = values[PREFERENCES];
  // A fresh profile has no persisted preferences record; its validated UI
  // snapshot is revision zero. Legacy valid preferences may omit the revision
  // too. A present malformed record must never become an implicit default.
  if (prefs !== undefined && (!object(prefs) || prefs.version !== 1 || !object(prefs.aliases)
    || Object.keys(prefs).some((key) => !['version', 'revision', 'aliases', 'privateKeys', 'presentation', 'library'].includes(key))
    || prefs.revision !== undefined && (!Number.isSafeInteger(prefs.revision) || prefs.revision < 0)
    || prefs.presentation !== undefined && typeof prefs.presentation !== 'boolean'
    || prefs.privateKeys !== undefined && (!Array.isArray(prefs.privateKeys) || prefs.privateKeys.some((key) => typeof key !== 'string')))) fail('READING_STALE');
  const preferencesRevision = prefs?.revision ?? 0;
  if (!reading && !options.allowMissingReading || incoming && (reading?.url !== incoming.url || reading?.revision !== incoming.revision)
    || options.expectedReadingRevision !== undefined && reading?.revision !== options.expectedReadingRevision
    || options.expectedPreferencesRevision !== undefined && preferencesRevision !== options.expectedPreferencesRevision) fail('READING_STALE');
  if (prefs?.presentation && prefs.privateKeys?.includes(`reading:${readingId}`)) fail('PRIVACY_LOCKED');
  return reading;
}

export function createReadingLibrary({ store = localData, extract = extractReadingArticle, now = () => Date.now(), uuid = () => globalThis.crypto.randomUUID() } = {}) {
  const load = async () => validateReadingLibrary((await store.get(READING_LIBRARY_KEY))[READING_LIBRARY_KEY]);
  async function mutate(readingId, options, change, incoming) {
    let result;
    await store.updateMany([READING_LIBRARY_KEY, TOOLS, PREFERENCES], (values) => {
      const current = validateReadingLibrary(values[READING_LIBRARY_KEY]);
      if (readingId) {
        const reading = liveReading(values, readingId, options, incoming), previous = current.articles[readingId];
        if (!incoming && (!previous || reading && previous.url !== reading.url && !options.allowMissingReading)) fail('READING_STALE');
        if (options.expectedRevision !== undefined && previous?.revision !== options.expectedRevision) fail('READING_STALE');
      } else if (options.expectedRevision !== undefined && current.revision !== options.expectedRevision) fail('READING_STALE');
      result = change(current, values);
      current.revision = nextRevision(current.revision);
      return { writes: { [READING_LIBRARY_KEY]: validateReadingLibrary(current) } };
    });
    return copy(result);
  }
  async function save(record, options = {}) {
    if (!id(record?.id) || !safeReadingUrl(record?.url) || safeReadingUrl(record.url) !== record.url || !revision(record.revision)) fail();
    let extracted;
    try {
      extracted = await extract(record, options);
      if (extracted) validateReadingArticle({ ...extracted, id: record.id, highlights: [], revision: 1, createdAt: 0, updatedAt: 0 });
    } catch { return null; }
    if (!extracted) return null;
    return mutate(record.id, options, (library) => {
      const previous = library.articles[record.id], timestamp = now();
      if (previous?.highlights.length && (previous.text !== extracted.text || previous.url !== extracted.url)) fail('READING_ARTICLE_CHANGED');
      const article = validateReadingArticle({ ...extracted, id: record.id, highlights: previous?.highlights || [], revision: nextRevision(previous?.revision || 0), createdAt: previous?.createdAt ?? timestamp, updatedAt: Math.max(timestamp, previous?.updatedAt || 0) });
      library.articles[record.id] = article; return article;
    }, record);
  }
  async function highlightChange(readingId, options, change) {
    return mutate(readingId, options, (library) => {
      const article = library.articles[readingId], result = change(article);
      article.revision = nextRevision(article.revision); article.updatedAt = Math.max(now(), article.updatedAt); return result;
    });
  }
  return {
    loadReadingLibrary: load,
    subscribeReadingLibrary(listener) {
      if (typeof listener !== 'function') fail();
      return store.subscribe((changes) => { if (Object.hasOwn(changes, READING_LIBRARY_KEY)) { try { listener(validateReadingLibrary(changes[READING_LIBRARY_KEY].newValue)); } catch { /* Never publish corrupt records to an open reader. */ } } });
    },
    saveReadingArticle: save,
    addReadingHighlight(readingId, selection, options = {}) {
      return highlightChange(readingId, options, (article) => {
        if (!fields(selection, ['start', 'end', 'quote', 'note'])) fail();
        if (article.highlights.length >= READING_LIBRARY_LIMITS.highlights) fail('READING_LIBRARY_CAPACITY');
        const at = now(), item = { ...copy(selection), id: uuid(), revision: 1, createdAt: at, updatedAt: at };
        article.highlights.push(item); return item;
      });
    },
    updateReadingHighlight(readingId, highlightId, patch, options = {}) {
      return highlightChange(readingId, options, (article) => {
        const item = article.highlights.find((value) => value.id === highlightId);
        if (!item || options.expectedHighlightRevision !== undefined && item.revision !== options.expectedHighlightRevision) fail('READING_STALE');
        if (!fields(patch, ['note'])) fail();
        item.note = patch.note; item.revision = nextRevision(item.revision); item.updatedAt = Math.max(now(), item.updatedAt); return item;
      });
    },
    deleteReadingHighlight(readingId, highlightId, options = {}) {
      return highlightChange(readingId, options, (article) => {
        const index = article.highlights.findIndex((value) => value.id === highlightId), item = article.highlights[index];
        if (!item || options.expectedHighlightRevision !== undefined && item.revision !== options.expectedHighlightRevision) fail('READING_STALE');
        article.highlights.splice(index, 1); return item;
      });
    },
    saveReadingSettings(patch, options = {}) {
      return mutate(null, options, (library) => {
        if (!object(patch) || Object.keys(patch).some((key) => !['fontSize', 'lineHeight', 'theme'].includes(key))) fail();
        library.settings = { ...library.settings, ...copy(patch) }; checkSettings(library.settings); return library.settings;
      });
    },
    cleanupRemovedReadingArticles(options = {}) {
      return mutate(null, options, (library, values) => {
        const tools = values[TOOLS];
        if (!object(tools) || !Array.isArray(tools.reading) || tools.trash !== undefined && !Array.isArray(tools.trash)) fail('READING_STALE');
        const retained = new Set();
        for (const record of tools.reading) { if (!id(record?.id)) fail('READING_STALE'); retained.add(record.id); }
        for (const item of tools.trash || []) if (item.kind === 'reading') { if (!id(item.record?.id)) fail('READING_STALE'); retained.add(item.record.id); }
        const removed = Object.keys(library.articles).filter((readingId) => !retained.has(readingId)), prefs = values[PREFERENCES];
        if (prefs?.presentation && removed.some((readingId) => prefs.privateKeys?.includes(`reading:${readingId}`))) fail('PRIVACY_LOCKED');
        for (const readingId of removed) delete library.articles[readingId];
        return { removed: removed.length };
      });
    },
    removeReadingArticle(readingId, options = {}) { return mutate(readingId, { ...options, allowMissingReading: true }, (library) => { const previous = library.articles[readingId]; delete library.articles[readingId]; return previous; }); },
  };
}
const readingLibrary = createReadingLibrary();
export const loadReadingLibrary = readingLibrary.loadReadingLibrary;
export const subscribeReadingLibrary = readingLibrary.subscribeReadingLibrary;
export const saveReadingArticle = readingLibrary.saveReadingArticle;
export const addReadingHighlight = readingLibrary.addReadingHighlight;
export const updateReadingHighlight = readingLibrary.updateReadingHighlight;
export const deleteReadingHighlight = readingLibrary.deleteReadingHighlight;
export const saveReadingSettings = readingLibrary.saveReadingSettings;
export const removeReadingArticle = readingLibrary.removeReadingArticle;
export const deleteReadingArticle = removeReadingArticle;
export const cleanupRemovedReadingArticles = readingLibrary.cleanupRemovedReadingArticles;
