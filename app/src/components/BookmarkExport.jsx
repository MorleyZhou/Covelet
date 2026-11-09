import { useRef, useState } from 'react';
import { tr } from '../i18n/index.js';
import { bookmarkExportScopes, serializeBookmarkExport } from '../lib/bookmark-export.js';
import { loadContentPreferences } from '../lib/content-preferences.js';
import { privateContentKeys } from '../lib/presentation.js';
import { loadState } from '../lib/storage.js';
import { userErrorMessage } from '../lib/user-error.js';
import { downloadRecoveryFile } from './RecoveryCenter.jsx';
import Select from './Select.jsx';
import { Button } from './ui/button.jsx';

export default function BookmarkExport({ state, hiddenKeys, initialPage, pageLabel, onClose, onBusyChange }) {
  const options = bookmarkExportScopes(state, hiddenKeys, pageLabel);
  const [scope, setScope] = useState(() => options.some((option) => option.value === `page:${initialPage}`) ? `page:${initialPage}` : 'all');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const working = useRef(false), openedRevision = useRef(state.revision);
  const changed = state.revision !== openedRevision.current;
  const valid = !changed && options.some((option) => option.value === scope);

  async function download() {
    if (working.current || !valid) return;
    working.current = true; setBusy(true); setError(''); onBusyChange?.(true);
    try {
      const latest = await loadState();
      if (latest.revision !== openedRevision.current) throw Error(tr('数据已在其他页面更新，请重新打开后再试。'));
      const latestHidden = privateContentKeys(latest, await loadContentPreferences());
      for (const key of hiddenKeys) latestHidden.add(key);
      const html = serializeBookmarkExport(latest, { scope, hiddenKeys: latestHidden, pageLabel });
      downloadRecoveryFile(new Blob([html], { type: 'text/html;charset=UTF-8' }), 'covelet-bookmarks.html');
      onClose();
    } catch (reason) { setError(userErrorMessage(reason)); }
    finally { working.current = false; setBusy(false); onBusyChange?.(false); }
  }

  return <div className="form-stack" aria-busy={busy}>
    <Select label={tr('导出范围')} value={scope} options={options} onChange={(value) => { setScope(value); setError(''); }} disabled={busy || changed} />
    <p className="hint">{tr('仅导出未标记隐藏的网站。')}</p>
    {(changed || error) && <p className="form-error" role="alert">{changed ? tr('数据已在其他页面更新，请重新打开后再试。') : tr(error)}</p>}
    <div className="modal-footer">
      <Button type="button" variant="secondary" onClick={onClose} disabled={busy}>{tr('取消')}</Button>
      <Button type="button" onClick={download} disabled={busy || !valid}>{tr('导出')}</Button>
    </div>
  </div>;
}
