import { test, expect } from './extension.fixture.mjs';
import { exportCompleteBackup, openRecovery, chooseBackupFile, restorePreview, revealDesktopItem } from './backup-helpers.mjs';
import { performance } from 'node:perf_hooks';
import { writeFile } from 'node:fs/promises';
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import { fromMarkdown } from '@futelab/folio/serialization';

const search = page => page.getByRole('combobox', { name: '搜索或输入网址', exact: true });
const editor = dialog => dialog.locator('.folio-note-editor [contenteditable="true"]');
const pad = value => String(value).padStart(4, '0');
const siteURL = index => `https://bench.example/site/${pad(index)}`;
const tag = '项目 A', noteTitle = 'Project notebook (研究)', sourceURL = 'https://capture.example/article?detail=a%7Cb#evidence';
const sourceTitle = 'Project capture source', excerpt = 'Captured journeycapture <literal> **not Markdown**';
const escapeHTML = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

function observeHTTP(context) {
  const trace = { phase: 'startup', requests: [] };
  context.on('request', request => {
    if (/^https?:/u.test(request.url())) trace.requests.push({ phase: trace.phase, method: request.method(), url: request.url(), resourceType: request.resourceType() });
  });
  return trace;
}
// These are action-to-observed-UI wall times, including automation transport and
// assertions. They are observations, not hardware-specific performance gates.
async function measure(timings, name, action) {
  const start = performance.now(), result = await action();
  timings[name] = Math.round((performance.now() - start) * 100) / 100; return result;
}
async function observeRendererLongTasks(page, timings) {
  const supported = await page.evaluate(() => {
    if (!PerformanceObserver.supportedEntryTypes.includes('longtask')) return false;
    const state = { entries: [], truncated: false };
    const append = entries => {
      for (const entry of entries) {
        if (state.entries.length >= 5000) { state.truncated = true; break; }
        state.entries.push({ startTime: entry.startTime, duration: entry.duration, name: entry.name,
          attribution: entry.attribution.map(item => ({ name: item.name, containerType: item.containerType, containerSrc: item.containerSrc })) });
      }
    };
    state.observer = new PerformanceObserver(list => append(list.getEntries()));
    state.flush = () => append(state.observer.takeRecords());
    state.observer.observe({ type: 'longtask', buffered: true });
    window.__coveletObservedLongTasks = state; return true;
  });
  expect(supported, 'the focused Chromium benchmark must expose real renderer long-task entries').toBe(true);
  const phases = [], observationErrors = [];
  return {
    async measure(name, action) {
      const startTime = await page.evaluate(() => performance.now()); let completed = false;
      try { const result = await measure(timings, name, action); completed = true; return result; }
      finally {
        // Let completed DOM work paint and deliver observer callbacks. This
        // paint/observation wait is outside the reported action wall time.
        try {
          await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
          phases.push(await page.evaluate(({ name, startTime, completed }) => ({ name, startTime, endTime: performance.now(), completed,
            domElementCount: document.querySelectorAll('*').length, sourceRowCount: document.querySelectorAll('.bookmark-import-row').length,
            mergeGroupCount: document.querySelectorAll('.import-merge-group').length,
            mergeTargetComboboxCount: document.querySelectorAll('.import-merge-groups [role="combobox"]').length,
            exportRowCount: document.querySelectorAll('[data-export-key]').length }), { name, startTime, completed }));
        } catch (error) { observationErrors.push({ name, message: error.message }); }
      }
    },
    async finish() {
      const observed = await page.evaluate(() => {
        const state = window.__coveletObservedLongTasks; state.flush(); state.observer.disconnect();
        return { entries: state.entries, truncated: state.truncated };
      });
      const round = value => Math.round(value * 100) / 100;
      return { method: 'Browser PerformanceObserver longtask entries (>50ms), independent of Playwright action/assertion wall time. Phase bounds include two paint frames after the assertion.',
        supported, truncated: observed.truncated, observationErrors,
        phases: phases.map(phase => {
          const tasks = observed.entries.filter(entry => entry.startTime < phase.endTime && entry.startTime + entry.duration > phase.startTime);
          return { ...phase, rendererPhaseMs: round(phase.endTime - phase.startTime), longTaskCount: tasks.length,
            totalLongTaskMs: round(tasks.reduce((sum, entry) => sum + entry.duration, 0)), maxLongTaskMs: round(Math.max(0, ...tasks.map(entry => entry.duration))),
            excessOver50Ms: round(tasks.reduce((sum, entry) => sum + Math.max(0, entry.duration - 50), 0)), tasks };
        }) };
    },
  };
}
async function report(testInfo, filename, value) {
  const path = testInfo.outputPath(filename); await writeFile(path, JSON.stringify(value, null, 2));
  await testInfo.attach(filename, { path, contentType: 'application/json' });
}
async function importCPUProbe(context, page, testInfo) {
  if (process.env.COVELET_QA_PROFILE_IMPORT !== 'on') return null;
  const client = await context.newCDPSession(page), phases = [];
  await client.send('Performance.enable'); await client.send('Profiler.enable');
  await client.send('Profiler.setSamplingInterval', { interval: 1000 }); await client.send('Profiler.start');
  const metrics = async () => Object.fromEntries((await client.send('Performance.getMetrics')).metrics.map(item => [item.name, item.value]));
  return {
    async measure(name, action) {
      const before = await metrics(); let completed = false;
      try { const result = await action(); completed = true; return result; }
      finally {
        const after = await metrics();
        phases.push({ name, completed, startTimeUs: before.Timestamp * 1e6, endTimeUs: after.Timestamp * 1e6,
          durationsMs: Object.fromEntries(['ScriptDuration', 'LayoutDuration', 'RecalcStyleDuration', 'TaskDuration'].map(key => [key, Math.round((after[key] - before[key]) * 100000) / 100])),
          wallFromMetricsMs: (after.Timestamp - before.Timestamp) * 1000,
          nodesDelta: after.Nodes - before.Nodes, layoutsDelta: after.LayoutCount - before.LayoutCount,
          styleRecalculationsDelta: after.RecalcStyleCount - before.RecalcStyleCount });
      }
    },
    async finish() {
      const { profile } = await client.send('Profiler.stop');
      const profilePath = testInfo.outputPath('import-renderer.cpuprofile');
      await writeFile(profilePath, JSON.stringify(profile)); await testInfo.attach('import-renderer-cpu-profile', { path: profilePath, contentType: 'application/json' });
      const nodes = new Map(profile.nodes.map(node => [node.id, node])), parents = new Map();
      for (const node of profile.nodes) for (const child of node.children || []) parents.set(child, node.id);
      function summarize(start, end) {
        const exclusive = new Map(), inclusive = new Map(); let cursor = profile.startTime, sampledUs = 0;
        for (let index = 0; index < (profile.samples || []).length; index++) {
          const next = cursor + profile.timeDeltas[index], duration = Math.max(0, Math.min(next, end) - Math.max(cursor, start)); cursor = next;
          if (!duration) continue;
          const id = profile.samples[index]; sampledUs += duration; exclusive.set(id, (exclusive.get(id) || 0) + duration);
          for (let current = id; current !== undefined; current = parents.get(current)) inclusive.set(current, (inclusive.get(current) || 0) + duration);
        }
        const top = values => [...values].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([id, duration]) => ({ nodeId: id, milliseconds: Math.round(duration / 10) / 100,
          functionName: nodes.get(id).callFrame.functionName || '<anonymous>', url: nodes.get(id).callFrame.url, lineNumber: nodes.get(id).callFrame.lineNumber + 1, columnNumber: nodes.get(id).callFrame.columnNumber + 1 }));
        return { sampledMs: sampledUs / 1000, topExclusive: top(exclusive), topInclusive: top(inclusive) };
      }
      await report(testInfo, 'import-cpu-diagnostic.json', { snapshots: process.env.COVELET_QA_TRACE_SNAPSHOTS || 'normal', samplingIntervalUs: 1000,
        profileStartTimeUs: profile.startTime, profileEndTimeUs: profile.endTime, profilePath,
        overall: summarize(profile.startTime, profile.endTime), phases: phases.map(phase => ({ ...phase, cpu: summarize(phase.startTimeUs, phase.endTimeUs) })) });
      await client.send('Profiler.disable'); await client.send('Performance.disable'); await client.detach();
    },
  };
}
async function close(page, title) {
  const dialog = page.getByRole('dialog', { name: title, exact: true });
  await dialog.getByRole('button', { name: '关闭', exact: true }).click(); await expect(dialog).toBeHidden();
}
async function snapshot(page) { const backup = await exportCompleteBackup(page); await close(page, '设置'); return backup; }
async function command(page, title, dialogTitle = title) {
  await page.getByRole('button', { name: '命令面板', exact: true }).click();
  const commands = page.getByRole('dialog', { name: '命令面板', exact: true });
  await commands.getByRole('combobox').fill(title); await commands.getByRole('option', { name: title, exact: true }).click();
  const dialog = page.getByRole('dialog', { name: dialogTitle, exact: true }); await expect(dialog).toBeVisible(); return dialog;
}
async function openNote(page, query, title) {
  await search(page).click(); await search(page).fill(query);
  await page.getByRole('option').filter({ hasText: title }).click();
  const dialog = page.getByRole('dialog', { name: '便笺', exact: true });
  await expect(dialog.getByLabel('便笺名称', { exact: true })).toHaveValue(title); await expect(editor(dialog)).toBeVisible(); return dialog;
}
async function pinOpenNote(page, dialog) {
  await dialog.getByRole('button', { name: '固定到桌面', exact: true }).click();
  const pin = page.getByRole('dialog', { name: '固定到桌面', exact: true });
  await expect(pin.getByRole('combobox', { name: '目标桌面', exact: true })).toBeEnabled();
  await pin.getByRole('combobox', { name: '尺寸', exact: true }).click();
  await pin.getByRole('option', { name: '小 · 2×2', exact: true }).click();
  await pin.getByRole('button', { name: '固定', exact: true }).click(); await expect(pin).toBeHidden();
  await close(page, '便笺'); await search(page).fill(''); await search(page).press('Escape');
}
async function downloadLibrary(page, dialog) {
  const ready = page.waitForEvent('download'); await dialog.getByRole('button', { name: '导出', exact: true }).click();
  const download = await ready, chunks = [], stream = await download.createReadStream();
  for await (const chunk of stream) chunks.push(chunk);
  expect(download.suggestedFilename()).toBe('Covelet-library.zip'); await expect(dialog).toBeHidden();
  const bytes = Buffer.concat(chunks);
  return { bytes, files: Object.fromEntries(Object.entries(unzipSync(bytes)).map(([name, data]) => [name, strFromU8(data)])) };
}
function properties(markdown) {
  const block = /^---\n([\s\S]*?)\n---\n\n/u.exec(markdown); expect(block).not.toBeNull();
  return { fields: Object.fromEntries(block[1].split('\n').map(line => { const colon = line.indexOf(':'); return [line.slice(0, colon), JSON.parse(line.slice(colon + 1))]; })), body: markdown.slice(block[0].length) };
}
function plainText(node) {
  if (node.type === 'text') return node.text;
  if (node.type === 'hardBreak') return '\n';
  return (node.content || []).map(plainText).join(node.type === 'doc' ? '\n' : '');
}
async function openLibrary(page, count) {
  const dialog = await command(page, '导出 Markdown 资料库');
  await expect(dialog.locator('[data-export-key]')).toHaveCount(count, { timeout: 30_000 });
  await expect(dialog.getByRole('button', { name: '导出', exact: true })).toBeEnabled(); return dialog;
}
async function restoreDataset(page, before, data, name) {
  const recovery = await openRecovery(page);
  await chooseBackupFile(page, recovery, Buffer.from(JSON.stringify(data)), name);
  await restorePreview(recovery); await close(page, '设置');
  // All fixtures use packaged artwork and letter icons. No parse, restore or
  // ordinary render action is allowed to retrieve a site's image.
  expect(before.navigation.settings.background.kind).toBe('builtin');
}
function nearCapacityData(before) {
  const data = structuredClone(before.data), navigation = structuredClone(before.navigation), now = Date.now();
  const pages = Array.from({ length: 50 }, (_, index) => index), groupId = navigation.groups[0].id;
  navigation.settings = { ...navigation.settings, background: { kind: 'builtin', value: 'alpine' }, pages,
    desktopPages: Object.fromEntries(pages.map(page => [page, { id: `bench-desktop-${page}`, name: `Bench desk ${page + 1}` }])) };
  navigation.entries = Array.from({ length: 1900 }, (_, index) => ({ id: `bench-site-${pad(index)}`, type: 'site', name: `Bench site ${pad(index)}`,
    url: siteURL(index), groupId, parentId: null, page: Math.floor(index / 38), order: index, icon: { kind: 'letter', value: 'BS' } }));
  const common = { revision: 1, createdAt: now - 10_000, updatedAt: now - 5000 };
  data.tools = { version: 3, revision: data.tools.revision, snapshots: [], trash: [],
    notes: Array.from({ length: 200 }, (_, index) => ({ ...common, id: `bench-note-${pad(index)}`, title: `Bench note ${pad(index)}`,
      body: `Initial project evidence benchneedle${pad(index)}.\nLocal context for synthetic benchmark ${index}.`, pinned: false })),
    reading: Array.from({ length: 500 }, (_, index) => ({ ...common, id: `bench-reading-${pad(index)}`, title: `Bench reading ${pad(index)}`,
      url: `https://bench.example/reading/${pad(index)}`, status: ['unread', 'read', 'archived'][index % 3], revisitOn: '2026-11-20' })) };
  const items = Object.fromEntries([...navigation.entries.map(item => [`site:${item.id}`, { description: `Saved project reference ${item.name}.`, tagIds: ['bench-tag'] }]),
    ...data.tools.notes.map(item => [`note:${item.id}`, { description: '', tagIds: ['bench-tag'] }]),
    ...data.tools.reading.map(item => [`reading:${item.id}`, { description: `Reading context ${item.title}.`, tagIds: ['bench-tag'] }])]);
  data.preferences = { ...data.preferences, aliases: {}, privateKeys: [], presentation: false,
    library: { version: 1, tags: [{ id: 'bench-tag', name: 'BenchProject' }], items } };
  data.navigation = Buffer.from(zipSync({ ...before.files, 'data.json': strToU8(JSON.stringify(navigation)) })).toString('base64');
  const sizes = { navigationBytes: Buffer.byteLength(JSON.stringify(navigation)), toolsBytes: Buffer.byteLength(JSON.stringify(data.tools)), libraryBytes: Buffer.byteLength(JSON.stringify(data.preferences.library)) };
  expect(sizes.navigationBytes).toBeLessThanOrEqual(2 * 1024 * 1024); expect(sizes.toolsBytes).toBeLessThanOrEqual(4 * 1024 * 1024); expect(sizes.libraryBytes).toBeLessThanOrEqual(1024 * 1024);
  return { data, sizes };
}

