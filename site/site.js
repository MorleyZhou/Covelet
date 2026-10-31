(() => {
  'use strict';

  // Locale codes match app/src/i18n/index.js. Only approved final copy ships.
  const locales = new Set(['zh-CN', 'en', 'zh-TW', 'ja', 'ko', 'de', 'fr', 'ru']);
  const select = document.querySelector('#language');
  const status = document.querySelector('#language-status');
  const cache = new Map();
  const bindings = [
    ['data-i18n', 'textContent'],
    ['data-i18n-content', 'content'],
    ['data-i18n-aria-label', 'aria-label'],
    ['data-i18n-href', 'href'],
  ];
  let activeLocale = 'zh-CN';
  let request = 0;

  // Keep the readable, JavaScript-free HTML shell if a locale cannot load.
  const fallback = { 'ui.error': '语言加载失败，请重试。' };
  for (const [attribute, target] of bindings) {
    for (const element of document.querySelectorAll(`[${attribute}]`)) {
      fallback[element.getAttribute(attribute)] = target === 'textContent'
        ? element.textContent : element.getAttribute(target);
    }
  }
  let activeMessages = fallback;

  const requestedLocale = () => {
    const value = new URL(location.href).searchParams.get('lang');
    return locales.has(value) ? value : 'zh-CN';
  };

  async function applyLanguage(locale, updateURL = false) {
    const currentRequest = ++request;
    select.disabled = true;
    status.hidden = true;
    try {
      let messages = cache.get(locale);
      if (!messages) {
        const response = await fetch(`i18n/${locale}.json`);
        if (!response.ok) throw new Error('Locale unavailable');
        messages = await response.json();
        // Reject incomplete dictionaries before updating any visible content.
        for (const key of Object.keys(fallback)) {
          if (typeof messages[key] !== 'string' || !messages[key].trim()) {
            throw new Error('Incomplete locale');
          }
        }
        cache.set(locale, messages);
      }
      if (currentRequest !== request) return;

      for (const [attribute, target] of bindings) {
        for (const element of document.querySelectorAll(`[${attribute}]`)) {
          const text = messages[element.getAttribute(attribute)];
          if (target === 'textContent') element.textContent = text;
          else element.setAttribute(target, text);
        }
      }
      document.documentElement.lang = locale;
      activeLocale = locale;
      activeMessages = messages;
      select.value = locale;
      if (updateURL) {
        const url = new URL(location.href);
        url.searchParams.set('lang', locale);
        history.replaceState(null, '', url);
      }
    } catch {
      if (currentRequest !== request) return;
      select.value = activeLocale;
      status.textContent = activeMessages['ui.error'];
      status.hidden = false;
    } finally {
      if (currentRequest === request) select.disabled = false;
    }
  }

  select.addEventListener('change', () => applyLanguage(select.value, true));
  window.addEventListener('popstate', () => applyLanguage(requestedLocale()));
  document.querySelector('#language-control').hidden = false;
  applyLanguage(requestedLocale());
})();
