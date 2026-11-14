import test from 'node:test';
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { unzipSync, strFromU8 } from 'fflate';
import { fromMarkdown } from '@futelab/folio/serialization';
import { Lexer } from 'marked';
import { localData } from './local-data.js';
import { createEmptyState, letterIcon } from './model.js';
import { noteDocumentText } from './note-document.js';
import { inspectMarkdownLibrary, exportMarkdownLibrary, MARKDOWN_LIBRARY_LIMITS } from './markdown-library.js';

const NAV = 'owntab.local.v1', PREFS = 'covelet.content.preferences.v1', TOOLS = 'covelet.tools.v1', WRITE = 'owntab.local.write.v1';
const chain = [WRITE, PREFS, TOOLS], encoder = new TextEncoder();
const note = (id, title = id, body = 'Plain text') => ({ id, title, body, pinned: false, revision: 1, createdAt: 0, updatedAt: 1730000000123 });
const reading = (id, title = id, status = 'unread') => ({ id, title, url: `https://reading.example.test/${id}?q=(x)#part`, status,
  revision: 1, createdAt: 1000, updatedAt: 1730000000123, revisitOn: '2026-11-20' });
const entry = (id, type, name, parentId, page, order) => ({ id, type, name, parentId, page, order, groupId: 'group-home',
  icon: letterIcon(name), ...(type === 'site' ? { url: `https://example.test/${id}?x=(a)&q=中文#part` } : {}) });
function fixture(t, { locked = false } = {}) {
  const navigation = createEmptyState(); navigation.revision = 3; navigation.settings.pages = [0, 1];
  navigation.settings.desktopPages = { 1: { id: 'desktop-project', name: 'Project: 中文 / #1' } };
  navigation.entries = [entry('folder-public', 'folder', 'Work / Research', null, 1, 0), entry('folder-private', 'folder', 'Hidden folder', null, 0, 1),
    entry('site-private', 'site', 'Same', null, 0, 2), entry('site-root', 'site', 'Same', null, 0, 3),
    entry('site-public', 'site', 'Visible (中文) #1!', 'folder-public', 1, 0), entry('site-inherited', 'site', 'Inherited secret', 'folder-private', 0, 0)];
  const records = { [NAV]: { version: 1, state: navigation, snapshots: [] },
    [TOOLS]: { version: 3, revision: 5, notes: [note('note-public', 'Public note'), note('note-private', 'Hidden note', 'Hidden body')],
      reading: [reading('reading-public', 'Public reading'), reading('reading-private', 'Hidden reading')], snapshots: [],
      trash: [{ id: 'expired-trash', kind: 'notes', deletedAt: 1, record: note('expired-note', 'Expired trash') }] },
    [PREFS]: { version: 1, revision: 7, aliases: {}, presentation: locked,
      privateKeys: ['folder:folder-private', 'site:site-private', 'note:note-private', 'reading:reading-private'],
      library: { version: 1, tags: [{ id: 'tag-work', name: '项目/2026' }, { id: 'tag-secret', name: 'Secret-only tag' }], items: {
        'site:site-public': { description: 'A useful description', tagIds: ['tag-work'] },
        'note:note-private': { description: 'Hidden description', tagIds: ['tag-secret'] },
      } } } };
  const context = new AsyncLocalStorage(), queues = new Map(), acquisitions = [], reads = [], hooks = {};
  const locks = { async request(name, options, callback) {
    const action = callback || options, previous = queues.get(name) || Promise.resolve();
    let release; const gate = new Promise((resolve) => { release = resolve; }); queues.set(name, previous.then(() => gate));
    await previous; const held = [...(context.getStore() || []), name]; acquisitions.push(held);
    try { return await context.run(held, action); } finally { release(); }
  } };
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks } });
  t.after(() => Object.defineProperty(globalThis, 'navigator', descriptor));
  t.mock.method(localData, 'get', async (requested) => {
    const keys = Array.isArray(requested) ? requested : [requested]; reads.push(keys);
    const held = context.getStore();
    assert.deepEqual(held, keys.includes(PREFS) && held.length === 2 ? [WRITE, PREFS] : chain);
    await hooks.onRead?.(keys, records);
    return structuredClone(Object.fromEntries(keys.filter((key) => Object.hasOwn(records, key)).map((key) => [key, records[key]])));
  });
  const writes = t.mock.method(localData, 'set', async () => { throw Error('Export must never write'); });
  const network = t.mock.method(globalThis, 'fetch', async () => { throw Error('Export must never fetch'); });
  return { records, acquisitions, locks, hooks, reads, writes, network };
}
const selectedKeys = (plan) => plan.rows.filter((row) => !row.issue).map((row) => row.key);
async function files(result) { return Object.fromEntries(Object.entries(unzipSync(new Uint8Array(await result.blob.arrayBuffer()))).map(([name, bytes]) => [name, strFromU8(bytes)])); }
function document(source) {
  const match = /^---\n([\s\S]*?)\n---\n\n([\s\S]*)$/u.exec(source); assert(match);
  const properties = {};
  for (const line of match[1].split('\n')) {
    const separator = line.indexOf(': '), key = line.slice(0, separator); assert(separator > 0); assert(!Object.hasOwn(properties, key));
    properties[key] = JSON.parse(line.slice(separator + 2));
  }
  return { properties, body: match[2] };
}
function links(tokens) {
  return tokens.flatMap((token) => [...(token.type === 'link' ? [token] : []), ...links(token.tokens || []),
    ...(token.items || []).flatMap((item) => links(item.tokens || []))]);
}

