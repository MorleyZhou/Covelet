import test from 'node:test';
import assert from 'node:assert/strict';
import { captureNoteDocument, captureSourceUrl, captureVisibleTags, readSelectedPage } from './note-capture.js';
import { noteDocumentText } from './note-document.js';

function fixture({ result, execute, latest } = {}) {
  const updated = new Set(), removed = new Set(), calls = [];
  const event = (set) => ({ addListener: (fn) => set.add(fn), removeListener: (fn) => set.delete(fn) });
  const tab = { id: 41, url: 'https://capture.test/article?q=full#section', status: 'complete' };
  const api = { tabs: { query: async () => [tab], get: async () => latest || tab,
    onUpdated: event(updated), onRemoved: event(removed) }, scripting: { executeScript: async (options) => {
      calls.push(options);
      if (execute) return execute(options);
      return [{ frameId: 0, documentId: 'main-document', result: result || { text: 'Selected text', title: 'Page title', url: tab.url } }];
    } } };
  return { api, calls, updated, removed, tab };
}

test('explicit capture uses one main frame, preserves its full source and releases navigation listeners', async () => {
  const f = fixture();
  assert.equal(f.calls.length, 0);
  assert.deepEqual(await readSelectedPage({ api: f.api }), { text: 'Selected text', title: 'Page title', url: f.tab.url, tabId: 41 });
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0].target, { tabId: 41, frameIds: [0] });
  assert.equal(f.updated.size + f.removed.size, 0);
});

test('a same-URL reload during capture is stale even if the latest URL is identical', async () => {
  let finish;
  const f = fixture({ execute: () => new Promise((resolve) => { finish = resolve; }) });
  const reading = readSelectedPage({ api: f.api });
  await Promise.resolve(); await Promise.resolve();
  for (const handler of f.updated) handler(41, { status: 'loading' });
  finish([{ frameId: 0, result: { text: 'Old text', title: 'Old title', url: f.tab.url } }]);
  await assert.rejects(reading, { code: 'CAPTURE_CHANGED' });
  assert.equal(f.updated.size + f.removed.size, 0);
});

test('navigation, closed tabs and non-main-frame results cannot become a captured draft', async () => {
  const f = fixture({ latest: { id: 41, url: 'https://other.test/', status: 'complete' } });
  await assert.rejects(readSelectedPage({ api: f.api }), { code: 'CAPTURE_CHANGED' });
  const child = fixture({ execute: async () => [{ frameId: 7, result: { text: 'Iframe text', url: 'https://child.test/' } }] });
  await assert.rejects(readSelectedPage({ api: child.api }), { code: 'CAPTURE_CHANGED' });
  const closed = fixture({ execute: async () => { for (const handler of closed.removed) handler(41); throw Error('Tab closed'); } });
  await assert.rejects(readSelectedPage({ api: closed.api }), { code: 'CAPTURE_CHANGED' });
});

test('restricted, ungranted and cancelled pages fail without fallback scraping or network', async () => {
  for (const url of ['chrome://extensions/', 'edge://settings/', 'file:///private.txt', 'javascript:alert(1)', 'https://user:secret@capture.test/']) {
    assert.throws(() => captureSourceUrl(url), { code: 'CAPTURE_UNAVAILABLE' });
  }
  const denied = fixture({ execute: async () => { throw Error('Cannot access contents'); } });
  await assert.rejects(readSelectedPage({ api: denied.api }), { code: 'CAPTURE_UNAVAILABLE' });
  assert.equal(denied.updated.size + denied.removed.size, 0);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(readSelectedPage({ api: denied.api, signal: controller.signal }), { name: 'AbortError' });
  assert.equal(denied.calls.length, 1);
});

test('aborted asynchronous capture cannot publish a late successful result', async () => {
  let finish;
  const controller = new AbortController(), f = fixture({ execute: () => new Promise((resolve) => { finish = resolve; }) });
  const reading = readSelectedPage({ api: f.api, signal: controller.signal });
  await Promise.resolve(); await Promise.resolve(); controller.abort();
  finish([{ frameId: 0, result: { text: 'Late', title: 'Late', url: f.tab.url } }]);
  await assert.rejects(reading, { name: 'AbortError' });
  assert.equal(f.updated.size + f.removed.size, 0);
});