test('near-capacity library records real input-to-result UI timings with zero ordinary HTTP', async ({ extension }, testInfo) => {
  test.setTimeout(240_000);
  const trace = observeHTTP(extension.context), timings = {}, page = await extension.newtab(), before = await snapshot(page);
  const renderer = await observeRendererLongTasks(page, timings);
  try {
  const { data, sizes } = nearCapacityData(before); trace.phase = 'supported-backup-restore';
  await renderer.measure('supportedRestoreToVisibleMs', async () => {
    await restoreDataset(page, before, data, 'near-capacity-project.json');
    await expect(page.locator('[data-entry-id="bench-site-0000"]')).toBeVisible();
  });
  trace.phase = 'ordinary-ui';
  await renderer.measure('commandOpenToFocusedOptionsMs', async () => {
    await page.getByRole('button', { name: '命令面板', exact: true }).click();
    const commands = page.getByRole('dialog', { name: '命令面板', exact: true });
    await expect(commands.getByRole('combobox')).toBeFocused();
    await expect(commands.getByRole('option', { name: '新便笺', exact: true })).toBeVisible();
  });
  const commands = page.getByRole('dialog', { name: '命令面板', exact: true });
  await renderer.measure('commandBodyQueryToResultMs', async () => {
    await commands.getByRole('combobox').fill('benchneedle0199 type:note');
    await expect(commands.getByRole('option')).toHaveCount(1); await expect(commands.getByRole('option')).toContainText('Bench note 0199');
  });
  await page.keyboard.press('Escape'); await expect(commands).toBeHidden();
  await renderer.measure('mainBodyQueryToResultMs', async () => {
    await search(page).fill('benchneedle0000 type:note');
    await expect(page.getByRole('option')).toHaveCount(1); await expect(page.getByRole('option')).toContainText('Bench note 0000');
  });
  await page.getByRole('option').click();
  let notes = page.getByRole('dialog', { name: '便笺', exact: true });
  await expect(notes.getByLabel('便笺名称', { exact: true })).toHaveValue('Bench note 0000');
  await pinOpenNote(page, notes);
  const pinned = await snapshot(page), widget = pinned.navigation.entries.find(item => item.extensionId === 'notes' && item.config.noteId === 'bench-note-0000');
  expect(widget).toBeTruthy();
  const card = page.locator(`[data-entry-id="${widget.id}"]`); await revealDesktopItem(page, card);
  await card.locator('[data-widget-launcher]').click(); notes = page.getByRole('dialog', { name: '便笺', exact: true });
  // A mounted editor is provisional until the requested record and its legacy
  // document have loaded. Measure edits to the actual bound note, not its
  // temporary empty draft, without an arbitrary initialization sleep.
  await expect(notes.getByLabel('便笺名称', { exact: true })).toHaveValue('Bench note 0000');
  await expect(editor(notes)).toContainText('Initial project evidence benchneedle0000.');
  await expect(editor(notes)).toContainText('Local context for synthetic benchmark 0.');
  await expect(editor(notes)).toBeEditable();
  await editor(notes).fill('Updated benchneedle0000 evidence visible in the pinned note.');
  await expect(editor(notes)).toContainText('Updated benchneedle0000 evidence visible in the pinned note.');
  await expect(notes.getByRole('button', { name: '保存', exact: true })).toBeEnabled();
  await renderer.measure('noteSaveToVisibleWidgetUpdateMs', async () => {
    await notes.getByRole('button', { name: '保存', exact: true }).click(); await expect(notes.getByRole('button', { name: '保存', exact: true })).toBeDisabled();
    await close(page, '便笺'); await expect(card).toBeVisible(); await expect(card).toContainText('Updated benchneedle0000 evidence');
  });
  await page.screenshot({ path: testInfo.outputPath('near-capacity-live-note.png'), animations: 'disabled' });
  const importing = await command(page, '导入网址与书签 HTML');
  await importing.getByRole('combobox', { name: '粘贴格式', exact: true }).click();
  await importing.getByRole('option', { name: 'OneTab 文本', exact: true }).click();
  const source = Array.from({ length: 1900 }, (_, index) => `${siteURL(index)} | Source ${pad(index)}`).join('\n');
  const cpu = await importCPUProbe(extension.context, page, testInfo);
  try {
  await renderer.measure('paste1900RowsToImportPreviewMs', async () => {
    const fill = () => importing.getByLabel('粘贴网址', { exact: true }).fill(source);
    const fillPhase = () => renderer.measure('textareaFillOnlyMs', fill);
    if (cpu) await cpu.measure('textareaFill', fillPhase); else await fillPhase();
    const preview = async () => {
    await importing.getByRole('button', { name: '预览网址', exact: true }).click();
    await expect(importing.locator('.bookmark-import-row')).toHaveCount(100, { timeout: 30_000 });
    await expect(importing.locator('.import-source-pagination').first().getByRole('status')).toHaveText('1–100 / 1,900');
    await expect(importing.locator('.import-merge-group')).toHaveCount(20);
    await expect(importing.locator('.import-merge-groups [role="combobox"]')).toHaveCount(20);
    await expect(importing.locator('.import-merge-pagination').first().getByRole('status')).toHaveText('1–20 / 1,900');
    await expect(importing.locator('.bookmark-import-summary')).toContainText('已选 1,900 项');
    await expect(importing.locator('.bookmark-import-summary')).toContainText('将添加 0 个网址');
    await expect(importing.getByRole('button', { name: '确认导入', exact: true })).toBeDisabled();
    };
    const previewPhase = () => renderer.measure('previewClickAndRenderOnlyMs', preview);
    if (cpu) await cpu.measure('previewClickAndRender', previewPhase); else await previewPhase();
  });
  } finally { await cpu?.finish(); }
  await renderer.measure('sourcePagingAndFullSelectionChecksMs', async () => {
    const pager = importing.locator('.import-source-pagination').first(), summary = importing.locator('.bookmark-import-summary');
    const all = importing.getByRole('checkbox', { name: '选择全部网址', exact: true });
    await pager.getByRole('button', { name: '下一页', exact: true }).click();
    await expect(pager.getByRole('status')).toHaveText('101–200 / 1,900');
    const source100 = importing.getByRole('checkbox', { name: '选择 Source 0100', exact: true });
    await expect(source100).toBeChecked(); await source100.uncheck();
    await expect(summary).toContainText('已选 1,899 项');
    await all.check(); await expect(summary).toContainText('已选 1,900 项'); await expect(source100).toBeChecked();
    await expect(pager.getByRole('status')).toHaveText('101–200 / 1,900');
    const folder = importing.locator('.bookmark-import-group-heading');
    await expect(folder).toHaveCount(1); await expect(folder.locator('small')).toHaveText('1,900');
    await folder.getByRole('checkbox').uncheck();
    await expect(summary).toContainText('已选 0 项'); await expect(all).not.toBeChecked(); await expect(source100).not.toBeChecked();
    await expect(pager.getByRole('status')).toHaveText('101–200 / 1,900');
    await all.check(); await expect(summary).toContainText('已选 1,900 项'); await expect(source100).toBeChecked();
    await expect(importing.locator('.bookmark-import-row')).toHaveCount(100);
    await expect(importing.locator('.import-merge-group')).toHaveCount(20);
    await expect(importing.getByRole('button', { name: '确认导入', exact: true })).toBeDisabled();
  });
  await importing.getByRole('button', { name: '取消', exact: true }).click(); await expect(importing).toBeHidden();
  // Exercise the supported local-file path too. This avoids conflating
  // Chromium's synthetic multi-line text insertion with parser/render latency.
  const fileImport = await command(page, '导入网址与书签 HTML'), choosingFile = page.waitForEvent('filechooser');
  await fileImport.getByRole('button', { name: '导入 OneTab 文本文件', exact: true }).click();
  const chooser = await choosingFile;
  await renderer.measure('oneTabFile1900RowsToImportPreviewMs', async () => {
    await chooser.setFiles({ name: 'near-capacity-onetab.txt', mimeType: 'text/plain', buffer: Buffer.from(source) });
    await expect(fileImport.locator('.bookmark-import-row')).toHaveCount(100, { timeout: 30_000 });
    await expect(fileImport.locator('.import-source-pagination').first().getByRole('status')).toHaveText('1–100 / 1,900');
    await expect(fileImport.locator('.import-merge-group')).toHaveCount(20);
    await expect(fileImport.locator('.import-merge-groups [role="combobox"]')).toHaveCount(20);
    await expect(fileImport.locator('.import-merge-pagination').first().getByRole('status')).toHaveText('1–20 / 1,900');
    await expect(fileImport.locator('.bookmark-import-summary')).toContainText('已选 1,900 项');
    await expect(fileImport.locator('.bookmark-import-summary')).toContainText('将添加 0 个网址');
    await expect(fileImport.getByRole('button', { name: '确认导入', exact: true })).toBeDisabled();
  });
  await fileImport.getByRole('button', { name: '取消', exact: true }).click(); await expect(fileImport).toBeHidden();
  const exporting = await renderer.measure('all2600RecordsToExportPreviewMs', () => openLibrary(page, 2600));
  const downloaded = await renderer.measure('exportClickToDecoded2601FileZipMs', () => downloadLibrary(page, exporting));
  expect(Object.keys(downloaded.files)).toHaveLength(2601); expect(Object.keys(downloaded.files).filter(name => name.startsWith('sites/'))).toHaveLength(1900);
  expect(Object.keys(downloaded.files).filter(name => name.startsWith('reading/'))).toHaveLength(500); expect(Object.keys(downloaded.files).filter(name => name.startsWith('notes/'))).toHaveLength(200);
  const after = await snapshot(page);
  expect(after.navigation.entries.filter(item => item.type === 'site')).toHaveLength(1900); expect(after.navigation.entries).toHaveLength(1901);
  expect(after.tools.reading).toHaveLength(500); expect(after.tools.notes).toHaveLength(200);
  expect(trace.requests, 'packaged background, local queries, pins, preview and export must issue no HTTP').toEqual([]);
  await report(testInfo, 'performance-metrics.json', { recordedAt: new Date().toISOString(), browser: await page.evaluate(() => navigator.userAgent),
    timingMethod: 'Milliseconds from real Playwright input/action through asserted visible result; includes automation transport and polling.',
    combinedPasteNote: 'Combined paste timing also contains nested phase observation/paint boundaries; use textareaFillOnlyMs and previewClickAndRenderOnlyMs to distinguish native input from preview work.',
    traceSnapshots: process.env.COVELET_QA_TRACE_SNAPSHOTS === 'off' ? 'off (isolated diagnostic)' : 'on (normal validation)',
    dataset: { initialSites: 1900, reading: 500, notes: 200, desktops: 50, finalNavigationEntries: 1901, exportedFiles: 2601, ...sizes }, timings,
    outputZipBytes: downloaded.bytes.length, network: trace.requests });
  } finally { await report(testInfo, 'renderer-longtasks.json', await renderer.finish()); }
});

