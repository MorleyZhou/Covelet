import { tr, getLocale } from "../i18n/index.js";
import binaryUrl from '../wasm/tools-core.wasm?url';

const encoder = new TextEncoder(), CAPACITY = 262144;
let pending;
export function loadToolsCore() {
  if (!pending) pending = (async () => {
    const response = await globalThis.fetch(binaryUrl, { credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error' });
    if (!response.ok) throw Error(tr("无法加载工具模块。"));
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength > 64 * 1024) throw Error(tr("工具模块大小无效。"));
    const module = await WebAssembly.compile(bytes);
    if (WebAssembly.Module.imports(module).length) throw Error(tr("工具模块包含外部依赖。"));
    const { exports: core } = await WebAssembly.instantiate(module);
    if (core.abi_version?.() !== 1 || core.memory?.buffer.byteLength !== 1048576) throw Error(tr("工具模块版本无效。"));
    const run = (a, b, operation) => {
      const first = encoder.encode(a), second = encoder.encode(b || '');
      if (first.length > CAPACITY || second.length > CAPACITY) throw Error(tr("内容超过工具处理上限。"));
      const input = new Uint8Array(core.memory.buffer, core.input_ptr(), CAPACITY), other = new Uint8Array(core.memory.buffer, core.other_ptr(), CAPACITY);
      try { input.set(first); other.set(second); return operation(first.length, second.length, new Uint32Array(core.memory.buffer, core.output_ptr(), 2048)); }
      finally { input.fill(0, 0, first.length); other.fill(0, 0, second.length); new Uint32Array(core.memory.buffer, core.output_ptr(), 2048).fill(0); }
    };
    return Object.freeze({
      metrics: (text) => run(text, '', (length, _, out) => { if (!core.text_metrics(length)) throw Error(tr("文字格式无效。")); return { characters: out[0], visible: out[1], lines: out[2], words: out[3] }; }),
      contains: (text, query) => {
        const normalized = text.normalize('NFKC').toLocaleLowerCase(getLocale()), needle = query.normalize('NFKC').toLocaleLowerCase(getLocale());
        if (needle.length > 8192) throw Error(tr("搜索词过长。"));
        if (!needle) return true;
        // Unicode normalization may expand a valid short note. Overlapping
        // chunks keep each call bounded without losing boundary matches.
        const step = 60000 - needle.length + 1;
        for (let at = 0; at < normalized.length; at += step) if (run(normalized.slice(at, at + 60000), needle, (a, b) => Boolean(core.text_contains(a, b)))) return true;
        return false;
      },
      diff: (before, after) => run(before, after, (a, b, out) => { if (!core.diff_summary(a, b)) throw Error(tr("差异内容无效。")); return { removed: out[0], added: out[1], prefixBytes: out[2], suffixBytes: out[3] }; }),
      unique: (urls) => {
        if (!Array.isArray(urls) || urls.length > 2000 || urls.some((url) => typeof url !== 'string' || /[\r\n]/.test(url))) throw Error(tr("链接列表无效。"));
        const unique = [], seen = new Set(); let batch = [], bytes = 0, offset = 0;
        const flush = () => {
          if (!batch.length) return;
          for (const index of run(batch.join('\n'), '', (length, _, out) => Array.from(out.slice(0, core.unique_lines(length))))) {
            const address = batch[index]; if (!seen.has(address)) { seen.add(address); unique.push(offset + index); }
          }
          offset += batch.length; batch = []; bytes = 0;
        };
        for (const url of urls) { const size = encoder.encode(url).length; if (size > CAPACITY) throw Error(tr("链接过长。")); if (bytes + size + 1 > CAPACITY) flush(); batch.push(url); bytes += size + 1; }
        flush(); return unique;
      },
    });
  })().catch((reason) => { pending = undefined; throw reason; });
  return pending;
}
