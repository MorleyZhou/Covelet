import { useEffect, useRef, useState } from 'react';
import { tr, formatNumber } from '../i18n/index.js';
import { inspectMarkdownLibrary, exportMarkdownLibrary } from '../lib/markdown-library.js';
import { userErrorMessage } from '../lib/user-error.js';
import { downloadRecoveryFile } from './RecoveryCenter.jsx';
import { Button } from './ui/button.jsx';
import { Checkbox } from './ui/checkbox.jsx';
import './markdown-library.css';

const kinds = () => [{ value: 'site', label: tr('网站') }, { value: 'reading', label: tr('稍后读') }, { value: 'note', label: tr('便笺') }];
export default function MarkdownLibraryExport({ onBusyChange, onClose }) {
  const [types, setTypes] = useState(['site', 'reading', 'note']), [plan, setPlan] = useState(null), [selected, setSelected] = useState(new Set());
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const working = useRef(false), active = useRef(true);
  async function run(action) {
    if (working.current) return;
    working.current = true; setBusy(true); onBusyChange?.(true); setError('');
    try { await action(); }
    catch (reason) { if (active.current) setError(userErrorMessage(reason)); }
    finally { working.current = false; if (active.current) setBusy(false); onBusyChange?.(false); }
  }
  function refresh(nextTypes = types) {
    return run(async () => {
      const next = await inspectMarkdownLibrary({ types: nextTypes });
      if (!active.current) return;
      setPlan(next); setSelected(new Set(next.rows.map((row) => row.key)));
    });
  }
  useEffect(() => { active.current = true; refresh(); return () => { active.current = false; }; }, []);
  const rows = plan?.rows || [], selectedRows = rows.filter((row) => selected.has(row.key));
  const selectedIssues = selectedRows.filter((row) => row.issue);
  function choose(key, checked) { setSelected((current) => { const next = new Set(current); if (checked) next.add(key); else next.delete(key); return next; }); }
  return <div className="markdown-library-export form-stack" aria-busy={busy || undefined}>
    <div className="markdown-library-scroll form-stack">
      <fieldset className="markdown-library-types" disabled={busy}><legend>{tr('导出内容')}</legend>{kinds().map((kind) => <label key={kind.value}>
        <Checkbox checked={types.includes(kind.value)} onCheckedChange={(checked) => {
          const next = checked === true ? [...types, kind.value] : types.filter((type) => type !== kind.value);
          setTypes(next); setPlan(null); setSelected(new Set()); refresh(next);
        }} />{kind.label}</label>)}</fieldset>
      <p className="hint">{tr('导出为未加密的 Markdown ZIP；已标记隐藏的内容始终排除。')}</p>
      <p className="hint">{tr('所有标签原名保留为属性；符合规则的标签同时写入原生标签。')}</p>
      {plan && <>
        <div className="markdown-library-selection"><label><Checkbox disabled={busy || !rows.length} checked={selected.size === rows.length && rows.length > 0 ? true : selected.size ? 'indeterminate' : false}
          onCheckedChange={(checked) => setSelected(new Set(checked === true ? rows.map((row) => row.key) : []))} />{tr('全选')}</label>
          <span role="status">{tr('已选 {0} 项', [formatNumber(selected.size)])}</span>
          {plan.issues.length > 0 && <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => setSelected((current) => new Set([...current].filter((key) => !rows.find((row) => row.key === key)?.issue)))}>{tr('排除不支持的项目')}</Button>}
        </div>
        <div className="markdown-library-rows" aria-label={tr('导出预览')}>{rows.map((row) => <label key={row.key} data-export-key={row.key}>
          <Checkbox checked={selected.has(row.key)} disabled={busy} onCheckedChange={(checked) => choose(row.key, checked === true)} aria-label={tr('选择 {0}', [row.title])} />
          <span><strong>{row.title}</strong><small>{[kinds().find((kind) => kind.value === row.type)?.label, ...row.path].join(' / ')}</small>
            {row.tagNames.length > 0 && <small>{tr('标签')} · {row.tagNames.join(' · ')}</small>}
            {row.issue && <small className="form-error">{typeof row.issue === 'string' ? row.issue : row.issue.message}</small>}
            {row.unsupportedTags?.length > 0 && <small>{tr('仅作为属性保留的标签：{0}', [row.unsupportedTags.join(' · ')])}</small>}
          </span></label>)}{!rows.length && <p className="hint">{tr('没有可导出的内容。')}</p>}</div>
      </>}
      {selectedIssues.length > 0 && <p className="form-error" role="alert">{tr('请取消选择无法完整导出的项目，或使用完整备份。')}</p>}
      {plan?.selectionIssue && selected.size === rows.length && <p className="form-error" role="alert">{plan.selectionIssue.message}</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
    </div>
    <div className="modal-footer">
      <Button type="button" variant="secondary" disabled={busy} onClick={onClose}>{tr('取消')}</Button>
      <Button type="button" variant="ghost" disabled={busy} onClick={() => refresh()}>{tr('重新预览')}</Button>
      <Button type="button" disabled={busy || !plan || !selected.size || Boolean(selectedIssues.length)} onClick={() => run(async () => {
        const result = await exportMarkdownLibrary(plan, { selectedKeys: [...selected] });
        downloadRecoveryFile(result.blob, result.filename); onClose();
      })}>{busy ? tr('正在导出…') : tr('导出')}</Button>
    </div>
  </div>;
}
