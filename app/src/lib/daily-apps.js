import { tr } from '../i18n/index.js';

const DAY = 86400000;
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const object = (value) => value && typeof value === 'object' && !Array.isArray(value);
const fail = (message) => { throw Error(tr(message)); };
export const appId = () => crypto.randomUUID();
export function boundedText(value, maximum, required = false) {
  if (typeof value !== 'string' || value.includes('\0') || value.length > maximum || required && !value.trim()) fail('请检查填写的内容。');
  return value.trim();
}
export function dateKey(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) fail('日期无效。');
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
export function validDate(value, optional = true) {
  if (value === '' && optional) return '';
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail('日期无效。');
  const [year, month, day] = value.split('-').map(Number), date = new Date(year, month - 1, day, 12);
  if (year < 1900 || year > 2200 || dateKey(date) !== value) fail('日期无效。');
  return value;
}
export function safeUrl(value) {
  if (!value) return '';
  boundedText(value, 4096);
  try { const url = new URL(value); if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) return url.href; } catch { /* Rejected below. */ }
  fail('请填写有效的 HTTP 或 HTTPS 地址。');
}
export function upsertRecord(records, record, expected = null, limit = 2000) {
  const current = records.find((item) => item.id === record.id);
  if (expected !== null && (!current || current.revision !== expected)) fail('这条记录已在其他页面更新，请重新打开。');
  if (expected === null && current) fail('这条记录已存在。');
  if (!current && records.length >= limit) fail('记录数量已达上限，请先整理已有内容。');
  const saved = { ...record, revision: (current?.revision || 0) + 1, updatedAt: Date.now() };
  return { records: current ? records.map((item) => item.id === record.id ? saved : item) : [...records, saved], saved };
}
export function removeRecord(records, id, expected) {
  const current = records.find((item) => item.id === id);
  if (!current || current.revision !== expected) fail('这条记录已在其他页面更新，请重新打开。');
  return records.filter((item) => item.id !== id);
}

export const TASK_DEFAULTS = Object.freeze({ lists: [{ id: 'inbox', name: '' }], tasks: [], history: [], notifications: false });
export const TASK_REPEATS = Object.freeze(['none', 'daily', 'weekdays', 'weekly', 'monthly']);
export function normalizeTask(input, now = Date.now()) {
  if (!object(input)) fail('任务无效。');
  const title = boundedText(input.title, 300, true), steps = input.steps || [];
  if (!Array.isArray(steps) || steps.length > 50 || !TASK_REPEATS.includes(input.repeat || 'none')) fail('任务无效。');
  const reminder = input.remindAt ? new Date(input.remindAt) : null;
  if (reminder && !Number.isFinite(reminder.getTime())) fail('提醒时间无效。');
  const normalized = { id: input.id || appId(), title, listId: boundedText(input.listId || 'inbox', 100, true),
    important: Boolean(input.important), myDay: validDate(input.myDay || ''), dueDate: validDate(input.dueDate || ''),
    remindAt: reminder ? reminder.toISOString() : '', repeat: input.repeat || 'none',
    notes: boundedText(input.notes || '', 20000),
    steps: steps.map((step) => ({ id: step.id || appId(), title: boundedText(step.title, 300, true), done: Boolean(step.done) })),
    completed: Boolean(input.completed), completedAt: Number(input.completedAt) || 0, createdAt: Number(input.createdAt) || now,
    notifiedAt: Number.isFinite(input.notifiedAt) && input.notifiedAt >= 0 ? input.notifiedAt : 0 };
  if (new Set(normalized.steps.map((item) => item.id)).size !== normalized.steps.length) fail('任务步骤无效。');
  return normalized;
}
export function nextTaskDate(anchor, repeat, today = dateKey()) {
  validDate(anchor, false); validDate(today, false);
  if (!TASK_REPEATS.includes(repeat) || repeat === 'none') return '';
  const base = anchor > today ? anchor : today, [y, m, d] = base.split('-').map(Number), date = new Date(y, m - 1, d, 12);
  if (repeat === 'monthly') {
    const last = new Date(y, m + 1, 0, 12).getDate(); date.setDate(1); date.setMonth(m); date.setDate(Math.min(d, last));
  } else {
    date.setDate(date.getDate() + (repeat === 'weekly' ? 7 : 1));
    if (repeat === 'weekdays') while ([0, 6].includes(date.getDay())) date.setDate(date.getDate() + 1);
  }
  return dateKey(date);
}
export function toggleTask(data, id, now = Date.now()) {
  const current = data.tasks.find((item) => item.id === id); if (!current) fail('任务已被移除。');
  const task = { ...current, revision: (current.revision || 1) + 1, updatedAt: now };
  if (task.completed) { task.completed = false; task.completedAt = 0; return { ...data, tasks: data.tasks.map((item) => item.id === id ? task : item) }; }
  const history = [...(data.history || []), { id: appId(), taskId: task.id, title: task.title, completedAt: now, listId: task.listId }].slice(-5000);
  if (task.repeat !== 'none') {
    const next = nextTaskDate(task.dueDate || dateKey(now), task.repeat, dateKey(now));
    if (task.remindAt) {
      const reminder = new Date(task.remindAt), [y, m, d] = next.split('-').map(Number);
      reminder.setFullYear(y, m - 1, d); task.remindAt = reminder.toISOString();
    }
    task.dueDate = next; task.myDay = ''; task.steps = task.steps.map((step) => ({ ...step, done: false })); task.completedAt = 0;
  } else { task.completed = true; task.completedAt = now; }
  return { ...data, history, tasks: data.tasks.map((item) => item.id === id ? task : item) };
}
export function dueTaskReminders(data, now = Date.now()) {
  if (!data?.notifications) return [];
  return (data.tasks || []).filter((task) => !task.completed && task.remindAt && Number.isFinite(Date.parse(task.remindAt)) && Date.parse(task.remindAt) <= now)
    .map((task) => ({ id: task.id, title: task.title, when: Date.parse(task.remindAt), revision: task.revision }));
}

