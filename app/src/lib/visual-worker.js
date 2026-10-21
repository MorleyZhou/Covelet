import { tr, getLocale } from "../i18n/index.js";
import { adaptiveIconBackground, adaptiveWidgetSurface } from './icon-presentation.js';

// This worker has fixed packaged image operations. It never accepts code,
// module URLs, imports, or instructions from configuration or image metadata.
const WASM_LIMIT = 512 * 1024;
const EDGE_LIMIT = 256;
const OUTPUT_EDGE = 128;
const CAPTION_LIMIT = 160;

function checkedView(memory, pointer, bytes) {
  if (!(memory instanceof WebAssembly.Memory) || !Number.isInteger(pointer) || pointer < 0 || pointer + bytes > memory.buffer.byteLength) throw new Error(tr("视觉模块内存无效。"));
  return new Uint8Array(memory.buffer, pointer, bytes);
}

function iconPresentation(core) {
  const data = checkedView(core.memory, core.icon_presentation_ptr(), 8 * 4);
  const details = new Uint32Array(data.buffer, data.byteOffset, 8);
  if (details[0] !== 1 || details[1] > 1 || details[2] > 1 || details[3] > 0xffffff || details[4] > 2 || details[5] > 1) throw Error(tr("视觉模块结果无效。"));
  const monochrome = details[4] === 1 ? 'light' : details[4] === 2 ? 'dark' : undefined;
  let ink;
  if (details[5]) {
    const values = checkedView(core.memory, core.icon_ink_ptr(), 64 * 4);
    ink = Array.from(new Uint32Array(values.buffer, values.byteOffset, 64));
    const total = ink.reduce((sum, value) => sum + value, 0);
    if (ink.some((value) => value > 10000) || total < 1 || total > 11000) throw Error(tr("视觉模块结果无效。"));
  }
  return { fullBleed: details[1] === 1, background: details[2] ? `#${details[3].toString(16).padStart(6, '0')}` : undefined,
    monochrome, surfaceTone: monochrome || 'mixed', ink };
}

function captionContrasts(core, { patches }) {
  if (!Array.isArray(patches) || patches.length > CAPTION_LIMIT) throw new Error(tr("文字区域无效。"));
  let captionCount = 0, iconCount = 0, widgetCount = 0;
  const captions = patches.map(({ width, height, pixels, scale, previous, type, tone, ink, theme }, index) => {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 256 || height > 64
      || !(pixels instanceof ArrayBuffer) || pixels.byteLength !== width * height * 4) throw new Error(tr("文字区域无效。"));
    const source = new Uint8Array(pixels);
    checkedView(core.memory, core.input_ptr(), source.byteLength).set(source);
    const icon = type === 'icon', widget = type === 'widget';
    if (icon && ink !== undefined && (!Array.isArray(ink) || ink.length !== 64
      || ink.some((value) => !Number.isSafeInteger(value) || value < 0 || value > 10000)
      || ink.reduce((sum, value) => sum + value, 0) < 1 || ink.reduce((sum, value) => sum + value, 0) > 11000)) throw Error(tr("视觉区域无效。"));
    if (widget ? ++widgetCount > 48 || !['system', 'light', 'dark'].includes(theme)
      : icon ? ++iconCount > 48 || !['light', 'dark', 'mixed', 'text', 'themed'].includes(tone) : ++captionCount > 64) throw new Error(tr("视觉区域无效。"));
    const status = icon || widget ? core.analyze_wallpaper(width, height)
      : core.analyze_caption(width, height, previous === 'dark' ? 1 : previous === 'light' ? 2 : 0,
        Math.round(Math.min(2, Math.max(.1, Number.isFinite(scale) ? scale : 1)) * 100));
    if (status !== 0) throw new Error(tr("局部视觉分析失败。"));
    const bytes = checkedView(core.memory, core.result_ptr(), 32 * 4);
    const stats = new Uint32Array(bytes.buffer, bytes.byteOffset, 32);
    if (stats[0] !== 1 || stats[1] !== 0 || !stats[2]) throw new Error(tr("局部视觉结果无效。"));
    if (widget) return { index, type: 'widget', ...adaptiveWidgetSurface(stats, theme, previous) };
    if (icon) return { index, type: 'icon', ...adaptiveIconBackground(stats, tone, previous, ink) };
    if (![1, 2].includes(stats[20]) || stats[21] > 2) throw new Error(tr("文字对比度结果无效。"));
    return { index, type: 'caption', ink: stats[20] === 1 ? 'dark' : 'light', support: stats[21], needsShadow: stats[21] > 0 };
  });
  return { kind: 'captions', captions };
}

