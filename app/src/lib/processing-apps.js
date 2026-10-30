import { tr } from '../i18n/index.js';

export const TEXT_LIMIT = 1024 * 1024;
export const IMAGE_LIMIT = 24 * 1024 * 1024;
export const OUTPUT_LIMIT = 48 * 1024 * 1024;
const fail = (message) => { throw Error(tr(message)); };
export function boundedText(value, limit = TEXT_LIMIT) {
  if (typeof value !== 'string' || value.length > limit || value.includes('\0')) fail(tr('内容过长或包含无效字符。'));
  return value;
}
export function parseToolJson(text) {
  boundedText(text);
  // Refuse precision loss rather than silently changing identifiers on format/export.
  return JSON.parse(text, (_key, value) => {
    if (typeof value === 'number' && (!Number.isFinite(value) || Number.isInteger(value) && !Number.isSafeInteger(value))) fail(tr('数字超出精确范围，请将长编号写为字符串。'));
    return value;
  });
}
export function queryJson(value, path) {
  if (typeof path !== 'string' || path.length > 1000 || !path.startsWith('$')) fail(tr('路径应以 $ 开头。'));
  const tokens = [], pattern = /(?:\.([\p{L}\p{N}_$-]+)|\[(\d+|\*|"(?:[^"\\]|\\.)*"|'[^']*')\])/uy;
  let at = 1;
  while (at < path.length) {
    pattern.lastIndex = at; const match = pattern.exec(path);
    if (!match) fail(tr('路径支持属性名、数组下标和 [*]。'));
    const bracket = match[2];
    tokens.push(match[1] ?? (bracket === '*' ? Symbol.for('wildcard') : /^\d+$/.test(bracket) ? Number(bracket) : bracket.startsWith('"') ? JSON.parse(bracket) : bracket.slice(1, -1)));
    at = pattern.lastIndex;
  }
  let matches = [value];
  for (const token of tokens) {
    matches = matches.flatMap((item) => {
      if (!item || typeof item !== 'object') return [];
      return token === Symbol.for('wildcard') ? Object.values(item) : Object.hasOwn(item, token) ? [item[token]] : [];
    });
    if (matches.length > 20000) fail(tr('匹配结果过多，请缩小路径范围。'));
  }
  return matches;
}
export function compareJson(left, right) {
  const changes = []; let visited = 0;
  function visit(a, b, path, depth = 0) {
    if (++visited > 50000 || depth > 64 || changes.length > 10000) fail(tr('结构过于复杂，请缩小对比范围。'));
    if (Object.is(a, b)) return;
    const arrays = Array.isArray(a) && Array.isArray(b);
    const objects = a && b && typeof a === 'object' && typeof b === 'object' && Array.isArray(a) === Array.isArray(b);
    if (objects) {
      for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
        const next = arrays ? `${path}[${key}]` : `${path}[${JSON.stringify(key)}]`;
        if (!Object.hasOwn(a, key)) changes.push({ path: next, type: 'added', after: b[key] });
        else if (!Object.hasOwn(b, key)) changes.push({ path: next, type: 'removed', before: a[key] });
        else visit(a[key], b[key], next, depth + 1);
      }
    } else changes.push({ path, type: 'changed', before: a, after: b });
  }
  visit(left, right, '$'); return changes;
}
export function compareLines(left, right, { ignoreWhitespace = false } = {}) {
  boundedText(left); boundedText(right);
  const a = left.split('\n'), b = right.split('\n'), normalize = (line) => ignoreWhitespace ? line.replace(/\s+/g, '') : line;
  if (a.length > 1500 || b.length > 1500 || a.length * b.length > 1000000) fail(tr('对比内容过多，请将文件拆成较小片段。'));
  const rows = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) rows[i][j] = normalize(a[i]) === normalize(b[j]) ? rows[i + 1][j + 1] + 1 : Math.max(rows[i + 1][j], rows[i][j + 1]);
  const result = []; let i = 0, j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && normalize(a[i]) === normalize(b[j])) result.push({ type: 'same', left: ++i, right: ++j, text: a[i - 1] });
    else if (j < b.length && (i === a.length || rows[i][j + 1] >= rows[i + 1][j])) result.push({ type: 'added', left: null, right: ++j, text: b[j - 1] });
    else result.push({ type: 'removed', left: ++i, right: null, text: a[i - 1] });
  }
  return result;
}
export function regexResult(text, expression, flags = 'g', replacement = '') {
  boundedText(text, 300000); boundedText(expression, 600); boundedText(replacement, 10000);
  if (!/^[dgimsuvy]*$/.test(flags) || new Set(flags).size !== flags.length) fail(tr('正则标记无效。'));
  const regex = new RegExp(expression, flags), scan = new RegExp(expression, flags.includes('g') ? flags : `${flags}g`), matches = [];
  for (const match of text.matchAll(scan)) {
    if (matches.length >= 10000) fail(tr('匹配结果过多，请缩小文本范围。'));
    matches.push({ index: match.index, text: match[0], groups: Array.from(match).slice(1).map((value) => value ?? null), named: match.groups ? { ...match.groups } : null });
  }
  let emitted = 0, previousEnd = 0;
  const replaced = text.replace(regex, (...parameters) => {
    const hasNamed = typeof parameters.at(-1) === 'object', offset = parameters.at(hasNamed ? -3 : -2), captures = parameters.slice(1, hasNamed ? -3 : -2), named = hasNamed ? parameters.at(-1) : null, match = parameters[0];
    emitted += offset - previousEnd; previousEnd = offset + match.length;
    let cursor = 0, output = ''; const substitutions = /\$(\$|&|`|'|\d{1,2}|<[^>]*>)/g;
    const append = (value) => { if (emitted + output.length + value.length > TEXT_LIMIT) fail(tr('替换结果过长，请缩小文本或替换内容。')); output += value; };
    for (const token of replacement.matchAll(substitutions)) {
      append(replacement.slice(cursor, token.index)); const code = token[1]; let value = token[0];
      if (code === '$') value = '$';
      else if (code === '&') value = match;
      else if (code === '`') value = text.slice(0, offset);
      else if (code === "'") value = text.slice(offset + match.length);
      else if (code.startsWith('<')) { if (named) value = named[code.slice(1, -1)] ?? ''; }
      else {
        const number = Number(code);
        if (number > 0 && number <= captures.length) value = captures[number - 1] ?? '';
        else if (code.length === 2 && Number(code[0]) > 0 && Number(code[0]) <= captures.length) value = `${captures[Number(code[0]) - 1] ?? ''}${code[1]}`;
      }
      append(value); cursor = token.index + token[0].length;
    }
    append(replacement.slice(cursor)); emitted += output.length; return output;
  });
  if (emitted + text.length - previousEnd > TEXT_LIMIT) fail(tr('替换结果过长，请缩小文本或替换内容。'));
  return { matches, replaced };
}
export function bytesToBase64(bytes) {
  let binary = ''; for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}
