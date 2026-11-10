(() => {
  'use strict';

  const routes = new Map([...document.querySelectorAll('link[rel="alternate"][hreflang]')]
    .filter((link) => link.hreflang !== 'x-default')
    .map((link) => [link.hreflang.toLowerCase(), new URL(link.href).pathname]));

  function localizedUrl(locale) {
    const route = routes.get(locale.toLowerCase());
    if (!route) return;
    const url = new URL(location.href);
    url.pathname = route;
    url.searchParams.delete('lang');
    return url;
  }

  const legacyLocale = new URL(location.href).searchParams.get('lang');
  const legacyUrl = legacyLocale && localizedUrl(legacyLocale);
  if (legacyUrl) {
    location.replace(legacyUrl);
    return;
  }

  const select = document.querySelector('#language');
  if (!select) return;
  select.addEventListener('change', () => {
    const url = localizedUrl(select.value);
    if (url) location.assign(url);
  });
  window.addEventListener('pageshow', () => { select.value = document.documentElement.lang; });
  document.querySelector('#language-control').hidden = false;
})();