test('mixed library export takes a locked read-only snapshot and excludes all marked/inherited private content even unlocked', async (t) => {
  const f = fixture(t), before = structuredClone(f.records), plan = await inspectMarkdownLibrary();
  assert.deepEqual(plan.counts, { site: 2, reading: 1, note: 1 }); assert.equal(plan.totalCount, 4);
  assert.deepEqual(plan.rows.find((row) => row.key === 'site:site-public').path, ['Project: 中文 / #1', 'Work / Research']);
  assert.deepEqual(plan.rows.find((row) => row.type === 'note').path, []);
  assert(Object.isFrozen(plan)); assert(Object.isFrozen(plan.rows)); assert(Object.isFrozen(plan.rows[0].tagNames));
  assert(!JSON.stringify(plan).includes('Secret-only')); assert(!JSON.stringify(plan).includes('Hidden')); assert(!JSON.stringify(plan).includes('Expired'));
  const result = await exportMarkdownLibrary(plan, { selectedKeys: selectedKeys(plan) }), archive = await files(result);
  assert.equal(result.filename, 'Covelet-library.zip'); assert.equal(result.blob.type, 'application/zip'); assert.equal(result.count, 4);
  assert.equal(Object.keys(archive).length, 5); assert(Object.keys(archive).includes('sites/Same.md'), 'private same-title copy must not reserve a filename');
  assert(!JSON.stringify(archive).includes('Hidden')); assert(!JSON.stringify(archive).includes('Secret-only')); assert(!JSON.stringify(archive).includes('Expired'));
  const site = Object.values(archive).filter((text) => text.startsWith('---')).map(document).find((item) => item.properties.title === 'Visible (中文) #1!');
  assert.deepEqual(site.properties.covelet_path, ['Project: 中文 / #1', 'Work / Research']);
  assert.deepEqual(site.properties.covelet_tags, ['项目/2026']); assert.deepEqual(site.properties.tags, ['项目/2026']);
  const read = document(archive['reading/Public reading.md']).properties;
  assert.equal(read.status, 'unread'); assert.equal(read.revisit_on, '2026-11-20'); assert.equal(read.created, '1970-01-01T00:00:01.000Z');
  assert.equal(read.updated, '2024-10-27T03:33:20.123Z'); assert.equal(read.url, f.records[TOOLS].reading[0].url);
  assert.deepEqual(f.records, before); assert.equal(f.writes.mock.callCount(), 0); assert.equal(f.network.mock.callCount(), 0);
  assert.deepEqual(f.acquisitions, [[WRITE], [WRITE, PREFS], chain, [WRITE], [WRITE, PREFS], chain]);
});

test('type selection includes archived/read items and an empty filter exposes no rows or unrelated tag warnings', async (t) => {
  const f = fixture(t, { locked: true }); f.records[TOOLS].reading.push(reading('read', 'Read', 'read'), reading('archived', 'Archived', 'archived'));
  const plan = await inspectMarkdownLibrary({ types: ['reading'] });
  assert.deepEqual(plan.counts, { site: 0, reading: 3, note: 0 });
  const archive = await files(await exportMarkdownLibrary(plan, { selectedKeys: selectedKeys(plan) }));
  assert.equal(document(archive['reading/Archived.md']).properties.status, 'archived');
  assert.equal(document(archive['reading/Read.md']).properties.status, 'read');
  const empty = await inspectMarkdownLibrary({ types: [] });
  assert.equal(empty.totalCount, 0); assert.deepEqual(empty.rows, []); assert.deepEqual(empty.warnings, []);
  await assert.rejects(exportMarkdownLibrary(empty, { selectedKeys: [] }), { code: 'MARKDOWN_LIBRARY_SELECTION' });
});

