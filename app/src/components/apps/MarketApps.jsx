import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { tr, getLocale, formatNumber } from '../../i18n/index.js';
import { useAppData, useAppAction, Field, AppError, downloadBlob, Button, Input, Select } from './shared.jsx';
import PromptDialog from '../PromptDialog.jsx';
import { Dialog as DialogRoot, DialogContent, DialogTitle } from '../ui/dialog.jsx';
import { DialogSurface, useFloatingContainer } from '../DialogSurface.jsx';
import { Disclosure } from '../ui/disclosure.jsx';
import { Plus, X, MagnifyingGlass, GearSix, DotsThree, ArrowsLeftRight, ArrowLeft, CaretLeft, CaretRight, PencilSimple, Trash, ArrowClockwise, Package, FileText, ShieldCheck, Truck, Wallet, Receipt, Trophy } from '@phosphor-icons/react';
import { requestAppAccess, fetchAppJSON } from '../../lib/app-network.js';
import {
  COMMON_CURRENCIES, MARKET_DEFAULTS, localISODate, validISODate, currencyCode, currencyDigits,
  parseMoney, minorToDecimal, convertCurrencyAmount, normalizeExchangeRates, exchangeRateURL, exchangeCacheState,
  stockSymbol, stockURL, stockCacheKey, normalizeStockQuote, normalizeStockSeries, chartPolyline, trimStockCache, publicStockInstrument, stockWebURL, effectiveStockProvider,
  ledgerSummary, validateTransaction, postDueBills, deadlineDays, trackingURL, normalizeTracking,
  sportsURL, normalizeSportsEvents, normalizeSportsTable, sportsEventDate, sportsEventPhase, selectSportsEvents, sportsProvider, openLigaSeason, openLigaURL, openLigaTableKey, normalizeOpenLigaTeams, normalizeOpenLigaEvents, normalizeOpenLigaTable, OFFICIAL_CARRIERS, officialTrackingURL,
} from '../../lib/market-apps.js';
import './market-apps.css';

const uid = () => crypto.randomUUID();
const options = (rows) => rows.map(([value, label]) => ({ value, label }));
const errorText = (error) => error?.message || tr('操作失败，请重试。');
const money = (minor, code) => `${minorToDecimal(minor, code)} ${code}`;
const stamp = (value) => value ? new Date(value).toLocaleString(getLocale()) : '—';
const n = (value, digits = 4) => Number.isFinite(value) ? formatNumber(value, { maximumFractionDigits: digits }) : '—';
function useSignals(props, dirty, busy) {
  useEffect(() => { props.onDirtyChange?.(dirty); return () => props.onDirtyChange?.(false); }, [dirty, props.onDirtyChange]);
  useEffect(() => { props.onBusyChange?.(busy); return () => props.onBusyChange?.(false); }, [busy, props.onBusyChange]);
}
function useRequest() {
  const active = useRef(null);
  useEffect(() => () => active.current?.abort(), []);
  const start = () => { active.current?.abort(); active.current = new AbortController(); return active.current.signal; };
  start.cancel = () => active.current?.abort();
  return start;
}
function ErrorNotice({ store, action }) { return <AppError message={store.error || action.error} onClose={() => action.setError('')} />; }
function Pending({ loading, children }) { return loading ? <p className="app-muted" role="status">{tr('正在读取…')}</p> : children; }
function Action({ children, onClick, disabled, primary = false, ...rest }) { return <Button type="button" variant={primary ? 'default' : 'secondary'} disabled={disabled} onClick={onClick} {...rest}>{children}</Button>; }
function IconAction({ label, children, className = '', ...props }) { return <Button type="button" variant="ghost" className={`market-icon-action ${className}`} aria-label={label} title={label} {...props}>{children}</Button>; }
const SheetClose = createContext(null);
function MarketSheet({ title, children, onClose, dirty = false, busy = false, message, onDismissError, compact = false }) {
  const surface = useFloatingContainer(), [content, setContent] = useState(null), [discard, setDiscard] = useState(false), opener = useRef(globalThis.document?.activeElement);
  const close = () => { if (busy) return; if (dirty) setDiscard(true); else onClose(); };
  return surface && <DialogRoot open onOpenChange={(open) => { if (!open) close(); }}><DialogContent ref={setContent} container={surface} className={`market-sheet ${compact ? 'market-sheet-compact' : ''}`} overlayClassName="market-sheet-overlay" aria-describedby={undefined}
    onKeyDown={(event) => event.stopPropagation()} onEscapeKeyDown={(event) => { event.stopPropagation(); if (busy || dirty) { event.preventDefault(); close(); } }} onInteractOutside={(event) => { event.preventDefault(); close(); }}
    onCloseAutoFocus={(event) => { event.preventDefault(); requestAnimationFrame(() => { if (opener.current?.isConnected && !opener.current.matches(':disabled')) opener.current.focus({ preventScroll: true }); }); }}>
    <DialogSurface.Provider value={content}><header className="market-sheet-heading"><DialogTitle>{title}</DialogTitle><IconAction label={tr('关闭面板')} disabled={busy} onClick={close}><X size={20} /></IconAction></header>
      <SheetClose.Provider value={close}><div className="market-sheet-body">{children}</div></SheetClose.Provider><AppError message={message} onClose={onDismissError} />
      {discard && <PromptDialog privacySafe action={tr('放弃修改')} onCancel={() => setDiscard(false)} onConfirm={onClose}>{tr('当前内容尚未保存，放弃修改？')}</PromptDialog>}
    </DialogSurface.Provider></DialogContent></DialogRoot>;
}
function SheetFooter({ busy, onCancel, submitLabel = tr('保存'), disabled = false }) { const close = useContext(SheetClose); return <footer className="market-sheet-footer"><Action disabled={busy} onClick={close || onCancel}>{tr('取消')}</Action><Button type="submit" disabled={busy || disabled}>{submitLabel}</Button></footer>; }
function QuietEmpty({ icon: Icon = Package, title, children, action }) { return <div className="market-empty"><Icon size={38} weight="light" /><strong>{title}</strong>{children && <p>{children}</p>}{action}</div>; }
function groupedBy(rows, key) { const groups = new Map(); for (const row of rows) { const value = key(row); if (!groups.has(value)) groups.set(value, []); groups.get(value).push(row); } return [...groups]; }
function CurrencySelect({ label, value, onChange, codes = COMMON_CURRENCIES, disabled }) {
  const names = useMemo(() => { try { return new Intl.DisplayNames([getLocale()], { type: 'currency' }); } catch { return null; } }, [getLocale()]);
  return <Select label={label} value={value} onChange={onChange} disabled={disabled} options={[...new Set([...codes, value])].sort().map((code) => ({ value: code, label: `${code} · ${names?.of(code) || code}` }))} />;
}
function ExportButton({ value, name, busy }) { return <Action disabled={busy} onClick={() => downloadBlob(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }), name)}>{tr('导出')}</Action>; }

export function CurrencyApp(props) {
  const store = useAppData('currency', MARKET_DEFAULTS.currency), { data, update, loading } = store, action = useAppAction(), start = useRequest();
  const [base, setBase] = useState('USD'), [target, setTarget] = useState('CNY'), [amount, setAmount] = useState('1'), [historical, setHistorical] = useState(''), [extra, setExtra] = useState('CAD'), [adding, setAdding] = useState(false);
  const initialized = useRef(false);
  useEffect(() => { if (!loading && !initialized.current) { initialized.current = true; setBase(data.base); setTarget(data.target); setAmount(data.amount || '1'); setHistorical(data.rateDate || ''); } }, [loading, data]);
  useSignals(props, false, action.busy);
  const cache = data.cache, codes = [...new Set([...COMMON_CURRENCIES, ...Object.keys(cache?.rates || {}), ...(data.favorites || []), ...(Intl.supportedValuesOf?.('currency') || [])])];
  const targets = [...new Set([target, ...(data.favorites || [])])];
  function conversion(code) {
    if (base === code) { try { return convertCurrencyAmount(amount, '1', '1', currencyDigits(code)); } catch { return '—'; } }
    if (!cache?.rates?.[base] || !cache.rates[code]) return '—';
    try { return convertCurrencyAmount(amount, cache.rates[base], cache.rates[code], currencyDigits(code)); } catch { return '—'; }
  }
  function refresh() {
    let url; try { url = exchangeRateURL([base, ...targets], historical); } catch (reason) { action.setError(errorText(reason)); return; }
    const access = requestAppAccess(url), signal = start();
    action.run(async () => {
      await access;
      const result = normalizeExchangeRates(await fetchAppJSON(url, { signal }), 'USD');
      if (!result.rates[base] || targets.some((code) => code !== 'USD' && !result.rates[code])) throw Error(tr('部分货币暂无可用汇率，已保留原有数据。'));
      signal.throwIfAborted();
      await update((current) => ({ ...current, base, target, amount, rateDate: historical, cache: result }));
    });
  }
  function rememberBase(nextBase, nextTarget = target) {
    try { convertCurrencyAmount(amount, '1', '1'); } catch (reason) { action.setError(errorText(reason)); return; }
    setBase(nextBase); setTarget(nextTarget);
    action.run(() => update((current) => ({ ...current, base: nextBase, target: nextTarget, amount })));
  }
  return <div className="app-workspace market-app market-currency">{!adding && <ErrorNotice store={store} action={action} />}<Pending loading={loading}>
    <section className="market-currency-pair">
      <div className="market-currency-line"><CurrencySelect label={tr('原币种')} value={base} codes={codes} disabled={action.busy} onChange={(value) => rememberBase(value)} /><Field label={tr('金额')}><Input className="market-amount-input" aria-label={tr('金额')} inputMode="decimal" value={amount} maxLength={30} disabled={action.busy} onChange={(event) => setAmount(event.target.value)} onBlur={() => { if (amount !== data.amount) { try { convertCurrencyAmount(amount, '1', '1'); update((current) => ({ ...current, amount })).catch((reason) => action.setError(errorText(reason))); } catch (reason) { action.setError(errorText(reason)); } } }} /></Field></div>
      <div className="market-swap-line"><span /><IconAction label={tr('交换货币')} disabled={action.busy} onClick={() => rememberBase(target, base)}><ArrowsLeftRight size={20} /></IconAction><span /></div>
      <div className="market-currency-line"><CurrencySelect label={tr('目标币种')} value={target} codes={codes} disabled={action.busy} onChange={(value) => rememberBase(base, value)} /><output className="market-conversion-result" aria-live="polite">{conversion(target)}</output></div>
    </section>
    <div className="market-currency-status"><small className="app-muted">{cache ? `${cache.source} · ${cache.date}` : tr('更新汇率后即可计算')}{historical && ` · ${tr('历史汇率')}`}</small><Action disabled={action.busy || loading} onClick={refresh}><ArrowClockwise size={15} className={action.busy ? 'market-spin' : ''} />{action.busy ? tr('正在更新…') : tr('更新汇率')}</Action>{action.busy && <Action onClick={start.cancel}>{tr('取消')}</Action>}</div>
    {!historical && exchangeCacheState(cache, [base, ...targets]) === 'stale' && <p className="app-muted">{tr('当前使用较早的汇率，可更新后再计算。')}</p>}
    <section className="market-favorites"><header className="market-section-heading"><h3>{tr('常用货币')}</h3><IconAction label={tr('添加常用货币')} disabled={action.busy} onClick={() => setAdding(true)}><Plus size={18} /></IconAction></header>
      {targets.filter((code) => code !== target && code !== base).map((code) => <div className="market-favorite-row" key={code}><Button type="button" variant="ghost" className="market-favorite-select" disabled={action.busy} onClick={() => rememberBase(base, code)}><strong>{code}</strong><span>{conversion(code)}</span></Button><IconAction label={tr('移除 {0}', [code])} disabled={action.busy} onClick={() => action.run(() => update((current) => ({ ...current, favorites: current.favorites.filter((value) => value !== code) })))}><X size={14} /></IconAction></div>)}
    </section>
    <Disclosure title={tr('历史汇率与来源')} className="market-currency-options"><Field label={tr('汇率日期')}><Input type="date" value={historical} max={localISODate()} disabled={action.busy} onChange={(event) => setHistorical(event.target.value)} /></Field>{historical && <Action disabled={action.busy} onClick={() => setHistorical('')}>{tr('使用最新汇率')}</Action>}{cache && <p className="app-muted">{tr('获取时间：{0}', [stamp(cache.fetchedAt)])}</p>}<p className="app-muted">{tr('参考汇率按日更新，实际兑换金额以交易机构为准。')}</p></Disclosure>
    {adding && <MarketSheet compact title={tr('添加常用货币')} onClose={() => setAdding(false)} busy={action.busy} message={store.error || action.error} onDismissError={() => action.setError('')}><form className="market-editor" onSubmit={(event) => { event.preventDefault(); action.run(async () => { const code = currencyCode(extra); await update((current) => { if (current.favorites.length >= 20 && !current.favorites.includes(code)) throw Error(tr('常用货币数量已达上限。')); return { ...current, favorites: [...new Set([...current.favorites, code])] }; }); setAdding(false); }); }}><fieldset disabled={action.busy}><CurrencySelect label={tr('货币')} codes={codes} value={extra} onChange={setExtra} /></fieldset><SheetFooter busy={action.busy} onCancel={() => setAdding(false)} submitLabel={tr('添加')} /></form></MarketSheet>}
  </Pending></div>;
}

