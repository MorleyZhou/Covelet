import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createEmptyState, createDemoState, normalizeUrl, validateProviderTemplate, buildProviderUrl,
  validateState, migrateWallpaperState, migrateNavigationState, searchEntries, moveEntry, combineEntries, deleteEntry, applyBookmarkImport, letterIcon,
} from './model.js';

const roots = (state) => state.entries.filter((entry) => entry.parentId === null).sort((a, b) => a.order - b.order);
const children = (state, id) => state.entries.filter((entry) => entry.parentId === id).sort((a, b) => a.order - b.order);

function legacyGroups() {
  const state = createDemoState();
  state.groups = [{ id: 'old-design', name: '设计' }, { id: 'old-dev', name: '开发' }];
  const design = new Set(['site-figma', 'site-mdn', 'site-bilibili']);
  const orders = { 'old-design': 0, 'old-dev': 0 };
  for (const entry of roots(state)) {
    entry.groupId = design.has(entry.id) ? 'old-design' : 'old-dev';
    entry.order = orders[entry.groupId]++;
  }
  for (const entry of state.entries) if (entry.parentId !== null) entry.groupId = 'old-dev';
  return validateState(state);
}

test('空状态用于迁移和同步，历史测试示例不包含可切换分组', () => {
  const empty = createEmptyState();
  assert.equal(empty.groups.length, 1);
  assert.equal(empty.groups[0].name, '桌面');
  assert.equal(empty.entries.length, 0);
  assert.deepEqual(empty.providers.map((provider) => provider.id), ['bing', 'google', 'duckduckgo']);
  assert.deepEqual(empty.settings.background, { kind: 'bing', value: 'daily' });
  assert.deepEqual(validateState(empty), empty);
  const demo = createDemoState();
  assert.deepEqual(demo.groups, empty.groups);
  assert.equal(demo.entries.filter((entry) => entry.groupId === 'group-home' && entry.parentId === null).length, 6);
  assert.equal(demo.entries.filter((entry) => entry.parentId === 'folder-docs').length, 2);
  empty.settings.theme = 'dark';
  assert.equal(createEmptyState().settings.theme, 'system');
});

test('每行数量默认八列，旧配置补齐且不改变其他布局，拒绝范围外与非整数值', () => {
  assert.equal(createEmptyState().settings.columns, 8);
  const legacy = createDemoState();
  delete legacy.settings.columns;
  legacy.settings.iconSize = 108;
  legacy.settings.width = 1300;
  legacy.settings.showClock = false;
  const before = structuredClone(legacy);
  const migrated = migrateNavigationState(JSON.parse(JSON.stringify(legacy)));
  assert.equal(migrated.settings.columns, 8);
  assert.deepEqual(migrated.settings, { ...before.settings, columns: 8 });
  assert.deepEqual(legacy, before, 'migration must not mutate the source configuration');
  for (const columns of [2, 6, 12]) {
    assert.equal(validateState({ ...migrated, settings: { ...migrated.settings, columns } }).settings.columns, columns);
  }
  for (const columns of [1, 13, 8.5, '8', null, undefined, NaN, Infinity]) {
    assert.throws(() => validateState({ ...migrated, settings: { ...migrated.settings, columns } }), /每行图标数量/u);
  }
});

test('每日背景只保存来源选项，旧用户壁纸迁移且保留本地图标', () => {
  const state = createDemoState();
  state.settings.background = { kind: 'image', value: 'old-wallpaper' };
  state.entries[0].icon = { kind: 'image', value: 'local-icon' };
  const migrated = migrateWallpaperState(state);
  assert.deepEqual(migrated.settings.background, { kind: 'bing', value: 'daily' });
  assert.deepEqual(migrated.entries[0].icon, state.entries[0].icon);
  assert.equal(state.settings.background.value, 'old-wallpaper');
  for (const value of ['https://tracker.test/a.jpg', 'other', '']) {
    assert.throws(() => validateState({ ...migrated, settings: { ...migrated.settings, background: { kind: 'bing', value } } }));
  }
});

