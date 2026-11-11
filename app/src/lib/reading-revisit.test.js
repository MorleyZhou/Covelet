import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { isDateKey, isReadingDue, localDateKey, matchesReadingRevisit, validateRevisitOn } from './reading-revisit.js';

test('revisit dates are actual four-digit Gregorian dates without timestamps or normalization', () => {
  for (const value of ['0001-01-01', '2000-02-29', '2024-02-29', '2026-11-11', '9999-12-31']) assert.equal(validateRevisitOn(value), value);
  for (const value of ['', null, undefined, '0000-01-01', '1900-02-29', '2026-02-29', '2026-04-31', '2026-1-01', '2026-13-01', '2026-11-00', '2026-11-11T00:00:00Z', ' 2026-11-11']) {
    assert.equal(isDateKey(value), false); assert.throws(() => validateRevisitOn(value), { code: 'READING_REVISIT' });
  }
});

test('due includes today and overdue dates independently of status and scheduled includes future dates', () => {
  const today = '2026-11-11';
  for (const status of ['unread', 'read', 'archived']) {
    assert(isReadingDue({ revisitOn: today, status }, today));
    assert(isReadingDue({ revisitOn: '2026-11-10', status }, today));
  }
  assert(!isReadingDue({ revisitOn: '2026-11-12' }, today));
  assert(matchesReadingRevisit({ revisitOn: '2026-11-12' }, 'scheduled', today));
  assert(matchesReadingRevisit({ revisitOn: '2026-11-10' }, 'scheduled', today));
  assert(matchesReadingRevisit({}, 'none', today)); assert(!matchesReadingRevisit({ revisitOn: today }, 'none', today));
  assert(!isReadingDue({}, today)); assert(!isReadingDue({ revisitOn: today }, 'invalid'));
});

test('local day calculation follows each device timezone instead of slicing UTC timestamps', () => {
  assert.equal(localDateKey(new Date(2026, 10, 11)), '2026-11-11');
  const moduleUrl = new URL('./reading-revisit.js', import.meta.url).href;
  const code = `import {localDateKey,isReadingDue} from ${JSON.stringify(moduleUrl)}; const today=localDateKey(new Date('2026-11-10T16:30:00Z')); console.log(JSON.stringify({today,due:isReadingDue({revisitOn:'2026-11-11'},today)}));`;
  for (const [timezone, expected] of [['Asia/Tokyo', { today: '2026-11-11', due: true }], ['America/Los_Angeles', { today: '2026-11-10', due: false }]]) {
    assert.deepEqual(JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, TZ: timezone }, encoding: 'utf8' })), expected);
  }
});