export const SNIPPET_DEFAULTS = Object.freeze({ items: [] });
export function templateVariables(body) {
  boundedText(body, 100000);
  return [...new Set([...body.matchAll(/\{\{\s*([\p{L}\p{N}_ .-]{1,60})\s*\}\}/gu)].map((match) => match[1].trim()))].slice(0, 40);
}
export function fillTemplate(body, variables = {}, now = new Date()) {
  const values = { date: dateKey(now), time: `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`, ...variables };
  return body.replace(/\{\{\s*([\p{L}\p{N}_ .-]{1,60})\s*\}\}/gu, (whole, key) => own(values, key.trim()) ? String(values[key.trim()]) : whole);
}
export function normalizeSnippet(input) {
  if (!object(input) || !['text', 'code', 'prompt', 'command'].includes(input.kind)) fail('小抄内容无效。');
  boundedText(input.body, 100000, true);
  return { id: input.id || appId(), title: boundedText(input.title, 200, true), body: input.body,
    description: boundedText(input.description || '', 2000), kind: input.kind, language: boundedText(input.language || '', 40),
    folder: boundedText(input.folder || '', 80), tags: [...new Set(boundedText(input.tags || '', 500).split(/[,，]/).map((part) => part.trim()).filter(Boolean))].join(', '), favorite: Boolean(input.favorite) };
}
export function importSnippetBundle(text, existing = []) {
  if (typeof text !== 'string' || text.length > 4 * 1024 * 1024) fail('小抄文件过大。');
  let input; try { input = JSON.parse(text); } catch { fail('无法读取小抄文件。'); }
  if (!object(input) || input.format !== 'covelet-snippets' || input.version !== 1 || !Array.isArray(input.items) || input.items.length > 500) fail('小抄文件格式无效。');
  const incoming = input.items.map((item) => normalizeSnippet(item));
  const signatures = new Set(existing.map((item) => JSON.stringify([item.title, item.body, item.kind]))), added = [];
  for (const item of incoming) {
    const signature = JSON.stringify([item.title, item.body, item.kind]);
    if (!signatures.has(signature)) { signatures.add(signature); added.push({ ...item, id: appId(), revision: 1, updatedAt: Date.now() }); }
  }
  if (existing.length + added.length > 2000) fail('记录数量已达上限，请先整理已有内容。');
  return [...existing, ...added];
}

