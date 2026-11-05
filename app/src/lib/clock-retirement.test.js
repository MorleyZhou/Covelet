import test from 'node:test';
import assert from 'node:assert/strict';
import { retireClockSchedules } from './clock-runtime.js';

test('clock retirement clears only owned plans, is repeatable and never reads or deletes runtime storage', async () => {
  const plans = new Map(['covelet-clock:old:timer', 'covelet-clock:old:alarm:one', 'other-feature:alarm', 'covelet-clock-lookalike'].map(name => [name, { name }]));
  const cleared = [], browser = { alarms: {
    async getAll() { return [...plans.values()]; },
    async clear(name) { cleared.push(name); return plans.delete(name); },
    async create() { assert.fail('retirement must not create another alarm'); },
  }, get storage() { assert.fail('retirement must not access or delete persisted clock records'); } };
  await retireClockSchedules(browser);
  assert.deepEqual(cleared, ['covelet-clock:old:timer', 'covelet-clock:old:alarm:one']);
  assert.deepEqual([...plans.keys()], ['other-feature:alarm', 'covelet-clock-lookalike']);
  await retireClockSchedules(browser);
  assert.equal(cleared.length, 2);
  await retireClockSchedules({});
});
