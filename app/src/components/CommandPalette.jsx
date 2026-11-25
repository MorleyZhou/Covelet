import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { tr, formatNumber } from '../i18n/index.js';
import { getContentTags } from '../lib/content-preferences.js';
import { parseStructuredSearch, removeStructuredCondition } from '../lib/structured-search.js';
import { filterSavedContent } from '../lib/saved-views.js';
import { SAVED_VIEW_LIMITS } from '../lib/saved-views.js';
import * as browserCommandApi from '../lib/browser-command.js';
import { PresentationContext } from '../lib/presentation.js';
import { userErrorMessage } from '../lib/user-error.js';
import BrowserSessions from './BrowserSessions.jsx';
import { Input } from './ui/input.jsx';
import { Button } from './ui/button.jsx';
import './command-palette.css';

export function StructuredConditions({ parsed, onClear, onRemove }) {
  if (!parsed.structured && parsed.status === 'ready') return null;
  return <div className="structured-conditions" role="status">
    {parsed.status === 'invalid' ? <span className="form-error">{tr('搜索条件无效，请检查类型、标签或引号。')}</span>
      : parsed.conditions.map((condition, index) => <span className="query-condition" key={`${condition.key}:${index}`}>{condition.operator}: {condition.value}
        {onRemove && <Button type="button" variant="ghost" size="sm" aria-label={`${tr('移除条件')} ${condition.operator}: ${condition.value}`} onClick={() => onRemove(condition)}>×</Button>}</span>)}
    {onClear && <Button type="button" variant="ghost" size="sm" onClick={onClear}>{tr('清除条件')}</Button>}
  </div>;
}

const sourceLabels = () => ({ content: tr('内容与操作'), tabs: tr('打开的标签页'), history: tr('浏览历史'), bookmarks: tr('浏览器书签'), sessions: tr('本机会话') });
const sourcePurpose = source => ({
  tabs: tr('授权后可按标题和网址搜索打开的普通标签页，并切换或关闭选中的标签。'),
  history: tr('授权后仅按输入词读取浏览器历史。结果不会保存或同步。'),
  bookmarks: tr('授权后可搜索浏览器书签。不会修改书签，也不会保存或同步搜索结果。'),
}[source]);
const imeEvent = (event, composing) => composing || event?.isComposing || event?.keyCode === 229 || event?.nativeEvent?.isComposing || event?.nativeEvent?.keyCode === 229;