test('视觉增强默认开启，严格迁移旧开关且保留明确选择、手动外观和原图引用', () => {
  const empty = createEmptyState();
  assert.equal(empty.settings.visualEnhancement, true);
  assert.equal(Object.hasOwn(empty.settings, 'adaptiveWallpaper'), false);
  assert.equal(Object.hasOwn(empty.settings, 'adaptIcons'), false);
  const legacy = createDemoState();
  delete legacy.settings.visualEnhancement;
  legacy.settings.theme = 'dark';
  legacy.settings.shade = 47;
  legacy.settings.background = { kind: 'gradient', value: 'linear-gradient(120deg, #123456, #abcdef)' };
  legacy.entries[0].icon = { kind: 'image', value: 'original-local-icon' };
  legacy.entries[0].iconBackground = '#1234aB';
  const before = structuredClone(legacy);
  const migrated = migrateNavigationState(legacy);
  assert.deepEqual(migrated, { ...before, settings: { ...before.settings, visualEnhancement: true } });
  assert.deepEqual(legacy, before, 'filling new switches must not mutate the source configuration');
  assert.deepEqual(migrateNavigationState(migrated), migrated);
  for (const adaptiveWallpaper of [false, true]) for (const adaptIcons of [false, true]) {
    const input = { ...before, settings: { ...before.settings, adaptiveWallpaper, adaptIcons } };
    assert.deepEqual(validateState(input), { ...before, settings: { ...before.settings, visualEnhancement: adaptiveWallpaper || adaptIcons } });
    for (const visualEnhancement of [false, true]) {
      const explicit = { ...input, settings: { ...input.settings, visualEnhancement } };
      assert.deepEqual(validateState(explicit), { ...before, settings: { ...before.settings, visualEnhancement } },
        'an explicit unified choice wins over both legacy flags');
    }
  }
  for (const key of ['visualEnhancement', 'adaptiveWallpaper', 'adaptIcons']) {
    for (const value of ['true', 'false', 0, 1, null, undefined, {}, []]) {
      assert.throws(() => validateState({ ...migrated, settings: { ...migrated.settings, [key]: value } }), new RegExp(`${key}须为开关值`, 'u'));
    }
  }
  for (const key of ['palette', 'wallpaperPixels', 'adaptedIcon']) {
    assert.throws(() => validateState({ ...migrated, settings: { ...migrated.settings, [key]: [] } }), /未知字段/u,
      'derived image results do not belong in portable configuration');
  }
});

test('网站图标兼容合法旧预设为名称文字，独立背景颜色只接受六位颜色', () => {
  const legacy = createDemoState();
  legacy.entries[0].name = '🌎指南';
  legacy.entries[0].icon = { kind: 'preset', value: 'github' };
  legacy.entries[0].iconBackground = '#Aa12fF';
  legacy.entries[1].icon = { kind: 'image', value: 'kept-local-icon' };
  const before = structuredClone(legacy);
  const migrated = migrateNavigationState(JSON.parse(JSON.stringify(legacy)));
  assert.deepEqual(migrated.entries[0].icon, { kind: 'letter', value: '🌎指' });
  assert.equal(migrated.entries[0].iconBackground, '#Aa12fF');
  assert.deepEqual(migrated.entries[1].icon, legacy.entries[1].icon);
  assert.equal(Object.hasOwn(migrated.entries[1], 'iconBackground'), false, 'default color is presentation, not an unnecessary stored field');
  assert.deepEqual(legacy, before);
  assert.deepEqual(letterIcon('  中文文档  '), { kind: 'letter', value: '中文' });
  assert.deepEqual(letterIcon(''), { kind: 'letter', value: '网' });
  assert.deepEqual(migrateNavigationState(migrated), migrated);
  const unknown = structuredClone(legacy); unknown.entries[0].icon.value = 'untrusted-brand';
  assert.throws(() => validateState(unknown), /预设图标/u);
  for (const color of ['#fff', '#12345678', 'red', 'url(https://tracker.test)', ' #123456', null, 123456, undefined]) {
    const bad = structuredClone(migrated); bad.entries[0].iconBackground = color;
    assert.throws(() => validateState(bad), /图标背景色/u);
  }
});

test('允许删除全部额外引擎，浏览器默认搜索不伪装成持久化模板', () => {
  const state = createEmptyState();
  assert.equal(state.providers.some((provider) => provider.id === 'browser'), false);
  state.providers = [];
  const checked = validateState(state);
  assert.deepEqual(checked.providers, []);
  assert.equal(Object.hasOwn(checked.settings, 'providerId'), false);
  assert.equal(Object.hasOwn(checked.settings, 'selectedProviderId'), false);
  assert.deepEqual(validateState(JSON.parse(JSON.stringify(checked))), checked);
  assert.throws(() => validateState({ ...checked, providers: [{ id: 'browser', name: '冒充默认搜索', template: 'https://example.com/?q={query}' }] }), /浏览器默认搜索/);
});

