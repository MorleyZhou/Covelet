import { useEffect, useState } from 'react';
import { useLanguage } from '../i18n/react.js';
import { DEFAULT_HOME_TIME, formatHomeTime } from '../lib/home-time.js';
import { useHomeTimeSettings } from '../lib/use-home-time-settings.js';

export default function HomeTime() {
  const { locale, tr } = useLanguage();
  const settings = useHomeTimeSettings();
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
  const { time, date, lunar, zodiac } = formatHomeTime(now, locale, settings || DEFAULT_HOME_TIME);
  return <div className="clock home-time">
    <time className="clock-time" dateTime={now.toISOString()}>{time}</time>
    <span className="clock-date">
      <span className="clock-gregorian">{date}</span>
      {lunar && <>{' '}<span aria-hidden="true">· </span><span className="clock-lunar">{tr('农历 {0}', [lunar])}</span></>}
      {zodiac && <>{' '}<span aria-hidden="true">· </span><span className="clock-zodiac">{tr(zodiac)}</span></>}
    </span>
  </div>;
}
