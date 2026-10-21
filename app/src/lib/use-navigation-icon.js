import { useEffect, useState } from 'react';
import { navigationIcon } from './navigation-icon-cache.js';

export function useNavigationIcon(source, scheme = 'light', elementRef) {
  const [result, setResult] = useState(null);
  useEffect(() => {
    if (!source) return;
    let active = true, started = false, url, observer, timer;
    const start = () => {
      if (started || !active) return;
      started = true; observer?.disconnect();
      timer = setTimeout(() => {
        navigationIcon(source).then((item) => {
          if (!active || !item) return;
          const blob = scheme === 'dark' && item.adaptive ? item.darkBlob : item.blob;
          url = URL.createObjectURL(blob);
          setResult({ source, scheme, url, adaptive: item.adaptive, vector: item.vector });
        }).catch(() => {});
      }, 80);
    };
    if (elementRef?.current && globalThis.IntersectionObserver) {
      observer = new IntersectionObserver((items) => { if (items.some((item) => item.isIntersecting)) start(); }, { rootMargin: '64px' });
      observer.observe(elementRef.current);
    } else start();
    return () => { active = false; clearTimeout(timer); observer?.disconnect(); if (url) URL.revokeObjectURL(url); };
  }, [source, scheme, elementRef]);
  return result?.source === source && result.scheme === scheme ? result : null;
}
