import { tr, getLocale, formatNumber } from "../i18n/index.js";
import { useEffect, useRef, useState } from 'react';
import { ClockCounterClockwise, ArrowsClockwise, CaretDown } from '@phosphor-icons/react';
import Select from './Select.jsx';
import PromptDialog, { MessageDialog } from './PromptDialog.jsx';
import { listCloudHistory, previewCloudHistory, restoreCloudHistory, clearCloudHistoryPreview } from '../lib/cloud-sync.js';
import { revisionSelection, revisionChangeLabel, REVISION_FIELD_LABELS } from '../lib/revision-diff.js';
import { loadToolsCore } from '../lib/tools-core.js';

const actions = { get add() { return tr("新增"); }, get remove() { return tr("移除"); }, get update() { return tr("修改"); } };
const valueText = (value) => value === null || value === undefined ? tr("不存在") : typeof value === 'string' ? value : typeof value === 'boolean' ? value ? tr("开启") : tr("关闭") : JSON.stringify(value, null, 2);
function FieldDelta({ before, after, core }) {
  const left = valueText(before), right = valueText(after);
  let first = left, second = right;
  if (core && left !== right) {
    const result = core.diff(left, right), encode = new TextEncoder(), decode = new TextDecoder();
    const parts = (value, Tag) => { const bytes = encode.encode(value), end = bytes.length - result.suffixBytes; return <>{decode.decode(bytes.slice(0, result.prefixBytes))}<Tag>{decode.decode(bytes.slice(result.prefixBytes, end))}</Tag>{decode.decode(bytes.slice(end))}</>; };
    first = parts(left, 'del'); second = parts(right, 'ins');
  }
  return <div className="revision-field-values"><pre aria-label={tr("当前值")}>{first}</pre><pre aria-label={tr("所选版本值")}>{second}</pre></div>;
}
function ChangeDetails({ change, core }) {
  if (change.kind === 'appearance') return <FieldDelta before={change.before} after={change.after} core={core} />;
  const fields = [...new Set([...Object.keys(change.before || {}), ...Object.keys(change.after || {})])].filter((key) => !['id', 'groupId'].includes(key) && JSON.stringify(change.before?.[key]) !== JSON.stringify(change.after?.[key]));
  return fields.map((field) => <div className="revision-field" key={field}><strong>{REVISION_FIELD_LABELS[field] || field}</strong><FieldDelta before={change.before?.[field]} after={change.after?.[field]} core={core} /></div>);
}