test('safe front matter preserves original tags and injected multiline data while conservative native tags get separate warnings', async (t) => {
  const f = fixture(t), title = 'Title: "quoted" # ---\nforged: true\u2028\u2029', description = 'Remark: "quoted" # x\n---\nforged: true\n& <script>\u0085\u2028\u2029end';
  const names = ['项目/2026', 'Project A', '123', '１２４', 'a//b', '/leading', 'trailing/', '😀', 'e\u0301', 'safe_tag-1'];
  f.records[TOOLS].notes = [note('special', title)];
  f.records[PREFS].library.tags = names.map((name, index) => ({ id: `tag-${index}`, name }));
  f.records[PREFS].library.items = { 'note:special': { description, tagIds: names.map((_, index) => `tag-${index}`) } };
  const plan = await inspectMarkdownLibrary({ types: ['note'] }); assert.equal(plan.issues.length, 0);
  assert.deepEqual(plan.warnings[0].tagNames, ['Project A', '123', '１２４', 'a//b', '/leading', 'trailing/', '😀']);
  const archive = await files(await exportMarkdownLibrary(plan, { selectedKeys: ['note:special'] }));
  const text = Object.entries(archive).find(([name]) => name.startsWith('notes/'))[1], result = document(text);
  assert.equal(result.properties.title, title); assert.equal(result.properties.description, description);
  assert.deepEqual(result.properties.covelet_tags, names); assert.deepEqual(result.properties.tags, ['项目/2026', 'e\u0301', 'safe_tag-1']);
  assert(!Object.hasOwn(result.properties, 'forged')); assert.match(text, /\\u2028\\u2029/u); assert.match(text, /\\u0085/u);
  assert(!text.includes('\u2028')); assert(!text.includes('\u2029'));
  assert(!Lexer.lex(result.body).some((token) => token.type === 'html')); assert(!archive['index.md'].includes('<script>'));
});

test('rich notes retain verified common Markdown, and legacy Markdown/literal fallback matches the editor without changing stored records', async (t) => {
  const f = fixture(t), markdown = '## Section\n\n**Bold** and *italic*, ~~strike~~, [link](https://example.test/a?q=(1)#part).\n\n- item\n\n- [x] finished\n- [ ] next\n\n> Quote\n\n```js\nconst n = 1;\n```\n\nBefore  \nAfter';
  const richDocument = JSON.parse(JSON.stringify(fromMarkdown(markdown)));
  f.records[TOOLS].notes = [{ ...note('rich', 'Rich', noteDocumentText(richDocument)), document: richDocument }, note('legacy', 'Legacy', markdown),
    note('literal', 'Literal', '<script>alert("literal")</script>')];
  const before = structuredClone(f.records), plan = await inspectMarkdownLibrary({ types: ['note'] });
  assert.deepEqual(plan.issues, []);
  const archive = await files(await exportMarkdownLibrary(plan, { selectedKeys: selectedKeys(plan) }));
  for (const filename of ['notes/Rich.md', 'notes/Legacy.md']) {
    const parsed = fromMarkdown(document(archive[filename]).body); parsed.content.shift();
    assert.deepEqual(JSON.parse(JSON.stringify(parsed)), richDocument);
  }
  const literal = fromMarkdown(document(archive['notes/Literal.md']).body); literal.content.shift();
  assert.equal(noteDocumentText(literal), '<script>alert("literal")</script>');
  assert.deepEqual(f.records, before); assert.equal(f.writes.mock.callCount(), 0);
});

