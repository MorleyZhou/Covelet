import { useLayoutEffect, useRef, useState } from 'react';

// The local contrast worker selects a surface independently for each tile.
// Update only when polarity changes, without observing our own style writes.
export function useIconScheme() {
  const ref = useRef(null), [scheme, setScheme] = useState('light');
  useLayoutEffect(() => {
    const node = ref.current;
    const update = ({ detail }) => { if (['light', 'dark'].includes(detail)) setScheme(detail); };
    node?.addEventListener('covelet:icon-scheme', update);
    return () => node?.removeEventListener('covelet:icon-scheme', update);
  }, []);
  return [ref, scheme];
}