test('规范化后移除未实质修改的旧百度预置，保留真正自定义搜索且重复迁移幂等', () => {
  const builtin = { id: 'baidu', name: '百度', template: 'https://www.baidu.com/s?wd={query}' };
  const legacy = createEmptyState(); legacy.providers.unshift(builtin);
  const original = structuredClone(legacy);
  assert.deepEqual(migrateNavigationState(legacy).providers, createEmptyState().providers);
  assert.deepEqual(legacy, original, 'legacy loading must not mutate the supplied configuration');
  for (const custom of [
    { ...builtin, id: 'my-baidu' },
    { ...builtin, name: '我的百度' },
    { ...builtin, template: 'https://www.baidu.com/s?wd={query}&source=custom' },
    { ...builtin, template: 'https://search.example.com/?q={query}' },
  ]) {
    const input = createEmptyState(); input.providers.unshift(custom);
    const active = migrateNavigationState(input);
    assert.deepEqual(active.providers[0], custom);
    assert.deepEqual(validateState(validateState(active)), active, 'a retained custom search cannot disappear on the next load');
  }
  const onlyBuiltin = { ...legacy, providers: [builtin] };
  assert.deepEqual(migrateNavigationState(onlyBuiltin).providers, []);
  assert.deepEqual(migrateNavigationState(migrateNavigationState(legacy)).providers, createEmptyState().providers);
  const cosmeticBuiltin = { ...builtin, name: ' 百度 ', template: ' https://www.baidu.com:443/s?wd={query} ' };
  const cosmeticState = { ...legacy, providers: [cosmeticBuiltin] };
  const cosmeticActive = validateState(cosmeticState);
  assert.deepEqual(cosmeticActive.providers, [], 'whitespace and a default HTTPS port do not turn the old built-in into a custom provider');
  assert.deepEqual(validateState(validateState(cosmeticActive)), cosmeticActive);
  const customState = { ...legacy, providers: [{ ...cosmeticBuiltin, id: 'custom-search-42' }] };
  const customActive = validateState(customState);
  assert.deepEqual(customActive.providers, [{ ...builtin, id: 'custom-search-42' }], 'a user-created identifier survives even when its search URL is otherwise the same');
  assert.deepEqual(validateState(validateState(customActive)), customActive);
  assert.deepEqual(cosmeticState.providers, [cosmeticBuiltin], 'normalization never mutates the original archive or configuration');
});

test('网址补全与协议、凭据及畸形输入校验', () => {
  assert.equal(normalizeUrl('example.com/docs?q=中文#part'), 'https://example.com/docs?q=%E4%B8%AD%E6%96%87#part');
  assert.equal(normalizeUrl('http://localhost:3000/path'), 'http://localhost:3000/path');
  assert.equal(normalizeUrl('example.com:8080/path'), 'https://example.com:8080/path');
  assert.equal(normalizeUrl('https://例子.中国'), 'https://xn--fsqu00a.xn--fiqs8s/');
  for (const value of ['javascript:alert(1)', 'data:text/html,x', 'file:///a', 'ftp://example.com', '//example.com', 'https://user:pass@example.com', 'https://example.com\\@evil.test', 'not an address', 'localhost', 'https://bad_host.test']) {
    assert.throws(() => normalizeUrl(value), undefined, value);
  }
});

test('搜索模板固定 origin，占位符只在路径或查询值中', () => {
  const template = validateProviderTemplate('https://example.com/search?q={query}&source=own');
  const result = new URL(buildProviderUrl(template, '中文 &x=1/#?@evil.test'));
  assert.equal(result.origin, 'https://example.com');
  assert.equal(result.searchParams.get('q'), '中文 &x=1/#?@evil.test');
  assert.equal(result.searchParams.get('source'), 'own');
  assert.equal(buildProviderUrl('https://example.com/search/{query}', 'a/b?c'), 'https://example.com/search/a%2Fb%3Fc');
  assert.equal(validateProviderTemplate('https://example.com/owntabqueryplaceholder?q={query}'), 'https://example.com/owntabqueryplaceholder?q={query}');
  assert.throws(() => buildProviderUrl('https://example.com/{query}', '..'));
  assert.throws(() => validateProviderTemplate('https://example.com/{query}/../fixed'), /占位符/);
  for (const value of ['https://{query}.example.com/', 'https://example.com/?{query}=x', 'https://example.com/#{query}', 'https://example.com/', 'https://example.com/?q={query}&x={query}', 'https://user:pass@example.com/?q={query}', 'javascript:{query}']) {
    assert.throws(() => validateProviderTemplate(value), undefined, value);
  }
});