export function encodeUtf8Base64(text) { return bytesToBase64(new TextEncoder().encode(boundedText(text))); }
export function decodeUtf8Base64(text) {
  const normalized = boundedText(text).trim().replaceAll('-', '+').replaceAll('_', '/');
  return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(atob(normalized), (character) => character.charCodeAt(0)));
}
export function parsePageSelection(spec, count) {
  if (!Number.isSafeInteger(count) || count < 1 || count > 2000) fail(tr('文档页数无效或超出限制。'));
  if (!String(spec).trim()) return Array.from({ length: count }, (_, index) => index);
  if (String(spec).length > 10000) fail(tr('页面选择过长。'));
  const result = [];
  for (const part of String(spec).split(',')) {
    const match = /^\s*(\d+)(?:\s*-\s*(\d+))?\s*$/.exec(part);
    if (!match) fail(tr('页码请填写为 1,3-5。'));
    const from = Number(match[1]), to = Number(match[2] || match[1]);
    if (from < 1 || to < 1 || from > count || to > count || Math.abs(to - from) > 2000) fail(tr('页码超出文档范围。'));
    const step = to >= from ? 1 : -1;
    for (let page = from; step > 0 ? page <= to : page >= to; page += step) result.push(page - 1);
    if (result.length > 2000) fail(tr('一次最多处理 2000 页。'));
  }
  return result;
}
export function reorderPdfPages(pages, ids, targetId = null) {
  if (!Array.isArray(pages) || pages.length > 2000 || !Array.isArray(ids)) fail(tr('一次最多处理 2000 页。'));
  const moving = new Set(ids), known = new Set(pages.map((page) => page.id));
  if (known.size !== pages.length || [...moving].some((id) => !known.has(id)) || targetId !== null && !known.has(targetId)) fail(tr('页码超出文档范围。'));
  if (!moving.size || moving.has(targetId)) return pages;
  const selected = pages.filter((page) => moving.has(page.id)), rest = pages.filter((page) => !moving.has(page.id)), target = targetId === null ? rest.length : rest.findIndex((page) => page.id === targetId);
  return [...rest.slice(0,target), ...selected, ...rest.slice(target)];
}
export function fitImage(width, height, targetWidth, targetHeight, crop = false) {
  if (![width, height].every((value) => Number.isFinite(value) && value >= 1) || width * height > 40000000) fail(tr('图片尺寸过大或无效。'));
  if (![targetWidth, targetHeight].every((value) => Number.isFinite(value) && value >= 0 && value <= 8192)) fail(tr('输出尺寸须在 1 至 8192 之间。'));
  let w = targetWidth || (targetHeight ? Math.round(width * targetHeight / height) : width), h = targetHeight || Math.round(height * w / width);
  if (!crop) { const scale = Math.min(w / width, h / height, 1); w = Math.max(1, Math.round(width * scale)); h = Math.max(1, Math.round(height * scale)); }
  if (w > 8192 || h > 8192 || w * h > 24000000) fail(tr('输出图片尺寸过大。'));
  const scale = Math.max(w / width, h / height);
  return { width: w, height: h, sourceX: crop ? (width - w / scale) / 2 : 0, sourceY: crop ? (height - h / scale) / 2 : 0, sourceWidth: crop ? w / scale : width, sourceHeight: crop ? h / scale : height };
}
export function colorContrast(first, second) {
  const luminance = (hex) => {
    if (!/^#[a-f\d]{6}$/i.test(hex)) fail(tr('请输入六位颜色值。'));
    const channels = [1, 3, 5].map((at) => { const channel = parseInt(hex.slice(at, at + 2), 16) / 255; return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4; });
    return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
  };
  const a = luminance(first), b = luminance(second); return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
}
export function extractPalette(pixels, count = 6) {
  const buckets = new Map();
  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i + 3] < 128) continue;
    const rgb = [pixels[i], pixels[i + 1], pixels[i + 2]].map((value) => Math.min(255, Math.round(value / 32) * 32)), hex = `#${rgb.map((value) => value.toString(16).padStart(2, '0')).join('')}`;
    buckets.set(hex, (buckets.get(hex) || 0) + 1);
  }
  return [...buckets].sort((a, b) => b[1] - a[1]).slice(0, count).map(([hex]) => hex);
}
export function encodeWav(channels, sampleRate, { gain = 1, fade = 0 } = {}) {
  if (!Array.isArray(channels) || channels.length < 1 || channels.length > 2 || !channels.every((channel) => channel instanceof Float32Array && channel.length === channels[0].length)
    || !Number.isFinite(sampleRate) || sampleRate < 8000 || sampleRate > 192000 || !Number.isFinite(gain) || gain < 0 || gain > 4 || !Number.isFinite(fade) || fade < 0) fail(tr('音频参数无效。'));
  const frames = channels[0].length, size = frames * channels.length * 2;
  if (!frames || size > OUTPUT_LIMIT) fail(tr('音频片段为空或过大。'));
  const bytes = new ArrayBuffer(44 + size), view = new DataView(bytes), ascii = (at, text) => [...text].forEach((letter, i) => view.setUint8(at + i, letter.charCodeAt(0)));
  ascii(0, 'RIFF'); view.setUint32(4, 36 + size, true); ascii(8, 'WAVE'); ascii(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, channels.length, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * channels.length * 2, true); view.setUint16(32, channels.length * 2, true); view.setUint16(34, 16, true); ascii(36, 'data'); view.setUint32(40, size, true);
  const fadeFrames = Math.min(Math.floor(fade * sampleRate), Math.floor(frames / 2)); let offset = 44;
  for (let i = 0; i < frames; i++) {
    const envelope = fadeFrames ? Math.min(1, i / fadeFrames, (frames - 1 - i) / fadeFrames) : 1;
    for (const channel of channels) { const sample = Math.max(-1, Math.min(1, channel[i] * gain * envelope)); view.setInt16(offset, sample < 0 ? Math.round(sample * 32768) : Math.round(sample * 32767), true); offset += 2; }
  }
  return new Blob([bytes], { type: 'audio/wav' });
}
export function trimAudioChannels(buffer, start, end) {
  if (!buffer || !Number.isFinite(buffer.duration) || !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end > buffer.duration + .001 || end <= start) fail(tr('请选择有效的起止时间。'));
  const from = Math.floor(start * buffer.sampleRate), to = Math.min(buffer.length, Math.floor(end * buffer.sampleRate));
  return Array.from({ length: Math.min(2, buffer.numberOfChannels) }, (_, channel) => buffer.getChannelData(channel).slice(from, to));
}
export function waveformSamples(samples, width = 400) {
  if (!samples?.length) return [];
  const bins = Math.min(width, samples.length), result = [];
  for (let i = 0; i < bins; i++) { let min = 1, max = -1; const from = Math.floor(i * samples.length / bins), to = Math.floor((i + 1) * samples.length / bins); for (let j = from; j < to; j++) { min = Math.min(min, samples[j]); max = Math.max(max, samples[j]); } result.push([min, max]); }
  return result;
}
export function validateBoard(input) {
  if (!input || typeof input !== 'object' || !Array.isArray(input.nodes) || !Array.isArray(input.edges) || input.nodes.length > 300 || input.edges.length > 600) fail(tr('画板内容无效或过大。'));
  const mode = input.mode === undefined ? 'free' : input.mode;
  if (!['free', 'mindmap'].includes(mode)) fail(tr('画板内容无效或过大。'));
  const ids = new Set();
  const nodes = input.nodes.map((node) => {
    if (!node || typeof node.id !== 'string' || !node.id.length || node.id.length > 100 || ids.has(node.id) || ![node.x, node.y].every((value) => Number.isFinite(value) && Math.abs(value) <= 100000)
      || typeof node.text !== 'string' || node.text.length > 2000 || typeof node.color !== 'string' || !/^#[\da-f]{6}$/i.test(node.color)) fail(tr('画板节点无效。'));
    const checked = { id: node.id, x: node.x, y: node.y, text: node.text, color: node.color, group: typeof node.group === 'string' ? node.group.slice(0, 100) : '' };
    if (mode === 'mindmap') {
      if (!(node.parentId === null || typeof node.parentId === 'string') || !Number.isInteger(node.order) || node.order < 0 || node.order > 300 || typeof node.collapsed !== 'boolean') fail(tr('导图层级无效。'));
      Object.assign(checked, { parentId: node.parentId, order: node.order, collapsed: node.collapsed });
    }
    ids.add(node.id); return checked;
  });
  const edges = input.edges.map((edge) => { if (!edge || !ids.has(edge.from) || !ids.has(edge.to) || edge.from === edge.to) fail(tr('画板连线无效。')); return { from: edge.from, to: edge.to }; });
  if (mode === 'mindmap') {
    const roots = nodes.filter((node) => node.parentId === null), byId = new Map(nodes.map((node) => [node.id, node]));
    if (roots.length !== 1 || input.rootId !== undefined && input.rootId !== roots[0].id) fail(tr('导图需要且只能有一个中心主题。'));
    for (const node of nodes) {
      const ancestors = new Set([node.id]); let parent = node.parentId;
      while (parent !== null) { if (!byId.has(parent) || ancestors.has(parent)) fail(tr('导图层级无效。')); ancestors.add(parent); parent = byId.get(parent).parentId; }
    }
    return { mode, rootId: roots[0]?.id || null, nodes, edges: [] };
  }
  return { ...(input.mode !== undefined ? { mode } : {}), nodes, edges };
}

export const MAP_NODE_WIDTH = 196, MAP_NODE_HEIGHT = 68;
export function mindMapChildren(board, id) { return board.nodes.filter((node) => node.parentId === id).sort((a, b) => a.order - b.order || a.id.localeCompare(b.id)); }
export function mindMapDescendants(board, id) {
  const result = new Set([id]), queue = [id];
  while (queue.length) for (const child of mindMapChildren(board, queue.shift())) { if (result.has(child.id)) fail(tr('导图层级无效。')); result.add(child.id); queue.push(child.id); }
  return result;
}
export function layoutMindMap(input) {
  const board = validateBoard(input);
  if (board.mode !== 'mindmap') return { nodes: board.nodes, edges: board.edges };
  const byId = new Map(board.nodes.map((node) => [node.id, node])), measured = new Map();
  const height = (id) => {
    const node = byId.get(id), children = node.collapsed ? [] : mindMapChildren(board, id);
    const value = children.length ? Math.max(104, children.reduce((sum, child) => sum + height(child.id), 0)) : 104; measured.set(id, value); return value;
  };
  if (!board.rootId) return { nodes: [], edges: [] };
  height(board.rootId); const nodes = [], edges = [];
  const place = (id, depth, top) => {
    const node = byId.get(id); nodes.push({ ...node, x: depth * 270, y: top + measured.get(id) / 2 - MAP_NODE_HEIGHT / 2 });
    if (node.collapsed) return;
    let cursor = top;
    for (const child of mindMapChildren(board, id)) { edges.push({ from: id, to: child.id }); place(child.id, depth + 1, cursor); cursor += measured.get(child.id); }
  };
  place(board.rootId, 0, 0); return { nodes, edges };
}
export function reparentMindMap(input, id, parentId, index = Infinity) {
  const board = validateBoard(input);
  if (board.mode !== 'mindmap' || id === board.rootId || !board.nodes.some((node) => node.id === id) || !board.nodes.some((node) => node.id === parentId) || mindMapDescendants(board, id).has(parentId)) fail(tr('不能把主题移入自己的分支。'));
  const siblings = mindMapChildren(board, parentId).filter((node) => node.id !== id), position = Math.max(0, Math.min(siblings.length, Number.isFinite(index) ? Math.floor(index) : siblings.length));
  siblings.splice(position, 0, { id }); const order = new Map(siblings.map((node, at) => [node.id, at]));
  return { ...input, ...board, nodes: board.nodes.map((node) => node.id === id ? { ...node, parentId, order: position } : order.has(node.id) ? { ...node, order: order.get(node.id) } : node.id === parentId ? { ...node, collapsed: false } : node) };
}
export function removeMindMapNodes(input, selected) {
  const board = validateBoard(input), removed = new Set();
  for (const id of selected) { if (id === board.rootId) fail(tr('中心主题需要保留。')); for (const descendant of mindMapDescendants(board, id)) removed.add(descendant); }
  return { ...input, ...board, nodes: board.nodes.filter((node) => !removed.has(node.id)) };
}

export function validateProcessingData(id, data) {
  const invalid = () => fail(tr('扩展内容格式无效，原有数据已保留。'));
  const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Blob);
  const text = (value, limit, allowEmpty = true) => typeof value === 'string' && value.length <= limit && (allowEmpty || value.length > 0) && !value.includes('\0');
  const stamp = (value) => Number.isFinite(value) && value >= 0;
  if (!object(data)) invalid();
  if (id === 'online-tools') {
    for (const key of ['text', 'right']) if (!text(data[key], TEXT_LIMIT)) invalid();
    if (!['json', 'diff', 'regex', 'encoding', 'text', 'time', 'format'].includes(data.mode) || !text(data.path, 1000) || !text(data.expression, 600) || !text(data.flags, 9) || !text(data.replacement, 10000)
      || !Array.isArray(data.history) || data.history.length > 8) invalid();
    const ids = new Set();
    for (const entry of data.history) {
      if (!object(entry) || !text(entry.id, 100, false) || ids.has(entry.id) || !['json', 'diff', 'regex', 'encoding', 'text', 'time', 'format'].includes(entry.name)
        || !text(entry.text, TEXT_LIMIT) || !text(entry.right, TEXT_LIMIT) || !stamp(entry.at)) invalid();
      ids.add(entry.id);
    }
  } else if (['images', 'pdf', 'media'].includes(id)) {
    if (!Array.isArray(data.outputs) || data.outputs.length > 100) invalid();
    let bytes = 0; const ids = new Set();
    for (const item of data.outputs) {
      if (!object(item) || !text(item.id, 100, false) || ids.has(item.id) || !text(item.name, 260, false) || !(item.blob instanceof Blob) || !item.blob.size || !stamp(item.createdAt)) invalid();
      const mime = item.blob.type;
      if (id === 'images' && !['image/png', 'image/jpeg', 'image/webp'].includes(mime) || id === 'pdf' && mime !== 'application/pdf' || id === 'media' && !/^(audio|video)\/(wav|webm)(;|$)/.test(mime)) invalid();
      if (id === 'images' && (![item.width, item.height].every((value) => Number.isInteger(value) && value > 0 && value <= 8192) || item.width * item.height > 24000000
        || !Array.isArray(item.palette) || item.palette.length > 12 || item.palette.some((color) => !/^#[a-f\d]{6}$/i.test(color)))) invalid();
      if (id === 'pdf' && (!Number.isInteger(item.pages) || item.pages < 1 || item.pages > 2000)) invalid();
      ids.add(item.id); bytes += item.blob.size;
    }
    if (bytes > OUTPUT_LIMIT) invalid();
    if (id === 'images') {
      const settings = data.settings;
      if (!object(settings) || !['image/png', 'image/jpeg', 'image/webp'].includes(settings.format) || typeof settings.crop !== 'boolean' || !text(settings.watermark, 100)
        || ![settings.width, settings.height].every((value) => typeof value === 'string' && value.length < 10 && Number.isFinite(Number(value)) && Number(value) >= 0 && Number(value) <= 8192)
        || typeof settings.quality !== 'string' || !Number.isFinite(Number(settings.quality)) || Number(settings.quality) < .1 || Number(settings.quality) > 1) invalid();
      for (const key of ['cropFocusX','cropFocusY','watermarkX','watermarkY']) if (settings[key] !== undefined && (!Number.isFinite(settings[key]) || settings[key] < 0 || settings[key] > 1)) invalid();
    }
  } else if (id === 'canvas') {
    if (!Array.isArray(data.boards) || data.boards.length > 30) invalid();
    const ids = new Set();
    for (const board of data.boards) {
      if (!object(board) || !text(board.id, 100, false) || ids.has(board.id) || !text(board.title, 120, false) || !stamp(board.updatedAt)) invalid();
      validateBoard(board); ids.add(board.id);
    }
  } else invalid();
  return data;
}
