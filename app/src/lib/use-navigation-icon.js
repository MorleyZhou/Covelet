import { useLayoutEffect, useState } from 'react';
import { peekNavigationIcon, readCachedNavigationIcon, subscribeNavigationIcons } from './navigation-icon-cache.js';
import { useSyncedData } from './use-synced-data.js';
import { observeCachedIconSources } from './navigation-icon-selection.js';

// A backing-color change does not change a raster image. Share its local URLs
// between the tile, form and drag preview; keep outgoing layers alive for their
// existing fade, then release URLs when the last mounted consumer is gone.
const images = new Map();
const FADE_GRACE_MS = 400;
function retainImage(source, item, revision) {
  let image = images.get(source);
  if (!image || image.item !== item || image.revision !== revision) {
    const url = URL.createObjectURL(item.blob);
    let darkUrl;
    try { if (item.adaptive) darkUrl = URL.createObjectURL(item.darkBlob); }
    catch (error) { URL.revokeObjectURL(url); throw error; }
    image = { item, revision, refs: 0, timer: null,
      value: { source, url, darkUrl, adaptive: item.adaptive, vector: item.vector } };
    images.set(source, image);
  }
  clearTimeout(image.timer);
  image.refs++;
  let released = false;
  return { value: image.value, release() {
    if (released) return;
    released = true;
    if (--image.refs) return;
    image.timer = setTimeout(() => {
      if (images.get(source) === image) images.delete(source);
      URL.revokeObjectURL(image.value.url);
      if (image.value.darkUrl) URL.revokeObjectURL(image.value.darkUrl);
    }, FADE_GRACE_MS);
  } };
}

export function useNavigationIcon(source, scheme = 'light', elementRef, attempt = 0, fallbackSource = '') {
  const revision = useSyncedData();
  const [result, setResult] = useState(null);
  useLayoutEffect(() => {
    if (!source) return;
    let active = true, lease, observer, adopted, adoptedSource;
    const adopt = (actualSource, item) => {
      if (!active || !item || item === adopted && actualSource === adoptedSource) return;
      adopted = item;
      adoptedSource = actualSource;
      const previous = lease;
      lease = retainImage(actualSource, item, revision);
      setResult({ ...lease.value, requestedSource: source, fallbackSource, phase: 'ready', attempt, revision });
      previous?.release();
    };
    const peek = (address) => {
      const prepared = peekNavigationIcon(address);
      if (prepared) return prepared;
      const existing = images.get(address);
      return existing?.revision === revision ? existing.item : null;
    };
    const selection = observeCachedIconSources(source, fallbackSource, {
      peek, read: readCachedNavigationIcon, subscribe: subscribeNavigationIcons, onReady: adopt,
      onMissing: () => {
        if (!active || adopted) return;
        setResult({ source, requestedSource: source, fallbackSource, phase: 'missing', cacheMiss: true, attempt, revision });
      }, defer: true,
    });
    const start = () => { observer?.disconnect(); selection.start(); };
    if (peek(source)) start();
    else if (elementRef?.current && globalThis.IntersectionObserver) {
      observer = new IntersectionObserver((items) => { if (items.some((item) => item.isIntersecting)) start(); }, { rootMargin: '64px' });
      observer.observe(elementRef.current);
    } else start();
    return () => { active = false; observer?.disconnect(); selection.stop(); lease?.release(); };
  }, [source, fallbackSource, elementRef, attempt, revision]);
  // Each consumer must render the URL whose lease it owns. Another lookup can
  // replace the shared entry while this tile is still mounted; reading that
  // entry here would borrow a URL that its actual owner may soon release.
  return result?.requestedSource === source && result.fallbackSource === fallbackSource && result.attempt === attempt && result.revision === revision ? { ...result, scheme, url: scheme === 'dark' && result.adaptive ? result.darkUrl : result.url }
    : { source, scheme, phase: source ? 'loading' : 'missing', url: '' };
}
