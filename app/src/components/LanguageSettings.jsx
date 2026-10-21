import { useState } from 'react';
import Select from './Select.jsx';
import { LANGUAGES, setLanguagePreference, tr } from '../i18n/index.js';
import { useLanguage } from '../i18n/react.js';

export default function LanguageSettings() {
  const { preference } = useLanguage();
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  return <div className="language-setting"><Select label={tr('语言')} value={preference} disabled={busy}
    options={[{ value: 'auto', label: tr('跟随浏览器') }, ...LANGUAGES]} onChange={async (value) => {
      setBusy(true); setError('');
      try { await setLanguagePreference(value); } catch (reason) { setError(reason.message); }
      finally { setBusy(false); }
    }} />{error && <p className="form-error" role="alert">{tr(error)}</p>}</div>;
}
