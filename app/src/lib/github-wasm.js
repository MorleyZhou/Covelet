import { tr, getLocale } from "../i18n/index.js";
const MEMORY = 524288;
export const GITHUB_MAX_DAYS = 378;
let runtime;

export async function createGitHubWasm(binary) {
  if (!(binary instanceof Uint8Array) && !(binary instanceof ArrayBuffer)) throw new Error(tr("组件内核格式无效。"));
  if (binary.byteLength > 32768) throw new Error(tr("组件内核超过大小限制。"));
  const module = await WebAssembly.compile(binary);
  if (WebAssembly.Module.imports(module).length) throw new Error(tr("组件内核不允许宿主导入。"));
  const core = (await WebAssembly.instantiate(module, {})).exports;
  if (['abi_version', 'input_ptr', 'output_ptr', 'result_ptr', 'analyze_calendar'].some((key) => typeof core[key] !== 'function')
    || core.abi_version() !== 1 || !(core.memory instanceof WebAssembly.Memory) || core.memory.buffer.byteLength !== MEMORY) throw new Error(tr("组件内核接口无效。"));
  const regions = [[core.input_ptr(), GITHUB_MAX_DAYS * 12], [core.output_ptr(), (GITHUB_MAX_DAYS + 14) * 4], [core.result_ptr(), 32]];
  if (regions.some(([start, size]) => start < 0 || start % 4 || start + size > MEMORY)
    || regions.some(([start, size], i) => regions.some(([other, length], j) => i !== j && start < other + length && other < start + size))) throw new Error(tr("组件内核缓冲区无效。"));
  const input = new Uint32Array(core.memory.buffer, regions[0][0], GITHUB_MAX_DAYS * 3);
  const output = new Uint32Array(core.memory.buffer, regions[1][0], GITHUB_MAX_DAYS + 14);
  const result = new Uint32Array(core.memory.buffer, regions[2][0], 8);
  return Object.freeze({ analyze(days) {
    if (!Array.isArray(days) || !days.length || days.length > GITHUB_MAX_DAYS) throw new Error(tr("贡献日历数量无效。"));
    try {
      days.forEach((day, index) => {
        const epoch = Date.parse(`${day.date}T00:00:00Z`) / 86400000;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(day.date) || !Number.isInteger(epoch)
          || new Date(epoch * 86400000).toISOString().slice(0, 10) !== day.date
          || !Number.isInteger(day.count) || day.count < 0 || day.count > 1000000
          || !Number.isInteger(day.level) || day.level < 0 || day.level > 4) throw new Error(tr("贡献日历内容无效。"));
        input.set([epoch, day.count, day.level], index * 3);
      });
      if (core.analyze_calendar(days.length) !== 0) throw new Error(tr("贡献日历日期或数值无效。"));
      const [total, activeDays, longestStreak, currentStreak, offset, weeks] = result;
      const cells = Array.from(output.subarray(0, weeks * 7), (level, slot) => level
        ? { ...days[slot - offset], level: level - 1 } : null);
      return { total, activeDays, longestStreak, currentStreak, weeks, cells };
    } finally { input.fill(0); output.fill(0); result.fill(0); }
  } });
}

async function packaged() {
  if (!runtime) runtime = (async () => {
    const response = await globalThis.fetch(new URL('../wasm/github-core.wasm', import.meta.url), {
      credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error',
    });
    if (!response.ok || Number(response.headers.get('content-length')) > 32768) throw new Error(tr("无法加载 GitHub 组件内核。"));
    return createGitHubWasm(await response.arrayBuffer());
  })().catch((error) => { runtime = null; throw error; });
  return runtime;
}

export async function analyzeGitHubCalendar(days) { return (await packaged()).analyze(days); }
