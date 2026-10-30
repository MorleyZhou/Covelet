import { tr, getLocale } from "../i18n/index.js";
import { localData } from './local-data.js';
const PREFIX = 'covelet.clock.v1.';
const DEMO_PREFIX = 'covelet.clock.demo.v1.';
const ALARM_PREFIX = 'covelet-clock:';
const preview = typeof document !== 'undefined' && import.meta.env?.DEV && new URLSearchParams(location.search).has('demo');
const native = () => !preview && Boolean(globalThis.chrome?.storage?.local && globalThis.chrome?.runtime?.id);
const keyFor = (id) => `${preview ? DEMO_PREFIX : PREFIX}${id}`;
const localListeners = new Set();
export const clockAlarmName = (id, kind, alarmId) => `${ALARM_PREFIX}${encodeURIComponent(id)}:${kind}${alarmId ? `:${alarmId}` : ''}`;
const alarmScope = (id) => `${ALARM_PREFIX}${encodeURIComponent(id)}:`;

export const emptyClockState = () => ({ version: 1, revision: 0, mode: 'clock', duration: 25 * 60 * 1000, notify: false,
  timer: { elapsed: 0, startedAt: 0, running: false, completed: false }, stopwatch: { elapsed: 0, startedAt: 0, running: false } });

function check(input) {
  if (!input) return emptyClockState();
  const value = structuredClone(input);
  if (value.version !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 0
    || !['clock', 'world', 'compare', 'countdown', 'stopwatch', 'alarm'].includes(value.mode) || typeof value.notify !== 'boolean'
    || !Number.isFinite(value.duration) || value.duration < 1000 || value.duration > 86400000
    || Object.hasOwn(value, 'alarms') && (!Array.isArray(value.alarms) || value.alarms.length > 20)) throw Error(tr("时钟数据无效。"));
  for (const key of ['timer', 'stopwatch']) {
    const timer = value[key];
    if (!timer || !Number.isFinite(timer.elapsed) || timer.elapsed < 0 || timer.elapsed > 31536000000
      || !Number.isFinite(timer.startedAt) || timer.startedAt < 0 || typeof timer.running !== 'boolean'
      || key === 'timer' && typeof timer.completed !== 'boolean') throw Error(tr("计时数据无效。"));
  }
  const ids = new Set();
  // Validate old records before migrating. Legacy alarms never become active.
  for (const alarm of value.alarms || []) {
    if (!alarm || typeof alarm.id !== 'string' || !/^[a-z\d-]{1,80}$/i.test(alarm.id) || ids.has(alarm.id)
      || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(alarm.time) || typeof alarm.enabled !== 'boolean'
      || typeof alarm.label !== 'string' || alarm.label.length > 80 || !Array.isArray(alarm.days)
      || alarm.days.length > 7 || new Set(alarm.days).size !== alarm.days.length || alarm.days.some((day) => !Number.isInteger(day) || day < 0 || day > 6)
      || alarm.nextAt !== undefined && (!Number.isFinite(alarm.nextAt) || alarm.nextAt < 0)) throw Error(tr("闹钟数据无效。"));
    ids.add(alarm.id);
  }
  if (value.mode === 'alarm') value.mode = 'clock';
  delete value.alarms;
  return value;
}

async function readClockRecord(id) {
  return (await localData.get(keyFor(id)))[keyFor(id)];
}
export async function readClockState(id) { return check(await readClockRecord(id)); }
async function write(id, value) {
  const checked = check(value);
  await localData.set({ [keyFor(id)]: checked });
  return checked;
}
export function subscribeClockState(id, callback) {
  return localData.subscribe((items) => {
    if (items[keyFor(id)]) { try { callback(check(items[keyFor(id)].newValue)); } catch { /* Keep usable state; the next user action reports an error. */ } }
  });
}
export async function updateClockState(id, update) {
  const action = async () => {
    const previous = await readClockState(id), next = await update(structuredClone(previous));
    next.revision = previous.revision + 1;
    const saved = await write(id, next);
    if (native()) await scheduleClockState(id, saved);
    return saved;
  };
  return globalThis.navigator?.locks ? navigator.locks.request(keyFor(id), action) : action();
}
export async function prepareClockState(id) {
  const action = async () => {
    const stored = await readClockRecord(id), value = check(stored);
    if (stored && (Object.hasOwn(stored, 'alarms') || stored.mode === 'alarm')) {
      value.revision++;
      await write(id, value);
    }
    // Scheduling retains countdown deadlines, clears obsolete alarm plans.
    if (native()) await scheduleClockState(id, value);
    return value;
  };
  return globalThis.navigator?.locks ? navigator.locks.request(keyFor(id), action) : action();
}
export function requestClockNotifications() {
  // The development page can deliver an in-page alert while it remains open;
  // only an installed extension requests OS notification access.
  if (!native()) return Promise.resolve(true);
  return chrome.permissions.request({ permissions: ['notifications'] });
}
export const supportsClockBackground = () => native();

