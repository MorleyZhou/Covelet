import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { tr } from '../i18n/index.js';
import { loadState } from '../lib/storage.js';
import { desktopPageName, logicalDesktopPages } from '../lib/desktop-pages.js';
import { WIDGET_SIZE_OPTIONS } from '../lib/widget-model.js';
import { pinContentWidget } from '../lib/pin-widget.js';
import { userErrorMessage } from '../lib/user-error.js';
import Select from './Select.jsx';
import { Button } from './ui/button.jsx';

export const PinDesktopContext = createContext({ page: 0, onPinned: () => {} });

export default function PinToDesktopDialog({ kind, record, preferences, Dialog, onClose, onPinned, onBusyChange }) {
  const desktop = useContext(PinDesktopContext);
  const baseline = useRef({ recordId: record.id, expectedRecordRevision: record.revision, expectedPreferencesRevision: preferences.revision });
  const [navigation, setNavigation] = useState(null), [page, setPage] = useState(''), [size, setSize] = useState(kind === 'view' ? 'medium' : 'small');
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), gate = useRef(false), active = useRef(true);
  useEffect(() => {
    active.current = true;
    loadState().then((state) => { if (active.current) { const pages = logicalDesktopPages(state); setNavigation(state); setPage(String(pages.includes(desktop.page) ? desktop.page : pages[0] ?? 0)); } }).catch((reason) => { if (active.current) setError(userErrorMessage(reason)); });
    return () => { active.current = false; onBusyChange?.(false); };
  }, []);
  return <Dialog title={tr('固定到桌面')} onClose={onClose} closeDisabled={busy} privacyKeys={[`${kind === 'note' ? 'note' : 'view'}:${baseline.current.recordId}`]}>
    <form className="form-stack pin-content-form" onSubmit={async (event) => {
      event.preventDefault(); event.stopPropagation();
      if (gate.current || !navigation || page === '' || event.nativeEvent.isComposing) return;
      gate.current = true; setBusy(true); onBusyChange?.(true); setError('');
      try {
        const result = await pinContentWidget({ ...baseline.current, kind, page: Number(page), size, expectedNavigationRevision: navigation.revision });
        (onPinned || desktop.onPinned)(result); onClose();
      } catch (reason) { if (active.current) setError(userErrorMessage(reason)); }
      finally { gate.current = false; if (active.current) setBusy(false); onBusyChange?.(false); }
    }}>
      <Select label={tr('目标桌面')} value={page} options={navigation ? logicalDesktopPages(navigation).map((value) => ({ value: String(value), label: desktopPageName(navigation.settings, value) })) : []}
        disabled={busy || !navigation} onChange={setPage} />
      <Select label={tr('尺寸')} value={size} options={WIDGET_SIZE_OPTIONS} disabled={busy} onChange={setSize} />
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="modal-footer"><Button type="button" variant="secondary" disabled={busy} onClick={onClose}>{tr('取消')}</Button>
        <Button type="submit" disabled={busy || !navigation || page === ''}>{tr('固定')}</Button></div>
    </form>
  </Dialog>;
}
