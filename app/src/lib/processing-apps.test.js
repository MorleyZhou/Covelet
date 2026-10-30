import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isolatePdfJs } from '../../scripts/vite-processing-pdf.mjs';
import { boundedText, parseToolJson, queryJson, compareJson, compareLines, regexResult, encodeUtf8Base64, decodeUtf8Base64,
  parsePageSelection, reorderPdfPages, fitImage, colorContrast, extractPalette, encodeWav, trimAudioChannels, waveformSamples, validateBoard, validateProcessingData,
  layoutMindMap, mindMapDescendants, reparentMindMap, removeMindMapNodes } from './processing-apps.js';

test('JSON formatting refuses unsafe integer and non-finite conversions', () => {
  assert.deepEqual(parseToolJson('{"id":"9223372036854775807","zero":0,"valid":false}'), { id: '9223372036854775807', zero: 0, valid: false });
  assert.throws(() => parseToolJson('{"id":9223372036854775807}'));
  assert.throws(() => parseToolJson('{"number":1e9999}'));
  assert.throws(() => boundedText('x'.repeat(21), 20));
});
test('JSON paths traverse only own keys, support quoted keys and wildcards without evaluating expressions', () => {
  const value = { items: [{ name: 'first' }, { name: 'second' }], 'has.dot': { 'a b': 0 } };
  assert.deepEqual(queryJson(value, '$.items[*].name'), ['first', 'second']);
  assert.deepEqual(queryJson(value, '$["has.dot"]["a b"]'), [0]);
  assert.deepEqual(queryJson(value, '$.items[9]'), []);
  assert.deepEqual(queryJson({}, '$.constructor'), []);
  assert.throws(() => queryJson(value, '$.items[?(@.id)]'));
  assert.throws(() => queryJson(value, 'items[0]'));
});
test('JSON comparison ignores object key order and preserves array ordering, deletions and null changes', () => {
  assert.deepEqual(compareJson({ a: 1, b: 2 }, { b: 2, a: 1 }), []);
  assert.deepEqual(compareJson({ a: null, b: false }, { a: 0, c: '' }), [
    { path: '$["a"]', type: 'changed', before: null, after: 0 },
    { path: '$["b"]', type: 'removed', before: false },
    { path: '$["c"]', type: 'added', after: '' },
  ]);
  assert.equal(compareJson([1, 2], [2, 1]).length, 2);
});
test('text comparison can reconstruct both originals including repeated lines and empty trailing lines', () => {
  const first = 'alpha\nrepeat\nrepeat\nomega\n', second = 'alpha\ninsert\nrepeat\nomega\n';
  const result = compareLines(first, second);
  assert.equal(result.filter((row) => row.type !== 'added').map((row) => row.text).join('\n'), first);
  assert.equal(result.filter((row) => row.type !== 'removed').map((row) => row.text).join('\n'), second);
  assert.equal(compareLines('a b\n c', 'ab\nc', { ignoreWhitespace: true }).every((row) => row.type === 'same'), true);
  assert.throws(() => compareLines(Array(1600).fill('a').join('\n'), 'a'));
});
test('regex result includes capture groups and named groups and follows supplied replacement flags', () => {
  const result = regexResult('id=12 id=34', 'id=(?<number>\\d+)', 'g', '[$<number>]');
  assert.deepEqual(result.matches.map((match) => match.groups), [['12'], ['34']]);
  assert.equal(result.matches[1].named.number, '34');
  assert.equal(result.replaced, '[12] [34]');
  assert.equal(regexResult('a a', 'a', '', 'b').replaced, 'b a');
  assert.throws(() => regexResult('abc', '[', 'g'));
  assert.throws(() => regexResult('abc', 'a', 'gg'));
  const template = "$$ [$&] $1 $10 $<value> $` $'";
  assert.equal(regexResult('preABpost', '(?<value>A)(B)', 'g', template).replaced, 'preABpost'.replace(/(?<value>A)(B)/g, template));
  assert.throws(() => regexResult('x'.repeat(20000), 'x{2}', 'g', 'a'.repeat(1000)));
  assert.throws(() => regexResult('x'.repeat(100000), 'x{100}', 'g', "$`$'"));
});
test('UTF-8 Base64 round trips Unicode and rejects malformed byte sequences', () => {
  const text = '你好 🌱 café\nsecond line';
  assert.equal(decodeUtf8Base64(encodeUtf8Base64(text)), text);
  assert.throws(() => decodeUtf8Base64('////'));
});
test('page selection uses one-based input, preserves explicit reordering, and rejects out-of-range input', () => {
  assert.deepEqual(parsePageSelection('', 3), [0, 1, 2]);
  assert.deepEqual(parsePageSelection('3-1,2', 3), [2, 1, 0, 1]);
  assert.deepEqual(parsePageSelection('1,3-5', 5), [0, 2, 3, 4]);
  for (const selection of ['0', '6', '1,,2', 'abc', '1-99']) assert.throws(() => parsePageSelection(selection, 5));
});
test('image fitting maintains original ratio and performs centered crop without upscaling ordinary resize', () => {
  const resized = fitImage(1000, 500, 400, 400, false);
  assert.equal(resized.width, 400); assert.equal(resized.height, 200);
  const crop = fitImage(1000, 500, 400, 400, true);
  assert.equal(crop.sourceX, 250); assert.equal(crop.sourceWidth, 500); assert.equal(crop.width, 400);
  assert.equal(fitImage(100, 50, 400, 0, false).width, 100);
  assert.throws(() => fitImage(20000, 20000, 100, 100));
  assert.throws(() => fitImage(100, 100, -5, 20));
});
test('palette ignores transparent pixels and contrast has known reference values', () => {
  assert.deepEqual(extractPalette(Uint8ClampedArray.from([255, 0, 0, 255, 255, 0, 0, 255, 0, 0, 255, 0, 0, 255, 0, 255])), ['#ff0000', '#00ff00']);
  assert.equal(colorContrast('#000000', '#ffffff'), 21);
  assert.equal(colorContrast('#123456', '#123456'), 1);
  assert.throws(() => colorContrast('red', '#ffffff'));
});
test('WAV encoder writes interleaved PCM, sample rate and clipped samples', async () => {
  const blob = encodeWav([Float32Array.from([-2, 0, 2]), Float32Array.from([.5, -.5, 0])], 44100);
  const buffer = await blob.arrayBuffer(), view = new DataView(buffer), text = new TextDecoder().decode(new Uint8Array(buffer));
  assert.equal(text.slice(0, 4), 'RIFF'); assert.equal(text.slice(8, 12), 'WAVE');
  assert.equal(view.getUint16(22, true), 2); assert.equal(view.getUint32(24, true), 44100); assert.equal(view.getUint32(40, true), 12);
  assert.equal(view.getInt16(44, true), -32768); assert.equal(view.getInt16(52, true), 32767);
  const faded = new DataView(await encodeWav([Float32Array.from([1, 1, 1, 1])], 8000, { fade: 1 }).arrayBuffer());
  assert.equal(faded.getInt16(44, true), 0); assert.equal(faded.getInt16(50, true), 0);
  assert.throws(() => encodeWav([new Float32Array(0)], 44100));
});
test('audio trimming rejects reversed bounds and waveform bins preserve peaks', () => {
  const samples = Float32Array.from([0, 1, -.5, 0]), buffer = { duration: 1, length: 4, sampleRate: 4, numberOfChannels: 1, getChannelData: () => samples };
  assert.deepEqual(Array.from(trimAudioChannels(buffer, .25, .75)[0]), [1, -.5]);
  assert.throws(() => trimAudioChannels(buffer, .75, .25));
  assert.deepEqual(waveformSamples(samples, 2), [[0, 1], [-.5, 0]]);
});
test('board validation rejects duplicate nodes, invalid coordinates and dangling edges', () => {
  const node = { id: 'a', x: 10, y: 20, text: '<script>plain text</script>', color: '#aabbcc' };
  const other = { ...node, id: 'b' };
  assert.equal(validateBoard({ nodes: [node, other], edges: [{ from: 'a', to: 'b' }] }).nodes[0].text, node.text);
  assert.throws(() => validateBoard({ nodes: [node, node], edges: [] }));
  assert.throws(() => validateBoard({ nodes: [{ ...node, x: Infinity }], edges: [] }));
  assert.throws(() => validateBoard({ nodes: [node], edges: [{ from: 'a', to: 'b' }] }));
  assert.throws(() => validateBoard({ nodes: [node], edges: [{ from: 'a', to: 'a' }] }));
});
test('domain validation rejects malformed synced data before a tool can render or overwrite it', () => {
  assert.deepEqual(validateProcessingData('pdf', { outputs: [] }), { outputs: [] });
  assert.throws(() => validateProcessingData('pdf', { outputs: 'not-an-array' }));
  assert.throws(() => validateProcessingData('canvas', { boards: [{ id: 'board', title: 'Title', updatedAt: 0, nodes: [], edges: [{ from: 'missing', to: 'also-missing' }] }] }));
  assert.throws(() => validateProcessingData('pdf', { outputs: [{ id: 'pdf', name: 'example.pdf', createdAt: 0, pages: 1, blob: new Blob(['pdf'], { type: 'text/html' }) }] }));
  const output = { id: 'sound', name: 'sound.wav', createdAt: 0, blob: new Blob(['audio'], { type: 'audio/wav' }) };
  assert.equal(validateProcessingData('media', { outputs: [output] }).outputs.length, 1);
  assert.throws(() => validateProcessingData('media', { outputs: [output, output] }));
});
const map = () => ({ mode: 'mindmap', rootId: 'root', nodes: [
  { id: 'root', parentId: null, order: 0, collapsed: false, x: 0, y: 0, text: 'Root', color: '#e9edf5' },
  { id: 'first', parentId: 'root', order: 0, collapsed: false, x: 0, y: 0, text: 'First', color: '#e9edf5' },
  { id: 'second', parentId: 'root', order: 1, collapsed: false, x: 0, y: 0, text: 'Second', color: '#e9edf5' },
  { id: 'nested', parentId: 'first', order: 0, collapsed: false, x: 0, y: 0, text: 'Nested', color: '#e9edf5' },
], edges: [] });
test('mind maps validate a single root, parent existence and cycles while legacy free graphs remain free', () => {
  assert.equal(validateBoard(map()).rootId, 'root');
  assert.throws(() => validateBoard({mode:'mindmap',rootId:null,nodes:[],edges:[]}));
  const orphan = map(); orphan.nodes[1].parentId = 'missing'; assert.throws(() => validateBoard(orphan));
  const cycle = map(); cycle.nodes[1].parentId = 'nested'; assert.throws(() => validateBoard(cycle));
  const roots = map(); roots.nodes[1].parentId = null; assert.throws(() => validateBoard(roots));
  const legacy = { nodes: [{ id: 'a', x: 20, y: 30, text: 'Legacy', color: '#aabbcc' }], edges: [] };
  assert.equal(validateBoard(legacy).mode, undefined);
  assert.equal(layoutMindMap(legacy).nodes[0].x, 20);
});
test('automatic map layout preserves hierarchy, sibling order and collapsed subtrees', () => {
  const document = map(), layout = layoutMindMap(document), lookup = new Map(layout.nodes.map((node) => [node.id, node]));
  assert(lookup.get('first').x > lookup.get('root').x);
  assert(lookup.get('nested').x > lookup.get('first').x);
  assert(lookup.get('second').y > lookup.get('first').y);
  document.nodes[1].collapsed = true;
  assert(!layoutMindMap(document).nodes.some((node) => node.id === 'nested'));
  assert.equal(document.nodes.length, 4, 'Folding must never remove saved descendants');
});
test('branch moves preserve descendants and reject descendant-as-parent and root moves', () => {
  const document = map(), moved = reparentMindMap(document, 'first', 'second');
  assert.equal(moved.nodes.find((node) => node.id === 'first').parentId, 'second');
  assert.equal(moved.nodes.find((node) => node.id === 'nested').parentId, 'first');
  assert.deepEqual([...mindMapDescendants(moved, 'first')], ['first', 'nested']);
  assert.throws(() => reparentMindMap(document, 'first', 'nested'));
  assert.throws(() => reparentMindMap(document, 'root', 'second'));
  const removed = removeMindMapNodes(document, ['first']);
  assert.deepEqual(removed.nodes.map((node) => node.id), ['root', 'second']);
  assert.throws(() => removeMindMapNodes(document, ['root']));
});
test('same-parent map reorder uses the new sibling position without dropping descendants', () => {
  const later = reparentMindMap(map(), 'first', 'root', 1);
  assert.deepEqual(layoutMindMap(later).nodes.filter((node) => node.parentId === 'root').map((node) => node.id), ['second','first']);
  const earlier = reparentMindMap(later, 'first', 'root', 0);
  assert.deepEqual(layoutMindMap(earlier).nodes.filter((node) => node.parentId === 'root').map((node) => node.id), ['first','second']);
  assert.equal(earlier.nodes.find((node) => node.id === 'nested').parentId, 'first');
  const document = { ...map(), id: 'saved-map', title: 'Project', updatedAt: 55 };
  for (const result of [reparentMindMap(document,'first','second'),removeMindMapNodes(document,['first'])]) {
    assert.equal(result.id,'saved-map'); assert.equal(result.title,'Project'); assert.equal(result.updatedAt,55);
  }
});
test('PDF group reordering preserves visible order, rotations and unselected pages', () => {
  const pages = [{id:'1',rotation:0},{id:'2',rotation:90},{id:'3',rotation:180},{id:'4',rotation:270}];
  assert.deepEqual(reorderPdfPages(pages,['3'],'1').map((page) => page.id), ['3','1','2','4']);
  assert.deepEqual(reorderPdfPages(pages,['3','1'],'4').map((page) => page.id), ['2','1','3','4']);
  assert.deepEqual(reorderPdfPages(pages,['1','2']).map((page) => page.id), ['3','4','1','2']);
  assert.equal(reorderPdfPages(pages,['2'],'1')[0].rotation, 90);
  assert.equal(reorderPdfPages(pages,['1'],'1'), pages);
  assert.throws(() => reorderPdfPages(pages,['missing'],'1'));
  assert.throws(() => reorderPdfPages([...pages,pages[0]],['1'],'2'));
});
test('packaged PDF renderer and worker fail closed for every external resource loader', () => {
  for (const [kind,file] of [['renderer','pdf.mjs'],['worker','pdf.worker.mjs']]) {
    const source = readFileSync(new URL(`../../node_modules/pdfjs-dist/build/${file}`,import.meta.url),'utf8'), isolated = isolatePdfJs(source,kind).code;
    assert.match(isolated,/const processingPdfRead = processingBlockedPdfResource/);
    assert.match(isolated,/class ProcessingDeniedPdfRequest \{ constructor\(\) \{ processingBlockedPdfResource\(\)/);
    assert(!/\b(?:XMLHttpRequest|WebSocket|EventSource|import\s*\()/.test(isolated));
    assert(!/(?<![\w$.])fetch\s*\(/.test(isolated));
    assert.throws(() => isolatePdfJs(source.replace(kind === 'renderer' ? 'this.workerSrc);' : '`${WasmImage.#wasmUrl}${this._noWasmFilename}`);','changedLoader();'),kind));
  }
});
