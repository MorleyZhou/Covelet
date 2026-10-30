import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, Copy, DownloadSimple, Plus, ArrowRight, ArrowSquareOut, FileText } from '@phosphor-icons/react';
import { tr, getLocale } from '../../i18n/index.js';
import { Button, Input, downloadBlob } from './shared.jsx';
import { toggleTask as completeTask, dateKey, templateVariables } from '../../lib/daily-apps.js';
import { stockCacheKey, chartPolyline, convertCurrencyAmount, currencyDigits, ledgerSummary, minorToDecimal, sportsEventPhase } from '../../lib/market-apps.js';
import { layoutMindMap, MAP_NODE_WIDTH, MAP_NODE_HEIGHT } from '../../lib/processing-apps.js';

export function WidgetAction({ children, onClick, className = '', ...props }) {
  return <Button type="button" variant="unstyled" size="unstyled" data-widget-action className={`app-widget-action ${className}`} {...props} onClick={(event) => { event.stopPropagation(); onClick?.(); }}>{children}</Button>;
}
const empty = (title, action, label) => <div className="app-widget-empty"><span>{title}</span><WidgetAction className="app-widget-primary" onClick={action}>{label}<ArrowRight size={14} /></WidgetAction></div>;
const money = (number, currency) => { try { return minorToDecimal(number, currency); } catch { return '—'; } };
const amount = (value) => typeof value === 'number' && Number.isFinite(value) ? new Intl.NumberFormat(getLocale(), { maximumFractionDigits: 2 }).format(value) : '—';

function CachedPicture({ blob, name }) {
  const [source, setSource] = useState(null);
  useEffect(() => { if (!(blob instanceof Blob)) return; const url = URL.createObjectURL(blob); setSource({ blob, url }); return () => URL.revokeObjectURL(url); }, [blob]);
  return source?.blob === blob ? <img className="app-widget-picture" src={source.url} alt={name} /> : null;
}
function BoardPicture({ board }) {
  const diagram = useMemo(() => { try { return layoutMindMap(board); } catch { return { nodes: [], edges: [] }; } }, [board]);
  if (!diagram.nodes.length) return null;
  const minX = Math.min(...diagram.nodes.map((node) => node.x)), minY = Math.min(...diagram.nodes.map((node) => node.y)), maxX = Math.max(...diagram.nodes.map((node) => node.x + MAP_NODE_WIDTH)), maxY = Math.max(...diagram.nodes.map((node) => node.y + MAP_NODE_HEIGHT));
  const byId = new Map(diagram.nodes.map((node) => [node.id, node]));
  return <svg className="app-widget-map" viewBox={`${minX - 16} ${minY - 16} ${maxX - minX + 32} ${maxY - minY + 32}`} role="img" aria-label={board.title}>
    {diagram.edges.map((edge, index) => { const from = byId.get(edge.from), to = byId.get(edge.to); if (!from || !to) return null; return <path key={index} d={`M ${from.x + MAP_NODE_WIDTH} ${from.y + MAP_NODE_HEIGHT / 2} C ${from.x + MAP_NODE_WIDTH + 36} ${from.y + MAP_NODE_HEIGHT / 2},${to.x - 36} ${to.y + MAP_NODE_HEIGHT / 2},${to.x} ${to.y + MAP_NODE_HEIGHT / 2}`} fill="none" stroke="currentColor" opacity=".35" strokeWidth="3" />; })}
    {diagram.nodes.map((node) => <g key={node.id}><rect x={node.x} y={node.y} width={MAP_NODE_WIDTH} height={MAP_NODE_HEIGHT} rx="12" fill={node.color || '#e9edf5'} /><text x={node.x + 14} y={node.y + 39} fontSize="20" fill="#253044">{node.text.slice(0, 11)}</text></g>)}
  </svg>;
}
function CurrencyContent({ data, update, action }) {
  const [draft, setDraft] = useState(data.amount || '1'), input = useRef(null);
  useEffect(() => { if (document.activeElement !== input.current) setDraft(data.amount || '1'); }, [data.amount]);
  const converted = useMemo(() => { try { return convertCurrencyAmount(draft, data.cache?.rates?.[data.base], data.cache?.rates?.[data.target], currencyDigits(data.target)); } catch { return '—'; } }, [draft, data.cache, data.base, data.target]);
  const save = () => { const value = draft.replace(/\.$/, ''); if (!/^\d{1,16}(?:\.\d{1,16})?$/.test(value)) { setDraft(data.amount || '1'); return; } setDraft(value); if (value !== data.amount) action.run(() => update((latest) => ({ ...latest, amount: value }))); };
  return <div className="app-widget-converter"><div className="app-widget-currency-input"><small>{data.base || 'USD'}</small><Input ref={input} inputMode="decimal" aria-label={tr('换算金额')} value={draft} maxLength={34} disabled={action.busy} onClick={(event) => event.stopPropagation()} onChange={(event) => setDraft(event.target.value)} onBlur={save} onKeyDown={(event) => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); input.current.blur(); } }} /></div><output><b>{converted}</b><small>{data.target || 'CNY'}</small></output>{data.cache?.date && <small className="app-widget-footnote">{data.cache.date}</small>}</div>;
}

