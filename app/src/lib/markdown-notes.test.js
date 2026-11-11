import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { unzipSync, strFromU8 } from 'fflate';
import { localData } from './local-data.js';
import { inspectMarkdownNotes, importMarkdownNotes, exportMarkdownNotes } from './markdown-notes.js';
import { loadPersonalTools, validatePersonalTools, exportPersonalTools, importPersonalTools } from './personal-tools.js';
import { noteDocumentText } from './note-document.js';

const TOOLS = 'covelet.tools.v1', PREFS = 'covelet.content.preferences.v1';
let values, writes, reads, held, commitLocks;
const emptyTools = () => ({ version: 3, revision: 0, notes: [], reading: [], snapshots: [], trash: [] });
const emptyPrefs = () => ({ version: 1, revision: 0, aliases: {}, privateKeys: [], presentation: false });
const file = (text, name = 'note.md') => { const blob = new Blob([text]); Object.defineProperty(blob, 'name', { value: name }); return blob; };
const baseline = () => ({ expectedRevision: values.get(TOOLS)?.revision ?? 0, expectedPreferencesRevision: values.get(PREFS)?.revision ?? 0 });
const exportOptions = (notes) => ({ ...baseline(), expectedRecordRevisions: Object.fromEntries(notes.map((note) => [note.id, note.revision])) });
const plainNote = (id, title = id, body = '') => ({ id, title, body, pinned: false, revision: 1, createdAt: 1, updatedAt: 1 });
beforeEach((t) => {
  values = new Map(); writes = []; reads = []; held = []; commitLocks = [];
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator'), queues = new Map();
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks: { request(name, options, callback) {
    const action = callback || options;
    const promise = (queues.get(name) || Promise.resolve()).then(async () => {
      held.push(name); try { return await action(); } finally { assert.equal(held.pop(), name); }
    });
    queues.set(name, promise.catch(() => {})); return promise;
  } } } });
  t.after(() => Object.defineProperty(globalThis, 'navigator', descriptor));
  t.mock.method(localData, 'get', async (requested) => {
    reads.push(requested);
    const keys = requested == null ? [...values.keys()] : Array.isArray(requested) ? requested : [requested];
    return structuredClone(Object.fromEntries(keys.filter((key) => values.has(key)).map((key) => [key, values.get(key)])));
  });
  t.mock.method(localData, 'set', async (patch) => {
    assert.equal(held.at(-1), TOOLS); writes.push(structuredClone(patch)); commitLocks.push([...held]);
    for (const [key, value] of Object.entries(patch)) values.set(key, structuredClone(value));
  });
});

test('Markdown preview is immutable and read-only, with explicit remote and relative image link conversions', async (t) => {
  const network = t.mock.method(globalThis, 'fetch', async () => { throw Error('No network is allowed'); });
  const plan = await inspectMarkdownNotes([file('# Real title\n\nBefore.\n\n![Remote](https://images.example.test/p.png)\n\n![Local](./images/local.png)\n\n# Body heading', 'fallback.md')]);
  assert.equal(plan.count, 1); assert.equal(plan.convertedImages, 2); assert.equal(plan.entries[0].convertedImages, 2);
  assert.equal(plan.entries[0].title, 'Real title'); assert.match(plan.entries[0].excerpt, /https:\/\/images.example.test\/p.png.*\.\/images\/local.png/);
  assert(Object.isFrozen(plan)); assert(Object.isFrozen(plan.entries)); assert(Object.isFrozen(plan.entries[0]));
  assert.equal(reads.length, 0); assert.equal(writes.length, 0); assert.equal(network.mock.callCount(), 0);
  const result = await importMarkdownNotes(plan, baseline());
  const imported = (await loadPersonalTools()).notes[0];
  assert.deepEqual(result.ids, [imported.id]); assert.equal(imported.title, 'Real title'); assert.match(imported.body, /Body heading/);
  assert(!JSON.stringify(imported.document).includes('"type":"image"')); assert.equal(imported.body, noteDocumentText(imported.document));
  assert.equal(writes.length, 1); assert.deepEqual(Object.keys(writes[0]), [TOOLS]);
  assert.deepEqual(commitLocks[0], [PREFS, TOOLS]);
  assert.equal(network.mock.callCount(), 0);
  await assert.rejects(importMarkdownNotes(plan, baseline()), /预览已失效/);
});

