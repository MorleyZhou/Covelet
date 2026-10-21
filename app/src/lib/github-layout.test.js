import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { githubCalendarSections } from './github-layout.js';
import { createGitHubWasm } from './github-wasm.js';
import { validateContributionDays } from './github-contributions.js';

test('single and split panels preserve the same full calendar, totals and global cell indices', async () => {
  const snapshot = JSON.parse(await readFile(new URL('../assets/github-preview.json', import.meta.url), 'utf8'));
  const days = validateContributionDays(snapshot.days);
  const core = await createGitHubWasm(await readFile(new URL('../wasm/github-core.wasm', import.meta.url)));
  const calendar = core.analyze(days);
  const single = githubCalendarSections(calendar);
  const sections = githubCalendarSections(calendar, true);
  assert.equal(single.length, 1);
  assert.deepEqual(single.flatMap((section) => section.cells), calendar.cells);
  assert.equal(sections.length, 2);
  assert.equal(sections[1].start % 7, 0);
  assert.deepEqual(sections.flatMap((section) => section.cells), calendar.cells);
  assert.equal(sections.flatMap((section) => section.cells).filter(Boolean).length, days.length);
  assert.equal(sections[0].weeks + sections[1].weeks, calendar.weeks);
  assert.equal(sections[1].cells[0], calendar.cells[sections[1].start]);
  assert.equal(calendar.total, days.reduce((sum, day) => sum + day.count, 0));
});

test('panel wrapping preserves partial edge weeks and their blank cells', () => {
  const cells = Array.from({ length: 21 }, (_, index) => index < 3 || index > 17 ? null : { date: `2026-01-${String(index).padStart(2, '0')}` });
  const calendar = { weeks: 3, cells };
  const medium = githubCalendarSections(calendar);
  assert.equal(medium.length, 1); assert.deepEqual(medium[0].cells, cells);
  const annual = githubCalendarSections(calendar, true);
  assert.deepEqual(annual.map(({ weeks }) => weeks), [2, 1]);
  assert.deepEqual(annual.flatMap(({ cells }) => cells), cells);
});
