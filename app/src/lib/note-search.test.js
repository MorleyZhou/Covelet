import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { findNoteMatches, findRenderedNoteMatches, matchedNoteSearchTerms, noteSearchTerms } from './note-search.js';

test('terms use existing NFKC/case/whitespace semantics and remain bounded literal data', () => {
  assert.deepEqual(noteSearchTerms('  ＡＢＣ\nabc 项目\t资料 '), ['abc', '项目', '资料']);
  assert.deepEqual(noteSearchTerms(['Alpha', 'ＢＥＴＡ Alpha']), ['alpha', 'beta']);
  assert.deepEqual(noteSearchTerms([]), []); assert.deepEqual(noteSearchTerms(undefined), []);
  assert.deepEqual(noteSearchTerms(['ok', null]), []);
  assert.deepEqual(noteSearchTerms('x'.repeat(2001)), []);
  assert.deepEqual(noteSearchTerms(Array.from({ length: 65 }, (_, index) => `term${index}`)), []);
  assert.deepEqual(noteSearchTerms('<script> [x].*'), ['<script>', '[x].*']);
});

test('normalized matches map back to full original graphemes and UTF-16 boundaries', () => {
  const body = 'ＡＢＣ ﬁ e\u0301 İ 🤖 café';
  const original = body;
  const result = findNoteMatches(body, ['abc', 'fi', 'é', 'i', '🤖']);
  assert.deepEqual(result.matches.map(({ start, end }) => body.slice(start, end)), ['ＡＢＣ', 'ﬁ', 'e\u0301', 'İ', '🤖', 'é']);
  assert.equal(body, original); assert.equal(result.truncated, false);
  for (const match of result.matches) assert.ok(match.start >= 0 && match.end <= body.length && match.start < match.end);
});

test('whole-string lowercase preserves contextual Greek final sigma matching', () => {
  const body = 'ΟΣ ος οσ';
  assert.deepEqual(findNoteMatches(body, 'ΟΣ').matches.map(({ start, end }) => body.slice(start, end)), ['ΟΣ', 'ος']);
});

test('body token selection excludes title or metadata-only words with one normalization pass', () => {
  assert.deepEqual(matchedNoteSearchTerms('ＡＢＣ e\u0301 项目', 'abc é 标签 资料'), ['abc', 'é']);
  assert.deepEqual(matchedNoteSearchTerms('正文', ['title', 'alias']), []);
  assert.deepEqual(matchedNoteSearchTerms(null, ['title']), []);
});

test('results are ordered, overlapping source ranges are merged, and count is bounded', () => {
  assert.deepEqual(findNoteMatches('abc abc', ['bc', 'ab', 'abc']).matches.map(({ start, end }) => [start, end]), [[0, 3], [4, 7]]);
  const result = findNoteMatches('foo foo foo foo', 'foo', { limit: 2 });
  assert.deepEqual(result.matches.map(({ start, end }) => [start, end]), [[0, 3], [4, 7]]);
  assert.equal(result.truncated, true);
  assert.equal(findNoteMatches('foo foo', 'foo', { limit: 2 }).truncated, false);
  assert.equal(findNoteMatches('foo', []).matches.length, 0);
});

test('DOM ranges cross inline formatting, respect block breaks, and ignore UI/hidden attributes', () => {
  const window = new JSDOM('<div class="ProseMirror"><p>Ａ<b>Ｂ</b>Ｃ &lt;img&gt;</p><p>next<br>line</p><button>private-button</button><p hidden>private-hidden</p><p aria-hidden="true">private-aria</p><p title="private-attribute">shown</p></div>').window;
  const root = window.document.querySelector('.ProseMirror'), before = root.outerHTML;
  const selection = window.getSelection(), selected = window.document.createRange();
  selected.selectNodeContents(root.querySelector('b')); selection.addRange(selected);
  const priorSelection = selection.toString();
  const result = findRenderedNoteMatches(root, ['abc', '<img>', 'next', 'private-button', 'private-hidden', 'private-aria', 'private-attribute']);
  assert.deepEqual(result.matches.map(({ range }) => range.toString()), ['ＡＢＣ', '<img>', 'next']);
  assert.equal(findRenderedNoteMatches(root, 'nextline').matches.length, 0);
  assert.equal(root.outerHTML, before); assert.equal(selection.toString(), priorSelection);
  assert.equal(root.querySelectorAll('mark').length, 0);
  window.close();
});

test('a hidden ancestor prevents all rendered matches, including stale retained editor DOM', () => {
  const window = new JSDOM('<div aria-hidden="true"><div class="ProseMirror"><p>Secret</p></div></div>').window;
  assert.equal(findRenderedNoteMatches(window.document.querySelector('.ProseMirror'), 'secret').matches.length, 0);
  assert.equal(findRenderedNoteMatches(null, 'secret').matches.length, 0);
  window.close();
});
