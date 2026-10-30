import test from 'node:test';
import assert from 'node:assert/strict';
import { TASK_DEFAULTS, LANGUAGE_DEFAULTS, MEAL_DEFAULTS, TRAVEL_DEFAULTS, SNIPPET_DEFAULTS,
  normalizeTask, nextTaskDate, toggleTask, dueTaskReminders, templateVariables, fillTemplate, importSnippetBundle,
  normalizeSnippet, normalizeWord, reviewWord, spellingMatches, normalizeTrip, normalizeTripItem,
  normalizeRecipe, normalizeMealPlan, shoppingList, upsertRecord, removeRecord, validateDailyDocument, dateKey } from './daily-apps.js';

test('daily apps start with structurally valid empty documents', () => {
  for (const [id, value] of Object.entries({ tasks: TASK_DEFAULTS, snippets: SNIPPET_DEFAULTS, language: LANGUAGE_DEFAULTS, travel: TRAVEL_DEFAULTS, meals: MEAL_DEFAULTS })) assert.equal(validateDailyDocument(id, value), value);
});
test('task repetition uses calendar months, weekends, and an overdue anchor', () => {
  assert.equal(nextTaskDate('2024-01-31', 'monthly', '2024-01-31'), '2024-02-29');
  assert.equal(nextTaskDate('2025-01-31', 'monthly', '2025-01-31'), '2025-02-28');
  assert.equal(nextTaskDate('2026-10-30', 'weekdays', '2026-10-30'), '2026-11-02');
  assert.equal(nextTaskDate('2020-01-01', 'daily', '2026-10-30'), '2026-10-31');
});
test('completing recurring tasks retains history and moves steps and reminder together', () => {
  const now = new Date(2026, 9, 30, 12).getTime(), reminder = new Date(2026, 9, 30, 9).toISOString();
  const task = { ...normalizeTask({ title: 'test', dueDate: '2026-10-30', remindAt: reminder, repeat: 'weekly', myDay: '2026-10-30', steps: [{ title: 'part', done: true }] }), revision: 3 };
  const next = toggleTask({ ...TASK_DEFAULTS, tasks: [task] }, task.id, now);
  assert.equal(next.history.length, 1); assert.equal(next.tasks[0].completed, false); assert.equal(next.tasks[0].revision, 4);
  assert.equal(next.tasks[0].dueDate, '2026-11-06'); assert.equal(next.tasks[0].myDay, ''); assert.equal(next.tasks[0].steps[0].done, false);
  assert.equal(dateKey(new Date(next.tasks[0].remindAt)), '2026-11-06');
});
test('due reminders exclude completed, future, malformed, and notifications-disabled tasks', () => {
  const now = Date.now(), tasks = [{ id: 'a', title: 'a', remindAt: new Date(now - 10).toISOString(), revision: 1 },
    { id: 'b', remindAt: new Date(now + 10000).toISOString() }, { id: 'c', remindAt: new Date(now - 10).toISOString(), completed: true }, { id: 'd', remindAt: 'broken' }];
  assert.deepEqual(dueTaskReminders({ notifications: false, tasks }, now), []);
  assert.deepEqual(dueTaskReminders({ notifications: true, tasks }, now).map((item) => item.id), ['a']);
});
test('record edits and deletion refuse stale revisions without changing the source', () => {
  const original = [{ id: 'one', title: 'original', revision: 4 }];
  assert.throws(() => upsertRecord(original, { id: 'one', title: 'stale' }, 3));
  assert.throws(() => removeRecord(original, 'one', 3));
  const updated = upsertRecord(original, { id: 'one', title: 'updated' }, 4);
  assert.equal(updated.saved.revision, 5); assert.equal(original[0].title, 'original');
});
test('templates preserve unknown placeholders and substitute special property names safely', () => {
  assert.deepEqual(templateVariables('{{姓名}} {{姓名}} {{ project-id }}'), ['姓名', 'project-id']);
  assert.equal(fillTemplate('Hi {{ name }} {{missing}} {{constructor}}', { name: 'Ada' }), 'Hi Ada {{missing}} {{constructor}}');
  assert.equal(fillTemplate('{{date}} {{time}}', {}, new Date(2026, 9, 30, 8, 7)), '2026-10-30 08:07');
});
test('snippet import validates all records before adding, skips content duplicates, and keeps code whitespace', () => {
  const source = normalizeSnippet({ title: 'test', body: '  return 1;\n', kind: 'code' });
  assert.equal(source.body, '  return 1;\n');
  const existing = [{ ...source, revision: 1 }], text = JSON.stringify({ format: 'covelet-snippets', version: 1, items: [source, { ...source, title: 'other', id: source.id }] });
  const result = importSnippetBundle(text, existing); assert.equal(result.length, 2); assert.notEqual(result[1].id, source.id); assert.equal(existing.length, 1);
  assert.throws(() => importSnippetBundle(JSON.stringify({ format: 'covelet-snippets', version: 1, items: [source, { title: 'invalid' }] }), existing));
});
test('word review records meaningful delays and preserves semantic text', () => {
  const word = { ...normalizeWord({ term: '  café ', meaning: 'coffee', language: 'fr', example: 'Un café.' }), revision: 1 }, now = 100000;
  const first = reviewWord(word, 'good', now); assert.equal(first.dueAt - now, 86400000); assert.equal(first.interval, 1);
  const second = reviewWord(first, 'good', now); assert.equal(second.interval, 2);
  const again = reviewWord(second, 'again', now); assert.equal(again.lapses, 1); assert.equal(again.dueAt - now, 600000);
  assert.equal(spellingMatches('ＣＡＦÉ ', 'café'), true); assert.equal(spellingMatches('cafe', 'café'), false);
});
test('travel validates real dates, trip ranges, and credential-free links', () => {
  assert.throws(() => normalizeTrip({ title: 'trip', startDate: '2025-02-29' }));
  const trip = normalizeTrip({ title: 'trip', startDate: '2026-11-01', endDate: '2026-11-04' });
  assert.throws(() => normalizeTripItem({ title: 'flight', date: '2026-10-31', type: 'transport' }, trip));
  assert.throws(() => normalizeTripItem({ title: 'hotel', date: '2026-11-02', type: 'stay', url: 'javascript:alert(1)' }, trip));
  assert.throws(() => normalizeTripItem({ title: 'hotel', date: '2026-11-02', type: 'stay', url: 'https://user:secret@example.com' }, trip));
  assert.equal(normalizeTripItem({ title: 'hotel', date: '2026-11-02', type: 'stay', url: 'https://example.com' }, trip).url, 'https://example.com/');
});
test('travel attachments accept local PDF bytes and reject executable or oversized types', () => {
  const trip = normalizeTrip({ title: 'trip' }), base = { title: 'ticket', type: 'booking', date: '2026-11-01' };
  const attachment = { id: 'file', name: 'ticket.pdf', blob: new Blob(['%PDF-'], { type: 'application/pdf' }) };
  assert.equal(normalizeTripItem({ ...base, attachments: [attachment] }, trip).attachments[0].blob, attachment.blob);
  assert.throws(() => normalizeTripItem({ ...base, attachments: [{ blob: new Blob(['<script>'], { type: 'text/html' }) }] }, trip));
});
test('shopping quantities scale portions and merge only compatible units', () => {
  const recipe = normalizeRecipe({ title: 'meal', servings: 2, ingredients: [{ name: 'Rice', quantity: 100, unit: 'g' }, { name: 'Salt', quantity: null, unit: '' }] });
  const another = normalizeRecipe({ title: 'other', servings: 1, ingredients: [{ name: 'rice', quantity: 0.5, unit: 'kg' }, { name: 'Rice', quantity: 25, unit: 'g' }] });
  const plan = [{ recipeId: recipe.id, servings: 4 }, { recipeId: another.id, servings: 2 }];
  const result = shoppingList([recipe, another], plan);
  assert.equal(result.find((item) => item.unit === 'g').quantity, 250); assert.equal(result.find((item) => item.unit === 'kg').quantity, 1);
  assert.equal(result.find((item) => item.name === 'Salt').quantity, null);
});
test('meal plans require an existing recipe, positive portions, and a calendar date', () => {
  const recipe = normalizeRecipe({ title: 'meal', servings: 2, ingredients: [{ name: 'rice', quantity: 100, unit: 'g' }] });
  assert.throws(() => normalizeMealPlan({ recipeId: 'missing', meal: 'dinner', servings: 2, date: '2026-11-01' }, [recipe]));
  assert.throws(() => normalizeMealPlan({ recipeId: recipe.id, meal: 'dinner', servings: -1, date: '2026-11-01' }, [recipe]));
  assert.equal(normalizeMealPlan({ recipeId: recipe.id, meal: 'dinner', servings: 2, date: '2026-11-01' }, [recipe]).servings, 2);
});
test('malformed synchronized libraries are rejected instead of being shown as empty', () => {
  assert.throws(() => validateDailyDocument('snippets', { items: {} }));
  assert.throws(() => validateDailyDocument('tasks', { ...TASK_DEFAULTS, lists: [] }));
  assert.throws(() => validateDailyDocument('language', { ...LANGUAGE_DEFAULTS, words: [{ id: 'word', term: 'test', meaning: 'test', language: 'en', revision: 1, stage: -1, dueAt: 0 }] }));
  assert.throws(() => validateDailyDocument('meals', { ...MEAL_DEFAULTS, shoppingChecks: { invalid: 'yes' } }));
});
