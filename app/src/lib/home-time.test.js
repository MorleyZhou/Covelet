import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_HOME_TIME, HOME_TIME_KEY, formatHomeTime, homeTimeZoneOptions, normalizeHomeTimeSettings } from './home-time.js';
import { isSyncRecord } from './sync-data-rules.js';

const at = (instant, timeZone, locale = 'zh-CN') => formatHomeTime(new Date(instant), locale, { ...DEFAULT_HOME_TIME, timeZone });

test('the configured time zone keeps Gregorian date, lunar date and zodiac on the same local day', () => {
  const instant = '2026-03-20T16:05:00Z';
  const shanghai = at(instant, 'Asia/Shanghai'), utc = at(instant, 'UTC');
  assert.match(shanghai.time, /^0{1,2}:05$/);
  assert.match(shanghai.date, /3月21日/);
  assert.equal(shanghai.lunar, '二月初三');
  assert.equal(shanghai.zodiac, '白羊座');
  assert.equal(utc.time, '16:05');
  assert.match(utc.date, /3月20日/);
  assert.equal(utc.lunar, '二月初二');
  assert.equal(utc.zodiac, '双鱼座');
});

test('lunar new year and leap month retain their localized labels', () => {
  assert.equal(at('2026-02-17T12:00:00Z', 'Asia/Shanghai').lunar, '正月初一');
  assert.equal(at('2025-07-25T12:00:00Z', 'Asia/Shanghai').lunar, '闰六月初一');
  assert.equal(at('2025-07-25T12:00:00Z', 'Asia/Shanghai', 'zh-TW').lunar, '閏六月初一');
  assert.equal(at('2026-02-17T12:00:00Z', 'Asia/Shanghai', 'en').lunar, 'First Month 1');
});

test('time settings preserve independent switches and stay device-local', () => {
  assert.deepEqual(normalizeHomeTimeSettings(), DEFAULT_HOME_TIME);
  const settings = normalizeHomeTimeSettings({ timeZone: 'not/a-zone', showLunar: false, showZodiac: false });
  assert.deepEqual(settings, { timeZone: 'local', showLunar: false, showZodiac: false });
  const { lunar, zodiac } = formatHomeTime(new Date('2026-02-17T12:00:00Z'), 'zh-CN', settings);
  assert.equal(lunar, '');
  assert.equal(zodiac, '');
  assert.equal(homeTimeZoneOptions('local')[0].value, 'local');
  assert.ok(homeTimeZoneOptions('Asia/Shanghai').some(({ value }) => value === 'Asia/Shanghai'));
  assert.equal(isSyncRecord('preferences', HOME_TIME_KEY), false);
});
