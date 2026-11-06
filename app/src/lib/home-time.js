import { tr } from '../i18n/index.js';
import { localData } from './local-data.js';
import { normalizeTimeZone, WORLD_ZONES, zoneLabel, zoneParts } from './time-zones.js';

export const HOME_TIME_KEY = 'covelet.home-time.v1';
export const DEFAULT_HOME_TIME = Object.freeze({ timeZone: 'local', showLunar: true, showZodiac: true });

export function normalizeHomeTimeSettings(value) {
  let timeZone = 'local';
  if (value?.timeZone && value.timeZone !== 'local') {
    try { timeZone = normalizeTimeZone(value.timeZone); } catch { /* An obsolete zone follows the device. */ }
  }
  return { timeZone, showLunar: value?.showLunar !== false, showZodiac: value?.showZodiac !== false };
}

export async function loadHomeTimeSettings() {
  return normalizeHomeTimeSettings((await localData.get(HOME_TIME_KEY))[HOME_TIME_KEY]);
}

export function updateHomeTimeSetting(field, value) {
  if (field === 'timeZone' && value !== 'local') value = normalizeTimeZone(value);
  else if (field !== 'timeZone' && (!(field === 'showLunar' || field === 'showZodiac') || typeof value !== 'boolean')) {
    throw new TypeError('Invalid time and date setting.');
  }
  return localData.update(HOME_TIME_KEY, (current) => ({ ...normalizeHomeTimeSettings(current), [field]: value }));
}

export function subscribeHomeTimeSettings(listener) {
  return localData.subscribe((changes) => {
    if (changes[HOME_TIME_KEY]) listener(normalizeHomeTimeSettings(changes[HOME_TIME_KEY].newValue));
  });
}

export function homeTimeZoneOptions(selected) {
  const common = new Map(WORLD_ZONES.map(({ value, label }) => [normalizeTimeZone(value), label]));
  const all = new Set([...common.keys(), ...(Intl.supportedValuesOf?.('timeZone') || [])]);
  if (selected !== 'local') all.add(selected);
  return [{ value: 'local', label: tr('跟随系统') }, ...[...all].map((value) => ({ value, label: common.get(value) || zoneLabel(value) }))];
}

function lunarDate(now, locale, timeZone) {
  const formatter = new Intl.DateTimeFormat(locale, { calendar: 'chinese', timeZone, month: 'long', day: 'numeric' });
  if (formatter.resolvedOptions().calendar !== 'chinese') return '';
  if (locale !== 'zh-CN' && locale !== 'zh-TW') return formatter.format(now);
  const parts = formatter.formatToParts(now);
  const month = parts.find((part) => part.type === 'month')?.value;
  const day = Number(parts.find((part) => part.type === 'day')?.value);
  if (!month || !Number.isInteger(day) || day < 1 || day > 30) return formatter.format(now);
  const digit = '〇一二三四五六七八九'[day % 10];
  if (day < 10) return `${month}初${digit}`;
  if (day === 10 || day === 20 || day === 30) return month + ({ 10: '初十', 20: '二十', 30: '三十' }[day]);
  return `${month}${day < 20 ? '十' : '廿'}${digit}`;
}

// Conventional Western zodiac date ranges, applied to the chosen zone's
// Gregorian day so that the sign changes alongside the displayed date.
const ZODIAC = [
  [20, '水瓶座'], [19, '双鱼座'], [21, '白羊座'], [20, '金牛座'],
  [21, '双子座'], [21, '巨蟹座'], [23, '狮子座'], [23, '处女座'],
  [23, '天秤座'], [23, '天蝎座'], [22, '射手座'], [22, '摩羯座'],
];

export function formatHomeTime(now, locale, settings = DEFAULT_HOME_TIME) {
  const timeZone = settings.timeZone === 'local' ? new Intl.DateTimeFormat().resolvedOptions().timeZone : settings.timeZone;
  const time = new Intl.DateTimeFormat(locale, { timeZone, hour: 'numeric', minute: '2-digit' }).format(now);
  const date = new Intl.DateTimeFormat(locale, { timeZone, calendar: 'gregory', month: 'long', day: 'numeric', weekday: 'long' }).format(now);
  const lunar = settings.showLunar ? lunarDate(now, locale, timeZone) : '';
  let zodiac = '';
  if (settings.showZodiac) {
    const { month, day } = zoneParts(+now, timeZone);
    const [firstDay, current] = ZODIAC[month - 1];
    zodiac = day >= firstDay ? current : ZODIAC[(month + 10) % 12][1];
  }
  return { time, date, lunar, zodiac };
}