test('empty selection permits manual input and an oversized selection is refused without truncation', async () => {
  const empty = fixture({ result: { text: '', title: 'No selection', url: 'https://capture.test/article?q=full#section' } });
  assert.equal((await readSelectedPage({ api: empty.api })).text, '');
  const long = fixture({ result: { text: 'x'.repeat(60001), title: 'Long', url: empty.tab.url } });
  await assert.rejects(readSelectedPage({ api: long.api }), { code: 'CAPTURE_LIMIT' });
});

test('captured HTML and Markdown stay literal and complete source URL remains searchable and clickable', () => {
  const body = '<img src="https://remote.test/a">\n**literal** [bad](javascript:alert(1))';
  const pageTitle = '<script>page title</script>', sourceUrl = 'https://capture.test/article?one=1&two=2#complete';
  const document = captureNoteDocument({ body, pageTitle, sourceUrl });
  assert.equal(document.type, 'doc');
  assert.equal(document.content[0].content[0].text, body.split('\n')[0]);
  assert.equal(noteDocumentText(document), `${body}\n${pageTitle}\n${sourceUrl}`);
  assert.deepEqual(document.content[2].content[0], { type: 'text', text: sourceUrl, marks: [{ type: 'link', attrs: { href: sourceUrl } }] });
  assert.equal(JSON.stringify(document).includes('"type":"image"'), false);
  assert.equal(document.content[0].content[0].marks, undefined);
});

test('manual note has no invented source and total body size includes provenance', () => {
  assert.deepEqual(captureNoteDocument({ body: 'Manual note' }), { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Manual note' }] }] });
  assert.throws(() => captureNoteDocument({ body: '   ' }));
  assert.throws(() => captureNoteDocument({ body: 'x'.repeat(59999), pageTitle: 'source title', sourceUrl: 'https://capture.test/' }));
});

test('literal multiline notes keep leading, trailing and consecutive breaks, including an exact CRLF projection', () => {
  for (const body of ['\n**literal**\n\n<img src="https://remote.test/x">\n', '\r\nfirst\r\n\r\nlast\r\n']) {
    const document = captureNoteDocument({ body });
    assert.equal(noteDocumentText(document), body);
    assert.equal(document.content[0].content.filter((node) => node.type === 'hardBreak').length, body.split('\n').length - 1);
    assert.ok(document.content[0].content.every((node) => ['text', 'hardBreak'].includes(node.type)));
    assert.ok(document.content[0].content.every((node) => !node.marks));
  }
});

test('locking removes private-only selected tags, including inherited hidden site tags, before a public note can receive them', () => {
  const preferences = { presentation: false, privateKeys: ['note:private'], library: { tags: [
    { id: 'private-tag', name: 'Private only' }, { id: 'shared-tag', name: 'Shared' }, { id: 'folder-tag', name: 'Hidden child' },
  ], items: {
    'note:private': { tagIds: ['private-tag', 'shared-tag'] },
    'note:public': { tagIds: ['shared-tag'] },
    'site:hidden-child': { tagIds: ['folder-tag'] },
  } } };
  const selected = ['private-tag', 'shared-tag', 'folder-tag'];
  assert.deepEqual(captureVisibleTags(preferences, selected), selected);
  assert.deepEqual(captureVisibleTags({ ...preferences, presentation: true }, selected, { hiddenKeys: new Set(['site:hidden-child']) }), ['shared-tag']);
  // Context locking also protects against stale props that still say unlocked.
  assert.deepEqual(captureVisibleTags(preferences, selected, { locked: true, hiddenKeys: new Set(['site:hidden-child']) }), ['shared-tag']);
  assert.deepEqual(captureVisibleTags({ ...preferences, library: { ...preferences.library, tags: [] } }, selected), []);
});
