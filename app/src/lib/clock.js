import { tr, getLocale } from "../i18n/index.js";
export function formatClock(value = new Date(), { locale = getLocale(), timeZone } = {}) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(tr("时间无效"));
  const zone = timeZone ? { timeZone } : {};
  return {
    time: new Intl.DateTimeFormat(locale, { ...zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date),
    date: new Intl.DateTimeFormat(locale, { ...zone, month: 'long', day: 'numeric', weekday: 'long' }).format(date),
    iso: date.toISOString(),
  };
}

export function nextMinuteDelay(now = Date.now()) {
  return 60_000 - (now % 60_000) + 20;
}
