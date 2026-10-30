import { tr } from '../i18n/index.js';
export function appURL(input) {
  let url; try { url = new URL(input); } catch { throw Error(tr('请填写完整的服务地址。')); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.href.length > 8192) throw Error(tr('服务地址无效。'));
  if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw Error(tr('远程服务需要使用 HTTPS。'));
  return url;
}
export function requestAppAccess(input) {
  const url = appURL(input);
  if (!globalThis.chrome?.permissions?.request) return Promise.reject(Error(tr('请在扩展中授权服务访问。')));
  // Intentionally invoked before an await, preserving the originating gesture.
  return chrome.permissions.request({ origins: [`${url.origin}/*`] }).then((granted) => { if (!granted) throw Error(tr('未获得此服务的访问权限。')); return true; });
}
export async function fetchAppResponse(input, { signal, headers, method = 'GET', body, timeout = 20000 } = {}) {
  const url = appURL(input);
  if (!globalThis.chrome?.permissions?.contains || !await chrome.permissions.contains({ origins: [`${url.origin}/*`] })) throw Error(tr('请先授权此服务的访问权限。'));
  const deadline = AbortSignal.timeout(timeout), combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
  let response;
  try { response = await globalThis.fetch(url.href, { method, body, headers, signal: combined, credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error', cache: 'no-store' }); }
  catch (reason) { if (signal?.aborted) throw reason; throw Error(tr('无法连接服务，请检查地址、服务状态和访问设置。')); }
  if (!response.ok) { await response.body?.cancel(); throw Error(tr('服务返回错误：{0}', [response.status])); }
  return response;
}
export async function readAppResponse(response, maxBytes = 4 * 1024 * 1024) {
  if (Number(response.headers.get('content-length')) > maxBytes) { await response.body?.cancel(); throw Error(tr('服务返回内容超过大小限制。')); }
  const reader = response.body?.getReader();
  if (!reader) return '';
  let size = 0, text = ''; const decoder = new TextDecoder();
  try {
    for (;;) { const { value, done } = await reader.read(); if (done) break; size += value.byteLength; if (size > maxBytes) throw Error(tr('服务返回内容超过大小限制。')); text += decoder.decode(value, { stream: true }); }
    return text + decoder.decode();
  } finally { await reader.cancel().catch(() => {}); }
}
export async function fetchAppJSON(url, options = {}) {
  const text = await readAppResponse(await fetchAppResponse(url, options), options.maxBytes);
  try { return JSON.parse(text); } catch { throw Error(tr('服务返回的内容格式无效。')); }
}
