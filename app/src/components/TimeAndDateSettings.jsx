import { useMemo, useState } from 'react';
import { tr } from '../i18n/index.js';
import { useLanguage } from '../i18n/react.js';
import { DEFAULT_HOME_TIME, homeTimeZoneOptions, updateHomeTimeSetting } from '../lib/home-time.js';
import { useHomeTimeSettings } from '../lib/use-home-time-settings.js';
import Select from './Select.jsx';
import { Switch } from './ui/switch.jsx';

export default function TimeAndDateSettings({ disabled = false }) {
  const { locale } = useLanguage();
  const saved = useHomeTimeSettings();
  const [busy, setBusy] = useState(false), [error, setError] = useState(false);
  const { timeZone, showLunar, showZodiac } = saved || DEFAULT_HOME_TIME;
  const options = useMemo(() => homeTimeZoneOptions(timeZone), [timeZone, locale]);
  const unavailable = disabled || busy || !saved;

  async function update(field, value) {
    setBusy(true);
    setError(false);
    try { await updateHomeTimeSetting(field, value); }
    catch { setError(true); }
    finally { setBusy(false); }
  }

  return <div className="form-stack">
    <Select label={tr('时区')} value={timeZone} disabled={unavailable} options={options} onChange={(value) => update('timeZone', value)} />
    <label className="check-label">
      <Switch checked={showLunar} disabled={unavailable} onCheckedChange={(value) => update('showLunar', value)} />
      {tr('显示农历')}
    </label>
    <label className="check-label">
      <Switch checked={showZodiac} disabled={unavailable} onCheckedChange={(value) => update('showZodiac', value)} />
      {tr('显示星座')}
    </label>
    {error && <p className="form-error" role="alert">{tr('设置未保存，请重试。')}</p>}
  </div>;
}
