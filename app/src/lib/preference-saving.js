import { tr, getLocale } from "../i18n/index.js";
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const merge = (older, newer) => ({
  ...older, ...newer,
  settings: { ...older?.settings, ...newer?.settings },
});

// Apply only edited preferences. A newer navigation revision is safe to merge;
// changing the same preference in another tab needs the user's attention.
export function applyPreferenceChanges(current, baseline, changes) {
  for (const key of Object.keys(changes.settings || {})) {
    if (!same(current.settings[key], baseline.settings[key]) && !same(current.settings[key], changes.settings[key])) {
      throw Object.assign(new Error(tr("此设置已在其他页面修改，请重新载入设置。")), { code: 'PREFERENCE_CONFLICT' });
    }
  }
  if (changes.providers && !same(current.providers, baseline.providers) && !same(current.providers, changes.providers)) {
    throw Object.assign(new Error(tr("搜索引擎已在其他页面修改，请重新载入设置。")), { code: 'PREFERENCE_CONFLICT' });
  }
  return { ...current, settings: { ...current.settings, ...changes.settings },
    ...(changes.providers ? { providers: changes.providers } : {}) };
}

export function createPreferenceSaver({ initial, read, write, onSaved = () => {}, onStatus = () => {}, delay = 160 }) {
  let baseline = structuredClone(initial), pending = null, flight = null, timer, failure = null;
  const report = (phase, error) => onStatus({ phase, error });
  function flush() {
    clearTimeout(timer);
    if (failure) return Promise.reject(failure);
    if (flight) return flight;
    if (!pending) return Promise.resolve(baseline);
    flight = (async () => {
      while (pending) {
        const changes = pending;
        pending = null;
        report('saving');
        try {
          const current = await read();
          const next = applyPreferenceChanges(current, baseline, changes);
          baseline = await write(next, current.revision);
          onSaved(baseline);
        } catch (error) {
          pending = merge(changes, pending);
          failure = error;
          report('error', error);
          throw error;
        }
      }
      report('idle');
      return baseline;
    })().finally(() => { flight = null; if (!pending) clearTimeout(timer); });
    return flight;
  }
  return {
    queue(changes) {
      pending = merge(pending, structuredClone(changes));
      if (failure) return;
      report('pending');
      clearTimeout(timer);
      timer = setTimeout(() => { flush().catch(() => {}); }, delay);
    },
    flush,
    retry() { failure = null; return flush(); },
    async reload() {
      clearTimeout(timer);
      if (flight) await flight.catch(() => {});
      pending = null;
      failure = null;
      baseline = await read();
      onSaved(baseline);
      report('idle');
      return baseline;
    },
  };
}
