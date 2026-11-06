import { useEffect, useState } from 'react';
import { DEFAULT_HOME_TIME, loadHomeTimeSettings, subscribeHomeTimeSettings } from './home-time.js';

export function useHomeTimeSettings() {
  const [settings, setSettings] = useState(null);
  useEffect(() => {
    let active = true, changed = false;
    const unsubscribe = subscribeHomeTimeSettings((value) => {
      changed = true;
      if (active) setSettings(value);
    });
    loadHomeTimeSettings().catch(() => DEFAULT_HOME_TIME).then((value) => {
      if (active && !changed) setSettings(value);
    });
    return () => { active = false; unsubscribe(); };
  }, []);
  return settings;
}
