import test from 'node:test';
import assert from 'node:assert/strict';
import { applyRecognizedSite, fallbackSiteName, iconTextColor } from './site-form.js';

const entry = () => ({
  id: 'entry-1', type: 'site', name: '我的名称', url: 'https://www.example.com/path?private=1',
  icon: { kind: 'image', value: 'previous-icon' }, iconBackground: '#123456', order: 3,
});
const target = { entryId: 'entry-1', origin: 'https://www.example.com' };

test('recognition applies a saved image or a fresh letter fallback while preserving current edits', () => {
  const current = entry();
  const image = applyRecognizedSite(current, { title: '  官方网站  ', icon: { kind: 'image', value: 'new-icon' } }, target);
  assert.equal(image.name, '官方网站');
  assert.deepEqual(image.icon, { kind: 'image', value: 'new-icon' });
  assert.equal(image.iconBackground, '#123456');
  assert.equal(image.order, 3);
  assert.equal(current.name, '我的名称');
  const fallback = applyRecognizedSite(current, { title: '官网', icon: null }, { ...target, preserveName: true });
  assert.equal(fallback.name, '我的名称');
  assert.deepEqual(fallback.icon, { kind: 'letter', value: '我的' });
  assert.equal(fallback.iconBackground, '#123456');
  const invalidName = applyRecognizedSite(current, { title: '\u0000invalid', icon: null }, target);
  assert.equal(invalidName.name, '我的名称');
  assert.deepEqual(invalidName.icon, { kind: 'letter', value: '我的' });
  const preset = { ...current, icon: { kind: 'preset', value: 'github' } };
  assert.deepEqual(applyRecognizedSite(preset, { title: '新网站', icon: null }, target).icon, { kind: 'letter', value: '新网' });
});

test('late recognition cannot replace another entry or an entry now using another origin', () => {
  const current = entry();
  const result = { title: '旧结果', icon: { kind: 'image', value: 'late-icon' } };
  assert.equal(applyRecognizedSite(current, result, { ...target, entryId: 'entry-old' }), current);
  assert.equal(applyRecognizedSite(current, result, { ...target, origin: 'https://different.example' }), current);
  const invalid = { ...current, url: 'javascript:alert(1)' };
  assert.equal(applyRecognizedSite(invalid, result, target), invalid);
});

test('a missing optional recognition result preserves a previously acquired image for the current origin', () => {
  const current = entry();
  const kept = applyRecognizedSite(current, { title: '新名称', icon: null }, { ...target, preserveIcon: true });
  assert.deepEqual(kept.icon, current.icon);
  assert.equal(kept.name, '新名称');
  assert.equal(kept.iconBackground, '#123456');
  const other = applyRecognizedSite(current, { title: '旧结果', icon: null }, { ...target, origin: 'https://other.example', preserveIcon: true });
  assert.equal(other, current);
});

test('URL names and letter icons handle Unicode, and solid colors use the higher contrast text', () => {
  assert.equal(fallbackSiteName('www.example.com/path?private=1'), 'example.com');
  assert.equal(fallbackSiteName('http://www.example.com:8080/path'), 'example.com:8080');
  const unicode = applyRecognizedSite(entry(), { title: '𠮷🍀网站', icon: null }, target);
  assert.deepEqual(unicode.icon, { kind: 'letter', value: '𠮷🍀' });
  assert.equal(iconTextColor(), '#1d1d1f');
  assert.equal(iconTextColor('#ffffff'), '#1d1d1f');
  assert.equal(iconTextColor('#000'), '#fff');
  assert.equal(iconTextColor('#1d1d1f'), '#fff');
  assert.equal(iconTextColor('#777777'), '#fff');
  assert.equal(iconTextColor('#888888'), '#1d1d1f');
  assert.equal(iconTextColor('invalid'), '#1d1d1f');
});
