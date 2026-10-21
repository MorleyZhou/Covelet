import test from 'node:test';
import assert from 'node:assert/strict';
import { formatClock, nextMinuteDelay } from './clock.js';
import { createEmptyState, validateState } from './model.js';

test('clock uses the requested zone across midnight and daylight saving boundaries', () => {
  const midnight = formatClock(new Date('2026-10-18T16:00:00Z'), { timeZone: 'Asia/Shanghai' });
  assert.equal(midnight.time, '00:00');
  assert.match(midnight.date, /10月19日.*星期一/);
  const before = formatClock(new Date('2026-03-08T06:59:00Z'), { locale: 'en-GB', timeZone: 'America/New_York' });
  const after = formatClock(new Date('2026-03-08T07:00:00Z'), { locale: 'en-GB', timeZone: 'America/New_York' });
  assert.equal(before.time, '01:59');
  assert.equal(after.time, '03:00');
  assert.equal(nextMinuteDelay(59_990), 30);
  assert.equal(nextMinuteDelay(59_999), 21);
  assert.equal(nextMinuteDelay(60_000), 60_020);
  assert.throws(() => formatClock('invalid'), /时间无效/);
});

test('legacy settings gain the clock without overwriting a saved icon size or explicit clock preference', () => {
  const state = createEmptyState();
  assert.equal(state.settings.iconSize, 64);
  assert.equal(state.settings.showClock, true);
  delete state.settings.showClock;
  state.settings.iconSize = 108;
  const migrated = validateState(state);
  assert.equal(migrated.settings.showClock, true);
  assert.equal(migrated.settings.iconSize, 108);
  migrated.settings.showClock = false;
  assert.equal(validateState(migrated).settings.showClock, false);
  assert.equal(Object.hasOwn(state.settings, 'showClock'), false);
});
