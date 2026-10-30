import { localData } from './local-data.js';
import { tr } from '../i18n/index.js';
const KEY = 'covelet.app.v1.tasks', PREFIX = 'covelet:task:';
const stamp = (task) => `${task.id}:${Date.parse(task.remindAt)}`;
export async function restoreTaskReminders() {
  if (!globalThis.chrome?.alarms) return;
  const envelope = (await localData.get(KEY))[KEY], data = envelope?.data;
  const rows = data?.notifications ? (data.tasks || []).filter((task) => !task.completed && task.remindAt && Number.isFinite(Date.parse(task.remindAt)) && task.notifiedAt !== Date.parse(task.remindAt)) : [];
  const expected = new Map(rows.map((task) => [PREFIX + stamp(task), task]));
  for (const alarm of await chrome.alarms.getAll()) if (alarm.name.startsWith(PREFIX) && !expected.has(alarm.name)) await chrome.alarms.clear(alarm.name);
  for (const [name, task] of expected) if (!await chrome.alarms.get(name)) await chrome.alarms.create(name, { when: Math.max(Date.now() + 1000, Date.parse(task.remindAt)) });
}
export async function handleTaskReminder(name) {
  if (!name.startsWith(PREFIX)) return;
  const envelope = (await localData.get(KEY))[KEY], data = envelope?.data;
  const task = data?.notifications && (data.tasks || []).find((item) => PREFIX + stamp(item) === name && !item.completed && item.notifiedAt !== Date.parse(item.remindAt));
  if (!task || !await chrome.permissions.contains({ permissions: ['notifications'] })) return;
  // Hidden task widgets must never disclose a title through notifications.
  const values = await localData.get(['covelet.content.preferences.v1', 'owntab.local.v1']);
  const prefs = values['covelet.content.preferences.v1'], entries = values['owntab.local.v1']?.state?.entries || [];
  const hidden = prefs?.presentation && entries.some((entry) => entry.extensionId === 'tasks' && prefs.privateKeys?.includes(`widget:${entry.id}`));
  await chrome.notifications.create(name, { type: 'basic', iconUrl: chrome.runtime.getURL('icons/icon-128.png'), title: tr('待办提醒'), message: hidden ? tr('有一项任务需要处理。') : task.title.slice(0, 200), priority: 1 });
  await localData.update(KEY, (latest) => {
    if (!latest?.data) return latest;
    return { ...latest, revision: latest.revision + 1, data: { ...latest.data, tasks: latest.data.tasks.map((item) => PREFIX + stamp(item) === name ? { ...item, notifiedAt: Date.parse(item.remindAt) } : item) } };
  });
}
