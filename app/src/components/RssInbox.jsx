import { useContext, useEffect, useRef, useState } from 'react';
import { tr, getLocale } from '../i18n/index.js';
import { rssInbox, rssFeedOrigin } from '../lib/rss-inbox.js';
import { getExtensionApi } from '../lib/extension-api.js';
import { saveReadingArticle } from '../lib/reading-library.js';
import { requestSiteAccess } from '../lib/site-info.js';
import { userErrorMessage } from '../lib/user-error.js';
import { PresentationContext } from '../lib/presentation.js';
import PromptDialog from './PromptDialog.jsx';
import { Button } from './ui/button.jsx';
import { Input } from './ui/input.jsx';
import './rss-inbox.css';

const sendNativeMessage = message => getExtensionApi()?.runtime?.sendMessage ? getExtensionApi().runtime.sendMessage(message)
  : Promise.reject(new Error(tr('订阅更新失败，请检查网络后重试。')));
const time = value => value ? new Date(value).toLocaleString(getLocale(), { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : tr('尚未更新');
export default function RssInbox({ Dialog, onClose, onOpenReading, hiddenReadingIds = new Set(), hiddenReadingUrls = new Set(), inbox = rssInbox,
  requestAccess = requestSiteAccess, sendMessage = sendNativeMessage, saveArticle = saveReadingArticle }) {
  const presentation = useContext(PresentationContext);
  const [data, setData] = useState(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [feedId, setFeedId] = useState('all'), [url, setUrl] = useState(''), [title, setTitle] = useState(''), [interval, setInterval] = useState(60), [adding, setAdding] = useState(false), [removing, setRemoving] = useState(null);
  const active = useRef(true), working = useRef(false), hidden = useRef(null);
  hidden.current = { ids: hiddenReadingIds, urls: hiddenReadingUrls };
  useEffect(() => {
    active.current = true; let changed = false;
    inbox.load().then(value => { if (active.current && !changed) setData(value); }).catch(reason => { if (active.current) setError(userErrorMessage(reason)); });
    const off = inbox.subscribe(value => { changed = true; if (active.current) setData(value); });
    return () => { active.current = false; off(); };
  }, [inbox]);
  const isHidden = item => hiddenReadingUrls.has(item.url) || item.savedReadingId && (hiddenReadingIds.has(item.savedReadingId) || presentation.active && presentation.hiddenKeys.has(`reading:${item.savedReadingId}`));
  const feeds = data?.feeds || [], items = (data?.items || []).filter(item => !isHidden(item) && (feedId === 'all' || item.feedId === feedId));
  async function run(action) {
    if (working.current) return; working.current = true; setBusy(true); setError('');
    try { await action(); if (active.current) setData(await inbox.load()); }
    catch (reason) { if (active.current) setError(userErrorMessage(reason, tr('订阅更新失败，请检查网络后重试。'))); }
    finally { working.current = false; if (active.current) setBusy(false); }
  }
  function add(event) {
    event.preventDefault(); if (working.current) return;
    let access;
    try { access = requestAccess(rssFeedOrigin(url)); } catch (reason) { setError(userErrorMessage(reason)); return; }
    const address = url, name = title, minutes = interval;
    run(async () => {
      if (!await access) throw new Error(tr('请先授权访问此订阅来源。'));
      await inbox.add({ url: address, title: name || undefined, intervalMinutes: minutes });
      if (active.current) { setUrl(''); setTitle(''); setAdding(false); }
    });
  }
  function refresh(id) {
    run(async () => {
      const result = await sendMessage({ type: 'covelet:rss:refresh', ...(id && { feedId: id }) });
      if (!result?.ok) throw Object.assign(new Error(result?.error?.message || tr('订阅更新失败，请检查网络后重试。')), { code: result?.error?.code });
      if (active.current && result.status) setData(result.status);
    });
  }
  function save(item) {
    if (working.current || isHidden(item)) return;
    // Saving and reading is the explicit action authorizing article access.
    let access;
    try { access = requestAccess(item.url).catch(() => false); } catch { access = Promise.resolve(false); }
    run(async () => {
      const granted = await access;
      if (hidden.current.urls.has(item.url) || item.savedReadingId && hidden.current.ids.has(item.savedReadingId)) return;
      const record = await inbox.save(item.id);
      if (hidden.current.ids.has(record.id) || hidden.current.urls.has(record.url)) return;
      if (granted) await saveArticle(record).catch(() => null);
      if (active.current && !hidden.current.ids.has(record.id) && !hidden.current.urls.has(record.url)) onOpenReading?.(record);
    });
  }
  return <Dialog title={tr('订阅收件箱')} wide maximizable className="rss-inbox-modal" closeDisabled={busy} onClose={() => { if (!working.current) onClose?.(); }}>
    <div className="rss-inbox-panel">
      <div className="rss-inbox-toolbar"><label>{tr('订阅来源')}<select aria-label={tr('订阅来源')} value={feedId} disabled={busy} onChange={event => setFeedId(event.target.value)}><option value="all">{tr('全部来源')}</option>{feeds.map(feed => <option key={feed.id} value={feed.id}>{feed.title}</option>)}</select></label>
        <div><Button type="button" variant="ghost" disabled={busy || !feeds.length} onClick={() => refresh(feedId === 'all' ? undefined : feedId)}>{tr('更新订阅')}</Button><Button type="button" variant="secondary" disabled={busy} onClick={() => setAdding(value => !value)}>{tr('添加订阅')}</Button></div></div>
      <p className="hint">{tr('收件箱只保存标题、摘要和链接。保存到稍后读后，可提取正文并离线阅读。')}</p>
      <p className="hint">{tr('每个来源保留最近 100 条，收件箱最多 500 条；已保存到稍后读的内容不受影响。')}</p>
      {adding && <form className="rss-inbox-add" onSubmit={add}><label>{tr('订阅地址')}<Input type="url" aria-label={tr('订阅地址')} required value={url} maxLength={4096} disabled={busy} onChange={event => setUrl(event.target.value)} placeholder="https://example.com/feed.xml" /></label>
        <label>{tr('名称')}<Input aria-label={tr('订阅名称')} value={title} maxLength={200} disabled={busy} onChange={event => setTitle(event.target.value)} placeholder={tr('可留空')} /></label>
        <label>{tr('更新间隔')}<select aria-label={tr('更新间隔')} value={interval} disabled={busy} onChange={event => setInterval(Number(event.target.value))}>{[[15, tr('每 15 分钟')], [60, tr('每小时')], [360, tr('每 6 小时')], [1440, tr('每天')]].map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <p className="hint">{tr('只请求所填订阅地址的访问权限，并在后台按此间隔更新。')}</p><Button type="submit" disabled={busy || !url.trim()}>{tr('添加订阅')}</Button></form>}
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="rss-inbox-workspace"><aside className="rss-inbox-feeds" aria-label={tr('订阅来源管理')}>{feeds.map(feed => <section key={feed.id}><strong>{feed.title}</strong><small>{time(feed.lastSuccess)}</small>{feed.lastError && <p className="form-error">{userErrorMessage(feed.lastError)}</p>}<div><Button type="button" variant="ghost" disabled={busy} onClick={() => refresh(feed.id)}>{tr('更新')}</Button><Button type="button" variant="ghost" disabled={busy} onClick={() => setRemoving(feed)}>{tr('移除')}</Button></div></section>)}</aside>
        <div className="rss-inbox-items" aria-label={tr('订阅条目')}>{items.map(item => <article key={item.id}><div><small>{feeds.find(feed => feed.id === item.feedId)?.title} · {time(item.publishedAt || item.receivedAt)}</small><h3>{item.title}</h3></div><p>{item.summary}</p><div><a href={item.url} target="_blank" rel="noreferrer noopener">{tr('打开原网页')}</a><Button type="button" variant="secondary" disabled={busy} onClick={() => save(item)}>{item.savedReadingId ? tr('阅读') : tr('保存并阅读')}</Button></div></article>)}{!items.length && <p className="tool-empty">{data ? tr('收件箱为空') : tr('正在读取…')}</p>}</div></div>
      {removing && <PromptDialog title={tr('移除订阅')} action={tr('移除')} busy={busy} onCancel={() => setRemoving(null)} onConfirm={() => run(async () => { await inbox.remove(removing.id); if (active.current) { if (feedId === removing.id) setFeedId('all'); setRemoving(null); } })}><p>{tr('移除此来源及其收件箱条目？已保存到稍后读的内容会保留。')}</p></PromptDialog>}
    </div>
  </Dialog>;
}
