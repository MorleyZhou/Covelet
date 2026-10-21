import { tr, getLocale } from "../i18n/index.js";
// This is a fixed packaged module, never an executable URL supplied by users or
// remote configuration. The controller owns network requests and Web Crypto.
export const SYNC_WASM_MAX_INPUT = 1024 * 1024;
export const SYNC_WASM_MAX_KEY = 512;
const MEMORY_BYTES = 2 * 1024 * 1024;
const MAX_BINARY_BYTES = 64 * 1024;
const PLANS = Object.freeze(['unchanged', 'push', 'pull', 'merge']);
let packagedRuntime;

function bytes(value, name, maximum) {
  if (!(value instanceof Uint8Array) && !(value instanceof ArrayBuffer)) throw new TypeError(tr("{0} 必须是 Uint8Array 或 ArrayBuffer。", [name]));
  const view = value instanceof Uint8Array ? value : new Uint8Array(value);
  if (view.byteLength > maximum) throw new RangeError(tr("{0} 超过 {1} 字节上限。", [name, maximum]));
  return new Uint8Array(view);
}

function hashBytes(value) {
  if (typeof value !== 'string' || !/^[\da-f]{64}$/i.test(value)) throw new TypeError(tr("同步摘要必须是完整的 SHA-256 十六进制字符串。"));
  return Uint8Array.from(value.match(/../g), part => Number.parseInt(part, 16));
}

const hex = value => Array.from(value, byte => byte.toString(16).padStart(2, '0')).join('');

export async function createSyncWasm(binaryBytes) {
  const binary = bytes(binaryBytes, tr("同步 WASM"), MAX_BINARY_BYTES);
  const module = await WebAssembly.compile(binary);
  if (WebAssembly.Module.imports(module).length !== 0) throw new Error(tr("同步 WASM 不允许宿主导入。"));
  const { exports: core } = await WebAssembly.instantiate(module, {});
  for (const name of ['abi_version', 'max_input_bytes', 'max_key_bytes', 'input_ptr', 'key_ptr', 'output_ptr', 'sha256_hash', 'hmac_sha256', 'sync_plan']) {
    if (typeof core[name] !== 'function') throw new Error(tr("同步 WASM 接口不完整。"));
  }
  if (!(core.memory instanceof WebAssembly.Memory) || core.memory.buffer.byteLength !== MEMORY_BYTES
    || core.abi_version() !== 1 || core.max_input_bytes() !== SYNC_WASM_MAX_INPUT || core.max_key_bytes() !== SYNC_WASM_MAX_KEY) {
    throw new Error(tr("同步 WASM 版本或内存限制不匹配。"));
  }
  const input = core.input_ptr(), key = core.key_ptr(), output = core.output_ptr();
  const regions = [[input, SYNC_WASM_MAX_INPUT], [key, SYNC_WASM_MAX_KEY], [output, 32]];
  if (regions.some(([start, length]) => !Number.isSafeInteger(start) || start < 0 || start + length > MEMORY_BYTES)
    || regions.some(([start, length], i) => regions.some(([other, size], j) => i !== j && start < other + size && other < start + length))) {
    throw new Error(tr("同步 WASM 缓冲区无效。"));
  }
  const memory = new Uint8Array(core.memory.buffer);
  const clear = (dataLength, keyLength = 0) => {
    memory.fill(0, input, input + dataLength);
    memory.fill(0, key, key + keyLength);
    memory.fill(0, output, output + 32);
  };

  // Each operation runs to completion without an await while memory is in use.
  // Concurrent callers therefore cannot overwrite one another's input buffers.
  return Object.freeze({
    async sha256(value) {
      const data = bytes(value, tr("同步数据"), SYNC_WASM_MAX_INPUT);
      try {
        memory.set(data, input);
        if (core.sha256_hash(data.length) !== 0) throw new Error(tr("同步摘要计算失败。"));
        return hex(memory.subarray(output, output + 32));
      } finally { clear(data.length); data.fill(0); }
    },
    async hmacSha256(keyValue, dataValue) {
      const keyBytes = bytes(keyValue, tr("签名密钥"), SYNC_WASM_MAX_KEY);
      let data;
      try {
        data = bytes(dataValue, tr("签名数据"), SYNC_WASM_MAX_INPUT);
        memory.set(data, input);
        memory.set(keyBytes, key);
        if (core.hmac_sha256(keyBytes.length, data.length) !== 0) throw new Error(tr("同步签名计算失败。"));
        return memory.slice(output, output + 32);
      } finally { clear(data?.length ?? 0, keyBytes.length); keyBytes.fill(0); data?.fill(0); }
    },
    async planSync(localHash, baseHash, remoteHash) {
      const local = hashBytes(localHash), base = hashBytes(baseHash), remote = hashBytes(remoteHash);
      try {
        memory.set(local, input); memory.set(base, input + 32); memory.set(remote, input + 64);
        const plan = PLANS[core.sync_plan()];
        if (!plan) throw new Error(tr("同步状态计算失败。"));
        return plan;
      } finally { clear(96); }
    },
  });
}

async function packaged() {
  if (!packagedRuntime) {
    packagedRuntime = (async () => {
      const url = new URL('../wasm/sync-core.wasm', import.meta.url);
      const response = await globalThis.fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error' });
      if (!response.ok || Number(response.headers.get('content-length')) > MAX_BINARY_BYTES) throw new Error(tr("无法加载包内同步计算内核。"));
      return createSyncWasm(await response.arrayBuffer());
    })().catch(error => { packagedRuntime = null; throw error; });
  }
  return packagedRuntime;
}

export async function sha256(value) {
  const data = bytes(value, tr("同步数据"), SYNC_WASM_MAX_INPUT);
  try { return await (await packaged()).sha256(data); }
  finally { data.fill(0); }
}

export async function hmacSha256(keyValue, dataValue) {
  const key = bytes(keyValue, tr("签名密钥"), SYNC_WASM_MAX_KEY);
  let data;
  try {
    data = bytes(dataValue, tr("签名数据"), SYNC_WASM_MAX_INPUT);
    return await (await packaged()).hmacSha256(key, data);
  } finally { key.fill(0); data?.fill(0); }
}

export async function planSync(localHash, baseHash, remoteHash) {
  hashBytes(localHash); hashBytes(baseHash); hashBytes(remoteHash);
  return (await packaged()).planSync(localHash, baseHash, remoteHash);
}