export const LANGUAGE_DEFAULTS = Object.freeze({ words: [], reviews: [], language: 'en' });
export function normalizeWord(input) {
  if (!object(input)) fail('单词内容无效。');
  const language = boundedText(input.language || 'en', 35, true);
  if (!/^[a-zA-Z]{2,8}(?:-[a-zA-Z0-9]{1,8})*$/.test(language)) fail('语种代码无效。');
  return { id: input.id || appId(), term: boundedText(input.term, 200, true), meaning: boundedText(input.meaning, 2000, true),
    language, phonetic: boundedText(input.phonetic || '', 200), example: boundedText(input.example || '', 4000),
    translation: boundedText(input.translation || '', 4000), source: boundedText(input.source || '', 4096), tags: boundedText(input.tags || '', 500),
    stage: Math.max(0, Math.min(20, Number(input.stage) || 0)), interval: Math.max(0, Math.min(365, Number(input.interval) || 0)),
    lapses: Math.max(0, Number(input.lapses) || 0), dueAt: Math.max(0, Number(input.dueAt) || 0), lastReviewedAt: Math.max(0, Number(input.lastReviewedAt) || 0) };
}
export function reviewWord(word, rating, now = Date.now()) {
  if (!['again', 'good', 'easy'].includes(rating)) fail('复习结果无效。');
  const again = rating === 'again', interval = again ? 0 : word.interval ? Math.min(365, Math.max(rating === 'easy' ? 4 : 1, Math.round(word.interval * (rating === 'easy' ? 2.8 : 2)))) : rating === 'easy' ? 4 : 1;
  return { ...word, interval, stage: again ? Math.max(0, (word.stage || 0) - 1) : Math.min(20, (word.stage || 0) + 1),
    lapses: (word.lapses || 0) + (again ? 1 : 0), lastReviewedAt: now, dueAt: now + (again ? 10 * 60000 : interval * DAY),
    revision: (word.revision || 1) + 1, updatedAt: now };
}
export const spellingMatches = (answer, term) => String(answer).normalize('NFKC').trim().toLocaleLowerCase() === String(term).normalize('NFKC').trim().toLocaleLowerCase();

export const TRAVEL_DEFAULTS = Object.freeze({ trips: [] });
export function normalizeTrip(input) {
  if (!object(input)) fail('行程内容无效。');
  const startDate = validDate(input.startDate || ''), endDate = validDate(input.endDate || '');
  if (startDate && endDate && startDate > endDate) fail('结束日期不能早于开始日期。');
  return { id: input.id || appId(), title: boundedText(input.title, 200, true), startDate, endDate, notes: boundedText(input.notes || '', 20000), items: input.items || [] };
}
export function normalizeTripItem(input, trip) {
  if (!object(input) || !['place', 'transport', 'stay', 'booking'].includes(input.type)) fail('行程安排无效。');
  const date = validDate(input.date, false);
  if (trip.startDate && date < trip.startDate || trip.endDate && date > trip.endDate) fail('安排日期应在行程日期范围内。');
  if (input.time && !/^([01]\d|2[0-3]):[0-5]\d$/.test(input.time)) fail('时间无效。');
  const attachments = input.attachments || [];
  if (!Array.isArray(attachments) || attachments.length > 8 || attachments.some((item) => !object(item) || !(item.blob instanceof Blob)
    || item.blob.size > 5 * 1024 * 1024 || !['image/jpeg', 'image/png', 'image/webp', 'application/pdf', 'text/plain'].includes(item.blob.type))
    || attachments.reduce((total, item) => total + item.blob.size, 0) > 20 * 1024 * 1024) fail('附件仅支持图片、PDF 或文本，每个不超过 5 MB。');
  return { id: input.id || appId(), type: input.type, title: boundedText(input.title, 300, true), date, time: input.time || '',
    address: boundedText(input.address || '', 1000), reference: boundedText(input.reference || '', 500), url: safeUrl(input.url || ''), notes: boundedText(input.notes || '', 10000), attachments };
}

