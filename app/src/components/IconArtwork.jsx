import { useLayoutEffect, useRef, useState } from 'react';

const DURATION = 280;

// Keep decoded outgoing elements mounted until the incoming image is ready.
// Each layer pins its own SVG color-scheme, so the outgoing artwork cannot
// change theme underneath the fade. No duplicate site/editor state is mounted.
export default function IconArtwork({ src, className, scheme = 'light', onError }) {
  const [layers, setLayers] = useState([]);
  const sequence = useRef(0), latest = useRef(null), frames = useRef([]), timers = useRef(new Set());
  latest.current = { onError };
  useLayoutEffect(() => {
    const id = ++sequence.current;
    for (const frame of frames.current) cancelAnimationFrame(frame);
    frames.current = [];
    setLayers((current) => [...current.filter((layer) => layer.phase !== 'loading').slice(-2),
      { id, src, className, scheme, phase: 'loading' }]);
  }, [src, className, scheme]);
  useLayoutEffect(() => () => {
    sequence.current++;
    for (const frame of frames.current) cancelAnimationFrame(frame);
    for (const timer of timers.current) clearTimeout(timer);
  }, []);
  function loaded(id) {
    if (id !== sequence.current) return;
    const show = () => {
      if (id !== sequence.current) return;
      const reduced = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      setLayers((current) => current.filter((layer) => !reduced || layer.id === id)
        .map((layer) => ({ ...layer, phase: layer.id === id ? 'current' : 'outgoing' })));
      const timer = setTimeout(() => {
        timers.current.delete(timer);
        setLayers((current) => current.filter((layer) => layer.id >= id));
      }, reduced ? 0 : DURATION + 80);
      timers.current.add(timer);
    };
    // Separate the initial opacity:0 frame from the committed visible frame,
    // including images that decode directly from the browser's memory cache.
    frames.current = [requestAnimationFrame(() => { frames.current = [requestAnimationFrame(show)]; })];
  }
  function failed(id, url) {
    setLayers((current) => current.filter((layer) => layer.id !== id));
    if (id === sequence.current) latest.current.onError?.(url);
  }
  return <span className="site-icon-artwork" aria-hidden="true">{layers.map((layer) => <img key={layer.id}
    src={layer.src} className={layer.className} data-artwork-phase={layer.phase} style={{ colorScheme: layer.scheme }}
    alt="" loading="lazy" referrerPolicy="no-referrer" crossOrigin="anonymous" draggable={false}
    onLoad={() => loaded(layer.id)} onError={() => failed(layer.id, layer.src)} />)}</span>;
}
