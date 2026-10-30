import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { getCachedIconPresentation, getVisualRuntimeStatus, observeVisualResult, subscribeVisualRuntimeStatus } from './visual-processing.js';

// A frozen tab must not turn a delayed decode into a permanent fallback.
// Keep successful samples/artwork alive; cancel unfinished work while hidden
// and reacquire it on return using the same bounded local processor/cache.
function observeForegroundVisualResult(kind, url, publish) {
  const document = globalThis.document, window = document?.defaultView;
  if (!document?.addEventListener) return observeVisualResult(kind, url, { publish });
  let disposed = false, suspended = document.visibilityState === 'hidden', ready = false, pending = false, stop;
  function start() {
    if (disposed || suspended || document.visibilityState === 'hidden' || ready || pending) return;
    pending = true;
    stop = observeVisualResult(kind, url, { publish(value) {
      if (disposed || suspended || document.visibilityState === 'hidden') return;
      pending = false; ready = value.phase === 'ready'; publish(value);
    } });
  }
  function suspend() {
    suspended = true;
    if (!ready) { stop?.(); stop = null; pending = false; }
  }
  function resume() {
    suspended = false;
    if (disposed || document.visibilityState === 'hidden' || ready || pending) return;
    stop?.(); stop = null; start();
  }
  const visibility = () => document.visibilityState === 'hidden' ? suspend() : resume();
  document.addEventListener('visibilitychange', visibility);
  document.addEventListener('freeze', suspend);
  document.addEventListener('resume', resume);
  window?.addEventListener('pagehide', suspend);
  window?.addEventListener('pageshow', resume);
  window?.addEventListener('focus', resume);
  start();
  return () => {
    disposed = true; stop?.();
    document.removeEventListener('visibilitychange', visibility);
    document.removeEventListener('freeze', suspend);
    document.removeEventListener('resume', resume);
    window?.removeEventListener('pagehide', suspend);
    window?.removeEventListener('pageshow', resume);
    window?.removeEventListener('focus', resume);
  };
}

export function useVisualRuntimeStatus() {
  return useSyncExternalStore(subscribeVisualRuntimeStatus, getVisualRuntimeStatus, getVisualRuntimeStatus);
}

export function useWallpaperAppearance(imageUrl, enabled) {
  const [result, setResult] = useState(null);
  const lifetime = useMemo(() => ({}), [imageUrl, enabled]);
  useEffect(() => {
    if (!enabled || !imageUrl) return;
    return observeForegroundVisualResult('wallpaper', imageUrl, (value) => setResult({ ...value, lifetime }));
  }, [imageUrl, enabled, lifetime]);
  if (!enabled) return { phase: 'off', palette: null, message: '' };
  if (!imageUrl) return { phase: 'idle', palette: null, message: '' };
  if (result?.lifetime === lifetime) return { palette: null, ...result };
  return { phase: 'processing', palette: null, message: '' };
}

export function useAdaptedIcon(originalUrl, enabled) {
  const [result, setResult] = useState(null);
  const lifetime = useMemo(() => ({}), [originalUrl, enabled]);
  useEffect(() => {
    if (!enabled || !originalUrl) return;
    return observeForegroundVisualResult('icon', originalUrl, (value) => setResult({ ...value, lifetime }));
  }, [originalUrl, enabled, lifetime]);
  if (!enabled || !originalUrl) return { url: originalUrl, phase: 'off', adapted: false, message: '' };
  if (result?.lifetime === lifetime) return { url: originalUrl, adapted: false, ...result };
  // A remounted tile/drag preview can reuse the bounded worker cache's known
  // coverage and ink while it acquires its own normalized artwork URL.
  return { ...getCachedIconPresentation(originalUrl), url: originalUrl, phase: 'processing', adapted: false, message: '' };
}
