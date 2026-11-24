import { localData } from './local-data.js';

export const SEARCH_ENGINE_KEY = 'covelet.search.engine.v1';
const valid = (value) => typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\s\u0000-\u001f\u007f]/u.test(value);
const normalize = (value) => valid(value) ? value : 'browser';

// The choice belongs to this browser, just like its default search engine.
// The ID is stored in encrypted local preferences, outside portable snapshots.
export function createSearchEnginePreference(storage = localData) {
  return {
    async read() { return normalize((await storage.get(SEARCH_ENGINE_KEY))[SEARCH_ENGINE_KEY]); },
    async write(value) {
      if (!valid(value)) throw new TypeError('Invalid search engine selection.');
      await storage.set({ [SEARCH_ENGINE_KEY]: value });
    },
    subscribe(listener) {
      return storage.subscribe((changes) => {
        if (changes[SEARCH_ENGINE_KEY]) listener(normalize(changes[SEARCH_ENGINE_KEY].newValue));
      });
    },
  };
}

export const searchEnginePreference = createSearchEnginePreference();
