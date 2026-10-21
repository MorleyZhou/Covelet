import { useSyncExternalStore } from 'react';
import { subscribeLanguage, languageSnapshot, getLocale, getLanguagePreference, tr } from './index.js';

export function useLanguage() {
  useSyncExternalStore(subscribeLanguage, languageSnapshot, languageSnapshot);
  return { locale: getLocale(), preference: getLanguagePreference(), tr };
}