export function runVisualOperation(core, { kind, width, height, pixels, patches }) {
  if (core.abi_version() !== 1) throw new Error(tr("视觉模块版本不兼容。"));
  if (kind === 'captions') return captionContrasts(core, { patches });
  if (!['wallpaper', 'icon'].includes(kind) || !Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > EDGE_LIMIT || height > EDGE_LIMIT || !(pixels instanceof ArrayBuffer) || pixels.byteLength !== width * height * 4) throw new Error(tr("视觉模块输入无效。"));
  checkedView(core.memory, core.input_ptr(), pixels.byteLength).set(new Uint8Array(pixels));
  const status = kind === 'wallpaper' ? core.analyze_wallpaper(width, height) : core.normalize_icon(width, height);
  if (status !== 0) throw new Error(status === 2 ? tr("图片没有可显示的内容。") : tr("视觉模块处理失败。"));
  const resultBytes = checkedView(core.memory, core.result_ptr(), 32 * 4);
  const stats = Array.from(new Uint32Array(resultBytes.buffer, resultBytes.byteOffset, 32));
  if (stats[0] !== 1 || stats[1] !== 0 || stats[2] < 1 || stats[2] > width * height || stats.slice(5, 9).some((value) => value > 10000)) throw new Error(tr("视觉模块结果无效。"));
  if (kind === 'wallpaper') return { kind, stats };
  return { kind, stats, presentation: iconPresentation(core), width: OUTPUT_EDGE, height: OUTPUT_EDGE, pixels: checkedView(core.memory, core.output_ptr(), OUTPUT_EDGE * OUTPUT_EDGE * 4).slice().buffer };
}

let loading;
async function loadCore() {
  if (!loading) loading = (async () => {
    // Fixed, bundled URL. No runtime argument can select a different binary.
    const url = new URL('../wasm/visual-core.wasm', import.meta.url);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await globalThis.fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error', signal: controller.signal });
      if (!response.ok || response.redirected || (response.url && response.url !== url.href)) throw new Error(tr("内置视觉模块加载失败。"));
      const length = response.headers.get('content-length');
      if (length !== null && (!/^\d+$/.test(length) || Number(length) > WASM_LIMIT)) throw new Error(tr("内置视觉模块大小无效。"));
      const reader = response.body?.getReader();
      const parts = [];
      let size = 0;
      if (reader) {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > WASM_LIMIT) { await reader.cancel(); throw new Error(tr("内置视觉模块大小无效。")); }
            parts.push(value);
          }
        } finally { reader.releaseLock(); }
      } else {
        const part = new Uint8Array(await response.arrayBuffer());
        size = part.length;
        parts.push(part);
      }
      if (!size || size > WASM_LIMIT) throw new Error(tr("内置视觉模块大小无效。"));
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const part of parts) { bytes.set(part, offset); offset += part.length; }
      const { instance } = await WebAssembly.instantiate(bytes, {});
      if (instance.exports.abi_version?.() !== 1 || typeof instance.exports.icon_presentation_ptr !== 'function'
        || typeof instance.exports.icon_ink_ptr !== 'function') throw new Error(tr("内置视觉模块版本无效。"));
      return instance.exports;
    } finally { clearTimeout(timer); }
  })().catch((error) => { loading = null; throw error; });
  return loading;
}

if (typeof WorkerGlobalScope !== 'undefined' && globalThis instanceof WorkerGlobalScope) {
  // One fixed-memory WASM instance is shared; operations cannot interleave.
  let sequence = Promise.resolve(), queuedCaptions = null, captionScheduled = false;
  const respond = (data, core) => {
    try {
      const result = runVisualOperation(core, data);
      globalThis.postMessage({ id: data.id, ok: true, result }, result.pixels ? [result.pixels] : []);
    } catch {
      globalThis.postMessage({ id: data?.id, ok: false, message: tr("内置视觉模块暂不可用，已使用原始外观。") });
    }
  };
  globalThis.onmessage = ({ data }) => {
    if (data?.kind === 'captions') {
      // While initialization or another operation is pending, keep only the
      // newest viewport. Rapid dragging cannot queue dozens of pixel buffers.
      if (queuedCaptions) globalThis.postMessage({ id: queuedCaptions.id, ok: false, cancelled: true });
      queuedCaptions = data;
      if (captionScheduled) return;
      captionScheduled = true;
      sequence = sequence.then(async () => {
        let core;
        try { core = await loadCore(); } catch { /* respond reports the fallback. */ }
        const current = queuedCaptions;
        queuedCaptions = null; captionScheduled = false;
        if (current) respond(current, core);
      });
      return;
    }
    sequence = sequence.then(async () => {
      let core;
      try { core = await loadCore(); } catch { /* respond reports the fallback. */ }
      respond(data, core);
    });
  };
}