test('complex blocks and remote images have explicit per-item issues and require deliberate exclusion', async (t) => {
  const f = fixture(t), documents = [
    { type: 'doc', content: [{ type: 'callout', attrs: { tone: 'info' }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Callout' }] }] }] },
    { type: 'doc', content: [{ type: 'image', attrs: { src: 'https://remote.example.test/image.png', alt: 'Remote' } }] },
    { type: 'doc', content: [{ type: 'bookmark', attrs: { url: 'https://example.test/', title: 'Bookmark', description: 'Rich card' } }] },
  ];
  f.records[TOOLS].notes = [note('simple', 'Simple'), ...documents.map((document, index) => ({ ...note(`complex-${index}`, `Complex ${index}`, noteDocumentText(document)), document }))];
  const plan = await inspectMarkdownLibrary({ types: ['note'] });
  assert.equal(plan.issues.length, 3); assert.equal(plan.rows.filter((row) => row.issue).length, 3);
  await assert.rejects(exportMarkdownLibrary(plan, { selectedKeys: plan.rows.map((row) => row.key) }), { code: 'MARKDOWN_LIBRARY_UNSUPPORTED' });
  const archive = await files(await exportMarkdownLibrary(plan, { selectedKeys: ['note:simple'] }));
  assert.deepEqual(Object.keys(archive), ['index.md', 'notes/Simple.md']); assert(!JSON.stringify(archive).includes('remote.example'));
  assert.equal(f.network.mock.callCount(), 0); assert.equal(f.writes.mock.callCount(), 0);
});

test('generated heading identifiers may be omitted only when no self-link depends on their exact anchors', async (t) => {
  const f = fixture(t), heading = { type: 'heading', attrs: { level: 2, id: 'generated-anchor', 'data-toc-id': 'generated-anchor' }, content: [{ type: 'text', text: 'Heading' }] };
  const plain = { type: 'doc', content: [heading] };
  const linked = { type: 'doc', content: [heading, { type: 'paragraph', content: [{ type: 'text', text: 'Jump', marks: [{ type: 'link', attrs: { href: '#generated%2Danchor' } }] }] }] };
  f.records[TOOLS].notes = [{ ...note('plain-heading', 'Plain heading', noteDocumentText(plain)), document: plain },
    { ...note('linked-heading', 'Linked heading', noteDocumentText(linked)), document: linked }];
  const plan = await inspectMarkdownLibrary({ types: ['note'] });
  assert.deepEqual(plan.issues.map((issue) => issue.key), ['note:linked-heading']);
  const archive = await files(await exportMarkdownLibrary(plan, { selectedKeys: ['note:plain-heading'] }));
  assert.match(archive['notes/Plain heading.md'], /## Heading/u);
  await assert.rejects(exportMarkdownLibrary(plan, { selectedKeys: ['note:linked-heading'] }), { code: 'MARKDOWN_LIBRARY_UNSUPPORTED' });
});

test('safe unique paths resolve from standard Markdown across Unicode, case, reserved names and special punctuation', async (t) => {
  const f = fixture(t), titles = ['CON', 'ＣＯＮ', 'com¹', 'A', 'a', 'é', 'e\u0301', 'ＮＵＬ.md', '../#(中文)!\'*?[]', '😀'.repeat(100),
    'Reserved;@&=+$,^[]%', 'Collision#', 'Collision_', '.hidden', '．hidden'];
  f.records[TOOLS].notes = titles.map((title, index) => note(`name-${index}`, title));
  const plan = await inspectMarkdownLibrary({ types: ['note'] }); assert.deepEqual(plan.issues, []);
  const archive = await files(await exportMarkdownLibrary(plan, { selectedKeys: selectedKeys(plan) })), paths = Object.keys(archive).filter((name) => name !== 'index.md');
  assert.equal(new Set(paths.map((name) => name.normalize('NFKC').toLowerCase())).size, titles.length);
  for (const path of paths) {
    assert(path.startsWith('notes/')); assert.equal(path.split('/').length, 2); assert(path.length < 240);
    assert(encoder.encode(path.split('/')[1]).length < 200); assert(!/[<>:"\\|?*#;@&=+$,%^\[\]\u0000-\u001f]/u.test(path));
  }
  const relative = links(Lexer.lex(archive['index.md'])); assert.equal(relative.length, titles.length);
  for (const link of relative) {
    assert(Object.hasOwn(archive, decodeURIComponent(link.href)), `missing target: ${link.href}`);
    assert(Object.hasOwn(archive, decodeURI(link.href)), `URI-reserved escapes must not resolve to a different filename: ${link.href}`);
  }
  assert(relative.some((link) => /%28/u.test(link.href))); assert(!relative.some((link) => /%23/u.test(link.href)));
  assert(Object.hasOwn(archive, 'notes/Collision_.md')); assert(Object.hasOwn(archive, 'notes/Collision_ (2).md'));
  assert(Object.hasOwn(archive, 'notes/_.hidden.md')); assert(paths.every((path) => !path.split('/')[1].normalize('NFKC').startsWith('.')));
  const properties = paths.map((path) => document(archive[path]).properties.title); assert.deepEqual(properties, titles);
});

test('all domain revisions and same-revision privacy/body replacements invalidate the preview without writing data', async (t) => {
  const f = fixture(t), plan = await inspectMarkdownLibrary(), before = structuredClone(f.records);
  const changes = [() => f.records[NAV].state.revision++, () => f.records[PREFS].revision++, () => f.records[TOOLS].revision++,
    () => f.records[PREFS].privateKeys.push('note:note-public'), () => { f.records[TOOLS].notes[0].body = 'Concurrent body'; },
    () => { f.records[PREFS].library.tags[0].name = 'Renamed tag'; }];
  for (const change of changes) {
    Object.assign(f.records, structuredClone(before)); change();
    await assert.rejects(exportMarkdownLibrary(plan, { selectedKeys: selectedKeys(plan) }), { code: 'REVISION_CONFLICT' });
  }
  Object.assign(f.records, structuredClone(before));
  assert.equal((await exportMarkdownLibrary(plan, { selectedKeys: ['note:note-public'] })).count, 1, 'a failed export does not consume the retained selection plan');
  assert.equal(f.writes.mock.callCount(), 0);
});

test('final snapshot recheck rejects a bypassing privacy replacement before returning a downloadable result', async (t) => {
  const f = fixture(t), plan = await inspectMarkdownLibrary(); let navigationReads = 0;
  f.hooks.onRead = (keys) => {
    if (keys.includes(NAV) && ++navigationReads === 2) f.records[PREFS].privateKeys.push('note:note-public');
  };
  await assert.rejects(exportMarkdownLibrary(plan, { selectedKeys: ['note:note-public'] }), { code: 'REVISION_CONFLICT' });
  assert.equal(f.writes.mock.callCount(), 0); assert.equal(navigationReads, 2);
});

test('confirmed selection is captured before lock waits and forged plans/keys are refused', async (t) => {
  const f = fixture(t), plan = await inspectMarkdownLibrary();
  await assert.rejects(exportMarkdownLibrary(structuredClone(plan), { selectedKeys: ['note:note-public'] }), { code: 'MARKDOWN_LIBRARY_PREVIEW' });
  for (const keys of [[], ['note:note-private'], ['missing'], ['note:note-public', 'note:note-public']]) {
    await assert.rejects(exportMarkdownLibrary(plan, { selectedKeys: keys }), { code: 'MARKDOWN_LIBRARY_SELECTION' });
  }
  let release, entered;
  const held = new Promise((resolve) => { entered = resolve; }), gate = new Promise((resolve) => { release = resolve; });
  const blocker = f.locks.request(WRITE, async () => { entered(); await gate; }); await held;
  const selection = ['note:note-public'], pending = exportMarkdownLibrary(plan, { selectedKeys: selection }); selection[0] = 'site:site-root';
  release(); await blocker; const archive = await files(await pending);
  assert.deepEqual(Object.keys(archive), ['index.md', 'notes/Public note.md']);
});

test('large readable indexes report a preview limit and a smaller explicit selection exports successfully', async (t) => {
  const f = fixture(t); f.records[TOOLS].reading = Array.from({ length: 500 }, (_, index) => reading(`large-${index}`, `资料${index} ${'文'.repeat(180)}`));
  f.records[PREFS].library.tags = Array.from({ length: 20 }, (_, index) => ({ id: `large-tag-${index}`, name: `标签${index}${'字'.repeat(50)}` }));
  f.records[PREFS].library.items = Object.fromEntries(f.records[TOOLS].reading.map((record) => [`reading:${record.id}`, { description: '', tagIds: f.records[PREFS].library.tags.map((tag) => tag.id) }]));
  const plan = await inspectMarkdownLibrary({ types: ['reading'] }); assert.deepEqual(plan.issues, []);
  assert.equal(plan.selectionIssue.code, 'MARKDOWN_LIBRARY_LIMIT');
  await assert.rejects(exportMarkdownLibrary(plan, { selectedKeys: selectedKeys(plan) }), { code: 'MARKDOWN_LIBRARY_LIMIT' });
  const result = await exportMarkdownLibrary(plan, { selectedKeys: selectedKeys(plan).slice(0, 5) }); assert.equal(result.count, 5);
  const archive = await files(result); assert(Object.values(archive).every((text) => encoder.encode(text).length <= MARKDOWN_LIBRARY_LIMITS.fileBytes));
  assert.equal(f.writes.mock.callCount(), 0);
});

test('unavailable locks and invalid preview filter options fail closed', async (t) => {
  const f = fixture(t);
  for (const options of [{ types: ['site', 'site'] }, { types: ['folder'] }, { types: 'note' }, { snapshot: {} }]) {
    await assert.rejects(inspectMarkdownLibrary(options), { code: 'MARKDOWN_LIBRARY_SELECTION' });
  }
  navigator.locks = undefined;
  await assert.rejects(inspectMarkdownLibrary(), { code: 'LOCK_UNAVAILABLE' }); assert.equal(f.writes.mock.callCount(), 0);
});
