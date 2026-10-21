import { tr, getLocale } from "../i18n/index.js";
let pending;
export function loadClockCore() {
  if (!pending) pending = (async () => {
    const response = await globalThis.fetch(new URL('../wasm/clock-core.wasm', import.meta.url), { credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error' });
    if (!response.ok) throw Error(tr("无法加载时钟内核。"));
    const bytes = await response.arrayBuffer();
    if (!bytes.byteLength || bytes.byteLength > 16384) throw Error(tr("时钟内核大小无效。"));
    const module = await WebAssembly.compile(bytes);
    if (WebAssembly.Module.imports(module).length) throw Error(tr("时钟内核包含不支持的导入。"));
    const core = (await WebAssembly.instantiate(module, {})).exports;
    if (['elapsed', 'remaining', 'hour_angle', 'minute_angle', 'second_angle'].some((key) => typeof core[key] !== 'function')) throw Error(tr("时钟内核接口无效。"));
    return core;
  })().catch((error) => { pending = null; throw error; });
  return pending;
}