export default function CommandPalette({ Dialog, navigation, tools, preferences, hiddenKeys, actions, onOpen, onSearch, onClose, today,
  browserApi = browserCommandApi, sessionsApi }) {
  const presentation = useContext(PresentationContext);
  const [query, setQuery] = useState(''), [selected, setSelected] = useState(0), [source, setSource] = useState('content');
  const [browserState, setBrowserState] = useState(null), [refresh, setRefresh] = useState(0), [busy, setBusy] = useState(false), [sessionsBusy, setSessionsBusy] = useState(false);
  const [error, setError] = useState(''), [ime, setIme] = useState(false);
  const sessionsRef = useRef(null), [sessionSelection, setSessionSelection] = useState({ count: 0 });
  const composing = useRef(false), list = useRef(null), generation = useRef(0), active = useRef(true), working = useRef(false), frame = useRef(null);
  const actionController = useRef(null);
  const browserSource = ['tabs', 'history', 'bookmarks'].includes(source), blocked = presentation.active && source !== 'content';
  const stateKey = `${source}\0${query}`, labels = sourceLabels();
  frame.current = { source, stateKey, blocked: presentation.active, query };
  const tags = getContentTags(preferences, { hiddenKeys });
  const parsed = useMemo(() => parseStructuredSearch(query, { tags }), [query, preferences, hiddenKeys]);
  const content = parsed.status === 'ready' ? filterSavedContent(navigation, tools, preferences, parsed.filters, { hiddenKeys, today }).rows : [];
  const terms = query.normalize('NFKC').toLocaleLowerCase().trim().split(/\s+/u).filter(Boolean);
  const commands = parsed.status !== 'ready' || parsed.structured ? [] : actions.filter((action) => terms.every((word) => `${action.title} ${action.keywords || ''}`.normalize('NFKC').toLocaleLowerCase().includes(word)));
  const localResults = [...commands.map((action) => ({ key: `action:${action.id}`, title: action.title, group: tr('操作'), run: action.run })),
    ...content.slice(0, 24).map((item) => ({ key: item.key, title: item.title, subtitle: item.subtitle,
      group: tr('内容'), run: () => onOpen(item, parsed.textQuery) }))];
  const visibleState = browserState?.key === stateKey && !blocked ? browserState : null;
  const results = source === 'content' ? localResults : browserSource && !blocked ? (visibleState?.rows || []).map(row => ({ ...row, key: `${source}:${row.id}`, subtitle: row.url, browserRow: row, group: labels[source] })) : [];
  const current = Math.min(selected, Math.max(0, results.length - 1)), pending = busy || sessionsBusy;
  useEffect(() => { setSelected(0); setError(''); }, [query, source, presentation.active]);
  useLayoutEffect(() => () => actionController.current?.abort(), [source, presentation.active]);
  useEffect(() => { list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' }); }, [current, results.length]);
  useEffect(() => {
    const request = ++generation.current, controller = new AbortController();
    if (!browserSource || presentation.active) { setBrowserState(null); return () => controller.abort(); }
    setBrowserState({ key: stateKey, phase: 'loading', rows: [] });
    const valid = () => active.current && generation.current === request && !frame.current.blocked && frame.current.stateKey === stateKey;
    const timer = setTimeout(async () => {
      try {
        const permission = await browserApi.browserCommandPermissions(source);
        if (!valid()) return;
        if (!permission.available || !permission.granted) { setBrowserState({ key: stateKey, phase: permission.available ? 'permission' : 'unavailable', rows: [] }); return; }
        const rows = await browserApi.searchBrowserCommands(source, query, { signal: controller.signal });
        if (valid()) setBrowserState({ key: stateKey, phase: 'ready', rows });
      } catch (reason) { if (valid()) setBrowserState({ key: stateKey, phase: 'error', rows: [], error: userErrorMessage(reason, tr('浏览器搜索未完成，请重试。')) }); }
    }, query.trim() ? 120 : 0);
    return () => { clearTimeout(timer); controller.abort(); generation.current++; };
  }, [source, query, presentation.active, browserApi, refresh]);
  useEffect(() => {
    active.current = true;
    const refreshSource = () => { actionController.current?.abort(); generation.current++; setBrowserState(null); setRefresh(value => value + 1); };
    const unsubscribe = browserApi.subscribeBrowserCommandPermissions?.(refreshSource);
    globalThis.addEventListener?.('focus', refreshSource);
    return () => { active.current = false; actionController.current?.abort(); generation.current++; unsubscribe?.(); globalThis.removeEventListener?.('focus', refreshSource); };
  }, [browserApi]);
  function close() { if (!working.current && !sessionsBusy && !composing.current) onClose(); }
  function requestPermission() {
    if (frame.current.blocked || working.current || composing.current) return;
    const key = stateKey; let permission;
    try { permission = browserApi.requestBrowserCommandPermission(source); }
    catch (reason) { setError(userErrorMessage(reason, tr('未获得浏览器访问权限，请重试授权。'))); return; }
    working.current = true; setBusy(true); setError('');
    Promise.resolve(permission).then(granted => {
      if (active.current && frame.current.stateKey === key && !frame.current.blocked) {
        if (!granted) setError(tr('未获得浏览器访问权限，请重试授权。'));
        setRefresh(value => value + 1);
      }
    }).catch(reason => { if (active.current && frame.current.stateKey === key && !frame.current.blocked) setError(userErrorMessage(reason, tr('未获得浏览器访问权限，请重试授权。'))); })
      .finally(() => { working.current = false; if (active.current) setBusy(false); });
  }
  async function browserAction(row, remove = false) {
    if (frame.current.blocked || working.current || composing.current) return;
    const key = stateKey, controller = new AbortController(); actionController.current = controller;
    working.current = true; setBusy(true); setError('');
    try {
      if (remove) await browserApi.closeBrowserTab(row, { signal: controller.signal });
      else if (source === 'tabs') await browserApi.activateBrowserTab(row, { signal: controller.signal });
      else await browserApi.openBrowserCommand(row, { signal: controller.signal });
      if (!controller.signal.aborted && active.current && frame.current.stateKey === key && !frame.current.blocked) {
        if (remove) { setBrowserState(null); setRefresh(value => value + 1); }
        else onClose();
      }
    } catch (reason) { if (!controller.signal.aborted && active.current && frame.current.stateKey === key && !frame.current.blocked) { setError(userErrorMessage(reason, tr('浏览器操作未完成，请刷新后重试。'))); setBrowserState(null); setRefresh(value => value + 1); } }
    finally { if (actionController.current === controller) actionController.current = null; working.current = false; if (active.current) setBusy(false); }
  }
  function run(index) {
    if (composing.current || pending || !results[index]) return;
    if (results[index].browserRow) browserAction(results[index].browserRow);
    else { onClose(); results[index].run(); }
  }
  return <Dialog title={tr('命令面板')} className="command-palette-modal" onClose={close} closeDisabled={pending || ime}
    onEscapeKeyDown={event => { if (imeEvent(event, composing.current) || working.current || sessionsBusy) event.preventDefault(); }}>
    <div className="command-palette" onCompositionStartCapture={() => { composing.current = true; setIme(true); }} onCompositionEndCapture={() => { composing.current = false; setIme(false); }}
      onKeyDownCapture={event => { if (imeEvent(event, composing.current) && ['Enter', 'Escape'].includes(event.key)) { event.preventDefault(); event.stopPropagation(); } }}>
      <label className="command-source"><span>{tr('搜索来源')}</span><select aria-label={tr('搜索来源')} value={source} disabled={pending || ime} onChange={event => setSource(event.target.value)}>
        {Object.entries(labels).map(([value, label]) => <option key={value} value={value} disabled={presentation.active && value !== 'content'}>{label}</option>)}
      </select></label>
      <Input data-autofocus aria-label={source === 'content' ? tr('搜索内容或操作') : tr('搜索标题或网址')} placeholder={source === 'content' ? tr('搜索内容或操作') : tr('搜索标题或网址')} value={query} autoComplete="off" maxLength={SAVED_VIEW_LIMITS.query}
        disabled={blocked || pending}
        role="combobox" aria-expanded={source === 'sessions' ? sessionSelection.count > 0 && !blocked : results.length > 0} aria-controls={source === 'sessions' ? 'browser-session-results' : 'command-results'} aria-activedescendant={blocked ? undefined : source === 'sessions' ? sessionSelection.activeId : results[current] ? `command-${current}` : undefined}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (imeEvent(event, composing.current)) return;
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault(); const delta = event.key === 'ArrowDown' ? 1 : -1;
            if (source === 'sessions') sessionsRef.current?.moveSelection(delta);
            else setSelected((value) => (value + delta + Math.max(1, results.length)) % Math.max(1, results.length));
          }
          if (event.key === 'Enter') { event.preventDefault(); if (source === 'sessions') sessionsRef.current?.activateSelection(); else run(current); }
        }} />
      {source === 'content' && <StructuredConditions parsed={parsed} onClear={() => setQuery(parsed.status === 'ready' ? parsed.textQuery : '')} onRemove={(condition) => setQuery(removeStructuredCondition(query, condition))} />}
      {blocked ? <div className="command-source-notice"><p>{tr('隐藏模式下不读取或显示浏览器来源和本机会话。')}</p><Button type="button" variant="ghost" onClick={() => presentation.requestUnlock?.()}>{tr('解锁隐藏内容')}</Button></div> : <>
      {browserSource && <p className="hint command-source-purpose">{sourcePurpose(source)}</p>}
      {browserSource && (!visibleState || visibleState.phase === 'loading') && <p className="hint" role="status">{tr('正在读取浏览器结果…')}</p>}
      {browserSource && visibleState?.phase === 'permission' && <div className="command-source-notice"><p>{tr('此来源需要单独授权，只有点击下面的按钮才会申请权限。')}</p><Button type="button" disabled={pending} onClick={requestPermission}>{tr('授权此来源')}</Button></div>}
      {browserSource && visibleState?.phase === 'unavailable' && <p className="hint">{tr('此来源需要受支持的浏览器扩展环境。')}</p>}
      {browserSource && visibleState?.phase === 'error' && <p className="form-error" role="alert">{visibleState.error}</p>}
      {source === 'history' && visibleState?.phase === 'ready' && !query.trim() && <p className="hint">{tr('输入文字后搜索浏览历史。')}</p>}
      {source === 'sessions' ? <BrowserSessions ref={sessionsRef} query={query} browserApi={browserApi} sessionsApi={sessionsApi} onBusyChange={setSessionsBusy} onSelectionChange={setSessionSelection} /> : <>
      <div ref={list} id="command-results" className="command-results" role="listbox" aria-label={tr('搜索结果')}>
        {results.map((result, index) => <div key={result.key}>
          {(index === 0 || results[index - 1].group !== result.group) && <p className="command-group">{result.group}</p>}
          <div role="option" id={`command-${index}`} aria-selected={current === index} className="command-result" onMouseMove={() => setSelected(index)}>
            <Button type="button" variant="unstyled" size="unstyled" className="command-result-open" disabled={pending} onClick={() => run(index)}>
              <strong>{result.title}</strong>{result.subtitle && <small>{result.subtitle}</small>}
            </Button>
            {source === 'tabs' && <Button type="button" variant="ghost" size="sm" className="command-tab-close" disabled={pending}
              aria-label={tr('关闭标签页 {0}', [result.title])} onClick={() => browserAction(result.browserRow, true)}>{tr('关闭标签页')}</Button>}
          </div>
        </div>)}
      </div>
      <div className="command-footer"><span role="status">{tr('当前匹配 {0} 项', [formatNumber(results.length)])}</span>
        {source === 'content' && parsed.status === 'ready' && query.trim() && <Button type="button" variant="ghost" onClick={() => { if (!composing.current) { onClose(); onSearch(query); } }}>{tr('在桌面中查看结果')}</Button>}
      </div></>}
      {error && <p className="form-error" role="alert">{error}</p>}
      </>}
    </div>
  </Dialog>;
}