test.describe('project migration-to-export journey', () => {
  // Real tabs, scripting and DOM selection on one exact synthetic HTTPS origin.
  // Only the isolated test copy gets this host grant; native activeTab prompting
  // is verified separately and is not claimed by this fixture.
  test.use({ pregrantedHosts: ['https://capture.example/*'] });
  test('project metadata, searched body, specific pin and appended source remain readable in the library ZIP', async ({ extension }, testInfo) => {
    test.setTimeout(180_000);
    const trace = observeHTTP(extension.context), timings = {}, page = await extension.newtab();
    const sourceSites = [{ name: 'Project evidence', url: 'https://project.example/evidence?q=(1)#summary', description: 'Imported project context: "quoted" # research' },
      { name: 'Project reference', url: 'https://project.example/reference', description: 'Second saved reference' }];
    const html = `<!DOCTYPE NETSCAPE-Bookmark-file-1><META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8"><DL><p><DT><H3>Project archive</H3><DL><p>${sourceSites.map(item =>
      `<DT><A HREF="${escapeHTML(item.url)}" TAGS="${escapeHTML(tag)}" DESCRIPTION="${escapeHTML(item.description)}">${escapeHTML(item.name)}</A>`).join('\n')}</DL><p></DL><p>`;
    trace.phase = 'local-project-journey';
    const importing = await command(page, '导入网址与书签 HTML'), chooserReady = page.waitForEvent('filechooser');
    await importing.getByRole('button', { name: '导入 Raindrop HTML 文件', exact: true }).click();
    await measure(timings, 'raindropFileToMetadataPreviewMs', async () => {
      await (await chooserReady).setFiles({ name: 'project-raindrop.html', mimeType: 'text/html', buffer: Buffer.from(html) });
      await expect(importing.locator('.bookmark-import-row')).toHaveCount(2);
      await expect(importing.locator('.import-source-tags').first()).toContainText(tag);
      await expect(importing.locator('.import-source-description').first()).toContainText(sourceSites[0].description);
    });
    await importing.getByRole('button', { name: '确认导入', exact: true }).click(); await expect(importing).toBeHidden();
    let notes = await command(page, '新便笺', '便笺');
    await notes.getByRole('button', { name: '新便笺', exact: true }).click();
    await notes.getByLabel('便笺名称', { exact: true }).fill(noteTitle);
    await editor(notes).fill('Opening brief: journeyneedle evidence.');
    await notes.getByRole('checkbox', { name: tag, exact: true }).check();
    await notes.getByRole('button', { name: '保存', exact: true }).click(); await expect(notes.getByRole('button', { name: '保存', exact: true })).toBeDisabled();
    await close(page, '便笺');
    await measure(timings, 'taggedBodyQueryToMatchedNoteMs', async () => {
      notes = await openNote(page, `journeyneedle type:note tag:"${tag}"`, noteTitle);
      await expect(notes.locator('[data-note-search-matches]')).toContainText('1 / 1');
      await expect(notes.getByRole('button', { name: '保存', exact: true })).toBeDisabled();
    });
    await pinOpenNote(page, notes);
    const original = await snapshot(page), originalNote = original.tools.notes.find(item => item.title === noteTitle);
    expect(originalNote).toBeTruthy();
    const widget = original.navigation.entries.find(item => item.extensionId === 'notes' && item.config.noteId === originalNote.id);
    expect(widget).toBeTruthy(); expect(widget.config.noteId).toBe(originalNote.id);
    const card = page.locator(`[data-entry-id="${widget.id}"]`); await revealDesktopItem(page, card);
    await expect(card).toContainText('Opening brief: journeyneedle evidence.');
    const metadata = (backup, key) => backup.data.preferences.library.items[key];
    const names = (backup, key) => metadata(backup, key).tagIds.map(id => backup.data.preferences.library.tags.find(item => item.id === id).name);
    for (const item of sourceSites) {
      const saved = original.navigation.entries.find(entry => entry.type === 'site' && entry.name === item.name);
      expect(saved.url).toBe(item.url); expect(metadata(original, `site:${saved.id}`).description).toBe(item.description); expect(names(original, `site:${saved.id}`)).toEqual([tag]);
    }
    expect(names(original, `note:${originalNote.id}`)).toEqual([tag]);
    expect(trace.requests, 'migration, body search and pin render must be local').toEqual([]);

    trace.phase = 'explicit-selected-page-capture';
    await extension.context.route(/^https:\/\/capture\.example\/(?:favicon\.ico|apple-touch-icon(?:-precomposed)?\.png|android-chrome-192x192\.png)$/u,
      route => route.fulfill({ status: 404, body: '' }));
    await extension.context.route(sourceURL.split('#')[0], route => route.fulfill({ status: 200, contentType: 'text/html',
      body: `<!doctype html><title>${sourceTitle}</title><p id="excerpt">${escapeHTML(excerpt)}</p>` }));
    const source = await extension.context.newPage(); await source.goto(sourceURL); await source.bringToFront();
    await source.locator('#excerpt').evaluate(element => {
      const selection = window.getSelection(), range = document.createRange(); range.selectNodeContents(element);
      selection.removeAllRanges(); selection.addRange(range);
    });
    const opened = extension.context.waitForEvent('page');
    await extension.worker.evaluate(async () => {
      await chrome.tabs.create({ url: chrome.runtime.getURL(chrome.runtime.getManifest().action.default_popup), active: false });
    });
    const popup = await opened;
    await popup.getByRole('tab', { name: '便笺', exact: true }).click();
    await expect(popup.getByLabel('便笺内容', { exact: true })).toHaveValue(excerpt);
    await expect(popup.locator('.note-capture-source a')).toHaveAttribute('href', sourceURL);
    await popup.getByRole('combobox', { name: '保存方式', exact: true }).click();
    await popup.getByRole('option', { name: '追加到便笺', exact: true }).click();
    await popup.getByRole('textbox', { name: '搜索目标便笺', exact: true }).fill(noteTitle);
    await popup.getByRole('combobox', { name: '选择目标便笺', exact: true }).click();
    await popup.getByRole('option', { name: noteTitle, exact: true }).click();
    await popup.getByRole('button', { name: '追加预览', exact: true }).click();
    await expect(popup.getByRole('region', { name: '追加预览', exact: true })).toContainText(excerpt);
    await expect(popup.getByRole('region', { name: '追加预览', exact: true })).toContainText(sourceURL);
    await measure(timings, 'appendClickToExistingWidgetUpdateMs', async () => {
      const closed = popup.waitForEvent('close'); await popup.getByRole('button', { name: '追加', exact: true }).click(); await closed;
      await page.bringToFront(); await expect(card).toBeVisible(); await expect(card).toContainText('journeycapture');
    });
    await source.close(); trace.phase = 'local-export';
    const appended = await snapshot(page), appendedNote = appended.tools.notes.find(item => item.id === originalNote.id);
    expect(appended.tools.notes).toHaveLength(1); expect(appendedNote.title).toBe(originalNote.title); expect(appendedNote.pinned).toBe(originalNote.pinned);
    expect(appendedNote.revision).toBe(originalNote.revision + 1); expect(appendedNote.body.startsWith(originalNote.body)).toBe(true);
    expect(appendedNote.body).toContain(excerpt); expect(appendedNote.body).toContain(sourceTitle); expect(appendedNote.body).toContain(sourceURL);
    expect(appendedNote.document.content.slice(0, originalNote.document.content.length)).toEqual(originalNote.document.content);
    expect(metadata(appended, `note:${originalNote.id}`)).toEqual(metadata(original, `note:${originalNote.id}`));
    expect(appended.navigation.entries.find(item => item.id === widget.id).config.noteId).toBe(originalNote.id);
    const exporting = await openLibrary(page, 3), downloaded = await measure(timings, 'projectExportToDecodedZipMs', () => downloadLibrary(page, exporting));
    expect(Object.keys(downloaded.files)).toHaveLength(4);
    const documents = Object.entries(downloaded.files).filter(([filename]) => filename !== 'index.md').map(([filename, content]) => ({ filename, ...properties(content) }));
    for (const item of sourceSites) {
      const exported = documents.find(document => document.fields.title === item.name);
      expect(exported.fields.url).toBe(item.url); expect(exported.fields.description).toBe(item.description); expect(exported.fields.covelet_tags).toEqual([tag]);
      expect(exported.fields.covelet_path).toContain('Project archive');
    }
    const exportedNote = documents.find(document => document.fields.title === noteTitle);
    expect(exportedNote.fields.covelet_type).toBe('note'); expect(exportedNote.fields.covelet_tags).toEqual([tag]); expect(exportedNote.fields.tags).toEqual([]);
    const readable = plainText(fromMarkdown(exportedNote.body));
    expect(readable).toContain(originalNote.body); expect(readable).toContain(excerpt); expect(readable).toContain(sourceTitle); expect(readable).toContain(sourceURL);
    expect(downloaded.files['index.md']).toContain('Project evidence'); expect(downloaded.files['index.md']).toContain('Project notebook');
    const zipPath = testInfo.outputPath('journey-Covelet-library.zip'); await writeFile(zipPath, downloaded.bytes);
    await testInfo.attach('journey-library', { path: zipPath, contentType: 'application/zip' });
    expect(trace.requests.filter(request => request.phase !== 'explicit-selected-page-capture'), 'ordinary project UI and exported content must not fetch').toEqual([]);
    expect(trace.requests.every(request => new URL(request.url).origin === 'https://capture.example')).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('project-journey-complete.png'), animations: 'disabled' });
    await report(testInfo, 'project-journey.json', { recordedAt: new Date().toISOString(), timings, migratedSites: sourceSites.length,
      originalNoteId: originalNote.id, appendedNoteId: appendedNote.id, originalNoteRevision: originalNote.revision, appendedNoteRevision: appendedNote.revision,
      pinnedWidgetId: widget.id, originalBlocksPreserved: true, exportedFiles: Object.keys(downloaded.files), zipBytes: downloaded.bytes.length,
      captureBoundary: 'Synthetic HTTPS main-frame text; real tabs/scripting/DOM selection; exact host grant only in isolated test copy; no native activeTab prompt claim.', network: trace.requests });
  });
});