export async function scheduleClockState(id, state) {
  if (!native() || !chrome.alarms) return;
  const expected = new Map();
  if (state.notify && state.timer.running) expected.set(clockAlarmName(id, 'timer'), state.timer.startedAt + state.duration - state.timer.elapsed);
  for (const alarm of await chrome.alarms.getAll()) if (alarm.name.startsWith(alarmScope(id)) && !expected.has(alarm.name)) await chrome.alarms.clear(alarm.name);
  for (const [name, when] of expected) {
    const existing = await chrome.alarms.get(name);
    if (!existing || Math.abs(existing.scheduledTime - when) > 1000) await chrome.alarms.create(name, { when: Math.max(Date.now() + 1, when) });
  }
}

async function notification(id, title, message) {
  if (typeof document !== 'undefined') globalThis.dispatchEvent(new CustomEvent('covelet-clock-alert', { detail: { title, message } }));
  if (!native()) return;
  if (!await chrome.permissions.contains({ permissions: ['notifications'] })) return;
  await chrome.notifications.create(id, { type: 'basic', iconUrl: chrome.runtime.getURL('icons/icon-128.png'), title, message, priority: 1 });
}

export async function finishClockTimer(id) {
  let announce = false;
  const state = await updateClockState(id, (value) => {
    const due = value.timer.running && Date.now() >= value.timer.startedAt + value.duration - value.timer.elapsed;
    if (due) { announce = value.notify; value.timer = { elapsed: value.duration, startedAt: 0, running: false, completed: true }; }
    return value;
  });
  if (announce) await notification(clockAlarmName(id, 'timer'), tr("倒计时结束"), tr("设定的时间已到。"));
  return state;
}

export async function handleClockAlarm(name) {
  if (typeof name !== 'string' || !name.startsWith(ALARM_PREFIX)) return;
  const parts = name.slice(ALARM_PREFIX.length).split(':'), [encodedId, kind, alarmId] = parts;
  let id;
  try { id = decodeURIComponent(encodedId); } catch { return; }
  if (!id || id.length > 200 || /[\s\u0000-\u001f\u007f]/u.test(id)) return;
  if (kind === 'timer' && parts.length === 2) { await finishClockTimer(id); return; }
  if (kind !== 'alarm' || parts.length !== 3 || !/^[a-z\d-]{1,80}$/i.test(alarmId)) return;
  // An already queued legacy event must never deliver an alarm notification.
  if (native() && chrome.alarms) await chrome.alarms.clear(name);
}

export async function restoreClockSchedules() {
  if (!native()) return;
  for (const alarm of await chrome.alarms.getAll()) {
    if (alarm.name.startsWith(ALARM_PREFIX) && alarm.name.slice(ALARM_PREFIX.length).split(':')[1] === 'alarm') await chrome.alarms.clear(alarm.name);
  }
  const all = await localData.get(null), navigation = all['owntab.local.v1']?.state;
  // A screen deletion only detaches the widget. Its record, local timers and
  // countdown plans remain valid until the user explicitly removes the widget.
  const valid = new Set(navigation?.entries?.filter((entry) => entry.type === 'widget' && entry.extensionId === 'clock').map((entry) => entry.id) || []);
  for (const [key, input] of Object.entries(all)) if (key.startsWith(PREFIX)) {
    const id = key.slice(PREFIX.length);
    if (!valid.has(id)) { await removeClockState(id); continue; }
    try {
      check(input);
      await prepareClockState(id);
    } catch { /* Leave malformed stored state for explicit recovery. */ }
  }
}
export async function removeClockState(id) {
  if (native()) {
    for (const alarm of await chrome.alarms.getAll()) if (alarm.name.startsWith(alarmScope(id))) await chrome.alarms.clear(alarm.name);
  }
  await localData.remove(keyFor(id));
}
