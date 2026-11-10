import { useState } from 'react';
import { formatNumber, tr } from '../i18n/index.js';
import { layoutDesktop } from '../lib/desktop-layout.js';
import { prepareLayoutTransfer, previewLayoutTransfer } from '../lib/navigation-destinations.js';
import { userErrorMessage } from '../lib/user-error.js';
import NavigationDestination from './NavigationDestination.jsx';
import Select from './Select.jsx';
import { Button } from './ui/button.jsx';

export default function LayoutTransfer({ state, selectedIds, preferences, columns, onApply, onClose }) {
  const [operation, setOperation] = useState('move'), [destination, setDestination] = useState('');
  const [error, setError] = useState('');
  let preview;
  try {
    if (destination) preview = previewLayoutTransfer(state, selectedIds, destination, preferences, operation);
  } catch { /* The user must reselect a target hidden or removed while the dialog was open. */ }
  const blocked = destination && !preview;
  function apply(event) {
    event.preventDefault();
    if (!preview?.sources.length || event.nativeEvent?.isComposing) return;
    try {
      const result = prepareLayoutTransfer(state, preview, operation);
      const key = layoutDesktop(result.state.entries, columns, null, result.state.settings.pages)
        .find((screen) => screen.items.some((entry) => entry.id === result.ids[0]))?.key ?? `${result.target.page}:0`;
      onApply({ ...result, key });
    } catch (reason) { setError(userErrorMessage(reason)); }
  }
  return <form className="form-stack" onSubmit={apply}>
    <Select label={tr('操作')} value={operation} options={[{ value: 'move', label: tr('移动') }, { value: 'copy', label: tr('复制') }]}
      onChange={(value) => { setOperation(value); setError(''); }} />
    <NavigationDestination state={state} preferences={preferences} value={destination}
      onChange={(value) => { setDestination(value); setError(''); }} />
    {preview && <p className="hint" role="status">
      {operation === 'move' ? tr('将移动 {0} 个网站。', [formatNumber(preview.sources.length)]) : tr('将复制 {0} 个网站。', [formatNumber(preview.sources.length)])}
      {preview.duplicates > 0 && <> {tr('将跳过 {0} 条重复网址。', [formatNumber(preview.duplicates)])}</>}
    </p>}
    {(error || blocked) && <p className="form-error" role="alert">{error || tr('目标位置已变化，请重新选择。')}</p>}
    <div className="dialog-actions">
      <Button variant="secondary" type="button" onClick={onClose}>{tr('取消')}</Button>
      <Button type="submit" disabled={!preview?.sources.length}>{operation === 'move' ? tr('移动') : tr('复制')}</Button>
    </div>
  </form>;
}
