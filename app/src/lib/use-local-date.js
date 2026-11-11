import { useEffect, useState } from 'react';
import { localDateKey } from './reading-revisit.js';

export function useLocalDateKey() {
  const [today, setToday] = useState(() => localDateKey());
  useEffect(() => {
    let timer, active = true;
    const refresh = () => {
      if (!active) return;
      setToday(localDateKey());
      clearTimeout(timer);
      const now = new Date(), midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
      // Midnight handles ordinary day changes; the minute check also catches
      // clock/timezone changes while this tab remains focused.
      timer = setTimeout(refresh, Math.max(1, Math.min(60_000, midnight.getTime() - now.getTime() + 20)));
    };
    refresh();
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      active = false; clearTimeout(timer);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, []);
  return today;
}
