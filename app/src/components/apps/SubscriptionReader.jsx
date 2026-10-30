import { useEffect, useRef, useState } from 'react';
import { Plus, X, GearSix, ArrowsClockwise, Star, ArrowSquareOut, ArrowLeft } from '@phosphor-icons/react';
import { tr, getLocale } from '../../i18n/index.js';
import { useAppData, useAppAction, Field, AppError, Button, Input, Select } from './shared.jsx';
import Confirm from '../PromptDialog.jsx';
import { fetchAppJSON, fetchAppResponse, readAppResponse, requestAppAccess } from '../../lib/app-network.js';
import { parseFeed, releaseItems, mergeFeedItems, feedText, safeContentURL } from '../../lib/connected-apps.js';
import { saveReadingItem } from '../../lib/personal-tools.js';
import './connected-apps.css';

const EMPTY = { sources: [], items: [], baselines: {} }, emptyDraft = () => ({ kind: 'rss', title: '', url: '', selector: '' });
export default function SubscriptionReader({ onDirtyChange, onBusyChange, initialContext }) {
  const { data, update, loaded, loading, error } = useAppData('subscriptions', EMPTY), action = useAppAction();
  const [draft, setDraft] = useState(emptyDraft), [filter, setFilter] = useState('unread'), [sourceId, setSourceId] = useState('all'), [query, setQuery] = useState('');
  const [selected, setSelected] = useState(''), [sheet, setSheet] = useState(null), [deleting, setDeleting] = useState(null), [discarding, setDiscarding] = useState(false);
  const [readingOpen, setReadingOpen] = useState(false);
  const contextUsed = useRef(false);
  useEffect(() => { if (!loaded || contextUsed.current) return; contextUsed.current = true; const item = data.items.find((row) => row.id === initialContext?.itemId); if (item) { setSelected(item.id); setFilter('all'); setReadingOpen(true); } }, [loaded, data.items, initialContext]);
  const abort = useRef(null), dirty = Boolean(draft.url || draft.title || draft.selector);
  useEffect(() => { onDirtyChange?.(dirty); return () => onDirtyChange?.(false); }, [dirty, onDirtyChange]);
  useEffect(() => { onBusyChange?.(action.busy); return () => onBusyChange?.(false); }, [action.busy, onBusyChange]);
  useEffect(() => () => abort.current?.abort(), []);
  const sourceURL = (source) => {
    if (source.kind !== 'releases') { const url = safeContentURL(source.url); if (!url) throw Error(tr('请填写有效的订阅地址。')); return url; }
    const match = source.url.trim().replace(/^https:\/\/github.com\//, '').replace(/\/$/, '').match(/^([\w.-]+)\/([\w.-]+)$/);
    if (!match) throw Error(tr('请填写 owner/repository 格式的项目名称。'));
    return `https://api.github.com/repos/${match[1]}/${match[2]}/releases?per_page=30`;
  };
  const refresh = async (source) => {
    abort.current = new AbortController(); const options = { signal: abort.current.signal }, url = sourceURL(source);
    const text = source.kind === 'releases' ? null : await readAppResponse(await fetchAppResponse(url, options));
    let incoming, baseline;
    if (source.kind === 'releases') incoming = releaseItems(await fetchAppJSON(url, options), source);
    else if (source.kind === 'rss') incoming = parseFeed(text, source);
    else {
      if (/<!ENTITY/i.test(text)) throw Error(tr('网页内容格式无效。'));
      const template = document.createElement('template'); template.innerHTML = text; const doc = template.content;
      doc.querySelectorAll('script,style,iframe,object,embed,noscript,head,title,link,meta').forEach((node) => node.remove());
      let node; try { node = source.selector ? doc.querySelector(source.selector) : doc; } catch { throw Error(tr('页面区域选择器无效。')); }
      if (!node) throw Error(tr('未找到指定页面区域。'));
      baseline = feedText(node.textContent, 100000); incoming = [];
    }
    await update((latest) => {
      if (!latest.sources.some((item) => item.id === source.id)) return latest;
      if (baseline !== undefined) { const previous = latest.baselines[source.id]; if (previous !== undefined && previous !== baseline) incoming = [{ id: `${source.id}:${Date.now()}`, sourceId: source.id, title: source.title, url, summary: baseline.slice(0, 12000), publishedAt: new Date().toISOString(), read: false, starred: false }]; latest.baselines[source.id] = baseline; }
      latest.items = mergeFeedItems(latest.items, incoming); latest.sources = latest.sources.map((item) => item.id === source.id ? { ...item, checkedAt: new Date().toISOString() } : item); return latest;
    });
  };
  const refreshSource = (source) => {
    let permission; try { permission = requestAppAccess(sourceURL(source)); } catch (reason) { action.setError(reason.message); return; }
    action.run(async () => { await permission; await refresh(source); });
  };
  const rows = data.items.filter((item) => (sourceId === 'all' || item.sourceId === sourceId) && (filter !== 'unread' || !item.read) && (filter !== 'starred' || item.starred) && `${item.title} ${item.summary}`.toLowerCase().includes(query.toLowerCase())).sort((a, b) => String(b.publishedAt).localeCompare(String(a.publishedAt)));
  const article = rows.find((item) => item.id === selected) || rows[0], currentSource = data.sources.find((source) => source.id === (sourceId === 'all' ? article?.sourceId : sourceId));
  const unread = (id) => data.items.filter((item) => !item.read && (id === 'all' || item.sourceId === id)).length;
  const changeItem = (item, patch) => action.run(() => update((latest) => ({ ...latest, items: latest.items.map((row) => row.id === item.id ? { ...row, ...patch } : row) })));
  const closeSheet = () => { if (action.busy) return; if (sheet === 'add' && dirty) setDiscarding(true); else setSheet(null); };
  return <div className="app-workspace subscription-reader">
    <AppError message={error || action.error} onClose={() => action.setError('')} />
    <div className={`reader-layout ${readingOpen ? 'has-reading' : ''}`} inert={sheet ? true : undefined}>
      <aside className="reader-sources"><div className="reader-sidebar-heading"><strong>{tr('订阅来源')}</strong><Button type="button" variant="ghost" size="icon" aria-label={tr('管理订阅')} onClick={() => setSheet('manage')}><GearSix size={18} /></Button></div>
        <Button type="button" variant="secondary" onClick={() => setSheet('add')}><Plus size={17} />{tr('添加订阅')}</Button>
        <div className="reader-filters">{[['unread', '未读'], ['all', '全部'], ['starred', '收藏']].map(([value, name]) => <Button type="button" variant="ghost" key={value} aria-pressed={filter === value} onClick={() => { setFilter(value); setSelected(''); }}>{tr(name)}</Button>)}</div>
        <div className="reader-source-list"><Button type="button" variant="ghost" aria-pressed={sourceId === 'all'} onClick={() => { setSourceId('all'); setSelected(''); }}><span>{tr('全部')}</span><small>{unread('all')}</small></Button>{data.sources.map((source) => <Button type="button" variant="ghost" key={source.id} aria-pressed={sourceId === source.id} onClick={() => { setSourceId(source.id); setSelected(''); }}><span>{source.title}</span><small>{unread(source.id)}</small></Button>)}</div>
      </aside>
      <section className="reader-articles" aria-label={tr('订阅内容')}><div className="reader-list-heading"><Input type="search" aria-label={tr('搜索订阅内容')} placeholder={tr('搜索')} value={query} onChange={(event) => setQuery(event.target.value)} />{currentSource && <Button type="button" variant="ghost" size="icon" disabled={action.busy} aria-label={tr('刷新')} onClick={() => refreshSource(currentSource)}><ArrowsClockwise size={18} className={action.busy ? 'site-info-spinner' : undefined} /></Button>}</div>
        <div className="reader-item-list">{rows.map((item) => <Button type="button" variant="unstyled" size="unstyled" className={`reader-item ${item.read ? '' : 'is-unread'}`} key={item.id} aria-pressed={article?.id === item.id} onClick={() => { setSelected(item.id); setReadingOpen(true); }}><span className="reader-item-source">{data.sources.find((source) => source.id === item.sourceId)?.title}{item.starred && <Star size={13} weight="fill" />}</span><strong>{item.title}</strong><span className="reader-item-summary">{item.summary.slice(0, 140)}</span><time>{item.publishedAt ? new Date(item.publishedAt).toLocaleDateString(getLocale()) : ''}</time></Button>)}{!rows.length && <p className="app-empty">{loading ? tr('正在加载…') : tr('没有符合条件的内容')}</p>}</div>
      </section>
      <section className="reader-reading" aria-label={tr('阅读内容')}>{article ? <><div className="reader-reading-toolbar"><Button type="button" variant="ghost" size="icon" className="reader-back" aria-label={tr('返回列表')} onClick={() => setReadingOpen(false)}><ArrowLeft size={18} /></Button><Button type="button" variant="ghost" disabled={action.busy} onClick={() => changeItem(article, { read: !article.read })}>{article.read ? tr('标为未读') : tr('标为已读')}</Button><Button type="button" variant="ghost" disabled={action.busy} onClick={() => changeItem(article, { starred: !article.starred })}><Star size={16} weight={article.starred ? 'fill' : 'regular'} />{article.starred ? tr('取消收藏') : tr('收藏')}</Button><Button type="button" variant="ghost" disabled={action.busy} onClick={() => action.run(() => saveReadingItem({ title: article.title, url: article.url, status: 'unread' }))}>{tr('加入稍后读')}</Button></div><article className="reader-article-body"><small className="app-muted">{currentSource?.title}</small><h3>{article.title}</h3><time className="app-muted">{article.publishedAt ? new Date(article.publishedAt).toLocaleString(getLocale()) : ''}</time><p>{article.summary}</p><a href={article.url} target="_blank" rel="noopener noreferrer">{tr('打开原文')} <ArrowSquareOut size={15} /></a></article></> : <div className="reader-empty"><h3>{tr('订阅中心')}</h3><p className="app-muted">{data.sources.length ? tr('没有符合条件的内容') : tr('添加一个订阅来源')}</p>{!data.sources.length && <Button type="button" onClick={() => setSheet('add')}>{tr('添加订阅')}</Button>}</div>}</section>
    </div>
    {sheet && <aside className="connected-sheet" aria-label={sheet === 'add' ? tr('添加订阅') : tr('管理订阅')}><div className="connected-sheet-heading"><h3>{sheet === 'add' ? tr('添加订阅') : tr('管理订阅')}</h3><Button type="button" variant="ghost" size="icon" disabled={action.busy} aria-label={tr('关闭面板')} onClick={closeSheet}><X size={19} /></Button></div>
      {sheet === 'add' ? <form className="app-form" onSubmit={(event) => { event.preventDefault(); let url; try { url = sourceURL(draft); } catch (reason) { action.setError(reason.message); return; } const permission = requestAppAccess(url); action.run(async () => { await permission; const source = { ...draft, id: crypto.randomUUID(), title: draft.title.trim() || draft.url, url: draft.kind === 'releases' ? draft.url.trim() : url }; await update((latest) => { if (latest.sources.length >= 100) throw Error(tr('订阅来源已达上限。')); if (latest.sources.some((item) => item.kind === source.kind && item.url === source.url && item.selector === source.selector)) throw Error(tr('此订阅已存在。')); return { ...latest, sources: [...latest.sources, source] }; }); setDraft(emptyDraft()); setSheet(null); setSourceId(source.id); await refresh(source); }); }}>
        <Select label={tr('订阅类型')} value={draft.kind} onChange={(kind) => setDraft({ ...draft, kind })} options={[{ value: 'rss', label: 'RSS / Atom' }, { value: 'releases', label: 'GitHub Releases' }, { value: 'web', label: tr('网页变化') }]} /><Field label={tr('名称')}><Input value={draft.title} maxLength={120} onChange={(event) => setDraft({ ...draft, title: event.target.value })} /></Field><Field label={tr('订阅地址')}><Input value={draft.url} maxLength={4096} placeholder={draft.kind === 'releases' ? 'owner/repository' : 'https://…'} onChange={(event) => setDraft({ ...draft, url: event.target.value })} /></Field>{draft.kind === 'web' && <Field label={tr('页面区域（可留空）')}><Input value={draft.selector} maxLength={200} onChange={(event) => setDraft({ ...draft, selector: event.target.value })} /></Field>}<Button type="submit" disabled={loading || action.busy}>{action.busy ? tr('正在获取…') : tr('添加并获取')}</Button>
      </form> : <div className="reader-source-management">{data.sources.map((source) => <div key={source.id}><strong>{source.title}</strong><small className="app-muted">{source.url}</small><small className="app-muted">{source.checkedAt ? new Date(source.checkedAt).toLocaleString(getLocale()) : tr('尚未获取')}</small><div className="app-toolbar"><Button type="button" variant="secondary" disabled={action.busy} onClick={() => refreshSource(source)}>{source.kind === 'web' ? tr('检查变化') : tr('刷新')}</Button><Button type="button" variant="ghost" disabled={action.busy} onClick={() => setDeleting(source)}>{tr('删除')}</Button></div></div>)}{!data.sources.length && <p className="app-empty">{tr('添加一个订阅来源')}</p>}</div>}
    </aside>}
    {action.busy && <div className="connected-progress" role="status">{tr('正在获取…')}<Button type="button" variant="ghost" onClick={() => abort.current?.abort()}>{tr('取消')}</Button></div>}
    {discarding && <Confirm action={tr('放弃修改')} onCancel={() => setDiscarding(false)} onConfirm={() => { setDiscarding(false); setDraft(emptyDraft()); setSheet(null); }}>{tr('当前内容尚未保存，放弃修改？')}</Confirm>}
    {deleting && <Confirm action={tr('删除')} destructive onCancel={() => setDeleting(null)} onConfirm={() => action.run(async () => { await update((latest) => { latest.sources = latest.sources.filter((source) => source.id !== deleting.id); latest.items = latest.items.filter((item) => item.sourceId !== deleting.id); delete latest.baselines[deleting.id]; return latest; }); if (sourceId === deleting.id) setSourceId('all'); setDeleting(null); })}>{tr('删除此订阅及其已保存内容？')}</Confirm>}
  </div>;
}
