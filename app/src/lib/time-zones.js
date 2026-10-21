import { tr, getLocale } from "../i18n/index.js";
export const WORLD_ZONES = Object.freeze([
  ['Asia/Shanghai', '北京'], ['Asia/Hong_Kong', '香港'], ['Asia/Tokyo', '东京'],
  ['Asia/Singapore', '新加坡'], ['Asia/Kolkata', '新德里'], ['Asia/Dubai', '迪拜'],
  ['Europe/London', '伦敦'], ['Europe/Paris', '巴黎'], ['Europe/Berlin', '柏林'],
  ['America/New_York', '纽约'], ['America/Chicago', '芝加哥'], ['America/Los_Angeles', '洛杉矶'],
  ['Australia/Sydney', '悉尼'], ['Pacific/Auckland', '奥克兰'], ['UTC', 'UTC'],
].map(([value, label]) => Object.freeze({ value, get label() { return tr(label); } })));
export const DEFAULT_WORLD_ZONES = Object.freeze(['Asia/Shanghai', 'Europe/London', 'America/New_York', 'America/Los_Angeles']);
const formatters = new Map();
export function normalizeTimeZone(value) {
  if (typeof value !== 'string' || !value || value.length > 100 || !/^[A-Za-z_+\-/\d]+$/.test(value)) throw Error(tr("请填写有效的 IANA 时区。"));
  try { return new Intl.DateTimeFormat('en', { timeZone: value }).resolvedOptions().timeZone; }
  catch { throw Error(tr("浏览器不支持这个时区。")); }
}
export const zoneLabel = (zone) => WORLD_ZONES.find((item) => item.value === zone)?.label || zone.replaceAll('_', ' ');
export function zoneParts(instant, timeZone) {
  let formatter = formatters.get(timeZone || 'local');
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-GB', { ...(timeZone ? { timeZone } : {}), year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
    if (formatters.size > 64) formatters.clear();
    formatters.set(timeZone || 'local', formatter);
  }
  const parts = Object.fromEntries(formatter.formatToParts(new Date(instant)).filter((part) => part.type !== 'literal').map((part) => [part.type, Number(part.value)]));
  const wall = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return { ...parts, wall, offset: (wall - Math.floor(instant / 1000) * 1000) / 60000 };
}
const pad = (value) => String(value).padStart(2, '0');
export const wallInput = (instant, zone) => {
  const p = zoneParts(instant, zone);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
};
export const utcOffset = (minutes) => {
  const seconds = Math.round(Math.abs(minutes) * 60);
  return `UTC${minutes < 0 ? '−' : '+'}${pad(Math.floor(seconds / 3600))}:${pad(Math.floor(seconds / 60) % 60)}${seconds % 60 ? `:${pad(seconds % 60)}` : ''}`;
};
// Find actual instants instead of treating a wall time as a fixed UTC offset.
// Spring gaps yield no candidate; the repeated autumn hour yields both choices.
export function instantsForWall(input, zone) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(input)) return [];
  const [year, month, day, hour, minute] = input.split(/\D/).map(Number);
  if (year < 1970 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return [];
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  const offsets = new Set();
  for (let hours = -48; hours <= 48; hours += 6) offsets.add(zoneParts(wall + hours * 3600000, zone).offset);
  return [...offsets].map((offset) => wall - offset * 60000).filter((instant) => wallInput(instant, zone) === input).sort((a, b) => a - b);
}