export function StocksApp(props) {
  const store = useAppData('stocks', MARKET_DEFAULTS.stocks), { data, update, loading } = store, action = useAppAction(), start = useRequest();
  const [listId, setListId] = useState(''), [listName, setListName] = useState(''), [symbolDraft, setSymbolDraft] = useState(''), [exchange, setExchange] = useState(''), [name, setName] = useState('');
  const [selected, setSelected] = useState(''), [period, setPeriod] = useState(30), [settings, setSettings] = useState(null), [remove, setRemove] = useState(null);
  const [panel, setPanel] = useState(null), [query, setQuery] = useState(''), [arranging, setArranging] = useState(false), [detailOpen, setDetailOpen] = useState(false);
  const contextConsumed = useRef(false);
  useEffect(() => { if (!store.loaded || contextConsumed.current) return; contextConsumed.current = true; const row = data.symbols.find((item) => item.id === props.initialContext?.symbolId); if (row) { setListId(row.listId); setSelected(row.id); setDetailOpen(true); } }, [store.loaded, data.symbols, props.initialContext]);
  const currentList = data.lists.find((row) => row.id === listId) || data.lists.find((row) => row.id === data.selectedList) || data.lists[0];
  const symbols = data.symbols.filter((row) => row.listId === currentList?.id), selectedSymbol = symbols.find((row) => row.id === selected) || symbols[0];
  const cacheKey = selectedSymbol ? stockCacheKey(data.settings.provider, selectedSymbol.symbol, selectedSymbol.exchange) : '';
  const quote = data.quotes[cacheKey], points = (data.series[cacheKey] || []).slice(-period);
  const provider = effectiveStockProvider(data.settings), publicInstrument = selectedSymbol && provider === 'public' ? publicStockInstrument(selectedSymbol.symbol, selectedSymbol.exchange) : null, externalQuote = provider === 'public' && !publicInstrument;
  const settingsBaseline = useRef(''), settingsDirty = settings !== null && JSON.stringify(settings) !== settingsBaseline.current;
  function editSettings() { const value = { ...data.settings, provider: effectiveStockProvider(data.settings) }; settingsBaseline.current = JSON.stringify(value); setSettings(value); setPanel('settings'); }
  const panelDirty = Boolean(panel === 'symbol' && (symbolDraft || name || exchange) || panel === 'list' && listName || panel === 'settings' && settingsDirty);
  useSignals(props, panelDirty, action.busy);
  function closePanel() { setPanel(null); setSymbolDraft(''); setName(''); setExchange(''); setListName(''); setSettings(null); }
  function selectList(id) {
    setListId(id);
    action.run(() => update((current) => {
      if (!current.lists.some((row) => row.id === id)) throw Error(tr('自选列表已被移除。'));
      return { ...current, selectedList: id };
    }));
  }
  function refresh() {
    if (!selectedSymbol) return;
    if (externalQuote) { window.open(stockWebURL(selectedSymbol.symbol), '_blank', 'noopener,noreferrer'); return; }
    const config = data.settings, target = { ...selectedSymbol };
    let quoteURL, seriesURL;
    try {
      const params = provider === 'alpha' ? { symbol: target.symbol } : { symbol: target.symbol, exchange: target.exchange };
      quoteURL = stockURL(provider, 'quote', params, config.apiKey);
      seriesURL = stockURL(provider, 'series', { ...params, ...(provider === 'twelve' ? { interval: '1day', outputsize: '366' } : { outputsize: 'compact' }) }, config.apiKey);
    } catch (reason) { action.setError(errorText(reason)); return; }
    const access = requestAppAccess(quoteURL), signal = start();
    action.run(async () => {
      await access;
      const nextQuote = normalizeStockQuote(await fetchAppJSON(quoteURL, { signal }), provider, target.symbol);
      // Quote and chart are independent: a chart limitation must not discard a valid quote.
      let nextSeries, chartError;
      try { nextSeries = normalizeStockSeries(await fetchAppJSON(seriesURL, { signal }), provider); } catch (reason) { if (signal.aborted) throw reason; chartError = reason; }
      signal.throwIfAborted();
      await update((current) => {
        if (!current.symbols.some((row) => row.id === target.id) || current.settings.provider !== config.provider || current.settings.apiKey !== config.apiKey) throw Error(tr('自选或数据源已变更，请重新更新。'));
        return { ...current, ...trimStockCache(current, cacheKey, nextQuote, nextSeries) };
      });
      if (chartError) action.setError(tr('行情已更新，走势图暂不可用。'));
    });
  }
  async function addSymbol() {
    const code = stockSymbol(symbolDraft), market = exchange.trim().slice(0, 40), label = name.trim().slice(0, 100), id = uid();
    await update((current) => {
      if (!current.lists.some((row) => row.id === currentList.id)) throw Error(tr('自选列表已被移除。'));
      if (current.symbols.length >= 200) throw Error(tr('自选数量已达上限。'));
      if (current.symbols.some((row) => row.listId === currentList.id && row.symbol === code && row.exchange === market)) throw Error(tr('该标的已在列表中。'));
      return { ...current, symbols: [...current.symbols, { id, listId: currentList.id, symbol: code, exchange: market, name: label }] };
    }); setSelected(id); setDetailOpen(true); closePanel();
  }
  function moveSymbol(id, direction) {
    action.run(() => update((current) => {
      const ids = current.symbols.map((row, index) => row.listId === currentList.id ? index : -1).filter((value) => value >= 0), at = ids.findIndex((index) => current.symbols[index].id === id), target = at + direction;
      if (at < 0 || target < 0 || target >= ids.length) return current;
      const next = [...current.symbols]; [next[ids[at]], next[ids[target]]] = [next[ids[target]], next[ids[at]]]; return { ...current, symbols: next };
    }));
  }
  function deleteSelection() {
    action.run(async () => { await update((current) => {
      if (!remove.list) return { ...current, symbols: current.symbols.filter((row) => row.id !== remove.symbol.id) };
      const lists = current.lists.filter((row) => row.id !== remove.list.id);
      if (!lists.length) return current;
      return { ...current, lists, selectedList: lists.some((row) => row.id === current.selectedList) ? current.selectedList : lists[0].id, symbols: current.symbols.filter((row) => row.listId !== remove.list.id) };
    }); setRemove(null); if (remove.list) closePanel(); });
  }
  return <div className={`app-workspace market-app market-stocks ${data.settings.colors}`}><Pending loading={loading}>
    <div className={`market-stocks-layout market-master-detail ${detailOpen ? 'market-detail-open' : ''}`}>
      <aside className="market-sidebar market-stock-sidebar">
        <header className="market-sidebar-heading"><Select label={tr('自选列表')} value={currentList?.id} options={data.lists.map((row) => ({ value: row.id, label: row.name || tr('我的自选') }))} disabled={action.busy} onChange={selectList} /><IconAction label={tr('管理自选列表')} disabled={action.busy} onClick={() => setPanel('list')}><DotsThree size={23} /></IconAction></header>
        <div className="market-search"><MagnifyingGlass size={17} /><Input aria-label={tr('搜索自选')} placeholder={tr('搜索自选')} value={query} onChange={(event) => setQuery(event.target.value)} /></div>
        <div className="market-sidebar-tools"><Action disabled={action.busy} onClick={() => setPanel('symbol')}><Plus size={16} />{tr('加入自选')}</Action><Action disabled={action.busy} aria-pressed={arranging} onClick={() => setArranging(!arranging)}>{arranging ? tr('完成') : tr('整理')}</Action></div>
        <div className="market-sidebar-scroll">{symbols.filter((row) => `${row.name} ${row.symbol} ${row.exchange}`.toLowerCase().includes(query.toLowerCase())).map((row) => {
          const saved = data.quotes[stockCacheKey(data.settings.provider, row.symbol, row.exchange)], index = symbols.findIndex((item) => item.id === row.id);
          return <div className="market-stock-row" key={row.id}><Button type="button" variant="ghost" aria-pressed={selectedSymbol?.id === row.id} onClick={() => { setSelected(row.id); setDetailOpen(true); }}><span><strong>{row.name || saved?.name || row.symbol}</strong><small>{row.symbol}{row.exchange ? ` · ${row.exchange}` : ''}</small></span><span><strong>{saved ? n(saved.price) : '—'}</strong><small className={saved?.percent == null ? '' : saved.percent >= 0 ? 'market-up' : 'market-down'}>{saved?.percent != null ? `${saved.percent > 0 ? '+' : ''}${n(saved.percent, 2)}%` : '—'}</small></span></Button>{arranging && <div className="market-row-actions"><IconAction label={tr('上移 {0}', [row.symbol])} disabled={action.busy || !index} onClick={() => moveSymbol(row.id, -1)}>↑</IconAction><IconAction label={tr('下移 {0}', [row.symbol])} disabled={action.busy || index === symbols.length - 1} onClick={() => moveSymbol(row.id, 1)}>↓</IconAction><IconAction label={tr('移除 {0}', [row.symbol])} disabled={action.busy} onClick={() => setRemove({ symbol: row })}><Trash size={15} /></IconAction></div>}</div>;
        })}{!symbols.length && <QuietEmpty icon={Plus} title={tr('建立你的自选')} action={<Action onClick={() => setPanel('symbol')}>{tr('加入自选')}</Action>} />}</div>
        <footer className="market-sidebar-footer"><Action disabled={action.busy} onClick={editSettings}><GearSix size={17} />{tr('数据源与显示')}</Action></footer>
      </aside>
      <section className="market-detail market-quote">{selectedSymbol ? <>
        <header className="market-detail-heading"><IconAction className="market-mobile-back" label={tr('返回自选')} onClick={() => setDetailOpen(false)}><ArrowLeft size={19} /></IconAction><div><h2>{selectedSymbol.name || quote?.name || selectedSymbol.symbol}</h2><small className="app-muted">{selectedSymbol.symbol}{selectedSymbol.exchange ? ` · ${selectedSymbol.exchange}` : ''}</small></div><div className="market-heading-actions"><Action primary disabled={action.busy} onClick={refresh}><ArrowClockwise size={16} className={action.busy ? 'market-spin' : ''} />{action.busy ? tr('正在更新…') : externalQuote ? tr('查看行情') : tr('更新行情')}</Action>{action.busy && <Action onClick={start.cancel}>{tr('取消')}</Action>}</div></header>
        <div className="market-quote-value"><strong className="market-price">{quote ? n(quote.price, 6) : '—'} <small>{quote?.currency || ''}</small></strong><span className={quote?.change == null ? 'app-muted' : quote.change >= 0 ? 'market-up' : 'market-down'}>{quote?.change != null ? `${quote.change > 0 ? '+' : ''}${n(quote.change)}` : '—'}{quote?.percent != null ? ` (${quote.percent > 0 ? '+' : ''}${n(quote.percent, 2)}%)` : ''}</span></div>
        <div className="market-periods" role="group" aria-label={tr('走势范围')}>{[[30, tr('近一月')], [90, tr('近三月')], [366, tr('近一年')]].map(([value, label]) => <Action key={value} aria-pressed={period === value} onClick={() => setPeriod(value)}>{label}</Action>)}</div>
        <div className="market-chart-area">{points.length ? <><svg className="market-chart" viewBox="0 0 600 170" role="img" aria-label={tr('{0} 走势，{1} 至 {2}', [selectedSymbol.symbol, points[0].date, points.at(-1).date])}><polyline fill="none" stroke="currentColor" strokeWidth="2.5" points={chartPolyline(points)} /></svg><div className="market-chart-dates"><small>{points[0].date}</small><small>{points.at(-1).date}</small></div></> : <QuietEmpty icon={ArrowClockwise} title={tr('暂无走势图')}><span>{externalQuote ? tr('此市场可直接打开行情网站查看。') : tr('更新行情后查看。')}</span></QuietEmpty>}</div>
        {quote && <><div className="market-metrics">{[[tr('开盘'), quote.open], [tr('最高'), quote.high], [tr('最低'), quote.low], [tr('前收'), quote.previous], [tr('成交量'), quote.volume]].map(([label, value]) => <div key={label}><small>{label}</small><strong>{n(value)}</strong></div>)}</div><p className="market-source app-muted">{quote.source} · {quote.date || stamp(quote.fetchedAt)} · {({ realtime: tr('实时'), delayed: tr('延迟'), eod: tr('日终'), unknown: tr('时效以数据源为准') })[provider === 'public' ? 'delayed' : data.settings.delay]}{quote.marketOpen !== null ? ` · ${quote.marketOpen ? tr('交易中') : tr('休市')}` : ''}</p></>}
      </> : <QuietEmpty icon={Plus} title={tr('从自选列表开始')} action={<Action primary onClick={() => setPanel('symbol')}>{tr('加入自选')}</Action>} />}</section>
    </div>
    {panel && <MarketSheet title={panel === 'symbol' ? tr('加入自选') : panel === 'list' ? tr('管理自选列表') : tr('数据源与显示')} onClose={closePanel} dirty={panelDirty} busy={action.busy} message={store.error || action.error} onDismissError={() => action.setError('')}>
      {panel === 'symbol' && <form className="market-editor" onSubmit={(event) => { event.preventDefault(); action.run(addSymbol); }}><fieldset disabled={action.busy}><Field label={tr('股票代码')}><Input autoFocus placeholder="AAPL / SBER.ME" value={symbolDraft} maxLength={40} onChange={(event) => setSymbolDraft(event.target.value)} /></Field><Field label={tr('名称，可选')}><Input value={name} maxLength={100} onChange={(event) => setName(event.target.value)} /></Field><Disclosure title={tr('指定交易所')}><Field label={tr('交易所，可选')}><Input placeholder="NASDAQ" value={exchange} maxLength={40} onChange={(event) => setExchange(event.target.value)} /></Field></Disclosure></fieldset><SheetFooter busy={action.busy} onCancel={closePanel} submitLabel={tr('加入自选')} disabled={!symbolDraft.trim()} /></form>}
      {panel === 'list' && <form className="market-editor" onSubmit={(event) => { event.preventDefault(); action.run(async () => { if (!listName.trim()) return; const id = uid(); await update((current) => { if (current.lists.length >= 10) throw Error(tr('自选列表数量已达上限。')); return { ...current, selectedList: id, lists: [...current.lists, { id, name: listName.trim().slice(0, 80) }] }; }); setListId(id); closePanel(); }); }}><fieldset disabled={action.busy}><Field label={tr('新列表名称')}><Input value={listName} maxLength={80} onChange={(event) => setListName(event.target.value)} /></Field><Action disabled={!listName.trim() || action.busy} onClick={() => action.run(async () => { await update((current) => ({ ...current, lists: current.lists.map((row) => row.id === currentList.id ? { ...row, name: listName.trim().slice(0, 80) } : row) })); closePanel(); })}>{tr('重命名当前列表')}</Action>{data.lists.length > 1 && <Action disabled={action.busy} onClick={() => setRemove({ list: currentList })}>{tr('删除列表')}</Action>}</fieldset><SheetFooter busy={action.busy} onCancel={closePanel} submitLabel={tr('新建列表')} disabled={!listName.trim()} /></form>}
      {panel === 'settings' && settings && <form className="market-editor" onSubmit={(event) => { event.preventDefault(); action.run(async () => { await update((current) => ({ ...current, settings: { ...settings, apiKey: settings.apiKey.trim() } })); closePanel(); }); }}><fieldset disabled={action.busy}><Select label={tr('行情服务')} value={settings.provider} onChange={(value) => setSettings({ ...settings, provider: value })} options={options([['public', tr('公开行情（免密钥）')], ['twelve', 'Twelve Data'], ['alpha', 'Alpha Vantage']])} />{settings.provider !== 'public' && <Field label="API Key"><Input type="password" autoComplete="off" value={settings.apiKey} maxLength={300} onChange={(event) => setSettings({ ...settings, apiKey: event.target.value })} /></Field>}{settings.provider !== 'public' && <Select label={tr('行情时效')} value={settings.delay} onChange={(value) => setSettings({ ...settings, delay: value })} options={options([['unknown', tr('按数据源授权')], ['realtime', tr('实时')], ['delayed', tr('延迟')], ['eod', tr('日终')]])} />}<Select label={tr('涨跌颜色')} value={settings.colors} onChange={(value) => setSettings({ ...settings, colors: value })} options={options([['red-up', tr('红涨绿跌')], ['green-up', tr('绿涨红跌')]])} />{settings.provider === 'public' ? <p className="app-muted">{tr('MOEX 代码（如 SBER.ME）可获取官方延迟行情，仅供个人参考。其它市场打开行情网站。')}</p> : <p className="app-muted">{tr('使用你有权展示的行情数据。市场覆盖、实时性和请求额度由数据源决定。')}</p>}</fieldset><SheetFooter busy={action.busy} onCancel={closePanel} /></form>}
      {remove && <PromptDialog title={tr('确认删除')} action={tr('删除')} destructive busy={action.busy} onCancel={() => setRemove(null)} onConfirm={() => deleteSelection()}>{tr('删除这个列表及其中的自选标的？')}</PromptDialog>}
    </MarketSheet>}
    {!panel && <><ErrorNotice store={store} action={action} />{remove && <PromptDialog title={tr('确认删除')} action={tr('删除')} destructive busy={action.busy} onCancel={() => setRemove(null)} onConfirm={() => deleteSelection()}>{tr('移除这个自选标的？')}</PromptDialog>}</>}
  </Pending></div>;
}