export default function CloudHistory({ disabled, unlocked, onBusyChange }) {
  const [versions, setVersions] = useState(null), [actor, setActor] = useState('all'), [limit, setLimit] = useState(20);
  const [preview, setPreview] = useState(null), [selected, setSelected] = useState([]), [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [feedback, setFeedback] = useState(''), [core, setCore] = useState(null);
  const [category, setCategory] = useState('all'), [changeLimit, setChangeLimit] = useState(30), [expanded, setExpanded] = useState(null);
  const active = useRef(true), gate = useRef(false);
  useEffect(() => { active.current = true; loadToolsCore().then((value) => { if (active.current) setCore(value); }).catch(() => {}); return () => { active.current = false; }; }, []);
  useEffect(() => () => { if (preview?.token) clearCloudHistoryPreview(preview.token); }, [preview?.token]);
  useEffect(() => { if (!unlocked) { setVersions(null); setPreview(null); setSelected([]); setConfirm(false); } }, [unlocked]);
  async function run(action) {
    if (gate.current || disabled) return;
    gate.current = true; setBusy(true); setError(''); setFeedback(''); onBusyChange(true);
    try { await action(); } catch (reason) { if (active.current) { setError(reason.message); setConfirm(false); } }
    finally { gate.current = false; if (active.current) { setBusy(false); onBusyChange(false); } }
  }
  const blocked = disabled || busy || !unlocked;
  const actors = [...new Map((versions || []).map((item) => [item.actor, { value: item.actor, label: item.own ? tr("此设备") : tr("设备 {0}", [item.actor.slice(0, 8)]) }])).values()];
  const filtered = (versions || []).filter((item) => actor === 'all' || item.actor === actor);
  const changes = (preview?.changes || []).filter((item) => category === 'all' || item.kind === category);
  function choose(keys) { setSelected(revisionSelection(preview.changes, keys)); setConfirm(false); }
  return <section className="cloud-history" aria-label={tr("云端版本历史")}>
    <div className="cloud-history-heading"><strong><ClockCounterClockwise size={17} />{tr("版本历史")}</strong><button type="button" className="button quiet" disabled={blocked} onClick={() => run(async () => { const items = await listCloudHistory(); if (active.current) { setVersions(items); setActor('all'); setLimit(20); } })}><ArrowsClockwise size={15} />{versions ? tr("刷新") : tr("浏览版本")}</button></div>
    {versions && <><Select label={tr("设备")} value={actor} onChange={(value) => { setActor(value); setLimit(20); }} options={[{ value: 'all', label: tr("全部设备") }, ...actors]} disabled={blocked} />
      <div className="cloud-history-list">{filtered.slice(0, limit).map((version) => <button type="button" key={version.name} aria-pressed={preview?.name === version.name} disabled={blocked} onClick={() => run(async () => { const value = await previewCloudHistory(version.name); if (active.current) { setPreview(value); setSelected([]); setCategory('all'); setChangeLimit(30); setExpanded(null); setConfirm(false); } })}><span>{version.own ? tr("此设备") : tr("设备 {0}", [version.actor.slice(0, 8)])}<strong>{tr("修订 {0}", [formatNumber(version.clock)])}</strong></span><small>{version.bytes ? `${formatNumber(Math.ceil(version.bytes / 1024))} KB` : tr("加密版本")}</small></button>)}{!filtered.length && <p className="hint">{tr("暂无云端版本")}</p>}</div>
      {filtered.length > limit && <button type="button" className="button quiet" disabled={blocked} onClick={() => setLimit(limit + 20)}>{tr("显示更多版本")}</button>}</>}
    {preview && <div className="cloud-history-preview"><div className="cloud-history-preview-heading"><strong>{tr("版本差异")}</strong>{preview.createdAt !== null && <time dateTime={new Date(preview.createdAt).toISOString()}>{new Date(preview.createdAt).toLocaleString(getLocale())}</time>}</div>
      {preview.legacy && <p className="hint">{tr("旧修订仅包含此设备修改过的项目，未记录的项目会保留。")}</p>}
      <Select label={tr("内容")} value={category} onChange={(value) => { setCategory(value); setChangeLimit(30); }} disabled={blocked} options={[{ value: 'all', label: tr("全部差异") }, { value: 'navigation', label: tr("导航与组件") }, { value: 'search', label: tr("搜索引擎") }, { value: 'appearance', label: tr("外观与布局") }]} />
      <div className="cloud-history-selection"><button type="button" className="button quiet" disabled={blocked || !changes.length} onClick={() => choose([...new Set([...selected, ...changes.map((item) => item.key)])])}>{tr("选择此类全部")}</button><button type="button" className="button quiet" disabled={blocked || !selected.length} onClick={() => choose([])}>{tr("清除选择")}</button><span>{tr("{0} 项已选", [formatNumber(selected.length)])}</span></div>
      <div className="revision-column-labels"><span>{tr("当前")}</span><span>{tr("所选版本")}</span></div>
      <div className="revision-changes">{changes.slice(0, changeLimit).map((change) => <div className="revision-change" key={change.key}><div className="revision-change-heading"><label><input type="checkbox" checked={selected.includes(change.key)} disabled={blocked} onChange={(event) => choose(event.target.checked ? [...selected, change.key] : selected.filter((key) => key !== change.key))} /><strong>{revisionChangeLabel(change)}</strong><small className={`revision-action-${change.action}`}>{actions[change.action]}</small></label><button type="button" aria-label={tr("查看{0}差异", [revisionChangeLabel(change)])} aria-expanded={expanded === change.key} disabled={blocked} onClick={() => setExpanded(expanded === change.key ? null : change.key)}><CaretDown size={15} /></button></div>
        {expanded === change.key && <div className="revision-change-detail"><ChangeDetails change={change} core={core} /></div>}</div>)}{!changes.length && <p className="hint">{tr("没有差异")}</p>}</div>
      {changes.length > changeLimit && <button type="button" className="button quiet" onClick={() => setChangeLimit(changeLimit + 30)}>{tr("显示更多差异")}</button>}
      <button type="button" className="button primary" disabled={blocked || !selected.length} onClick={() => setConfirm(true)}>{tr("恢复所选项目")}</button>
      {confirm && <PromptDialog title={tr('确认恢复')} action={tr('确认恢复')} busy={busy} confirmDisabled={blocked || !selected.length} onCancel={() => setConfirm(false)} onConfirm={() => run(async () => { await restoreCloudHistory(preview.token, selected); if (active.current) { setPreview(null); setSelected([]); setConfirm(false); setFeedback(tr('已恢复所选项目')); } })}><p>{tr('恢复所选 {0} 项？关联文件夹会一并恢复，其他子导航会保留在桌面；本机将保留恢复前的配置快照。', [formatNumber(selected.length)])}</p></PromptDialog>}
    </div>}
    <MessageDialog message={error || feedback} onClose={() => { setError(''); setFeedback(''); }} />
  </section>;
}