export default function DesktopWidgetContent({ appId, data, onOpen, update, action }) {
  if (appId === 'tasks') {
    const rows = (data.tasks || []).filter((item) => !item.completed).sort((a, b) => Number(b.myDay === dateKey()) - Number(a.myDay === dateKey()) || Number(b.important) - Number(a.important));
    return rows.length ? <><div className="app-widget-list">{rows.slice(0, 6).map((item) => <div className="app-widget-task-row" key={item.id}><WidgetAction className="app-widget-check" role="checkbox" aria-checked="false" aria-label={tr('完成任务：{0}', [item.title])} disabled={action.busy} onClick={() => action.run(() => update((latest) => latest.tasks.find((row) => row.id === item.id)?.completed ? latest : completeTask(latest, item.id)))}><Check size={12} /></WidgetAction><WidgetAction className="app-widget-line" onClick={() => onOpen({ taskId: item.id })}>{item.title}</WidgetAction></div>)}</div><WidgetAction className="app-widget-footer-action" onClick={() => onOpen()}><Plus size={14} />{tr('添加任务')}</WidgetAction></> : empty(tr('今天想做什么？'), () => onOpen(), tr('添加任务'));
  }
  if (appId === 'snippets') {
    const rows = [...(data.items || [])].sort((a, b) => Number(b.favorite) - Number(a.favorite));
    return rows.length ? <div className="app-widget-list">{rows.slice(0, 6).map((item) => { const variables = templateVariables(item.body); return <div className="app-widget-snippet-row" key={item.id}><WidgetAction className="app-widget-line" onClick={() => onOpen({ recordId: item.id })}>{item.title}</WidgetAction><WidgetAction className="app-widget-icon-action" aria-label={variables.length ? tr('填写模板：{0}', [item.title]) : tr('复制：{0}', [item.title])} disabled={action.busy} onClick={() => variables.length ? onOpen({ recordId: item.id }) : action.run(() => navigator.clipboard.writeText(item.body))}>{variables.length ? <ArrowRight size={14} /> : <Copy size={14} />}</WidgetAction></div>; })}</div> : empty(tr('收藏常用文本'), () => onOpen(), tr('新小抄'));
  }
  if (appId === 'currency') return <CurrencyContent data={data} update={update} action={action} />;
  if (appId === 'stocks') {
    const rows = (data.symbols || []).filter((item) => item.listId === data.selectedList);
    return rows.length ? <div className="app-widget-stock-list">{rows.slice(0, 5).map((item) => { const key = stockCacheKey(data.settings.provider, item.symbol, item.exchange), quote = data.quotes?.[key], points = data.series?.[key] || [], rising = quote?.change >= 0, green = data.settings.colors === 'green-up' ? rising : !rising; return <WidgetAction className="app-widget-stock-row" key={item.id} onClick={() => onOpen({ symbolId: item.id })}><strong>{item.name || item.symbol}</strong><b>{amount(quote?.price)}</b><small>{item.symbol}</small><span className="app-widget-stock-change" style={quote ? { color: green ? '#28784b' : '#b34d45' } : undefined}>{quote?.percent === null || quote?.percent === undefined ? '—' : `${quote.percent > 0 ? '+' : ''}${quote.percent.toFixed(2)}%`}</span>{points.length > 1 && <svg viewBox="0 0 120 25" aria-hidden="true"><polyline points={chartPolyline(points.slice(-30), 120, 25)} fill="none" stroke="currentColor" strokeWidth="1.6" /></svg>}</WidgetAction>; })}</div> : empty(tr('添加你关注的标的'), () => onOpen(), tr('加入自选'));
  }
  if (appId === 'language') {
    const words = data.words || [], word = [...words].sort((a, b) => a.dueAt - b.dueAt)[0];
    return word ? <div className="app-widget-vocabulary"><WidgetAction onClick={() => onOpen({ wordId: word.id })}><strong>{word.term}</strong><span>{word.meaning}</span></WidgetAction><WidgetAction className="app-widget-footer-action" onClick={() => onOpen({ wordId: word.id })}>{tr('学习')}<ArrowRight size={14} /></WidgetAction></div> : empty(tr('积累新单词'), () => onOpen(), tr('添加单词'));
  }
  if (appId === 'subscriptions') {
    const rows = (data.items || []).filter((item) => !item.read).sort((a, b) => String(b.publishedAt).localeCompare(String(a.publishedAt)));
    return rows.length ? <div className="app-widget-list">{rows.slice(0, 5).map((item) => <WidgetAction className="app-widget-article" key={item.id} onClick={() => onOpen({ itemId: item.id })}><strong>{item.title}</strong><small>{data.sources?.find((source) => source.id === item.sourceId)?.title}</small></WidgetAction>)}</div> : empty(tr('没有未读内容'), () => onOpen(), tr('查看订阅'));
  }
  if (appId === 'ai-chat') {
    const session = [...(data.sessions || [])].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))[0];
    return <div className="app-widget-chat">{session ? <WidgetAction className="app-widget-chat-last" onClick={() => onOpen({ sessionId: session.id })}><strong>{session.title}</strong><span>{session.messages.at(-1)?.content.slice(0, 170)}</span></WidgetAction> : <span className="app-widget-hint">{tr('连接自己的模型')}</span>}<WidgetAction className="app-widget-primary" onClick={() => onOpen({ newSession: true })}><Plus size={14} />{tr('新会话')}</WidgetAction></div>;
  }
  if (appId === 'online-tools') return <div className="app-widget-tool-grid">{[['json', 'JSON'], ['diff', tr('文本对比')], ['regex', tr('正则')], ['encoding', tr('编码')]].map(([tool, title]) => <WidgetAction key={tool} onClick={() => onOpen({ tool })}>{title}</WidgetAction>)}</div>;
  if (appId === 'canvas') { const board = [...(data.boards || [])].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0]; return board ? <div className="app-widget-board"><BoardPicture board={board} /><WidgetAction className="app-widget-footer-action" onClick={() => onOpen({ boardId: board.id })}>{board.title}<ArrowRight size={14} /></WidgetAction></div> : empty(tr('整理一个新想法'), () => onOpen(), tr('新建导图')); }
  if (['images', 'pdf', 'media'].includes(appId)) {
    const record = [...(data.outputs || [])].sort((a, b) => b.createdAt - a.createdAt)[0];
    return <div className="app-widget-file-tool">{record ? <><div className="app-widget-file-preview">{appId === 'images' ? <CachedPicture blob={record.blob} name={record.name} /> : <FileText size={25} />}<strong>{record.name}</strong></div><div className="app-widget-file-actions"><WidgetAction onClick={() => onOpen()}>{tr('打开工具')}<ArrowRight size={14} /></WidgetAction><WidgetAction className="app-widget-icon-action" aria-label={tr('下载：{0}', [record.name])} onClick={() => downloadBlob(record.blob, record.name)}><DownloadSimple size={16} /></WidgetAction></div></> : appId === 'media' ? <div className="app-widget-tool-grid"><WidgetAction onClick={() => onOpen({ kind: 'audio' })}>{tr('音频剪辑')}</WidgetAction><WidgetAction onClick={() => onOpen({ kind: 'video' })}>{tr('视频剪辑')}</WidgetAction></div> : empty(appId === 'images' ? tr('压缩、裁剪与转换') : tr('合并、提取与排序'), () => onOpen(), appId === 'images' ? tr('处理图片') : tr('整理 PDF'))}</div>;
  }
  if (appId === 'ledger') {
    const currency = data.accounts?.[0]?.currency || 'CNY'; let total = { expense: 0, income: 0 }; try { total = ledgerSummary(data, dateKey().slice(0, 7), currency); } catch { /* Invalid data is handled by the owning app. */ }
    return <div className="app-widget-ledger"><small>{tr('本月支出')}</small><strong>{money(total.expense, currency)}<small>{currency}</small></strong><span>{tr('收入')} {money(total.income, currency)}</span><WidgetAction className="app-widget-footer-action" onClick={() => onOpen()}>{tr('查看流水')}<ArrowRight size={14} /></WidgetAction></div>;
  }
  if (appId === 'travel') {
    const today = dateKey(), upcoming = (data.trips || []).flatMap((trip) => (trip.items || []).map((item) => ({ trip, item }))).filter(({ item }) => item.date >= today).sort((a, b) => `${a.item.date}${a.item.time}`.localeCompare(`${b.item.date}${b.item.time}`))[0], trip = upcoming?.trip || data.trips?.[0];
    return trip ? <div className="app-widget-itinerary"><small>{trip.title}</small><WidgetAction onClick={() => onOpen({ tripId: trip.id, itemId: upcoming?.item.id })}><strong>{upcoming?.item.title || trip.title}</strong><span>{upcoming ? `${upcoming.item.date} ${upcoming.item.time}` : trip.startDate}</span>{upcoming?.item.address && <small>{upcoming.item.address}</small>}</WidgetAction></div> : empty(tr('下一次去哪里？'), () => onOpen(), tr('规划行程'));
  }
  if (appId === 'meals') { const mealOrder = ['breakfast', 'lunch', 'dinner', 'snack'], rows = (data.plan || []).filter((item) => item.date === dateKey()).sort((a, b) => mealOrder.indexOf(a.meal) - mealOrder.indexOf(b.meal)); return <div className="app-widget-meals"><div className="app-widget-list">{rows.length ? rows.slice(0, 4).map((item) => <WidgetAction key={item.id} className="app-widget-meal-row" onClick={() => onOpen({ view: 'plan' })}><small>{tr(({ breakfast: '早餐', lunch: '午餐', dinner: '晚餐', snack: '加餐' })[item.meal])}</small><strong>{data.recipes?.find((recipe) => recipe.id === item.recipeId)?.title}</strong></WidgetAction>) : <span className="app-widget-hint">{tr('安排今天的餐单')}</span>}</div><WidgetAction className="app-widget-footer-action" onClick={() => onOpen({ view: 'shopping' })}>{tr('购物清单')}<ArrowRight size={14} /></WidgetAction></div>; }
  if (appId === 'orders') { const rows = [...(data.items || [])].sort((a, b) => Number(b.status === 'shipping') - Number(a.status === 'shipping') || String(a.returnBy || '9999').localeCompare(String(b.returnBy || '9999'))); return rows.length ? <div className="app-widget-list">{rows.slice(0, 5).map((item) => <WidgetAction className="app-widget-order-row" key={item.id} onClick={() => onOpen({ itemId: item.id })}><strong>{item.title}</strong><small>{tr(({ shipping: '在途', ordered: '已下单', received: '已收货', returned: '已退货' })[item.status])}</small></WidgetAction>)}</div> : empty(tr('收好订单与凭证'), () => onOpen(), tr('添加物品')); }
  if (appId === 'sports') { const rows = [...(data.events || [])].sort((a, b) => { const nextA = sportsEventPhase(a) === 'upcoming', nextB = sportsEventPhase(b) === 'upcoming'; return Number(nextB) - Number(nextA) || (nextA ? 1 : -1) * `${a.date}${a.time || ''}`.localeCompare(`${b.date}${b.time || ''}`); }); return rows.length ? <div className="app-widget-list">{rows.slice(0, 3).map((item) => <WidgetAction className="app-widget-match" key={item.id} onClick={() => onOpen({ eventId: item.id })}><small>{item.date} {item.time}</small><strong>{item.home}<b>{item.homeScore === null ? '—' : item.homeScore}</b></strong><strong>{item.away}<b>{item.awayScore === null ? '—' : item.awayScore}</b></strong></WidgetAction>)}</div> : empty(tr('关注下一场比赛'), () => onOpen(), tr('查看赛程')); }
  return <WidgetAction className="app-widget-primary" onClick={() => onOpen()}>{tr('打开工具')}<ArrowSquareOut size={14} /></WidgetAction>;
}