export const MEAL_DEFAULTS = Object.freeze({ recipes: [], plan: [], shoppingChecks: {} });
export function normalizeRecipe(input) {
  if (!object(input) || !Array.isArray(input.ingredients) || input.ingredients.length < 1 || input.ingredients.length > 100) fail('请添加食材。');
  const servings = Number(input.servings);
  if (!Number.isFinite(servings) || servings <= 0 || servings > 1000) fail('请填写有效的份数。');
  return { id: input.id || appId(), title: boundedText(input.title, 200, true), servings,
    ingredients: input.ingredients.map((item) => {
      const quantity = item.quantity === '' || item.quantity === null || item.quantity === undefined ? null : Number(item.quantity);
      if (quantity !== null && (!Number.isFinite(quantity) || quantity <= 0 || quantity > 1000000)) fail('食材数量无效。');
      return { id: item.id || appId(), name: boundedText(item.name, 100, true), quantity, unit: boundedText(item.unit || '', 40) };
    }), instructions: boundedText(input.instructions || '', 30000), source: safeUrl(input.source || '') };
}
export function normalizeMealPlan(input, recipes) {
  if (!object(input) || !recipes.some((item) => item.id === input.recipeId) || !['breakfast', 'lunch', 'dinner', 'snack'].includes(input.meal)) fail('用餐安排无效。');
  const servings = Number(input.servings); if (!Number.isFinite(servings) || servings <= 0 || servings > 1000) fail('请填写有效的份数。');
  return { id: input.id || appId(), recipeId: input.recipeId, meal: input.meal, date: validDate(input.date, false), servings };
}
export function shoppingList(recipes, plan) {
  const result = new Map(), byId = new Map(recipes.map((item) => [item.id, item]));
  for (const item of plan) {
    const recipe = byId.get(item.recipeId); if (!recipe) continue;
    for (const ingredient of recipe.ingredients) {
      const key = `${ingredient.name.normalize('NFKC').trim().toLocaleLowerCase()}\0${ingredient.unit.normalize('NFKC').trim().toLocaleLowerCase()}`;
      const quantity = ingredient.quantity === null ? null : ingredient.quantity * item.servings / recipe.servings;
      if (!result.has(key)) result.set(key, { name: ingredient.name, unit: ingredient.unit, quantity, optionalAmount: quantity === null });
      else { const entry = result.get(key); if (quantity === null) entry.optionalAmount = true; else entry.quantity = (entry.quantity || 0) + quantity; }
    }
  }
  return [...result.values()].map((item) => ({ ...item, quantity: item.quantity === null ? null : Math.round(item.quantity * 10000) / 10000 }));
}

// Read/import validation protects a malformed synchronized document from being
// presented as an empty library and subsequently overwritten by a new draft.
export function validateDailyDocument(id, value) {
  if (!object(value)) fail('扩展数据无效，原有内容已保留。');
  const array = (input, limit) => { if (!Array.isArray(input) || input.length > limit) fail('扩展内容过多或格式无效。'); return input; };
  const records = (input, limit, validate) => {
    const seen = new Set();
    for (const item of array(input, limit)) {
      if (!object(item) || typeof item.id !== 'string' || !item.id || item.id.length > 200 || seen.has(item.id)
        || !Number.isSafeInteger(item.revision) || item.revision < 1) fail('扩展记录无效，原有内容已保留。');
      seen.add(item.id); validate(item);
    }
  };
  if (id === 'tasks') {
    const listIds = new Set();
    for (const list of array(value.lists, 40)) {
      if (!object(list) || typeof list.id !== 'string' || !list.id || listIds.has(list.id)) fail('任务清单无效。');
      boundedText(list.name, 100); listIds.add(list.id);
    }
    if (!listIds.has('inbox') || typeof value.notifications !== 'boolean') fail('任务清单无效。');
    records(value.tasks, 2000, (item) => { normalizeTask(item); if (!listIds.has(item.listId)) fail('任务清单无效。'); });
    for (const item of array(value.history, 5000)) {
      if (!object(item) || typeof item.id !== 'string' || !Number.isFinite(item.completedAt) || item.completedAt < 0) fail('任务记录无效。');
      boundedText(item.title, 300, true);
    }
  } else if (id === 'snippets') records(value.items, 2000, normalizeSnippet);
  else if (id === 'language') {
    records(value.words, 10000, (word) => { normalizeWord(word); if (!Number.isSafeInteger(word.stage) || word.stage < 0 || word.stage > 20 || !Number.isFinite(word.dueAt) || word.dueAt < 0) fail('单词记录无效。'); });
    for (const review of array(value.reviews, 10000)) if (!object(review) || typeof review.wordId !== 'string' || !['again', 'good', 'easy'].includes(review.rating) || !Number.isFinite(review.at) || review.at < 0) fail('学习记录无效。');
  } else if (id === 'travel') records(value.trips, 100, (trip) => { normalizeTrip(trip); records(trip.items, 500, (item) => {
    normalizeTripItem(item, trip);
    for (const attachment of item.attachments) { boundedText(attachment.name, 200, true); boundedText(attachment.id, 200, true); }
  }); });
  else if (id === 'meals') {
    records(value.recipes, 1000, normalizeRecipe); records(value.plan, 3000, (item) => normalizeMealPlan(item, value.recipes));
    if (!object(value.shoppingChecks) || Object.keys(value.shoppingChecks).length > 5000 || Object.values(value.shoppingChecks).some((item) => item !== true)) fail('购物记录无效。');
  } else fail('不支持此扩展。');
  return value;
}
export const validateDailyData = validateDailyDocument;
