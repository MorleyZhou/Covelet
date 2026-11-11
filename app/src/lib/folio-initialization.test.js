import test from 'node:test';
import assert from 'node:assert/strict';
import { isFolioInitializationChange } from './folio-initialization.js';

const id = '16ec91cd-6831-4f36-96a0-4f91904300aa', another = '67ec91cd-6831-4f36-96a0-4f91904300bb';
const source = () => ({ type: 'doc', content: [
  { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Section' }] },
  { type: 'paragraph', content: [{ type: 'text', text: 'Link', marks: [{ type: 'link', attrs: { href: 'https://example.test/path#part' } }] }] },
  { type: 'taskList', content: [{ type: 'taskItem', attrs: { checked: false }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Task' }] }] }] },
] });
function normalized() {
  const value = source();
  value.content[0].attrs = { level: 2, folioBlockId: null, id, 'data-toc-id': id };
  value.content[1].attrs = { folioBlockId: null };
  Object.assign(value.content[1].content[0].marks[0].attrs, { target: '_blank', rel: 'noopener noreferrer nofollow', class: null, title: null });
  value.content[2].attrs = { folioBlockId: null };
  value.content[2].content[0].content[0].attrs = { folioBlockId: null };
  return value;
}

test('only the observed missing defaults and paired generated heading identity are equivalent', () => {
  const before = source(), after = normalized(), original = structuredClone(before), normalizedCopy = structuredClone(after);
  assert.equal(isFolioInitializationChange(before, after), true);
  assert.equal(isFolioInitializationChange(before, structuredClone(before)), true);
  assert.deepEqual(before, original); assert.deepEqual(after, normalizedCopy);
});

test('the first real typing, formatting, hyperlink and checkbox changes remain observable', () => {
  const cases = [
    (next) => { next.content[0].content[0].text += '!'; },
    (next) => { next.content[0].content[0].marks = [{ type: 'bold' }]; },
    (next) => { next.content[1].content[0].marks[0].attrs.href = 'https://different.test/'; },
    (next) => { next.content[2].content[0].attrs.checked = true; },
    (next) => { next.content.push({ type: 'paragraph' }); },
  ];
  for (const change of cases) { const after = normalized(); change(after); assert.equal(isFolioInitializationChange(source(), after), false); }
});

test('existing IDs and all existing attribute value changes cannot be ignored', () => {
  const before = normalized(), after = normalized(); after.content[0].attrs.id = another; after.content[0].attrs['data-toc-id'] = another;
  assert.equal(isFolioInitializationChange(before, after), false);
  const changedLevel = normalized(); changedLevel.content[0].attrs.level = 3;
  assert.equal(isFolioInitializationChange(source(), changedLevel), false);
  const explicitNull = source(); explicitNull.content[0].attrs.id = null;
  assert.equal(isFolioInitializationChange(explicitNull, normalized()), false);
  const changedTarget = normalized(); changedTarget.content[1].content[0].marks[0].attrs.target = '_self';
  assert.equal(isFolioInitializationChange(before, changedTarget), false);
});

test('different or custom heading pairs, unknown additions and removed attributes are real changes', () => {
  const wrongPair = normalized(); wrongPair.content[0].attrs['data-toc-id'] = another;
  assert.equal(isFolioInitializationChange(source(), wrongPair), false);
  const customPair = normalized(); customPair.content[0].attrs.id = 'custom'; customPair.content[0].attrs['data-toc-id'] = 'custom';
  assert.equal(isFolioInitializationChange(source(), customPair), false);
  const unknown = normalized(); unknown.content[1].attrs.textAlign = 'center';
  assert.equal(isFolioInitializationChange(source(), unknown), false);
  const removed = normalized(); delete removed.content[0].attrs.level;
  assert.equal(isFolioInitializationChange(normalized(), removed), false);
});

test('ordered-list schema defaults are equivalent only when originally missing', () => {
  const before = { type: 'doc', content: [{ type: 'orderedList', content: [{ type: 'listItem', content: [{ type: 'paragraph' }] }] }] };
  const after = structuredClone(before); after.content[0].attrs = { folioBlockId: null, start: 1, type: null }; after.content[0].content[0].content[0].attrs = { folioBlockId: null };
  assert.equal(isFolioInitializationChange(before, after), true);
  const changedStart = structuredClone(after); changedStart.content[0].attrs.start = 2;
  assert.equal(isFolioInitializationChange(before, changedStart), false);
  assert.equal(isFolioInitializationChange(after, changedStart), false);
  const changedType = structuredClone(after); changedType.content[0].attrs.type = 'a';
  assert.equal(isFolioInitializationChange(after, changedType), false);
});

test('missing heading identity defaults may be null, but existing null IDs cannot change', () => {
  const before = source(), after = normalized(); after.content[0].attrs.id = null; after.content[0].attrs['data-toc-id'] = null;
  assert.equal(isFolioInitializationChange(before, after), true);
  assert.equal(isFolioInitializationChange(after, normalized()), false);
});

test('undefined parser object keys are absent in JSON without ignoring any JSON value', () => {
  const before = { type: 'doc', content: [{ type: 'horizontalRule', content: undefined }] };
  const after = { type: 'doc', content: [{ type: 'horizontalRule', attrs: { folioBlockId: null } }] };
  assert.equal(isFolioInitializationChange(before, after), true);
  const changed = structuredClone(before); changed.content[0].content = [];
  assert.equal(isFolioInitializationChange(changed, after), false);
  const marked = { type: 'text', text: 'Code', marks: undefined };
  assert.equal(isFolioInitializationChange(marked, { type: 'text', text: 'Code' }), true);
  assert.equal(isFolioInitializationChange(marked, { type: 'text', text: 'Edited' }), false);
});
