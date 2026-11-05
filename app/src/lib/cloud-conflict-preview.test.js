import test from 'node:test';
import assert from 'node:assert/strict';
import { conflictRecordPreview, conflictRecordScope, conflictRecordSummary, conflictRecordImpact } from './cloud-conflict-preview.js';

test('conflict previews show both complete small records as inert text, describe Blob bytes, and bound large bodies', () => {
  assert.equal(conflictRecordPreview({ body: '<img src="https://private.test">', blob: new Blob(['sample'], { type: 'image/png' }) }),
    JSON.stringify({ body: '<img src="https://private.test">', blob: '二进制内容：6 字节，类型 image/png' }, null, 2));
  const preview = conflictRecordPreview({ body: 'a'.repeat(1000000), items: Array(100000).fill('more') });
  assert.ok(preview.length < 13000); assert.match(preview, /预览已截短/);
});

const navigation = { namespace: 'preferences', key: 'owntab.local.v1' };
const tools = { namespace: 'preferences', key: 'covelet.tools.v1' };
const version = (value) => ({ deleted: false, value });

test('navigation summaries describe the whole domain and names rather than internal record fields', () => {
  const value = { version: 1, state: { revision: 9, entries: [
    { type: 'site', name: 'Docs', url: 'https://docs.example/' },
    { type: 'folder', name: 'Work' }, { type: 'widget', name: 'Clock' },
  ] }, snapshots: [{ state: 'older' }] };
  const before = structuredClone(value), summary = conflictRecordSummary(navigation, version(value));
  assert.equal(summary.scope, '导航、文件夹与外观');
  assert.deepEqual(summary.lines, ['网站 1 个 · 文件夹 1 个 · 组件 1 个', '网站：Docs — https://docs.example/', '文件夹：Work', '组件：Clock', '还包含桌面布局、外观、搜索设置和导航历史。']);
  assert.equal(summary.partial, false);
  assert.doesNotMatch(JSON.stringify(summary), /revision|snapshots|"version"/);
  assert.match(conflictRecordImpact(navigation), /全部内容.*其他修改.*下次同步/);
  assert.deepEqual(value, before, 'display projection must not mutate the record');
  assert.equal(conflictRecordScope({ ...navigation, namespace: 'future-content' }), '扩展数据', 'key alone must not mislabel another namespace');
});

test('note and reading summaries expose meaningful differences, including titles, excerpts and retained collections', () => {
  const value = { notes: [{ title: 'Today', body: 'Changed on this device' }], reading: [{ title: 'Read this', url: 'https://reading.example/' }], trash: [{}], snapshots: [{}, {}] };
  const local = conflictRecordSummary(tools, version(value));
  const remote = conflictRecordSummary(tools, version({ ...value, notes: [{ title: 'Today', body: 'Changed on another device' }] }));
  assert.deepEqual(local.lines, ['便笺 1 条 · 稍后读 1 条', '便笺：Today — Changed on this device', '稍后读：Read this — https://reading.example/', '另含回收站 1 项和旧版快照 2 份。']);
  assert.notDeepEqual(local, remote, 'same titles with different note text must remain distinguishable');
  assert.match(conflictRecordImpact(tools), /便笺与稍后读.*全部内容/);
  const templates = conflictRecordSummary({ namespace: 'preferences', key: 'covelet.desktop-templates.v1' }, version({ templates: [{ name: 'Work' }] }));
  assert.deepEqual(templates.lines, ['桌面方案 1 个', 'Work']);
});

test('image summaries never read Blob contents, fetch media or create URLs, and state the comparison limit', () => {
  class UnreadBlob extends Blob {
    text() { throw Error('must not read'); }
    arrayBuffer() { throw Error('must not read'); }
    stream() { throw Error('must not read'); }
  }
  const originalFetch = globalThis.fetch, originalURL = URL.createObjectURL;
  globalThis.fetch = () => { throw Error('must not fetch'); };
  URL.createObjectURL = () => { throw Error('must not create media URLs'); };
  try {
    const record = { namespace: 'navigation-icons', key: 'https://private.example/image' };
    const summary = conflictRecordSummary(record, version({ blob: new UnreadBlob(['abc'], { type: 'image/png' }), width: 32, height: 64 }));
    assert.equal(summary.scope, '网站图标');
    assert.deepEqual(summary.lines, ['文件大小：3 字节 · 类型：image/png', '尺寸：32 × 64', '这里只显示文件信息，不能判断两张图片是否相同。']);
    assert.match(conflictRecordImpact(record), /这份图片或图标文件/);
    assert.doesNotMatch(JSON.stringify(summary), /https:/);
  } finally { globalThis.fetch = originalFetch; URL.createObjectURL = originalURL; }
});

test('summaries remain bounded inert text, skip accessors, and honestly mark partial and unsupported content', () => {
  const html = '<img src="https://private.example" onerror="alert(1)">';
  const value = { state: { entries: [ { type: 'site', name: html, url: 'https://example/' } ] } };
  const inert = conflictRecordSummary(navigation, version(value));
  assert.ok(inert.lines.some(line => line.includes(html)), 'untrusted markup stays text for React to escape');
  const many = conflictRecordSummary(navigation, version({ state: { entries: Array(100000).fill({ type: 'site', name: 'x'.repeat(1000000), url: 'https://example/' }) } }));
  assert.equal(many.partial, true);
  assert.ok(JSON.stringify(many).length < 6000);
  assert.match(many.lines[0], /仅列出部分/);
  assert.doesNotMatch(many.lines[0], /网站 2000 个/, 'scan limit must not be reported as the true total');
  const getter = Object.defineProperty({}, 'state', { enumerable: true, get() { throw Error('must not invoke getter'); } });
  const unknown = conflictRecordSummary(navigation, version(getter));
  assert.match(unknown.lines[0], /暂不支持.*摘要/);
  const deleted = conflictRecordSummary(tools, { deleted: true, get value() { throw Error('deleted values must not be inspected'); } });
  assert.deepEqual(deleted.lines, ['此版本已删除这组内容。采用此版本会保留删除结果。']);
  assert.doesNotThrow(() => conflictRecordPreview(getter));
  const hugeKey = { ['x'.repeat(1000000)]: 'value' };
  assert.ok(conflictRecordPreview(hugeKey).length < 1000, 'technical details also bound object keys');
});
