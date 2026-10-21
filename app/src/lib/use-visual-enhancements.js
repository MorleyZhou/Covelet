import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { getVisualRuntimeStatus, observeVisualResult, subscribeVisualRuntimeStatus } from './visual-processing.js';

export function useVisualRuntimeStatus() {
  return useSyncExternalStore(subscribeVisualRuntimeStatus, getVisualRuntimeStatus, getVisualRuntimeStatus);
}

export function useWallpaperAppearance(imageUrl, enabled) {
  const [result, setResult] = useState(null);
  const lifetime = useMemo(() => ({}), [imageUrl, enabled]);
  useEffect(() => {
    if (!enabled || !imageUrl) return;
    return observeVisualResult('wallpaper', imageUrl, { publish: (value) => setResult({ ...value, lifetime }) });
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
    return observeVisualResult('icon', originalUrl, { publish: (value) => setResult({ ...value, lifetime }) });
  }, [originalUrl, enabled, lifetime]);
  if (!enabled || !originalUrl) return { url: originalUrl, phase: 'off', adapted: false, message: '' };
  if (result?.lifetime === lifetime) return { url: originalUrl, adapted: false, ...result };
  return { url: originalUrl, phase: 'processing', adapted: false, message: '' };
}
