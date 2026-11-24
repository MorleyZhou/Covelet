// Semantic merging sits inside the existing authenticated all-data-v1 records.
// It neither changes their wire identities nor decides causal ordering.
const MAX_ROWS = 12000;
const copy = (value) => value === undefined ? undefined : structuredClone(value);
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Blob);
const own = (value, key) => Object.hasOwn(value || {}, key);
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const fail = (code = 'DATA_SYNC_INVALID') => { throw Object.assign(new Error(code), { code }); };

// Blob metadata and JSON serialization cannot establish byte equality. The
// caller already has authenticated digests and may avoid this fallback entirely.
function equal(left, right) {
  if (left instanceof Blob || right instanceof Blob) return false;
  if (left === right) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) || Array.isArray(right)) return Array.isArray(left) && Array.isArray(right)
    && left.length === right.length && left.every((entry, index) => equal(entry, right[index]));
  const keys = Object.keys(left).filter((key) => left[key] !== undefined).sort(compare);
  const other = Object.keys(right).filter((key) => right[key] !== undefined).sort(compare);
  return keys.length === other.length && keys.every((key, index) => key === other[index] && equal(left[key], right[key]));
}

function pick(base, local, remote, hasBase) {
  if (equal(local, remote)) return { value: copy(local), conflict: false };
  if (hasBase && equal(local, base)) return { value: copy(remote), conflict: false };
  if (hasBase && equal(remote, base)) return { value: copy(local), conflict: false };
  // Missing is only evidence of deletion relative to a trusted baseline.
  if (local === undefined || remote === undefined) return {
    value: copy(local === undefined ? remote : local), conflict: hasBase && base !== undefined,
  };
  return { value: copy(local), conflict: true };
}

function projected(value, fields) {
  if (!object(value)) return undefined;
  return Object.fromEntries(fields.filter((key) => own(value, key)).map((key) => [key, value[key]]));
}

// Merge a logical record's independent fields while keeping related fields
// indivisible. A row's explicit local/remote choice still selects its whole value.
function mergeFields(base, local, remote, hasBase, { coupled = [], metadata = true } = {}) {
  if (!object(local) || !object(remote)) return pick(base, local, remote, hasBase);
  if (!hasBase) return pick(base, local, remote, false);
  const result = {}, handled = new Set(), keys = [...new Set([...Object.keys(base || {}), ...Object.keys(local), ...Object.keys(remote)])].sort(compare);
  let conflict = false;
  for (const group of coupled) {
    for (const key of group) handled.add(key);
    if (!keys.some((key) => group.includes(key))) continue;
    const selected = pick(projected(base, group), projected(local, group), projected(remote, group), hasBase);
    Object.assign(result, selected.value); conflict ||= selected.conflict;
  }
  for (const key of keys) {
    if (handled.has(key)) continue;
    if (metadata && ['revision', 'updatedAt'].includes(key) && [local[key], remote[key]].every(Number.isSafeInteger)) {
      // Metadata must not turn independent title/body edits into a conflict.
      result[key] = Math.max(local[key], remote[key]); continue;
    }
    const selected = pick(base?.[key], local[key], remote[key], hasBase);
    if (selected.value !== undefined) result[key] = selected.value;
    conflict ||= selected.conflict;
  }
  return { value: result, conflict };
}

