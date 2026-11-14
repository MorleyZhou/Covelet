import { tr } from '../i18n/index.js';

export function isDateKey(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return day <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}

export function validateRevisitOn(value) {
  if (!isDateKey(value)) throw Object.assign(Error(tr('再看日期无效，请选择有效日期。')), { code: 'READING_REVISIT' });
  return value;
}

export function localDateKey(now = new Date()) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime()) || now.getFullYear() < 1 || now.getFullYear() > 9999) throw RangeError('Invalid local date');
  return `${String(now.getFullYear()).padStart(4, '0')}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

export function isReadingDue(item, today = localDateKey()) {
  return isDateKey(today) && isDateKey(item?.revisitOn) && item.revisitOn <= today;
}

function nextSevenDayEnd(today) {
  const [year, month, day] = today.split('-').map(Number), date = new Date(0);
  // Calendar arithmetic must ignore DST and Date.UTC's special handling of
  // years 0..99. Stored dates remain local-day keys rather than instants.
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() + 6);
  if (date.getUTCFullYear() > 9999) return '9999-12-31';
  return `${String(date.getUTCFullYear()).padStart(4, '0')}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

export function matchesReadingRevisit(item, revisit, today = localDateKey()) {
  if (revisit === null || revisit === undefined) return true;
  if (revisit === 'none') return item?.revisitOn === undefined;
  if (revisit === 'scheduled') return isDateKey(item?.revisitOn);
  if (revisit === 'today') return isDateKey(today) && item?.revisitOn === today;
  if (revisit === 'next7d') return isDateKey(today) && isDateKey(item?.revisitOn) && item.revisitOn >= today && item.revisitOn <= nextSevenDayEnd(today);
  return revisit === 'due' && isReadingDue(item, today);
}