const blankTransaction = () => ({ accountId: '', kind: 'expense', amount: '', category: '', date: localISODate(), note: '' });
export function LedgerApp(props) {
  const store = useAppData('ledger', MARKET_DEFAULTS.ledger), { data, update, loading } = store, action = useAppAction();
  const [view, setView] = useState('transactions'), [month, setMonth] = useState(localISODate().slice(0, 7)), [currency, setCurrency] = useState('CNY'), [accountId, setAccountId] = useState('');
  const [draft, setDraft] = useState(blankTransaction), [account, setAccount] = useState({ name: '', currency: 'CNY', opening: '0' }), [budget, setBudget] = useState({ category: '', amount: '' });
  const [bill, setBill] = useState({ name: '', accountId: '', amount: '', category: '', nextDate: localISODate(), cadence: 'monthly', kind: 'expense' }), [remove, setRemove] = useState(null), [editor, setEditor] = useState(null), baseline = useRef('');
  const editorValue = { transaction: draft, account, budget, bill }[editor], dirty = Boolean(editor && JSON.stringify(editorValue) !== baseline.current);
  useEffect(() => { if (!loading && accountId && !data.accounts.some((row) => row.id === accountId)) setAccountId(''); }, [loading, data.accounts, accountId]);
  useSignals(props, dirty, action.busy);
  const summary = ledgerSummary(data, month || localISODate().slice(0, 7), currency, view === 'budgets' ? '' : accountId), selectedAccount = data.accounts.find((row) => row.id === (draft.accountId || data.accounts[0]?.id));
  const patch = (value) => setDraft((current) => ({ ...current, ...value }));
  function openEditor(kind, row) {
    const next = kind === 'transaction' ? row ? { ...row, amount: minorToDecimal(row.amount, row.currency) } : { ...blankTransaction(), accountId: accountId || data.accounts.find((item) => item.currency === currency)?.id || data.accounts[0]?.id || '' }
      : kind === 'account' ? { name: '', currency, opening: '0' }
        : kind === 'budget' ? { category: row?.category || '', amount: row ? minorToDecimal(row.amount, row.currency) : '' }
          : { name: '', accountId: accountId || data.accounts[0]?.id || '', amount: '', category: '', nextDate: localISODate(), cadence: 'monthly', kind: 'expense' };
    ({ transaction: setDraft, account: setAccount, budget: setBudget, bill: setBill })[kind](next); baseline.current = JSON.stringify(next); setEditor(kind);
  }
  function closeEditor() { setEditor(null); }
  async function saveTransaction() {
    const value = validateTransaction({ ...draft, accountId: draft.accountId || data.accounts[0]?.id }, data.accounts);
    await update((current) => {
      if (!current.accounts.some((row) => row.id === value.accountId && row.currency === value.currency)) throw Error(tr('账户已变更，请重新选择。'));
      if (current.transactions.length >= 10000 && !draft.id) throw Error(tr('账本记录过多，请先导出归档。'));
      const previous = current.transactions.find((row) => row.id === draft.id);
      if (draft.id && (!previous || previous.updatedAt !== draft.updatedAt)) throw Error(tr('这条记录已在其他页面更新，请重新打开。'));
      return { ...current, transactions: draft.id ? current.transactions.map((row) => row.id === draft.id ? { ...value, id: row.id, updatedAt: Date.now() } : row) : [...current.transactions, { ...value, id: uid(), updatedAt: Date.now() }] };
    }); closeEditor();
  }
  async function saveEditor() {
    if (editor === 'transaction') return saveTransaction();
    if (editor === 'account') {
      const name = account.name.trim(); if (!name) throw Error(tr('请填写账户名称。')); const opening = parseMoney(account.opening, account.currency);
      await update((current) => { if (current.accounts.length >= 30) throw Error(tr('账户数量已达上限。')); return { ...current, accounts: [...current.accounts, { id: uid(), name, currency: account.currency, opening }] }; });
    } else if (editor === 'budget') {
      const amount = parseMoney(budget.amount, currency), category = budget.category.trim(); if (amount <= 0 || !category || !/^\d{4}-\d{2}$/.test(month)) throw Error(tr('请填写分类和大于零的预算。'));
      await update((current) => ({ ...current, budgets: [...current.budgets.filter((row) => !(row.month === month && row.currency === currency && row.category === category)), { id: uid(), month, currency, category, amount }] }));
    } else {
      const transaction = validateTransaction({ ...bill, date: bill.nextDate, accountId: bill.accountId || data.accounts[0]?.id }, data.accounts); if (!bill.name.trim()) throw Error(tr('请填写账单名称。'));
      await update((current) => ({ ...current, bills: [...current.bills, { ...transaction, id: uid(), name: bill.name.trim().slice(0, 100), nextDate: bill.nextDate, cadence: bill.cadence }] }));
    }
    closeEditor();
  }
  const names = { transactions: tr('收支'), accounts: tr('账户'), budgets: tr('预算'), bills: tr('周期账单') }, editorNames = { transaction: draft.id ? tr('编辑记录') : tr('记一笔'), account: tr('添加账户'), budget: tr('保存预算'), bill: tr('添加账单') };
  const categories = [...new Set(data.transactions.filter((row) => row.kind === draft.kind).map((row) => row.category))].slice(-8);
  return <div className="app-workspace market-app market-ledger"><Pending loading={loading}>
    <div className="market-ledger-layout"><aside className="market-sidebar market-ledger-sidebar"><nav className="market-view-nav" aria-label={tr('账本')}>
      {Object.entries(names).map(([id, label]) => <Button type="button" variant="ghost" key={id} aria-pressed={view === id} onClick={() => setView(id)}>{id === 'transactions' ? <Receipt size={18} /> : id === 'accounts' ? <Wallet size={18} /> : id === 'budgets' ? <Trophy size={18} /> : <ArrowClockwise size={18} />}{label}</Button>)}
    </nav><section className="market-account-filter"><small className="app-muted">{tr('筛选账户')}</small><Button type="button" variant="ghost" aria-pressed={!accountId} onClick={() => { setAccountId(''); setView('transactions'); }}>{tr('全部账户')}</Button>{data.accounts.map((row) => <Button type="button" variant="ghost" key={row.id} aria-pressed={accountId === row.id} onClick={() => { setAccountId(row.id); setCurrency(row.currency); setView('transactions'); }}><span>{row.name}</span><small>{row.currency}</small></Button>)}</section><footer className="market-sidebar-footer"><ExportButton value={data} name="covelet-ledger.json" busy={action.busy} /></footer></aside>
    <main className="market-ledger-main"><header className="market-detail-heading"><h2>{names[view]}</h2><div className="market-heading-actions"><Action primary disabled={action.busy} onClick={() => openEditor(view === 'transactions' ? data.accounts.length ? 'transaction' : 'account' : { accounts: 'account', budgets: 'budget', bills: data.accounts.length ? 'bill' : 'account' }[view])}><Plus size={16} />{view === 'transactions' ? tr('记一笔') : view === 'accounts' ? tr('添加账户') : view === 'budgets' ? tr('保存预算') : tr('添加账单')}</Action></div></header>
      {view !== 'accounts' && <div className="market-ledger-period">{view !== 'bills' && <Field label={tr('月份')}><Input type="month" value={month} onChange={(event) => setMonth(event.target.value)} /></Field>}{view !== 'bills' && <CurrencySelect label={tr('统计货币')} value={currency} onChange={setCurrency} codes={[...COMMON_CURRENCIES, ...data.accounts.map((row) => row.currency)]} />}{view === 'transactions' && <div className="market-mobile-account"><Select label={tr('筛选账户')} value={accountId} onChange={(id) => { setAccountId(id); const account = data.accounts.find((row) => row.id === id); if (account) setCurrency(account.currency); }} options={[{ value: '', label: tr('全部账户') }, ...data.accounts.map((row) => ({ value: row.id, label: row.name }))]} /></div>}</div>}
      {view === 'transactions' && <><div className="market-ledger-overview">{[[tr('收入'), summary.income, 'income'], [tr('支出'), summary.expense, 'expense'], [tr('结余'), summary.balance, 'balance']].map(([label, value, cls]) => <div key={label} className={cls}><small>{label}</small><strong>{money(value, currency)}</strong></div>)}</div>
        {!data.accounts.length ? <QuietEmpty icon={Wallet} title={tr('添加第一个账户')} action={<Action primary onClick={() => openEditor('account')}>{tr('添加账户')}</Action>} /> : !summary.records.length ? <QuietEmpty icon={Receipt} title={tr('这个月还没有收支')} action={<Action onClick={() => openEditor('transaction')}>{tr('记一笔')}</Action>} /> : <div className="market-transactions">{groupedBy([...summary.records].sort((a, b) => b.date.localeCompare(a.date)), (row) => row.date).map(([date, rows]) => <section className="market-transaction-day" key={date}><h3>{date}</h3>{rows.map((row) => <div className="market-transaction-row" key={row.id}><Button type="button" variant="ghost" className="market-transaction-main" disabled={action.busy} onClick={() => openEditor('transaction', row)}><span className={`market-transaction-sign ${row.kind}`}>{row.kind === 'income' ? '+' : '−'}</span><span><strong>{row.category}</strong><small>{data.accounts.find((item) => item.id === row.accountId)?.name}{row.note ? ` · ${row.note}` : ''}</small></span><b className={row.kind}>{row.kind === 'income' ? '+' : '−'}{money(row.amount, row.currency)}</b></Button><IconAction label={tr('删除记录')} disabled={action.busy} onClick={() => setRemove({ kind: 'transactions', id: row.id })}><Trash size={16} /></IconAction></div>)}</section>)}</div>}</>}
      {view === 'accounts' && <div className="market-account-grid">{data.accounts.map((row) => { const balance = data.transactions.filter((item) => item.accountId === row.id).reduce((sum, item) => sum + (item.kind === 'income' ? item.amount : -item.amount), row.opening); return <article className="market-account-card" key={row.id}><header><Wallet size={20} /><strong>{row.name}</strong><IconAction label={tr('删除账户')} disabled={action.busy} onClick={() => setRemove({ kind: 'accounts', id: row.id })}><Trash size={16} /></IconAction></header><small className="app-muted">{tr('账户余额')}</small><b>{money(balance, row.currency)}</b><Action onClick={() => { setAccountId(row.id); setCurrency(row.currency); setView('transactions'); }}>{tr('查看流水')}</Action></article>; })}{!data.accounts.length && <QuietEmpty icon={Wallet} title={tr('添加第一个账户')} action={<Action onClick={() => openEditor('account')}>{tr('添加账户')}</Action>} />}</div>}
      {view === 'budgets' && <div className="market-budget-list">{data.budgets.filter((row) => row.month === month && row.currency === currency).map((row) => { const used = summary.categories[row.category] || 0; return <article className="market-budget" key={row.id}><header><Button type="button" variant="ghost" disabled={action.busy} onClick={() => openEditor('budget', row)}>{row.category}</Button><span>{money(used, currency)} / {money(row.amount, currency)}</span><IconAction label={tr('删除预算')} disabled={action.busy} onClick={() => setRemove({ kind: 'budgets', id: row.id })}><Trash size={16} /></IconAction></header><progress max={row.amount} value={Math.min(used, row.amount)} aria-label={tr('{0}预算使用情况', [row.category])} /><small className={used > row.amount ? 'market-deadline' : 'app-muted'}>{used > row.amount ? tr('超出预算 {0}', [money(used - row.amount, currency)]) : tr('剩余 {0}', [money(row.amount - used, currency)])}</small></article>; })}{!data.budgets.some((row) => row.month === month && row.currency === currency) && <QuietEmpty icon={Wallet} title={tr('为这个月设置预算')} action={<Action onClick={() => openEditor('budget')}>{tr('保存预算')}</Action>} />}</div>}
      {view === 'bills' && <><div className="market-bills-toolbar"><Action primary disabled={action.busy || !data.bills.some((row) => row.nextDate <= localISODate())} onClick={() => action.run(() => update((current) => postDueBills(current).data))}>{tr('将到期账单入账')}</Action><small className="app-muted">{tr('到期账单在你确认后记入账本。')}</small></div><div className="market-bill-list">{[...data.bills].sort((a, b) => a.nextDate.localeCompare(b.nextDate)).map((row) => <article className="market-bill" key={row.id}><span className="market-bill-date">{row.nextDate}</span><div><strong>{row.name}</strong><small>{data.accounts.find((item) => item.id === row.accountId)?.name} · {({ weekly: tr('每周'), monthly: tr('每月'), yearly: tr('每年') })[row.cadence]}</small></div><b>{row.kind === 'income' ? '+' : '−'}{money(row.amount, row.currency)}</b><IconAction label={tr('删除账单')} disabled={action.busy} onClick={() => setRemove({ kind: 'bills', id: row.id })}><Trash size={16} /></IconAction></article>)}</div>{!data.bills.length && <QuietEmpty icon={ArrowClockwise} title={tr('管理固定收支')} action={<Action onClick={() => openEditor(data.accounts.length ? 'bill' : 'account')}>{tr('添加账单')}</Action>} />}</>}
    </main></div>
    {editor && <MarketSheet title={editorNames[editor]} onClose={closeEditor} dirty={dirty} busy={action.busy} message={store.error || action.error} onDismissError={() => action.setError('')}><form className="market-editor" onSubmit={(event) => { event.preventDefault(); action.run(saveEditor); }}><fieldset disabled={action.busy}>
      {editor === 'transaction' && <><div className="market-segments">{[['expense', tr('支出')], ['income', tr('收入')]].map(([kind, label]) => <Action key={kind} aria-pressed={draft.kind === kind} onClick={() => patch({ kind })}>{label}</Action>)}</div><Field label={tr('金额')}><div className="market-ledger-amount"><span>{selectedAccount?.currency || currency}</span><Input autoFocus inputMode="decimal" required value={draft.amount} maxLength={20} onChange={(event) => patch({ amount: event.target.value })} /></div></Field><Field label={tr('分类')}><Input required value={draft.category} maxLength={80} onChange={(event) => patch({ category: event.target.value })} /></Field>{categories.length > 0 && <div className="market-category-chips">{categories.map((category) => <Action key={category} aria-pressed={draft.category === category} onClick={() => patch({ category })}>{category}</Action>)}</div>}<Select label={tr('账户')} value={selectedAccount?.id || ''} onChange={(value) => patch({ accountId: value })} options={data.accounts.map((row) => ({ value: row.id, label: `${row.name} · ${row.currency}` }))} /><Field label={tr('日期')}><Input type="date" required value={draft.date} onChange={(event) => patch({ date: event.target.value })} /></Field><Field label={tr('备注')}><Input value={draft.note} maxLength={2000} onChange={(event) => patch({ note: event.target.value })} /></Field></>}
      {editor === 'account' && <><Field label={tr('账户名称')}><Input autoFocus value={account.name} required maxLength={80} onChange={(event) => setAccount({ ...account, name: event.target.value })} /></Field><CurrencySelect label={tr('货币')} value={account.currency} onChange={(value) => setAccount({ ...account, currency: value })} /><Field label={tr('期初余额')}><Input value={account.opening} inputMode="decimal" maxLength={20} onChange={(event) => setAccount({ ...account, opening: event.target.value })} /></Field></>}
      {editor === 'budget' && <><p className="app-muted">{month} · {currency}</p><Field label={tr('分类')}><Input autoFocus required value={budget.category} maxLength={80} onChange={(event) => setBudget({ ...budget, category: event.target.value })} /></Field><Field label={tr('月预算')}><Input required inputMode="decimal" value={budget.amount} maxLength={20} onChange={(event) => setBudget({ ...budget, amount: event.target.value })} /></Field></>}
      {editor === 'bill' && <><Field label={tr('账单名称')}><Input autoFocus required value={bill.name} maxLength={100} onChange={(event) => setBill({ ...bill, name: event.target.value })} /></Field><Select label={tr('类型')} value={bill.kind} onChange={(value) => setBill({ ...bill, kind: value })} options={options([['expense', tr('支出')], ['income', tr('收入')]])} /><Select label={tr('账户')} value={bill.accountId || data.accounts[0]?.id || ''} onChange={(value) => setBill({ ...bill, accountId: value })} options={data.accounts.map((row) => ({ value: row.id, label: `${row.name} · ${row.currency}` }))} /><Field label={tr('金额')}><Input required inputMode="decimal" value={bill.amount} maxLength={20} onChange={(event) => setBill({ ...bill, amount: event.target.value })} /></Field><Field label={tr('分类')}><Input required value={bill.category} maxLength={80} onChange={(event) => setBill({ ...bill, category: event.target.value })} /></Field><Field label={tr('下次日期')}><Input required type="date" value={bill.nextDate} onChange={(event) => setBill({ ...bill, nextDate: event.target.value })} /></Field><Select label={tr('重复')} value={bill.cadence} onChange={(value) => setBill({ ...bill, cadence: value })} options={options([['weekly', tr('每周')], ['monthly', tr('每月')], ['yearly', tr('每年')]])} /></>}
    </fieldset><SheetFooter busy={action.busy} onCancel={closeEditor} disabled={editor === 'transaction' && (!selectedAccount || !draft.amount)} /></form></MarketSheet>}
    {!editor && <ErrorNotice store={store} action={action} />}
    {remove && <PromptDialog title={tr('确认删除')} action={tr('删除')} destructive busy={action.busy} onCancel={() => setRemove(null)} onConfirm={() => action.run(async () => { await update((current) => { if (remove.kind === 'accounts' && (current.transactions.some((row) => row.accountId === remove.id) || current.bills.some((row) => row.accountId === remove.id))) throw Error(tr('账户仍有流水或周期账单，请先处理关联记录。')); return { ...current, [remove.kind]: current[remove.kind].filter((row) => row.id !== remove.id) }; }); setRemove(null); })}>{tr('删除这条记录？')}</PromptDialog>}
  </Pending></div>;
}