export function mergeSyncRecord(namespace, key, { base, local, remote, hasBase = false, choices = {} } = {}) {
  const rows = []; let count = 0;
  const tally = () => { if (++count > MAX_ROWS) fail('DATA_SYNC_CAPACITY'); };
  const row = (path, kind, before, left, right, merge = pick, options) => {
    tally();
    const selected = merge(before, left, right, hasBase, options);
    if (equal(left, right)) return selected.value;
    const id = JSON.stringify(path), deleted = hasBase && before !== undefined && (left === undefined || right === undefined);
    const status = deleted ? 'deleted' : !hasBase ? left === undefined || right === undefined ? 'one' : 'both'
      : !equal(left, before) && !equal(right, before) ? 'both' : 'one';
    const defaultChoice = selected.conflict ? left === undefined ? 'remote' : right === undefined || merge === pick ? 'local'
      : equal(selected.value, left) ? 'local' : equal(selected.value, right) ? 'remote' : 'merged' : 'merged';
    const choice = own(choices, id) ? choices[id] : defaultChoice;
    if (!['local', 'remote', 'merged'].includes(choice)) fail();
    const value = choice === 'local' ? left : choice === 'remote' ? right : selected.value;
    const label = left?.name || left?.title || right?.name || right?.title || path.at(-1) || key;
    rows.push({ id, label: String(label), kind, status, local: copy(left), remote: copy(right), merged: copy(selected.value), choice, conflict: selected.conflict });
    return copy(value);
  };
  const collection = (path, kind, before, left, right, options) => {
    const map = (value) => {
      if (value === undefined) return new Map();
      if (!Array.isArray(value)) fail();
      const result = new Map();
      for (const item of value) {
        if (!object(item) || typeof item.id !== 'string' || !item.id || result.has(item.id)) fail();
        result.set(item.id, item);
      }
      return result;
    };
    const b = map(before), l = map(left), r = map(right), output = [];
    for (const id of [...new Set([...b.keys(), ...l.keys(), ...r.keys()])].sort(compare)) {
      const value = row([...path, id], kind, b.get(id), l.get(id), r.get(id), mergeFields, options);
      if (value !== undefined) output.push(value);
    }
    return output;
  };
  const dictionary = (path, kind, before, left, right, fields = true) => {
    for (const value of [before, left, right]) if (value !== undefined && !object(value)) fail();
    const result = {};
    for (const id of [...new Set([...Object.keys(before || {}), ...Object.keys(left || {}), ...Object.keys(right || {})])].sort(compare)) {
      const value = row([...path, id], kind, before?.[id], left?.[id], right?.[id], fields ? mergeFields : pick);
      if (value !== undefined) Object.defineProperty(result, id, { value, enumerable: true, writable: true, configurable: true });
    }
    return result;
  };
  const structure = (path, before, left, right, handlers) => {
    if (!object(left) || !object(right)) return row(path, 'record', before, left, right);
    const result = {};
    for (const field of [...new Set([...Object.keys(before || {}), ...Object.keys(left), ...Object.keys(right)])].sort(compare)) {
      let value;
      if (field === 'revision' && [left[field], right[field]].every(Number.isSafeInteger)) value = Math.max(left[field], right[field]);
      else value = handlers[field] ? handlers[field]([...path, field], before?.[field], left[field], right[field])
        : row([...path, field], 'field', before?.[field], left[field], right[field]);
      if (value !== undefined) Object.defineProperty(result, field, { value, enumerable: true, writable: true, configurable: true });
    }
    return result;
  };
  let value;
  if (namespace !== 'preferences' || !object(local) || !object(remote)) value = row([], 'record', base, local, remote);
  else if (key === 'owntab.local.v1') {
    const placement = { coupled: [['groupId', 'parentId', 'page', 'position', 'order', 'detached']] };
    value = structure([], base, local, remote, {
      state: (path, b, l, r) => structure(path, b, l, r, {
        entries: (p, a, x, y) => collection(p, 'navigation', a, x, y, placement),
        groups: (p, a, x, y) => collection(p, 'group', a, x, y),
        providers: (p, a, x, y) => collection(p, 'provider', a, x, y),
        settings: (p, a, x, y) => dictionary(p, 'appearance', a, x, y, false),
        trash: (p, a, x, y) => structure(p, a, x, y, { items: (q, d, e, f) => collection(q, 'trash', d, e, f) }),
      }),
    });
    if (Array.isArray(value?.state?.entries)) {
      const containers = new Map();
      for (const entry of value.state.entries) {
        const id = JSON.stringify([entry.groupId, entry.parentId]);
        if (!containers.has(id)) containers.set(id, []);
        containers.get(id).push(entry);
      }
      // Independently added records can occupy the same order slot. Retain
      // every ID and rebuild continuous container order with a stable tie-break.
      for (const entries of containers.values()) entries.sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || compare(a.id, b.id))
        .forEach((entry, index) => { entry.order = index; });
    }
  } else if (key === 'covelet.tools.v1') value = structure([], base, local, remote, {
    notes: (p, b, l, r) => collection(p, 'note', b, l, r, { coupled: [['body', 'document']] }),
    reading: (p, b, l, r) => collection(p, 'reading', b, l, r),
    snapshots: (p, b, l, r) => collection(p, 'history', b, l, r),
    trash: (p, b, l, r) => collection(p, 'trash', b, l, r),
  });
  else if (key === 'covelet.content.preferences.v1') value = structure([], base, local, remote, {
    aliases: (p, b, l, r) => dictionary(p, 'alias', b, l, r, false),
    privateKeys: (p, b, l, r) => {
      if ([b, l, r].some((list) => list !== undefined && (!Array.isArray(list) || list.some((item) => typeof item !== 'string')))) fail();
      const selected = dictionary(p, 'visibility', Object.fromEntries((b || []).map((id) => [id, true])),
        Object.fromEntries((l || []).map((id) => [id, true])), Object.fromEntries((r || []).map((id) => [id, true])), false);
      return Object.keys(selected).sort(compare);
    },
    library: (p, b, l, r) => structure(p, b, l, r, {
      tags: (q, d, e, f) => collection(q, 'tag', d, e, f),
      items: (q, d, e, f) => dictionary(q, 'metadata', d, e, f),
      views: (q, d, e, f) => collection(q, 'view', d, e, f),
    }),
  });
  else value = row([], 'record', base, local, remote);
  return { value, rows, units: count };
}

// Include unchanged records in the capacity calculation: an empty preview is
// not evidence that a snapshot contains no business data.
export function countSyncRecordUnits(namespace, key, value) {
  if (value === undefined) return 0;
  return mergeSyncRecord(namespace, key, { base: value, local: value, remote: value, hasBase: true }).units;
}

export function countSyncSnapshotUnits(snapshot, max = MAX_ROWS) {
  if (!snapshot || snapshot.version !== 1 || !Array.isArray(snapshot.records)
    || !Number.isSafeInteger(max) || max < 0) fail();
  let total = 0;
  const seen = new Set();
  for (const record of snapshot.records) {
    if (!record || typeof record.namespace !== 'string' || typeof record.key !== 'string' || record.value === undefined) fail();
    const id = JSON.stringify([record.namespace, record.key]);
    if (seen.has(id)) fail();
    seen.add(id);
    total += countSyncRecordUnits(record.namespace, record.key, record.value);
    if (total > max) fail('DATA_SYNC_CAPACITY');
  }
  return total;
}