test('Markdown title, links, tasks and common formatting round-trip through one note and tools backup', async () => {
  const source = '# Title *characters*\n\n## Section\n\nA **bold** and *italic* [link](https://example.test/?q=1#part).\n\n- item\n\n- [x] finished\n- [ ] next\n\n> Quote\n\n```js\nconst n = 1;\n```';
  await importMarkdownNotes(await inspectMarkdownNotes([file(source)]), baseline());
  const note = (await loadPersonalTools()).notes[0], output = await exportMarkdownNotes([note.id], exportOptions([note]));
  assert.equal(output.filename, 'Title characters.md'); assert.match(output.blob.type, /text\/markdown/);
  const exported = await output.blob.text(); assert.match(exported, /^# Title characters\n/u);
  const preview = await inspectMarkdownNotes([file(exported, output.filename)]);
  await importMarkdownNotes(preview, baseline());
  const notes = (await loadPersonalTools()).notes;
  assert.equal(notes[1].title, notes[0].title); assert.equal(notes[1].body, notes[0].body); assert.notEqual(notes[1].id, notes[0].id);
  const backup = await exportPersonalTools(); values.clear(); await importPersonalTools(backup);
  assert.deepEqual((await loadPersonalTools()).notes, notes);
});

test('a batch creates fresh identities and exports safe unique flat ZIP names', async () => {
  values.set(TOOLS, { ...emptyTools(), notes: [plainNote('existing', 'Same')] });
  await importMarkdownNotes(await inspectMarkdownNotes([file('# Same\n\nOne', 'same.md'), file('# Same\n\nTwo', 'same.md'), file('# CON\n\nThree')]), baseline());
  const data = await loadPersonalTools(); assert.equal(data.notes.length, 4); assert.equal(data.notes[0].id, 'existing');
  assert.equal(new Set(data.notes.map((note) => note.id)).size, 4); assert.equal(writes.length, 1);
  const result = await exportMarkdownNotes(data.notes.map((note) => note.id), exportOptions(data.notes));
  assert.equal(result.filename, 'Covelet-notes.zip');
  const archive = unzipSync(new Uint8Array(await result.blob.arrayBuffer()));
  assert.deepEqual(Object.keys(archive), ['Same.md', 'Same (2).md', 'Same (3).md', '_CON.md']);
  assert(Object.values(archive).every((bytes) => strFromU8(bytes).startsWith('# ')));
  assert.equal(writes.length, 1);
});

test('UTF-8, input size, unsupported content and document limits fail before any storage activity', async () => {
  for (const files of [[], Array.from({ length: 51 }, () => file('a')), [file(new Uint8Array(512 * 1024 + 1))],
    Array.from({ length: 11 }, () => file(new Uint8Array(512 * 1024))), [file(new Uint8Array([0xff]))], [file('<script>alert(1)</script>')],
    [file('| A | B |\n|---|---|\n| 1 | 2 |')], [file('a'.repeat(60001))], [file('hello', 'note.txt')],
    [file('![bad](javascript:alert(1))')], [file('![bad](blob:https://example.test/abc)')], [file('![bad](data:image/png;base64,AAAA)')]]) {
    await assert.rejects(inspectMarkdownNotes(files));
  }
  assert.equal(reads.length, 0); assert.equal(writes.length, 0);
  await assert.rejects(inspectMarkdownNotes([file('safe', 'a.md'), file('<script>x</script>', 'bad.md')]), (reason) => reason.filename === 'bad.md');
});

test('stale baselines, forged previews, note capacity and failed storage leave the entire batch unchanged', async (t) => {
  const plan = await inspectMarkdownNotes([file('# New\n\nA'), file('# New\n\nB')]);
  await assert.rejects(importMarkdownNotes(structuredClone(plan), baseline()), /预览已失效/);
  values.set(PREFS, { ...emptyPrefs(), revision: 1 });
  await assert.rejects(importMarkdownNotes(plan, { expectedRevision: 0, expectedPreferencesRevision: 0 }), { code: 'REVISION_CONFLICT' });
  values.set(TOOLS, { ...emptyTools(), revision: 1 });
  await assert.rejects(importMarkdownNotes(plan, { expectedRevision: 0, expectedPreferencesRevision: 1 }), { code: 'REVISION_CONFLICT' });
  values.set(TOOLS, validatePersonalTools({ ...emptyTools(), notes: Array.from({ length: 199 }, (_, i) => plainNote(`old-${i}`)) }));
  let before = structuredClone(values);
  await assert.rejects(importMarkdownNotes(plan, baseline())); assert.deepEqual(values, before); assert.equal(writes.length, 0);
  values.set(TOOLS, emptyTools()); before = structuredClone(values);
  const failed = t.mock.method(localData, 'set', async () => { throw Error('synthetic failed commit'); });
  await assert.rejects(importMarkdownNotes(plan, baseline()), /未能保存/); assert.deepEqual(values, before); failed.mock.restore();
  const results = await Promise.allSettled([importMarkdownNotes(plan, baseline()), importMarkdownNotes(plan, baseline())]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1); assert.equal(writes.length, 1);
});

test('export rejects fresh private markings even while unlocked and enforces frozen record and global revisions', async () => {
  values.set(TOOLS, { ...emptyTools(), notes: [plainNote('public'), plainNote('private')] });
  values.set(PREFS, { ...emptyPrefs(), privateKeys: ['note:private'] });
  const notes = (await loadPersonalTools()).notes, options = exportOptions(notes), before = structuredClone(values);
  await assert.rejects(exportMarkdownNotes(['public', 'private'], options), { code: 'PRIVACY_LOCKED' });
  await assert.rejects(exportMarkdownNotes(['public'], { ...exportOptions([notes[0]]), expectedPreferencesRevision: 99 }), { code: 'REVISION_CONFLICT' });
  await assert.rejects(exportMarkdownNotes(['public'], { ...exportOptions([notes[0]]), expectedRecordRevisions: { public: 99 } }), { code: 'REVISION_CONFLICT' });
  await assert.rejects(exportMarkdownNotes(['public'], { ...exportOptions([notes[0]]), expectedRevision: 99 }), { code: 'REVISION_CONFLICT' });
  assert.deepEqual(values, before); assert.equal(writes.length, 0);
});

test('complex blocks and existing images reject the whole export and read-only export never prunes trash', async () => {
  const image = { type: 'doc', content: [{ type: 'image', attrs: { src: 'https://example.test/image.png', alt: 'Image' } }] };
  const callout = { type: 'doc', content: [{ type: 'callout', attrs: { tone: 'info' }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Important' }] }] }] };
  for (const document of [image, callout]) {
    const notes = [plainNote('public'), { ...plainNote('rich'), document, body: noteDocumentText(document) }];
    values.set(TOOLS, validatePersonalTools({ ...emptyTools(), notes }));
    await assert.rejects(exportMarkdownNotes(['public', 'rich'], exportOptions(notes)), /完整备份/);
    assert.equal(writes.length, 0);
  }
  const note = plainNote('public', 'Public', 'Plain text');
  values.set(TOOLS, { ...emptyTools(), notes: [note], trash: [{ id: 'expired', kind: 'notes', deletedAt: 1, record: plainNote('old') }] });
  const before = structuredClone(values);
  await exportMarkdownNotes(['public'], exportOptions([note]));
  assert.deepEqual(values, before); assert.equal(writes.length, 0);
});
