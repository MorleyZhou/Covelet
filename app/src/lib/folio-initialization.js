// The parser can leave undefined object keys, which do not exist in JSON.
const has = (value, key) => Object.hasOwn(value, key) && value[key] !== undefined;
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const generatedId = /^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/iu;
const linkDefaults = Object.freeze({ target: '_blank', rel: 'noopener noreferrer nofollow', class: null, title: null });

function sameAttributes(before, after, type) {
  if (!object(before) || !object(after)) return false;
  const headingIdentity = type === 'heading' && !has(before, 'id') && !has(before, 'data-toc-id') && has(after, 'id') && has(after, 'data-toc-id')
    && (after.id === null && after['data-toc-id'] === null || generatedId.test(after.id) && after['data-toc-id'] === after.id);
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (!has(before, key) && !has(after, key)) continue;
    if (has(before, key)) {
      if (!has(after, key) || !sameValue(before[key], after[key])) return false;
    } else if (!(key === 'folioBlockId' && after[key] === null)
      && !(type === 'link' && has(linkDefaults, key) && after[key] === linkDefaults[key])
      && !(type === 'orderedList' && (key === 'start' && after[key] === 1 || key === 'type' && after[key] === null))
      && !(headingIdentity && (key === 'id' || key === 'data-toc-id'))) return false;
  }
  return true;
}

function sameValue(before, after) {
  if (before === after) return true;
  if (Array.isArray(before) || Array.isArray(after)) return Array.isArray(before) && Array.isArray(after)
    && before.length === after.length && before.every((item, index) => sameValue(item, after[index]));
  if (!object(before) || !object(after)) return false;
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (!has(before, key) && !has(after, key)) continue;
    if (key === 'attrs' && typeof before.type === 'string' && before.type === after.type && has(after, key)) {
      if (!sameAttributes(has(before, key) ? before[key] : {}, after[key], before.type)) return false;
    } else if (!has(before, key) || !has(after, key) || !sameValue(before[key], after[key])) return false;
  }
  return true;
}

// Folio 0.2.1 emits an update when its schema supplies missing defaults or
// generates a paired heading/TOC identity. Keep all text, structure, marks,
// links, existing identities and nondefault attribute changes observable.
export function isFolioInitializationChange(before, after) {
  return sameValue(before, after);
}
