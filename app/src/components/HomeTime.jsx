import { useEffect, useState } from 'react';
import { getLocale } from '../i18n/index.js';
import { useLanguage } from '../i18n/react.js';

export default function HomeTime() {
  useLanguage();
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    let timer;
    const refresh = () => {
      clearTimeout(timer);
      setNow(new Date());
      // Read the wall clock again after sleep or a system time change.
      timer = setTimeout(refresh, 60000 - Date.now() % 60000);
    };
    const resume = () => { if (!document.hidden) refresh(); };
    refresh();
    document.addEventListener('visibilitychange', resume);
    window.addEventListener('pageshow', refresh);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', resume);
      window.removeEventListener('pageshow', refresh);
    };
  }, []);
  const locale = getLocale();
  return <div className="clock home-time">
    <time className="clock-time" dateTime={now.toISOString()}>{new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit' }).format(now)}</time>
    <span className="clock-date">{new Intl.DateTimeFormat(locale, { month: 'long', day: 'numeric', weekday: 'long' }).format(now)}</span>
  </div>;
}