test('旧多组按组顺序合并到桌面，完整保留文件夹、子项和本地图标且迁移幂等', () => {
  const state = legacyGroups();
  state.entries[0].icon = { kind: 'image', value: 'local-icon' };
  state.settings.background = { kind: 'image', value: 'old-wallpaper' };
  const before = structuredClone(state);
  const next = migrateNavigationState(state);
  assert.deepEqual(state, before);
  assert.equal(next.revision, state.revision);
  assert.deepEqual(next.groups, [{ id: 'group-home', name: '桌面' }]);
  assert.deepEqual(roots(next).map((entry) => entry.id), ['site-figma', 'site-mdn', 'site-bilibili', 'site-github', 'site-notion', 'folder-docs']);
  assert.deepEqual(children(next, 'folder-docs').map((entry) => entry.id), ['site-react', 'site-vite']);
  assert.equal(next.entries.length, state.entries.length);
  assert.deepEqual(next.entries[0].icon, state.entries[0].icon);
  assert.deepEqual(next.entries.map((entry) => entry.url), state.entries.map((entry) => entry.url));
  assert.ok(next.entries.every((entry) => entry.groupId === 'group-home'));
  assert.deepEqual(next.settings.background, { kind: 'bing', value: 'daily' });
  assert.deepEqual(migrateNavigationState(next), next);
});

test('进出文件夹与同容器重排保持每个容器连续顺序', () => {
  let state = createDemoState();
  state = moveEntry(state, 'site-github', { groupId: 'group-home', parentId: 'folder-docs', index: 1 });
  assert.deepEqual(state.entries.filter((entry) => entry.parentId === 'folder-docs').sort((a, b) => a.order - b.order).map((entry) => entry.id), ['site-react', 'site-github', 'site-vite']);
  state = moveEntry(state, 'site-github', { groupId: 'group-home', index: 0 });
  state = moveEntry(state, 'site-github', { groupId: 'group-home', index: 5 });
  assert.equal(state.entries.find((entry) => entry.id === 'site-github').order, 5);
  assert.doesNotThrow(() => validateState(state));
});

test('删除文件夹原地展开子项，删除网址后重新编号', () => {
  const state = createDemoState();
  const next = deleteEntry(state, 'folder-docs');
  const items = next.entries.filter((entry) => entry.groupId === 'group-home' && entry.parentId === null).sort((a, b) => a.order - b.order);
  assert.deepEqual(items.slice(-2).map((entry) => entry.id), ['site-react', 'site-vite']);
  assert.equal(state.entries.some((entry) => entry.id === 'folder-docs'), true);
  assert.equal(next.entries.some((entry) => entry.id === 'folder-docs'), false);
  assert.doesNotThrow(() => validateState(deleteEntry(next, 'site-react')));
});

test('桌面图标合并在目标位置创建文件夹，拖入已有文件夹且保持输入与其他位置', () => {
  const state = createDemoState(), before = structuredClone(state);
  let next = combineEntries(state, 'site-github', 'site-notion', { folderId: 'folder-new', name: '工具' });
  assert.deepEqual(state, before);
  assert.equal(next.revision, 1);
  assert.deepEqual(roots(next).map((entry) => entry.id), ['site-figma', 'folder-new', 'site-mdn', 'site-bilibili', 'folder-docs']);
  assert.deepEqual(children(next, 'folder-new').map((entry) => entry.id), ['site-notion', 'site-github']);
  assert.equal(next.entries.find((entry) => entry.id === 'folder-new').name, '工具');
  next = combineEntries(next, 'site-bilibili', 'folder-new');
  assert.equal(next.revision, 2);
  assert.deepEqual(children(next, 'folder-new').map((entry) => entry.id), ['site-notion', 'site-github', 'site-bilibili']);
  assert.doesNotThrow(() => validateState(next));
  assert.throws(() => combineEntries(state, 'site-github', 'site-github', { folderId: 'x' }), /自身/);
  assert.throws(() => combineEntries(state, 'folder-docs', 'site-github', { folderId: 'x' }), /文件夹/);
  assert.throws(() => combineEntries(state, 'site-react', 'site-github', { folderId: 'x' }), /同一个容器/);
  assert.throws(() => combineEntries(state, 'site-github', 'site-figma', { folderId: 'folder-docs' }), /已存在/);
  assert.throws(() => moveEntry(state, 'folder-docs', { parentId: 'folder-docs' }), /文件夹/);
  assert.throws(() => moveEntry(state, 'site-github', { groupId: 'old-group' }), /桌面/);
});