const blankOrder = () => ({ title: '', seller: '', orderNumber: '', boughtOn: localISODate(), status: 'ordered', trackingNumber: '', carrier: '', returnBy: '', warrantyUntil: '', serial: '', note: '', attachments: [] });
export function OrdersApp(props) {
  const store = useAppData('orders', MARKET_DEFAULTS.orders), { data, update, loading } = store, action = useAppAction(), start = useRequest();
  const [draft, setDraft] = useState(blankOrder), [query, setQuery] = useState(''), [editing, setEditing] = useState(false), [dirty, setDirty] = useState(false), [remove, setRemove] = useState(null), [settings, setSettings] = useState(null);
  const [selectedId, setSelectedId] = useState(''), [filter, setFilter] = useState('all'), [detailTab, setDetailTab] = useState('overview'), [detailOpen, setDetailOpen] = useState(false);
  const [customCarrier, setCustomCarrier] = useState(false);
  const contextConsumed = useRef(false);
  useEffect(() => { if (!store.loaded || contextConsumed.current) return; contextConsumed.current = true; const row = data.items.find((item) => item.id === props.initialContext?.itemId); if (row) { setSelectedId(row.id); setFilter('all'); setQuery(''); setDetailTab('overview'); setDetailOpen(true); } }, [store.loaded, data.items, props.initialContext]);
  useSignals(props, dirty || Boolean(settings && JSON.stringify(settings) !== JSON.stringify(data.tracking)), action.busy);
  const patch = (value) => { setDraft((current) => ({ ...current, ...value })); setDirty(true); };
  const records = data.items.filter((row) => `${row.title}\n${row.seller}\n${row.orderNumber}\n${row.trackingNumber}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()) && (filter === 'all' || filter === 'transit' && ['ordered', 'shipping'].includes(row.status) || filter === 'returns' && row.returnBy && deadlineDays(row.returnBy) >= 0 || filter === 'warranty' && row.warrantyUntil && deadlineDays(row.warrantyUntil) >= 0)).sort((a, b) => b.boughtOn.localeCompare(a.boughtOn));
  const selectedItem = records.find((row) => row.id === selectedId) || records[0];
  const carrierLink = selectedItem ? officialTrackingURL(selectedItem.carrier, selectedItem.trackingNumber) : null;
  const statusLabels = { ordered: tr('已下单'), shipping: tr('运输中'), received: tr('已收货'), returned: tr('已退货') };
  function closeEditor() { setEditing(false); setDirty(false); setDraft(blankOrder()); }
  function choose(row) { setDraft(row ? structuredClone(row) : blankOrder()); setCustomCarrier(Boolean(row?.carrier && !OFFICIAL_CARRIERS.includes(row.carrier))); setEditing(true); setDirty(false); }
  async function save() {
    if (!draft.title.trim() || !validISODate(draft.boughtOn) || ['returnBy', 'warrantyUntil'].some((key) => draft[key] && !validISODate(draft[key]))) throw Error(tr('请填写物品名称和有效日期。'));
    const record = { ...draft, id: draft.id || uid(), title: draft.title.trim(), updatedAt: Date.now() };
    await update((current) => {
      const previous = current.items.find((row) => row.id === record.id);
      if (draft.id && (!previous || previous.updatedAt !== draft.updatedAt)) throw Error(tr('物品已在其他页面更新，请重新打开。'));
      if (!draft.id && current.items.length >= 300) throw Error(tr('物品数量已达上限。'));
      return { ...current, items: previous ? current.items.map((row) => row.id === record.id ? record : row) : [...current.items, record] };
    }); setSelectedId(record.id); setFilter('all'); setQuery(''); setDetailOpen(true); closeEditor();
  }
  async function attach(files) {
    const selected = [...files];
    if (selected.some((file) => !['application/pdf', 'image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 2 * 1024 * 1024)) throw Error(tr('收据支持 PDF、PNG、JPEG、WebP，每个文件不超过 2 MB。'));
    const next = [...draft.attachments, ...selected.map((blob) => ({ id: uid(), name: blob.name.slice(0, 200), blob }))];
    const otherBytes = data.items.filter((row) => row.id !== draft.id).flatMap((row) => row.attachments || []).reduce((sum, row) => sum + row.blob.size, 0);
    if (next.length > 4 || otherBytes + next.reduce((sum, row) => sum + row.blob.size, 0) > 8 * 1024 * 1024) throw Error(tr('每件物品最多 4 个收据文件，全部收据合计不超过 8 MB。'));
    patch({ attachments: next });
  }
  function refreshTracking(row) {
    let url; try { url = trackingURL(data.tracking.endpoint, row.trackingNumber); } catch (reason) { action.setError(errorText(reason)); return; }
    const access = requestAppAccess(url), signal = start(), config = { ...data.tracking };
    action.run(async () => {
      await access;
      const tracking = normalizeTracking(await fetchAppJSON(url, { signal, headers: config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {} }));
      signal.throwIfAborted();
      await update((current) => {
        const previous = current.items.find((item) => item.id === row.id);
        if (!previous || previous.trackingNumber !== row.trackingNumber || JSON.stringify(current.tracking) !== JSON.stringify(config)) throw Error(tr('运单或数据源已变更，请重新更新。'));
        return { ...current, items: current.items.map((item) => item.id === row.id ? { ...item, tracking, updatedAt: Date.now() } : item) };
      });
    });
  }
  return <div className="app-workspace market-app market-orders"><Pending loading={loading}>
    <div className={`market-orders-layout market-master-detail ${detailOpen ? 'market-detail-open' : ''}`}><aside className="market-sidebar">
      <header className="market-sidebar-heading"><h3>{tr('订单与物品')}</h3><IconAction label={tr('添加物品')} disabled={action.busy} onClick={() => choose(null)}><Plus size={21} /></IconAction></header>
      <div className="market-search"><MagnifyingGlass size={17} /><Input aria-label={tr('搜索订单与物品')} placeholder={tr('搜索订单与物品')} value={query} maxLength={100} onChange={(event) => setQuery(event.target.value)} /></div>
      <div className="market-filter-pills">{[['all', tr('全部')], ['transit', tr('待收货')], ['returns', tr('可退换')], ['warranty', tr('保修中')]].map(([value, label]) => <Action key={value} aria-pressed={filter === value} onClick={() => setFilter(value)}>{label}</Action>)}</div>
      <div className="market-sidebar-scroll">{records.map((row) => <Button className="market-order-row" type="button" variant="ghost" aria-pressed={selectedItem?.id === row.id} key={row.id} onClick={() => { setSelectedId(row.id); setDetailOpen(true); setDetailTab('overview'); }}><span className={`market-order-glyph ${row.status}`}><Package size={21} /></span><span><strong>{row.title}</strong><small>{row.seller || row.boughtOn}</small></span><small>{statusLabels[row.status]}</small></Button>)}{!records.length && <QuietEmpty icon={Package} title={query || filter !== 'all' ? tr('没有符合条件的物品') : tr('保存你的订单与物品')} action={!query && filter === 'all' && <Action onClick={() => choose(null)}>{tr('添加物品')}</Action>} />}</div>
      <footer className="market-sidebar-footer"><Action disabled={action.busy} onClick={() => setSettings({ ...data.tracking })}><GearSix size={17} />{tr('物流接口')}</Action></footer>
    </aside><main className="market-detail market-order-detail">{selectedItem ? <>
      <header className="market-detail-heading"><IconAction className="market-mobile-back" label={tr('返回物品列表')} onClick={() => setDetailOpen(false)}><ArrowLeft size={19} /></IconAction><div><h2>{selectedItem.title}</h2><small className="app-muted">{selectedItem.seller}</small></div><div className="market-heading-actions"><IconAction label={tr('编辑物品')} disabled={action.busy} onClick={() => choose(selectedItem)}><PencilSimple size={19} /></IconAction><IconAction label={tr('删除物品')} disabled={action.busy} onClick={() => setRemove(selectedItem.id)}><Trash size={19} /></IconAction></div></header>
      <div className="market-order-summary"><span className={`market-status ${selectedItem.status}`}>{statusLabels[selectedItem.status]}</span><small>{tr('购买日期')} · {selectedItem.boughtOn}</small></div>
      <nav className="market-tabs" aria-label={tr('物品详情')}>{[['overview', tr('概览')], ['tracking', tr('物流')], ['receipts', tr('凭证')], ['warranty', tr('退换与保修')]].map(([value, label]) => <Button type="button" variant="ghost" key={value} aria-pressed={detailTab === value} onClick={() => setDetailTab(value)}>{label}{value === 'receipts' && selectedItem.attachments?.length > 0 ? ` (${selectedItem.attachments.length})` : ''}</Button>)}</nav>
      {detailTab === 'overview' && <div className="market-order-overview"><dl className="market-description-list">{[[tr('订单号'), selectedItem.orderNumber], [tr('商家'), selectedItem.seller], [tr('序列号'), selectedItem.serial]].filter(([, value]) => value).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl><div className="market-order-shortcuts">
        {selectedItem.trackingNumber && <Button type="button" variant="ghost" onClick={() => setDetailTab('tracking')}><Truck size={24} /><span><strong>{selectedItem.tracking?.status || tr('物流')}</strong><small>{selectedItem.carrier} {selectedItem.trackingNumber}</small></span><CaretRight size={17} /></Button>}
        {[[tr('退换截止'), selectedItem.returnBy], [tr('保修截止'), selectedItem.warrantyUntil]].filter(([, date]) => date).map(([label, date]) => { const days = deadlineDays(date); return <Button type="button" variant="ghost" key={label} onClick={() => setDetailTab('warranty')}><ShieldCheck size={24} /><span><strong>{label} · {date}</strong><small className={days >= 0 && days <= 7 ? 'market-deadline' : ''}>{days >= 0 ? tr('剩余 {0} 天', [days]) : tr('已到期')}</small></span><CaretRight size={17} /></Button>; })}
        {(selectedItem.attachments || []).length > 0 && <Button type="button" variant="ghost" onClick={() => setDetailTab('receipts')}><FileText size={24} /><span><strong>{tr('收据与凭证')}</strong><small>{selectedItem.attachments.map((row) => row.name).join(' · ')}</small></span><CaretRight size={17} /></Button>}</div>{selectedItem.note && <section className="market-order-note"><h3>{tr('备注')}</h3><p>{selectedItem.note}</p></section>}
        {!selectedItem.note && !selectedItem.orderNumber && !selectedItem.serial && !selectedItem.trackingNumber && !selectedItem.returnBy && !selectedItem.warrantyUntil && !selectedItem.attachments?.length && <QuietEmpty icon={Package} title={tr('物品已归档')} action={<Action onClick={() => choose(selectedItem)}>{tr('补充物品资料')}</Action>} />}
      </div>}
      {detailTab === 'tracking' && <section className="market-tracking"><header className="market-section-heading"><div><h3>{selectedItem.tracking?.status || tr('物流')}</h3><small className="app-muted">{selectedItem.carrier} {selectedItem.trackingNumber}</small></div>{selectedItem.trackingNumber && data.tracking.endpoint && <Action disabled={action.busy} onClick={() => refreshTracking(selectedItem)}><ArrowClockwise size={16} className={action.busy ? 'market-spin' : ''} />{action.busy ? tr('正在更新…') : tr('更新物流')}</Action>}{action.busy && <Action onClick={start.cancel}>{tr('取消')}</Action>}</header>{selectedItem.trackingNumber && <div className="market-tracking-links">{carrierLink ? <Button asChild variant="secondary"><a href={carrierLink} target="_blank" rel="noopener noreferrer">{tr('到承运商官网查询')}</a></Button> : <Action onClick={() => choose(selectedItem)}>{tr('选择承运商')}</Action>}<Action onClick={() => action.run(() => navigator.clipboard.writeText(selectedItem.trackingNumber))}>{tr('复制运单号')}</Action></div>}{selectedItem.tracking?.events?.length ? <><small className="app-muted">{tr('更新时间：{0}', [stamp(selectedItem.tracking.updatedAt)])}</small><ol className="market-tracking-timeline">{selectedItem.tracking.events.map((event, index) => <li key={index}><strong>{event.description}</strong><small>{event.time} {event.location}</small></li>)}</ol></> : <QuietEmpty icon={Truck} title={tr('暂无物流动态')} action={!selectedItem.trackingNumber ? <Action onClick={() => choose(selectedItem)}>{tr('填写运单号')}</Action> : null} />}</section>}
      {detailTab === 'receipts' && <section className="market-receipts">{(selectedItem.attachments || []).map((file) => <Button type="button" variant="ghost" className="market-receipt-row" key={file.id} onClick={() => downloadBlob(file.blob, file.name)}><FileText size={30} /><span><strong>{file.name}</strong><small>{n(file.blob.size / 1024, 1)} KB</small></span><span>{tr('下载')}</span></Button>)}{!selectedItem.attachments?.length && <QuietEmpty icon={FileText} title={tr('暂无收据与凭证')} action={<Action onClick={() => choose(selectedItem)}>{tr('添加凭证')}</Action>} />}</section>}
      {detailTab === 'warranty' && <section className="market-warranty">{[[tr('退换截止'), selectedItem.returnBy], [tr('保修截止'), selectedItem.warrantyUntil]].map(([label, date]) => { const days = deadlineDays(date); return <article className="market-warranty-card" key={label}><ShieldCheck size={25} /><div><small>{label}</small><strong>{date || '—'}</strong>{date && <span className={days >= 0 && days <= 7 ? 'market-deadline' : 'app-muted'}>{days >= 0 ? tr('剩余 {0} 天', [days]) : tr('已到期')}</span>}</div></article>; })}{selectedItem.serial && <dl className="market-description-list"><div><dt>{tr('序列号')}</dt><dd>{selectedItem.serial}</dd></div></dl>}<Action onClick={() => choose(selectedItem)}>{tr('编辑退换与保修信息')}</Action></section>}
    </> : <QuietEmpty icon={Package} title={tr('订单、凭证与保修，一处查找')} action={<Action primary onClick={() => choose(null)}>{tr('添加物品')}</Action>} />}</main></div>
    {editing && <MarketSheet title={draft.id ? tr('编辑物品') : tr('添加物品')} onClose={closeEditor} dirty={dirty} busy={action.busy} message={store.error || action.error} onDismissError={() => action.setError('')}><form className="market-editor" onSubmit={(event) => { event.preventDefault(); action.run(save); }}><fieldset disabled={action.busy}>
      <Field label={tr('物品名称')}><Input autoFocus value={draft.title} required maxLength={200} onChange={(event) => patch({ title: event.target.value })} /></Field><Field label={tr('商家')}><Input value={draft.seller} maxLength={200} onChange={(event) => patch({ seller: event.target.value })} /></Field><Field label={tr('购买日期')}><Input type="date" required value={draft.boughtOn} onChange={(event) => patch({ boughtOn: event.target.value })} /></Field><Select label={tr('状态')} value={draft.status} onChange={(value) => patch({ status: value })} options={Object.entries(statusLabels).map(([value, label]) => ({ value, label }))} />
      <Disclosure title={tr('订单与物流')} defaultOpen={Boolean(draft.orderNumber || draft.trackingNumber)}><Field label={tr('订单号')}><Input value={draft.orderNumber} maxLength={200} onChange={(event) => patch({ orderNumber: event.target.value })} /></Field><Select label={tr('物流公司')} value={customCarrier ? 'other' : draft.carrier} onChange={(value) => { setCustomCarrier(value === 'other'); patch({ carrier: value === 'other' ? '' : value }); }} options={[{ value: '', label: tr('选择承运商') }, ...OFFICIAL_CARRIERS.map((value) => ({ value, label: value })), { value: 'other', label: tr('其他物流公司') }]} />{customCarrier && <Field label={tr('其他物流公司')}><Input value={draft.carrier} maxLength={200} onChange={(event) => patch({ carrier: event.target.value })} /></Field>}<Field label={tr('运单号')}><Input value={draft.trackingNumber} maxLength={200} onChange={(event) => patch({ trackingNumber: event.target.value })} /></Field></Disclosure>
      <Disclosure title={tr('退换与保修')} defaultOpen={Boolean(draft.returnBy || draft.warrantyUntil || draft.serial)}>{[[tr('退换截止'), 'returnBy'], [tr('保修截止'), 'warrantyUntil']].map(([label, key]) => <Field key={key} label={label}><Input type="date" value={draft[key]} onChange={(event) => patch({ [key]: event.target.value })} /></Field>)}<Field label={tr('序列号')}><Input value={draft.serial} maxLength={200} onChange={(event) => patch({ serial: event.target.value })} /></Field></Disclosure>
      <Disclosure title={tr('收据与凭证')} defaultOpen={Boolean(draft.attachments.length)}><Field label={tr('添加凭证')}><Input type="file" multiple accept="application/pdf,image/png,image/jpeg,image/webp" onChange={(event) => { const files = event.target.files; action.run(() => attach(files)); event.target.value = ''; }} /></Field>{draft.attachments.map((row) => <div className="market-attachment" key={row.id}><FileText size={18} /><span>{row.name}</span><IconAction label={tr('下载 {0}', [row.name])} onClick={() => downloadBlob(row.blob, row.name)}><FileText size={16} /></IconAction><IconAction label={tr('移除 {0}', [row.name])} onClick={() => patch({ attachments: draft.attachments.filter((item) => item.id !== row.id) })}><X size={16} /></IconAction></div>)}</Disclosure><Field label={tr('备注')}><Input value={draft.note} maxLength={2000} onChange={(event) => patch({ note: event.target.value })} /></Field>
    </fieldset><SheetFooter busy={action.busy} onCancel={closeEditor} disabled={!dirty || !draft.title.trim()} /></form></MarketSheet>}
    {settings && <MarketSheet title={tr('物流接口')} onClose={() => setSettings(null)} busy={action.busy} dirty={JSON.stringify(settings) !== JSON.stringify(data.tracking)} message={store.error || action.error} onDismissError={() => action.setError('')}><form className="market-editor" onSubmit={(event) => { event.preventDefault(); action.run(async () => { if (settings.endpoint) trackingURL(settings.endpoint, 'check'); await update((current) => ({ ...current, tracking: { endpoint: settings.endpoint.trim(), apiKey: settings.apiKey.trim() } })); setSettings(null); }); }}><fieldset disabled={action.busy}><p className="app-muted">{tr('官网查询无需配置接口或密钥。自动更新可使用你自己的物流服务。')}</p><Disclosure title={tr('自动物流接口（高级）')}><Field label={tr('物流接口地址')}><Input value={settings.endpoint} maxLength={2000} placeholder="https://example.com/tracking/{number}" onChange={(event) => setSettings({ ...settings, endpoint: event.target.value })} /></Field><Field label="API Key"><Input type="password" autoComplete="off" value={settings.apiKey} maxLength={300} onChange={(event) => setSettings({ ...settings, apiKey: event.target.value })} /></Field><p className="app-muted">{tr('接口地址用 {number} 代表运单号。接口需返回物流状态和事件列表。')}</p></Disclosure></fieldset><SheetFooter busy={action.busy} onCancel={() => setSettings(null)} /></form></MarketSheet>}
    {!editing && !settings && <ErrorNotice store={store} action={action} />}
    {remove && <PromptDialog title={tr('确认删除')} action={tr('删除')} destructive busy={action.busy} onCancel={() => setRemove(null)} onConfirm={() => action.run(async () => { await update((current) => ({ ...current, items: current.items.filter((row) => row.id !== remove) })); setRemove(null); })}>{tr('删除这件物品及其收据和物流记录？')}</PromptDialog>}
  </Pending></div>;
}

const blankEvent = () => ({ home: '', away: '', date: localISODate(), time: '', league: '', homeScore: '', awayScore: '', status: '' });
export function SportsApp(props) {
  const store = useAppData('sports', MARKET_DEFAULTS.sports), { data, update, loading } = store, action = useAppAction(), start = useRequest();
  const [teamQuery, setTeamQuery] = useState(''), [teamId, setTeamId] = useState(''), [teamResults, setTeamResults] = useState([]), [settings, setSettings] = useState(null), [draft, setDraft] = useState(null), [remove, setRemove] = useState(null), [filter, setFilter] = useState('matches');
  const [following, setFollowing] = useState(false), [selectedDate, setSelectedDate] = useState(localISODate()), [selectedTeamId, setSelectedTeamId] = useState(''), eventBaseline = useRef('');
  const settingsBaseline = useRef(''), provider = sportsProvider(data.settings), settingsDirty = Boolean(settings && JSON.stringify(settings) !== settingsBaseline.current);
  const contextConsumed = useRef(false);
  useEffect(() => { if (!store.loaded || contextConsumed.current) return; contextConsumed.current = true; const row = data.events.find((item) => item.id === props.initialContext?.eventId); if (row) { setSelectedDate(sportsEventDate(row)); setSelectedTeamId(''); setFilter('matches'); } }, [store.loaded, data.events, props.initialContext]);
  function openSettings() { const value = { ...data.settings, provider, league: data.settings.league || 'bl1' }; settingsBaseline.current = JSON.stringify(value); setSettings(value); }
  const eventDirty = draft && JSON.stringify(draft) !== eventBaseline.current;
  useSignals(props, Boolean(following && (teamQuery || teamId) || eventDirty || settingsDirty), action.busy);
  function editEvent(row) { const value = row ? { ...row, homeScore: row.homeScore ?? '', awayScore: row.awayScore ?? '', time: row.time || '' } : { ...blankEvent(), date: selectedDate }; eventBaseline.current = JSON.stringify(value); setDraft(value); }
  function closeFollowing() { setFollowing(false); setTeamQuery(''); setTeamId(''); setTeamResults([]); }
  function shiftDate(direction) { const date = new Date(`${selectedDate || localISODate()}T12:00:00`); date.setDate(date.getDate() + direction); setSelectedDate(localISODate(date)); }
  function search() {
    if (!teamQuery.trim()) return;
    if (provider === 'openliga') {
      let url; try { url = openLigaURL('getavailableteams', data.settings); } catch (reason) { action.setError(errorText(reason)); return; }
      const access = requestAppAccess(url), signal = start(), query = teamQuery.trim().toLocaleLowerCase();
      action.run(async () => { await access; const teams = normalizeOpenLigaTeams(await fetchAppJSON(url, { signal })).filter((row) => row.name.toLocaleLowerCase().includes(query)); signal.throwIfAborted(); setTeamResults(teams); if (!teams.length) throw Error(tr('当前公开联赛中没有匹配球队，可更换联赛或手动关注。')); }); return;
    }
    let url; try { url = sportsURL('searchteams', { t: teamQuery.trim() }, data.settings.apiKey); } catch (reason) { action.setError(errorText(reason)); return; }
    const access = requestAppAccess(url), signal = start();
    action.run(async () => { await access; const response = await fetchAppJSON(url, { signal }); if (!response || !Object.hasOwn(response, 'teams') || response.teams !== null && !Array.isArray(response.teams)) throw Error(tr('球队搜索结果无效。')); setTeamResults((response.teams || []).slice(0, 50).filter((row) => /^\d+$/.test(row.idTeam || '')).map((row) => ({ id: row.idTeam, name: row.strTeam || row.idTeam, league: row.strLeague || '' }))); });
  }
  async function follow(team) {
    await update((current) => { if (current.teams.some((row) => row.id === team.id)) return current; if (current.teams.length >= 30) throw Error(tr('关注球队数量已达上限。')); return { ...current, teams: [...current.teams, team] }; }); closeFollowing();
  }
  function refresh() {
    const config = { ...data.settings }, teams = data.teams.filter((row) => /^\d{1,12}$/.test(row.id));
    if (provider === 'openliga') {
      let url; try { url = openLigaURL('getmatchdata', config); } catch (reason) { action.setError(errorText(reason)); return; }
      const access = requestAppAccess(url), signal = start(), key = openLigaTableKey(config);
      action.run(async () => {
        await access;
        const events = normalizeOpenLigaEvents(await fetchAppJSON(url, { signal }), key);
        if (!events.length) throw Error(tr('公开联赛暂无赛程，请选择其他联赛或赛季。'));
        const standings = normalizeOpenLigaTable(await fetchAppJSON(openLigaURL('getbltable', config), { signal }));
        signal.throwIfAborted();
        await update((current) => { if (JSON.stringify(current.settings) !== JSON.stringify(config)) throw Error(tr('关注或数据源已变更，请重新更新。')); return { ...current, events: [...current.events.filter((row) => row.leagueKey !== key), ...events], tables: { ...current.tables, [key]: standings }, fetchedAt: Date.now(), fetchedSource: 'OpenLigaDB' }; });
      }); return;
    }
    if (!teams.length && !config.leagueId) { action.setError(tr('请先关注球队，或设置联赛编号。')); return; }
    if (config.leagueId && !/^\d{1,12}$/.test(config.leagueId)) { action.setError(tr('联赛编号无效。')); return; }
    let firstURL; try { firstURL = sportsURL('eventsnext', { id: teams[0]?.id || '0' }, config.apiKey); } catch (reason) { action.setError(errorText(reason)); return; }
    const access = requestAppAccess(firstURL), signal = start();
    action.run(async () => {
      await access;
      let events = [], standings = null;
      for (const team of teams) {
        const next = await fetchAppJSON(sportsURL('eventsnext', { id: team.id }, config.apiKey), { signal });
        const previous = await fetchAppJSON(sportsURL('eventslast', { id: team.id }, config.apiKey), { signal });
        if (!next || !Object.hasOwn(next, 'events') || !previous || !Object.hasOwn(previous, 'results')) throw Error(tr('赛程数据无效。'));
        events.push(...normalizeSportsEvents(next.events), ...normalizeSportsEvents(previous.results));
      }
      if (config.leagueId) {
        const response = await fetchAppJSON(sportsURL('eventsseason', { id: config.leagueId, s: config.season }, config.apiKey), { signal });
        if (!response || !Object.hasOwn(response, 'events')) throw Error(tr('赛程数据无效。'));
        events.push(...normalizeSportsEvents(response.events));
        const table = await fetchAppJSON(sportsURL('lookuptable', { l: config.leagueId, s: config.season }, config.apiKey), { signal }); if (!table || !Object.hasOwn(table, 'table')) throw Error(tr('积分榜数据无效。')); standings = normalizeSportsTable(table.table);
      }
      const rows = [...new Map(events.map((row) => [row.id, row])).values()];
      signal.throwIfAborted();
      await update((current) => {
        if (JSON.stringify(current.settings) !== JSON.stringify(config) || JSON.stringify(current.teams.filter((row) => /^\d{1,12}$/.test(row.id))) !== JSON.stringify(teams)) throw Error(tr('关注或数据源已变更，请重新更新。'));
        return { ...current, events: [...current.events.filter((row) => row.source !== 'TheSportsDB'), ...rows], tables: standings ? { ...current.tables, [config.leagueId]: standings } : current.tables, fetchedAt: Date.now(), fetchedSource: 'TheSportsDB' };
      });
    });
  }
  async function saveEvent() {
    if (!draft.home.trim() || !draft.away.trim() || !validISODate(draft.date)) throw Error(tr('请填写双方名称和有效日期。'));
    const score = (value) => { if (value === '') return null; if (!/^\d{1,4}$/.test(value)) throw Error(tr('比分须为非负整数。')); return Number(value); };
    const startsAt = draft.time ? new Date(`${draft.date}T${draft.time}`).toISOString() : null;
    const value = { ...draft, id: draft.id || uid(), home: draft.home.trim().slice(0, 100), away: draft.away.trim().slice(0, 100), homeScore: score(String(draft.homeScore)), awayScore: score(String(draft.awayScore)), startsAt, source: 'manual' };
    await update((current) => { if (current.events.length >= 3000 && !draft.id) throw Error(tr('赛事记录数量已达上限。')); if (draft.id && !current.events.some((row) => row.id === draft.id)) throw Error(tr('这场比赛已被移除。')); return { ...current, events: draft.id ? current.events.map((row) => row.id === draft.id ? value : row) : [...current.events, value] }; }); setSelectedDate(draft.date); setFilter('matches'); setDraft(null);
  }
  const events = selectSportsEvents(data.events, { view: filter, date: selectedDate, team: data.teams.find((row) => row.id === selectedTeamId) });
  const standings = data.tables[provider === 'openliga' ? openLigaTableKey(data.settings) : data.settings.leagueId] || [];
  return <div className="app-workspace market-app market-sports"><Pending loading={loading}>
    <div className="market-sports-layout"><aside className="market-sidebar"><header className="market-sidebar-heading"><h3>{tr('我的关注')}</h3><IconAction label={tr('关注球队')} disabled={action.busy} onClick={() => setFollowing(true)}><Plus size={20} /></IconAction></header><nav className="market-view-nav" aria-label={tr('筛选球队')}><Button type="button" variant="ghost" aria-pressed={!selectedTeamId} onClick={() => setSelectedTeamId('')}><Trophy size={18} />{tr('全部比赛')}</Button>{data.teams.map((row) => <div className="market-team-nav" key={row.id}><Button type="button" variant="ghost" aria-pressed={selectedTeamId === row.id} onClick={() => setSelectedTeamId(row.id)}><span className="market-team-initial">{row.name.slice(0, 1)}</span><span><strong>{row.name}</strong><small>{row.league}</small></span></Button><IconAction label={tr('取消关注 {0}', [row.name])} disabled={action.busy} onClick={() => setRemove({ team: row.id })}><X size={14} /></IconAction></div>)}</nav>{!data.teams.length && <div className="market-sidebar-empty"><Action onClick={() => setFollowing(true)}><Plus size={16} />{tr('关注球队')}</Action></div>}<footer className="market-sidebar-footer"><Action disabled={action.busy} onClick={openSettings}><GearSix size={17} />{tr('数据源设置')}</Action></footer></aside>
    <main className="market-sports-main"><header className="market-detail-heading"><h2>{data.teams.find((row) => row.id === selectedTeamId)?.name || tr('赛事')}</h2><div className="market-heading-actions"><IconAction label={tr('手动添加比赛')} disabled={action.busy} onClick={() => editEvent(null)}><Plus size={20} /></IconAction><Action primary disabled={action.busy} onClick={refresh}><ArrowClockwise size={16} className={action.busy ? 'market-spin' : ''} />{action.busy ? tr('正在更新…') : tr('更新赛程')}</Action>{action.busy && <Action onClick={start.cancel}>{tr('取消')}</Action>}</div></header>
      <nav className="market-tabs" aria-label={tr('赛事视图')}>{[['matches', tr('比赛')], ['upcoming', tr('赛程')], ['results', tr('赛果')], ['standings', tr('积分榜')]].map(([value, label]) => <Button key={value} type="button" variant="ghost" aria-pressed={filter === value} onClick={() => setFilter(value)}>{label}</Button>)}</nav>
      {filter === 'matches' && <div className="market-date-nav"><IconAction label={tr('前一天')} onClick={() => shiftDate(-1)}><CaretLeft size={18} /></IconAction><Input type="date" aria-label={tr('比赛日期')} value={selectedDate} onChange={(event) => setSelectedDate(event.target.value || localISODate())} /><IconAction label={tr('后一天')} onClick={() => shiftDate(1)}><CaretRight size={18} /></IconAction><Action aria-pressed={selectedDate === localISODate()} onClick={() => setSelectedDate(localISODate())}>{tr('今天')}</Action></div>}
      {filter !== 'standings' ? <div className="market-match-list">{groupedBy(events, (row) => sportsEventDate(row)).map(([date, rows]) => <section className="market-match-day" key={date}>{filter !== 'matches' && <h3>{date}</h3>}{rows.map((row) => { const phase = sportsEventPhase(row); return <article className="market-match-card" key={row.id}><header><small>{row.league || tr('比赛')}</small><span className={phase === 'live' ? 'market-live' : 'app-muted'}>{row.status || ({ upcoming: tr('未赛'), results: tr('已结束'), live: tr('进行中'), postponed: tr('已推迟'), unknown: tr('暂无赛果') })[phase]}</span>{row.source === 'manual' && <div className="market-match-actions"><IconAction label={tr('编辑比赛')} disabled={action.busy} onClick={() => editEvent(row)}><PencilSimple size={15} /></IconAction><IconAction label={tr('删除比赛')} disabled={action.busy} onClick={() => setRemove({ event: row.id })}><Trash size={15} /></IconAction></div>}</header><div className="market-match"><strong>{row.home}</strong><div>{phase === 'upcoming' && row.homeScore == null && row.awayScore == null ? <time>{row.startsAt ? new Date(row.startsAt).toLocaleTimeString(getLocale(), { hour: '2-digit', minute: '2-digit' }) : '—'}</time> : <b>{row.homeScore ?? '—'} <span>:</span> {row.awayScore ?? '—'}</b>}<small>{row.source === 'manual' ? tr('手动记录') : row.source}</small></div><strong>{row.away}</strong></div></article>; })}</section>)}{!events.length && <QuietEmpty icon={Trophy} title={filter === 'matches' ? tr('当天暂无比赛') : filter === 'results' ? tr('暂无赛果') : tr('暂无待进行的比赛')} action={<Action onClick={() => editEvent(null)}>{tr('手动添加比赛')}</Action>}><span>{data.teams.length ? tr('更新赛程，或记录一场比赛。') : tr('关注球队后更新赛程，也可以手动记录比赛。')}</span></QuietEmpty>}</div>
        : standings.length > 0 ? <div className="market-table-wrap"><table className="market-table"><caption>{tr('积分榜')}{data.settings.season ? ` · ${data.settings.season}` : ''}</caption><thead><tr>{[tr('排名'), tr('球队'), tr('场次'), tr('胜'), tr('平'), tr('负'), tr('积分')].map((label) => <th key={label}>{label}</th>)}</tr></thead><tbody>{standings.map((row, index) => <tr key={row.id || index} className={data.teams.some((team) => team.id === row.id) ? 'market-followed-team' : ''}><td>{row.rank ?? '—'}</td><td>{row.name}</td><td>{row.played ?? '—'}</td><td>{row.wins ?? '—'}</td><td>{row.draws ?? '—'}</td><td>{row.losses ?? '—'}</td><td><strong>{row.points ?? '—'}</strong></td></tr>)}</tbody></table></div> : <QuietEmpty icon={Trophy} title={tr('暂无积分榜')} action={<Action onClick={openSettings}>{tr('设置联赛与赛季')}</Action>} />}
      <footer className="market-source app-muted">{provider === 'openliga' || data.fetchedSource === 'OpenLigaDB' ? <><a href="https://www.openligadb.de/" target="_blank" rel="noopener noreferrer">OpenLigaDB</a> · <a href="https://opendatacommons.org/licenses/odbl/1-0/" target="_blank" rel="noopener noreferrer">ODbL 1.0</a> · {tr('公开社区联赛')}</> : 'TheSportsDB'}{data.fetchedAt ? ` · ${tr('更新时间：{0}', [stamp(data.fetchedAt)])}` : ''}</footer>
    </main></div>
    {following && <MarketSheet title={tr('关注球队')} onClose={closeFollowing} busy={action.busy} dirty={Boolean(teamQuery || teamId)} message={store.error || action.error} onDismissError={() => action.setError('')}><div className="market-follow-editor"><form className="market-team-search" onSubmit={(event) => { event.preventDefault(); search(); }}><Field label={tr('球队名称')}><Input autoFocus value={teamQuery} maxLength={100} placeholder={provider === 'openliga' ? 'Bayern' : 'Arsenal'} disabled={action.busy} onChange={(event) => setTeamQuery(event.target.value)} /></Field><Button type="submit" disabled={action.busy || !teamQuery.trim()}>{action.busy ? tr('正在搜索…') : tr('搜索球队')}</Button>{action.busy && <Action onClick={start.cancel}>{tr('取消')}</Action>}</form><div className="market-team-results">{teamResults.map((row) => <Button type="button" variant="ghost" className="market-team-result" key={row.id} disabled={action.busy} onClick={() => action.run(() => follow(row))}><span><strong>{row.name}</strong><small>{row.league}</small></span><Plus size={18} /></Button>)}</div><Disclosure title={tr('手动关注')}><Field label={tr('球队编号，可选')}><Input inputMode="numeric" value={teamId} maxLength={12} disabled={action.busy} onChange={(event) => setTeamId(event.target.value)} /></Field><Action disabled={action.busy || !teamQuery.trim()} onClick={() => action.run(() => { if (teamId && !/^\d{1,12}$/.test(teamId)) throw Error(tr('球队编号无效。')); return follow({ id: teamId || `manual:${uid()}`, name: teamQuery.trim().slice(0, 100), league: '' }); })}>{tr('手动关注')}</Action></Disclosure></div></MarketSheet>}
    {settings && <MarketSheet title={tr('数据源设置')} onClose={() => setSettings(null)} busy={action.busy} dirty={settingsDirty} message={store.error || action.error} onDismissError={() => action.setError('')}><form className="market-editor" onSubmit={(event) => { event.preventDefault(); action.run(async () => {
      if (settings.provider === 'openliga') openLigaURL('getmatchdata', settings); else if (settings.leagueId && !/^\d{1,12}$/.test(settings.leagueId.trim())) throw Error(tr('联赛编号无效。'));
      await update((current) => ({ ...current, settings: { ...settings, apiKey: settings.apiKey.trim(), leagueId: settings.leagueId.trim(), season: settings.season.trim().slice(0, 20), league: settings.league.trim() } })); setSettings(null);
    }); }}><fieldset disabled={action.busy}><Select label={tr('赛程来源')} value={settings.provider} onChange={(value) => setSettings({ ...settings, provider: value })} options={options([['openliga', tr('OpenLigaDB（免密钥）')], ['sportsdb', tr('TheSportsDB（自有授权）')]])} />
      {settings.provider === 'openliga' ? <><Select label={tr('公开联赛')} value={settings.league} onChange={(value) => setSettings({ ...settings, league: value })} options={options([['bl1', tr('德国甲级联赛')], ['bl2', tr('德国乙级联赛')], ['bl3', tr('德国丙级联赛')], ...(!['bl1', 'bl2', 'bl3'].includes(settings.league) ? [[settings.league, settings.league]] : [])])} /><Field label={tr('赛季起始年份')}><Input inputMode="numeric" value={settings.season} maxLength={4} placeholder={openLigaSeason({})} onChange={(event) => setSettings({ ...settings, season: event.target.value })} /></Field><Disclosure title={tr('其他社区联赛')}><Field label={tr('联赛代码')}><Input value={settings.league} maxLength={20} placeholder="bl1" onChange={(event) => setSettings({ ...settings, league: event.target.value })} /></Field><a href="https://www.openligadb.de/" target="_blank" rel="noopener noreferrer">OpenLigaDB</a></Disclosure><p className="app-muted">{tr('公开源以德国足球等社区联赛为主，覆盖与更新取决于维护者。')}</p></> : <><Field label={tr('联赛编号，可选')}><Input inputMode="numeric" value={settings.leagueId} maxLength={12} placeholder="4328" onChange={(event) => setSettings({ ...settings, leagueId: event.target.value })} /></Field><Field label={tr('赛季，可选')}><Input value={settings.season} maxLength={20} placeholder="2026-2027" onChange={(event) => setSettings({ ...settings, season: event.target.value })} /></Field><Field label="TheSportsDB API Key"><Input type="password" autoComplete="off" value={settings.apiKey} maxLength={200} onChange={(event) => setSettings({ ...settings, apiKey: event.target.value })} /></Field><p className="app-muted">{tr('仅使用你已获得发布与数据访问授权的服务。')}</p></>}
    </fieldset><SheetFooter busy={action.busy} onCancel={() => setSettings(null)} /></form></MarketSheet>}
    {draft && <MarketSheet title={draft.id ? tr('编辑比赛') : tr('手动添加比赛')} onClose={() => setDraft(null)} busy={action.busy} dirty={eventDirty} message={store.error || action.error} onDismissError={() => action.setError('')}><form className="market-editor" onSubmit={(event) => { event.preventDefault(); action.run(saveEvent); }}><fieldset disabled={action.busy}><div className="market-score-editor"><Field label={tr('主队')}><Input autoFocus required value={draft.home} maxLength={100} onChange={(event) => setDraft({ ...draft, home: event.target.value })} /></Field><Field label={tr('客队')}><Input required value={draft.away} maxLength={100} onChange={(event) => setDraft({ ...draft, away: event.target.value })} /></Field><Field label={tr('主队比分')}><Input inputMode="numeric" value={draft.homeScore} maxLength={4} onChange={(event) => setDraft({ ...draft, homeScore: event.target.value })} /></Field><Field label={tr('客队比分')}><Input inputMode="numeric" value={draft.awayScore} maxLength={4} onChange={(event) => setDraft({ ...draft, awayScore: event.target.value })} /></Field></div><Field label={tr('日期')}><Input type="date" required value={draft.date} onChange={(event) => setDraft({ ...draft, date: event.target.value })} /></Field><Field label={tr('当地时间，可选')}><Input type="time" value={draft.time} onChange={(event) => setDraft({ ...draft, time: event.target.value })} /></Field><Field label={tr('联赛')}><Input value={draft.league} maxLength={100} onChange={(event) => setDraft({ ...draft, league: event.target.value })} /></Field><Field label={tr('状态')}><Input value={draft.status} maxLength={100} onChange={(event) => setDraft({ ...draft, status: event.target.value })} /></Field></fieldset><SheetFooter busy={action.busy} onCancel={() => setDraft(null)} submitLabel={tr('保存比赛')} /></form></MarketSheet>}
    {!following && !settings && !draft && <ErrorNotice store={store} action={action} />}
    {remove && <PromptDialog title={tr('确认删除')} action={tr('删除')} destructive busy={action.busy} onCancel={() => setRemove(null)} onConfirm={() => action.run(async () => { await update((current) => remove.team ? { ...current, teams: current.teams.filter((row) => row.id !== remove.team) } : { ...current, events: current.events.filter((row) => row.id !== remove.event) }); if (remove.team === selectedTeamId) setSelectedTeamId(''); setRemove(null); })}>{remove.team ? tr('取消关注这个球队？') : tr('删除这场手动记录的比赛？')}</PromptDialog>}
  </Pending></div>;
}

export default function MarketApps(props) {
  const Component = { stocks: StocksApp, currency: CurrencyApp, ledger: LedgerApp, orders: OrdersApp, sports: SportsApp }[props.appId];
  return Component ? <Component {...props} /> : null;
}
