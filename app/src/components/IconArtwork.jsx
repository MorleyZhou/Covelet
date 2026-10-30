import { useLayoutEffect, useRef, useState } from 'react';

const DURATION = 280;

// Keep decoded outgoing elements mounted until the incoming image is ready.
// Each layer pins its own SVG color-scheme, so the outgoing artwork cannot
// change theme underneath the fade. No duplicate site/editor state is mounted.
export default function IconArtwork({ src, identity = src, pending = false, className, scheme = 'light', onError }) {
  const [layers, setLayers] = useState([]);
  const sequence = useRef(0), latest = useRef(null), frames = useRef([]), timers = useRef(new Set());
  latest.current = { onError };
  useLayoutEffect(() => {
    if (!src && pending) return;
    const id = ++sequence.current;
    for (const frame of frames.current) cancelAnimationFrame(frame);
    frames.current = [];
    if (!src) { setLayers((current) => current.length ? [] : current); return; }
    // Navigation artwork must consume retained local bytes. A future caller
    // must not accidentally reintroduce a remote <img> fallback on cache miss.
    if (!src.startsWith('blob:')) { failed(id, src); return; }
    setLayers((current) => {
      const visible = current.filter((layer) => ['current', 'outgoing'].includes(layer.phase)).slice(-2);
      const displayed = visible.find((layer) => layer.phase === 'current');
      // Analysis can change fit without changing the actual picture. Keep its
      // already-decoded DOM image instead of fading a duplicate over itself.
      if (displayed?.src === src && displayed.scheme === scheme) {
        return visible.map((layer) => layer.id === displayed.id ? { ...layer, identity, className } : layer);
      }
      const replace = displayed?.identity === identity && displayed.scheme === scheme;
      return [...visible, { id, src, identity, className, scheme, replace, phase: visible.length ? 'loading' : 'initial' }];
    });
  }, [src, identity, pending, className, scheme]);
  useLayoutEffect(() => () => {
    sequence.current++;
    for (const frame of frames.current) cancelAnimationFrame(frame);
    for (const timer of timers.current) clearTimeout(timer);
  }, []);
  function loaded(id, initial, replace) {
    if (id !== sequence.current) return;
    const show = () => {
      if (id !== sequence.current) return;
      const reduced = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      setLayers((current) => current.filter((layer) => !(reduced || replace) || layer.id === id)
        .map((layer) => ({ ...layer, instant: layer.id === id && replace, phase: layer.id === id ? 'current' : 'outgoing' })));
      const timer = setTimeout(() => {
        timers.current.delete(timer);
        setLayers((current) => current.filter((layer) => layer.id >= id));
      }, reduced ? 0 : DURATION + 80);
      timers.current.add(timer);
    };
    // First paint has no outgoing artwork to blend with. Only subsequent
    // replacements need an opacity:0 frame and the existing crossfade.
    if (initial || replace) show();
    else frames.current = [requestAnimationFrame(() => { frames.current = [requestAnimationFrame(show)]; })];
  }
  function failed(id, url) {
    setLayers((current) => current.filter((layer) => layer.id !== id));
    if (id === sequence.current) latest.current.onError?.(url);
  }
  return <span className="site-icon-artwork" aria-hidden="true">{layers.map((layer) => <img key={layer.id}
    src={layer.src} className={layer.className} data-artwork-phase={layer.phase} data-artwork-instant={layer.instant || undefined} style={{ colorScheme: layer.scheme }}
    alt="" loading="eager" referrerPolicy="no-referrer" draggable={false}
    onLoad={() => loaded(layer.id, layer.phase === 'initial', layer.replace)} onError={() => failed(layer.id, layer.src)} />)}</span>;
}
