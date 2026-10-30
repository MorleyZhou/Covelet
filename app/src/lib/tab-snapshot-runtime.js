import { tr } from '../i18n/index.js';
import { captureTabSnapshot, restoreTabSnapshot } from './personal-tools.js';

const CAPTURE = 'covelet:snapshot:capture', RESTORE = 'covelet:snapshot:restore';
const failure = () => Error(tr('快照操作未完成，请重试。'));
async function send(message) {
  if (!globalThis.chrome?.runtime?.id) throw failure();
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) throw Error(response?.error || tr('快照操作未完成，请重试。'));
  return response.result;
}

// Keep the optional permission request in the popup's explicit click. Bind the
// capture to that popup's window rather than the worker's last-focused window.
export function captureSnapshotFromPopup(name) {
  if (!globalThis.chrome?.runtime?.id) return Promise.reject(failure());
  const access = chrome.permissions.request({ permissions: ['tabs'] });
  const window = chrome.windows.getCurrent();
  return Promise.all([access, window]).then(([granted, current]) => {
    if (!granted) throw Error(tr('请在扩展中允许读取标签页。'));
    return send({ type: CAPTURE, name, windowId: current.id });
  });
}

export function restoreSnapshotFromPopup(id, revision, indices) {
  return send({ type: RESTORE, id, revision, indices });
}

// Register only a message listener. All tab reads/window creation happen in
// response to a confirmed action from our own toolbar popup, never page code.
export function installTabSnapshotActions(languageReady) {
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (![CAPTURE, RESTORE].includes(message?.type)) return;
    if (sender.id !== chrome.runtime.id || sender.url?.split(/[?#]/, 1)[0] !== chrome.runtime.getURL('popup.html')) return;
    const execute = async () => {
      await languageReady;
      if (!message || typeof message !== 'object' || Array.isArray(message)) throw failure();
      if (message.type === CAPTURE) {
        if (Object.keys(message).some((key) => !['type', 'name', 'windowId'].includes(key))
          || typeof message.name !== 'string' || message.name.length > 200 || message.name.includes('\0')
          || !Number.isInteger(message.windowId) || message.windowId < 0) throw failure();
        return captureTabSnapshot(message.name, { windowId: message.windowId, requestPermission: false });
      }
      if (Object.keys(message).some((key) => !['type', 'id', 'revision', 'indices'].includes(key))
        || typeof message.id !== 'string' || !/^[a-z\d-]{1,100}$/i.test(message.id)
        || !Number.isSafeInteger(message.revision) || message.revision < 1 || !Array.isArray(message.indices)
        || !message.indices.length || message.indices.length > 50 || message.indices.some((index) => !Number.isInteger(index) || index < 0)) throw failure();
      return restoreTabSnapshot(message.id, message.revision, message.indices);
    };
    const reply = (value) => { try { respond(value); } catch { /* The popup may already be closed. */ } };
    execute().then((result) => reply({ ok: true, result }), (reason) => reply({ ok: false, error: reason.message || tr('快照操作未完成，请重试。') }));
    return true;
  });
}