test('文件夹内部拖放只重排，移出或删除倒数第二项自动在原位展开最后一项', () => {
  const state = createDemoState();
  const reordered = combineEntries(state, 'site-vite', 'site-react');
  assert.deepEqual(children(reordered, 'folder-docs').map((entry) => entry.id), ['site-vite', 'site-react']);
  assert.equal(reordered.entries.filter((entry) => entry.type === 'folder').length, 1);
  const moved = moveEntry(state, 'site-react', { index: 0 });
  assert.equal(moved.entries.some((entry) => entry.id === 'folder-docs'), false);
  assert.deepEqual(roots(moved).map((entry) => entry.id), ['site-react', 'site-github', 'site-figma', 'site-notion', 'site-mdn', 'site-bilibili', 'site-vite']);
  const removed = deleteEntry(state, 'site-react');
  assert.equal(removed.entries.some((entry) => entry.id === 'folder-docs'), false);
  assert.equal(roots(removed).at(-1).id, 'site-vite');
  const oneChild = structuredClone(state);
  oneChild.entries = oneChild.entries.filter((entry) => entry.id !== 'site-vite');
  const emptied = moveEntry(oneChild, 'site-react', { index: 0 });
  assert.equal(emptied.entries.some((entry) => entry.id === 'folder-docs'), false);
  assert.equal(emptied.entries.length, 6);
  assert.doesNotThrow(() => validateState(emptied));
});

test('导入按目标容器去重，多次导入复用文件夹，不修改原数据', () => {
  const state = createEmptyState();
  const plan = { folders: [{ name: '开发 / 文档', originalPath: '开发 / 文档' }], sites: [
    { name: '根网址', url: 'https://example.com', folder: null },
    { name: '根网址重复', url: 'https://example.com/', folder: null },
    { name: '文件夹网址', url: 'https://example.com/', folder: '开发 / 文档' },
  ] };
  const first = applyBookmarkImport(state, plan, 'group-home');
  assert.equal(state.entries.length, 0);
  assert.equal(first.entries.length, 3);
  const second = applyBookmarkImport(first, plan, 'group-home');
  assert.equal(second.entries.length, 3);
  assert.equal(second.entries.find((entry) => entry.type === 'folder').id, first.entries.find((entry) => entry.type === 'folder').id);
  assert.throws(() => applyBookmarkImport(state, { folders: [], sites: [{ name: '坏链接', url: 'javascript:alert(1)', folder: null }] }, 'group-home'));
  assert.throws(() => applyBookmarkImport(state, { folders: [], sites: [{ name: '坏目录', url: 'https://example.com', folder: '未知' }] }, 'group-home'));
  assert.equal(state.entries.length, 0);
});

test('严格状态校验拒绝坏引用、重复排序、危险资源与未知字段', () => {
  for (const mutate of [
    (state) => { state.entries[0].groupId = 'missing'; },
    (state) => { state.entries[0].parentId = 'missing'; },
    (state) => { state.entries[0].parentId = 'site-notion'; },
    (state) => { state.entries[6].groupId = 'group-dev'; },
    (state) => { state.entries[1].order = 0; },
    (state) => { state.entries[0].id = state.entries[1].id; },
    (state) => { state.entries[0].icon = { kind: 'image', value: 'https://tracker.test/a.png' }; },
    (state) => { state.settings.background = { kind: 'gradient', value: 'linear-gradient(red, url(https://tracker.test))' }; },
    (state) => { state.settings.background = { kind: 'gradient', value: 'linear-gradient(red,blue),\\75rl(https://tracker.test)' }; },
    (state) => { state.settings.blur = Infinity; },
    (state) => { state.telemetry = true; },
    (state) => { state.entries[0].name = 'x'.repeat(201); },
  ]) {
    const state = createDemoState(); mutate(state);
    assert.throws(() => validateState(state));
  }
});

test('本地检索仅匹配名称及域名并允许找到文件夹', () => {
  const state = createDemoState();
  assert.deepEqual(searchEntries(state, '  GITHUB ').map((entry) => entry.id), ['site-github']);
  assert.equal(searchEntries(state, 'mozilla.org')[0].id, 'site-mdn');
  assert.equal(searchEntries(state, '哔哩')[0].id, 'site-bilibili');
  assert.equal(searchEntries(state, '文档').some((entry) => entry.type === 'folder'), true);
  assert.equal(searchEntries(state, '/zh-CN/').length, 0);
  assert.equal(searchEntries(state, ' ').length, 0);
  const result = searchEntries(state, 'GitHub'); result[0].name = '已修改';
  assert.equal(state.entries[0].name, 'GitHub');
});
