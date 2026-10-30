import { tr } from '../i18n/index.js';

export const COMMON_CURRENCIES = Object.freeze(['USD', 'CNY', 'EUR', 'GBP', 'JPY', 'HKD', 'AUD', 'CAD', 'CHF', 'SGD', 'KRW', 'TWD', 'NZD', 'THB', 'MYR', 'INR', 'AED', 'KWD']);
export const MARKET_DEFAULTS = Object.freeze({
  currency: { base: 'USD', target: 'CNY', amount: '1', favorites: ['CNY', 'EUR', 'JPY', 'HKD'], cache: null },
  stocks: { lists: [{ id: 'watchlist-main', name: '' }], selectedList: 'watchlist-main', symbols: [], quotes: {}, series: {}, settings: { provider: 'public', apiKey: '', delay: 'unknown', colors: 'red-up' } },
  ledger: { accounts: [], transactions: [], budgets: [], bills: [] },
  orders: { items: [], tracking: { endpoint: '', apiKey: '' } },
  sports: { teams: [], events: [], tables: {}, settings: { provider: 'openliga', league: 'bl1', apiKey: '', leagueId: '', season: '' }, fetchedAt: null },
});

const fail = (message) => { throw Error(tr(message)); };
const finite = (value) => value !== null && value !== '' && value !== undefined && Number.isFinite(Number(value));
const number = (value) => finite(value) ? Number(value) : null;
const clean = (value, maximum = 200) => typeof value === 'string' ? value.slice(0, maximum).trim() : '';
export function localISODate(now = new Date()) {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}
export function validISODate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
export function currencyCode(value) {
  const code = typeof value === 'string' ? value.trim().toUpperCase() : '';
  if (!/^[A-Z]{3}$/.test(code)) fail('请填写三位货币代码。');
  return code;
}
export function currencyDigits(code) {
  return new Intl.NumberFormat('en', { style: 'currency', currency: currencyCode(code) }).resolvedOptions().maximumFractionDigits;
}
export function parseMoney(value, code = 'CNY') {
  const digits = currencyDigits(code), text = String(value).trim();
  if (!/^-?\d{1,12}(?:\.\d+)?$/.test(text)) fail('请填写有效金额。');
  const negative = text.startsWith('-'), [whole, fraction = ''] = text.replace(/^-/, '').split('.');
  if (fraction.length > digits) fail('金额的小数位超过该货币支持的精度。');
  const minor = BigInt(whole) * 10n ** BigInt(digits) + BigInt(fraction.padEnd(digits, '0') || '0');
  if (minor > BigInt(Number.MAX_SAFE_INTEGER)) fail('金额超出支持范围。');
  return Number(negative ? -minor : minor);
}
export function minorToDecimal(value, code = 'CNY') {
  if (!Number.isSafeInteger(value)) fail('金额无效。');
  const digits = currencyDigits(code), absolute = BigInt(Math.abs(value)), divisor = 10n ** BigInt(digits);
  return `${value < 0 ? '-' : ''}${absolute / divisor}${digits ? `.${String(absolute % divisor).padStart(digits, '0')}` : ''}`;
}
function decimal(value) {
  const text = String(value).trim();
  if (!/^\d{1,16}(?:\.\d{1,16})?$/.test(text)) fail('汇率或金额格式无效。');
  const [whole, fraction = ''] = text.split('.');
  return { numerator: BigInt(whole + fraction), denominator: 10n ** BigInt(fraction.length) };
}
// Decimal arithmetic is kept in integers through the final currency rounding.
export function convertCurrencyAmount(amount, fromRate, toRate, digits = 2) {
  if (!Number.isInteger(digits) || digits < 0 || digits > 4) fail('货币精度无效。');
  const a = decimal(amount), from = decimal(fromRate), to = decimal(toRate);
  if (from.numerator <= 0n || to.numerator <= 0n) fail('汇率无效。');
  const numerator = a.numerator * to.numerator * from.denominator * 10n ** BigInt(digits);
  const denominator = a.denominator * to.denominator * from.numerator;
  const rounded = (numerator * 2n + denominator) / (denominator * 2n);
  const text = String(rounded).padStart(digits + 1, '0');
  return digits ? `${text.slice(0, -digits)}.${text.slice(-digits)}` : text;
}
export function normalizeExchangeRates(payload, base = 'USD', fetchedAt = Date.now()) {
  const code = currencyCode(base), rates = { [code]: '1' }, dates = {};
  if (!Array.isArray(payload) || !payload.length || payload.length > 300) fail('汇率服务没有返回有效数据。');
  for (const row of payload) {
    if (!row || currencyCode(row.base) !== code || !validISODate(row.date) || !finite(row.rate) || Number(row.rate) <= 0) fail('汇率服务返回的数据无效。');
    const quote = currencyCode(row.quote), rate = String(row.rate);
    decimal(rate); rates[quote] = rate; dates[quote] = row.date;
  }
  const date = Object.values(dates).sort()[0]; dates[code] = date;
  return { base: code, rates, dates, date, fetchedAt, source: 'Frankfurter' };
}
export function exchangeCacheState(cache, codes, today = localISODate()) {
  if (!cache || !cache.rates || !validISODate(cache.date)) return 'missing';
  if (codes.some((code) => !finite(cache.rates[code]) || Number(cache.rates[code]) <= 0)) return 'incomplete';
  return deadlineDays(cache.date, today) < -7 ? 'stale' : 'available';
}
export function exchangeRateURL(codes, date = '') {
  const quotes = [...new Set(codes.map(currencyCode))].filter((value) => value !== 'USD');
  if (date && !validISODate(date)) fail('日期无效。');
  const url = new URL('https://api.frankfurter.dev/v2/rates');
  url.searchParams.set('base', 'USD');
  if (quotes.length) url.searchParams.set('quotes', quotes.join(','));
  if (date) url.searchParams.set('date', date);
  return url.href;
}

export function stockSymbol(value) {
  const symbol = clean(value, 40).toUpperCase();
  if (!/^[A-Z0-9^][A-Z0-9.^:/_-]{0,39}$/.test(symbol)) fail('请填写有效的股票代码。');
  return symbol;
}
export function stockURL(provider, endpoint, params, apiKey) {
  if (provider === 'public') {
    const instrument = publicStockInstrument(params.symbol, params.exchange);
    if (!instrument || !['quote', 'series'].includes(endpoint)) fail('此市场可在行情网站查看，或选择已授权的数据源。');
    const url = new URL(`https://iss.moex.com/iss/engines/stock/markets/shares/boards/TQBR/securities/${instrument}${endpoint === 'series' ? '/candles' : ''}.json`);
    url.searchParams.set('iss.meta', 'off'); url.searchParams.set('iss.only', endpoint === 'series' ? 'candles' : 'securities,marketdata');
    if (endpoint === 'series') { const from = new Date(); from.setFullYear(from.getFullYear() - 1); url.searchParams.set('from', localISODate(from)); url.searchParams.set('till', localISODate()); url.searchParams.set('interval', '24'); }
    return url.href;
  }
  if (!['twelve', 'alpha'].includes(provider) || !clean(apiKey, 300)) fail('请先保存行情服务和 API Key。');
  if (!['quote', 'series', 'search'].includes(endpoint)) fail('行情请求无效。');
  const url = new URL(provider === 'twelve' ? `https://api.twelvedata.com/${{ quote: 'quote', series: 'time_series', search: 'symbol_search' }[endpoint]}` : 'https://www.alphavantage.co/query');
  if (provider === 'alpha') url.searchParams.set('function', { quote: 'GLOBAL_QUOTE', series: 'TIME_SERIES_DAILY', search: 'SYMBOL_SEARCH' }[endpoint]);
  for (const [key, value] of Object.entries(params || {})) if (value !== '' && value !== undefined) url.searchParams.set(key, String(value));
  url.searchParams.set('apikey', apiKey.trim());
  return url.href;
}
export function stockCacheKey(provider, symbol, exchange = '') { return `${provider}:${stockSymbol(symbol)}:${clean(exchange, 40)}`; }
export function publicStockInstrument(symbol, exchange = '') {
  const code = stockSymbol(symbol);
  if (!code.endsWith('.ME') && !/^MOEX$/i.test(exchange.trim())) return null;
  const instrument = code.replace(/\.ME$/, '');
  if (!/^[A-Z0-9]{1,20}$/.test(instrument)) fail('此公开行情源不支持该代码。');
  return instrument;
}
export function stockWebURL(symbol) { return `https://finance.yahoo.com/quote/${encodeURIComponent(stockSymbol(symbol))}/`; }
export function effectiveStockProvider(settings) { return settings.provider === 'public' || !settings.apiKey?.trim() ? 'public' : settings.provider; }
function moexRows(block) {
  if (!block || !Array.isArray(block.columns) || !Array.isArray(block.data) || block.data.length > 5000) fail('行情服务返回的数据无效。');
  return block.data.map((row) => { if (!Array.isArray(row)) fail('行情服务返回的数据无效。'); return Object.fromEntries(block.columns.map((key, index) => [key, row[index]])); });
}
function providerError(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) fail('行情服务返回的数据无效。');
  if (payload.status === 'error' || payload.Note || payload.Information || payload['Error Message']) fail('行情服务拒绝了请求，请检查密钥、市场权限或请求频率。');
}
export function normalizeStockQuote(payload, provider, fallbackSymbol = '', fetchedAt = Date.now()) {
  providerError(payload);
  if (provider === 'public') {
    const row = moexRows(payload.marketdata)[0], security = moexRows(payload.securities)[0];
    if (!security || fallbackSymbol && stockSymbol(fallbackSymbol).replace(/\.ME$/, '') !== clean(security.SECID).toUpperCase()) fail('该标的暂无可用行情，请检查代码与市场权限。');
    const live = finite(row?.LAST), price = live ? Number(row.LAST) : number(security.PREVPRICE);
    if (price === null) fail('该标的暂无可用行情，请检查代码与市场权限。');
    return { symbol: stockSymbol(fallbackSymbol || security.SECID), name: clean(security.LATNAME || security.SHORTNAME), exchange: 'MOEX', currency: security.CURRENCYID === 'SUR' ? 'RUB' : clean(security.CURRENCYID, 10), price,
      change: live ? number(row.CHANGE) : null, percent: live ? number(row.LASTTOPREVPRICE) : null, open: live ? number(row.OPEN) : null, high: live ? number(row.HIGH) : null, low: live ? number(row.LOW) : null, previous: number(security.PREVPRICE), volume: live ? number(row.VOLTODAY) : null,
      date: live ? `${clean(row.SYSTIME, 64).slice(0, 10)} ${clean(row.UPDATETIME, 16)} MSK`.trim() : clean(security.PREVDATE, 64), marketOpen: row?.TRADINGSTATUS === 'T' ? true : row?.TRADINGSTATUS === 'N' ? false : null, source: live ? 'MOEX ISS · 15 min' : 'MOEX ISS · previous close', fetchedAt };
  }
  const row = provider === 'alpha' ? payload['Global Quote'] : payload;
  if (!row || !finite(provider === 'alpha' ? row['05. price'] : row.close)) fail('该标的暂无可用行情，请检查代码与市场权限。');
  const alpha = provider === 'alpha';
  return {
    symbol: clean(alpha ? row['01. symbol'] : row.symbol, 40) || stockSymbol(fallbackSymbol),
    name: clean(alpha ? '' : row.name), exchange: clean(alpha ? '' : row.exchange, 60),
    currency: clean(alpha ? '' : row.currency, 10), price: Number(alpha ? row['05. price'] : row.close),
    change: number(alpha ? row['09. change'] : row.change),
    percent: number(alpha ? String(row['10. change percent'] || '').replace('%', '') : row.percent_change),
    open: number(alpha ? row['02. open'] : row.open), high: number(alpha ? row['03. high'] : row.high), low: number(alpha ? row['04. low'] : row.low),
    previous: number(alpha ? row['08. previous close'] : row.previous_close), volume: number(alpha ? row['06. volume'] : row.volume),
    date: clean(alpha ? row['07. latest trading day'] : row.datetime, 64), marketOpen: typeof row.is_market_open === 'boolean' ? row.is_market_open : null,
    source: alpha ? 'Alpha Vantage' : 'Twelve Data', fetchedAt,
  };
}
export function trimStockCache(current, cacheKey, nextQuote, nextSeries) {
  const quotes = { ...current.quotes, [cacheKey]: nextQuote }, series = { ...current.series, ...(nextSeries ? { [cacheKey]: nextSeries } : {}) };
  const recent = Object.keys(quotes).sort((a, b) => (quotes[b].fetchedAt || 0) - (quotes[a].fetchedAt || 0));
  const kept = new Set(recent.slice(0, 200)), chartKeys = new Set(recent.slice(0, 50));
  return { quotes: Object.fromEntries(Object.entries(quotes).filter(([key]) => kept.has(key))), series: Object.fromEntries(Object.entries(series).filter(([key]) => chartKeys.has(key))) };
}
export function normalizeStockSeries(payload, provider) {
  providerError(payload);
  const rows = provider === 'public' ? moexRows(payload.candles).map((row) => ({ datetime: row.begin, close: row.close })) : provider === 'alpha' ? Object.entries(payload['Time Series (Daily)'] || {}).map(([datetime, row]) => ({ datetime, close: row['4. close'] })) : payload.values;
  if (!Array.isArray(rows) || !rows.length || rows.length > 5000) fail('该标的暂无可用走势图。');
  const points = rows.filter((row) => typeof row.datetime === 'string' && /^\d{4}-\d{2}-\d{2}/.test(row.datetime) && finite(row.close)).map((row) => ({ date: row.datetime.slice(0, 32), price: Number(row.close) })).sort((a, b) => a.date.localeCompare(b.date));
  if (!points.length) fail('走势图数据无效。');
  return points.slice(-366);
}
export function chartPolyline(points, width = 600, height = 170) {
  if (!points.length) return '';
  const prices = points.map((row) => row.price), min = Math.min(...prices), max = Math.max(...prices), span = max - min || Math.max(Math.abs(min) * 0.01, 1);
  return prices.map((price, index) => `${(points.length === 1 ? width / 2 : index / (points.length - 1) * width).toFixed(2)},${(height - 8 - (price - min) / span * (height - 16)).toFixed(2)}`).join(' ');
}

export function nextBillDate(date, cadence, anchorDay) {
  if (!validISODate(date) || !['weekly', 'monthly', 'yearly'].includes(cadence)) fail('周期账单日期无效。');
  const [year, month, day] = date.split('-').map(Number);
  if (cadence === 'weekly') { const next = new Date(`${date}T00:00:00Z`); next.setUTCDate(next.getUTCDate() + 7); return next.toISOString().slice(0, 10); }
  const targetMonth = cadence === 'monthly' ? month : month - 1;
  const targetYear = cadence === 'yearly' ? year + 1 : year;
  const start = new Date(Date.UTC(targetYear, targetMonth, 1));
  const lastDay = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0)).getUTCDate();
  start.setUTCDate(Math.min(anchorDay || day, lastDay)); return start.toISOString().slice(0, 10);
}
export function ledgerSummary(data, month, code, accountId = '') {
  currencyCode(code);
  if (!/^\d{4}-\d{2}$/.test(month)) fail('月份无效。');
  const records = (data.transactions || []).filter((row) => row.currency === code && row.date.startsWith(month) && (!accountId || row.accountId === accountId));
  let income = 0, expense = 0;
  const categories = {};
  for (const row of records) {
    if (!Number.isSafeInteger(row.amount) || row.amount < 0) fail('账本金额无效。');
    if (row.kind === 'income') income += row.amount;
    else if (row.kind === 'expense') { expense += row.amount; categories[row.category] = (categories[row.category] || 0) + row.amount; }
    else fail('账本类型无效。');
    if (!Number.isSafeInteger(income) || !Number.isSafeInteger(expense)) fail('账本金额超出支持范围。');
  }
  return { income, expense, balance: income - expense, categories, records };
}
export function validateTransaction(input, accounts) {
  const account = accounts.find((row) => row.id === input.accountId);
  if (!account) fail('请先选择账户。');
  if (!['income', 'expense'].includes(input.kind) || !validISODate(input.date)) fail('收支类型或日期无效。');
  const amount = parseMoney(input.amount, account.currency);
  if (amount <= 0) fail('金额必须大于零。');
  const category = clean(input.category, 80); if (!category) fail('请填写分类。');
  return { accountId: account.id, currency: account.currency, kind: input.kind, amount, category, date: input.date, note: clean(input.note, 2000) };
}
export function postDueBills(input, today = localISODate()) {
  if (!validISODate(today)) fail('日期无效。');
  const data = structuredClone(input); let posted = 0;
  for (const bill of data.bills || []) {
    if (!bill.anchorDay && validISODate(bill.nextDate)) bill.anchorDay = Number(bill.nextDate.slice(8));
    let count = 0;
    while (bill.nextDate <= today) {
      if (++count > 120) fail('待入账周期过多，请先调整账单日期。');
      if (!validISODate(bill.nextDate) || !Number.isSafeInteger(bill.amount) || bill.amount <= 0 || !['income', 'expense'].includes(bill.kind)) fail('周期账单无效。');
      const account = data.accounts.find((row) => row.id === bill.accountId);
      if (!account || account.currency !== bill.currency) fail('周期账单的账户已变更，请重新设置。');
      const id = `bill:${bill.id}:${bill.nextDate}`;
      if (!data.transactions.some((row) => row.id === id)) {
        data.transactions.push({ id, accountId: bill.accountId, currency: bill.currency, kind: bill.kind, amount: bill.amount, category: bill.category, date: bill.nextDate, note: bill.name, billId: bill.id }); posted++;
      }
      bill.nextDate = nextBillDate(bill.nextDate, bill.cadence, bill.anchorDay);
    }
  }
  if (data.transactions.length > 10000) fail('账本记录过多，请先导出归档。');
  return { data, posted };
}
export function deadlineDays(date, today = localISODate()) {
  if (!validISODate(date) || !validISODate(today)) return null;
  return Math.round((new Date(`${date}T00:00:00Z`) - new Date(`${today}T00:00:00Z`)) / 86400000);
}
export function trackingURL(template, trackingNumber) {
  if (!template || !template.includes('{number}') || !clean(trackingNumber, 100)) fail('请设置含 {number} 的物流接口地址。');
  const url = new URL(template.replaceAll('{number}', encodeURIComponent(trackingNumber.trim())));
  if (url.protocol !== 'https:' || url.username || url.password) fail('物流接口须使用不含账号密码的 HTTPS 地址。');
  return url.href;
}
export function normalizeTracking(payload) {
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.events) || payload.events.length > 100) fail('物流服务返回的数据格式不受支持。');
  return { status: clean(payload.status, 100), updatedAt: Date.now(), events: payload.events.map((row) => {
    if (!row || !clean(row.description, 1000)) fail('物流记录无效。');
    return { time: clean(row.time, 64), description: clean(row.description, 1000), location: clean(row.location, 200) };
  }) };
}
export const OFFICIAL_CARRIERS = Object.freeze(['UPS', 'FedEx', 'DHL', 'USPS', 'SF Express']);
export function officialTrackingURL(carrier, trackingNumber) {
  const name = String(carrier || '').trim().toLowerCase().replace(/[\s-]/g, ''), value = String(trackingNumber || '').trim();
  if (!value || value.length > 200) return null;
  let url, key;
  if (name === 'ups') { url = new URL('https://www.ups.com/track'); key = 'tracknum'; }
  else if (name === 'fedex') { url = new URL('https://www.fedex.com/fedextrack/'); key = 'trknbr'; }
  else if (name === 'dhl') { url = new URL('https://www.dhl.com/global-en/home/tracking.html'); key = 'tracking-id'; }
  else if (name === 'usps') { url = new URL('https://tools.usps.com/go/TrackConfirmAction'); key = 'tLabels'; }
  else if (['sfexpress', '顺丰', '順豐'].includes(name)) return 'https://www.sf-express.com/chn/sc/waybill/list';
  else return null;
  url.searchParams.set(key, value); return url.href;
}
export function sportsProvider(settings) { return settings.provider || (settings.apiKey?.trim() ? 'sportsdb' : 'openliga'); }
export function openLigaSeason(settings, now = new Date()) {
  const value = String(settings.season || '').slice(0, 4);
  return /^\d{4}$/.test(value) ? value : String(now.getFullYear() - (now.getMonth() < 6 ? 1 : 0));
}
export function openLigaURL(endpoint, settings) {
  if (!['getmatchdata', 'getbltable', 'getavailableteams'].includes(endpoint)) fail('赛事请求无效。');
  const league = settings.league || 'bl1'; if (!/^[a-z0-9_-]{1,20}$/i.test(league)) fail('联赛代码无效。');
  return `https://api.openligadb.de/${endpoint}/${encodeURIComponent(league)}/${openLigaSeason(settings)}`;
}
export function openLigaTableKey(settings) { return `openliga:${settings.league || 'bl1'}:${openLigaSeason(settings)}`; }
export function normalizeOpenLigaTeams(rows) {
  if (!Array.isArray(rows) || rows.length > 200) fail('球队搜索结果无效。');
  return rows.filter((row) => row && Number.isSafeInteger(row.teamId) && typeof row.teamName === 'string').map((row) => ({ id: `openliga:${row.teamId}`, name: clean(row.teamName), league: 'OpenLigaDB' }));
}
export function normalizeOpenLigaEvents(rows, leagueKey, now = Date.now()) {
  if (!Array.isArray(rows) || rows.length > 3000) fail('赛程数据无效。');
  return rows.map((row) => {
    if (!row || !Number.isSafeInteger(row.matchID) || !row.team1?.teamName || !row.team2?.teamName || !Number.isSafeInteger(row.team1.teamId) || !Number.isSafeInteger(row.team2.teamId) || !Number.isFinite(Date.parse(row.matchDateTimeUTC)) || !Array.isArray(row.matchResults) || row.matchResults.some((result) => !result || typeof result !== 'object')) fail('赛程数据无效。');
    const startsAt = new Date(row.matchDateTimeUTC).toISOString(), finished = row.matchIsFinished === true;
    const results = [...(row.matchResults || [])].sort((a, b) => (b.resultOrderID || (b.resultTypeID === 2 ? 2 : 1)) - (a.resultOrderID || (a.resultTypeID === 2 ? 2 : 1)));
    const age = now - Date.parse(startsAt), score = finished || age >= 0 && age < 5 * 3600000 ? results[0] : null, homeScore = number(score?.pointsTeam1), awayScore = number(score?.pointsTeam2);
    return { id: `openliga:${row.matchID}`, home: clean(row.team1.teamName), away: clean(row.team2.teamName), homeId: `openliga:${row.team1.teamId}`, awayId: `openliga:${row.team2.teamId}`, date: startsAt.slice(0, 10), startsAt, homeScore, awayScore, league: clean(row.leagueName), leagueKey, source: 'OpenLigaDB', status: finished ? 'FT' : score && now - Date.parse(startsAt) < 5 * 3600000 ? 'live' : '' };
  });
}
export function normalizeOpenLigaTable(rows) {
  if (!Array.isArray(rows) || rows.length > 200) fail('积分榜数据无效。');
  return rows.map((row, index) => { if (!row || !Number.isSafeInteger(row.teamInfoId) || !clean(row.teamName)) fail('积分榜数据无效。'); return { id: `openliga:${row.teamInfoId}`, name: clean(row.teamName), rank: index + 1, played: number(row.matches), wins: number(row.won), draws: number(row.draw), losses: number(row.lost), points: number(row.points) }; });
}
export function sportsURL(endpoint, params, apiKey = '') {
  if (!['searchteams', 'eventsnext', 'eventslast', 'eventsseason', 'lookuptable'].includes(endpoint)) fail('赛事请求无效。');
  const key = clean(apiKey, 200); if (!key) fail('此数据源需要你已授权的 API Key，可改用公开联赛。');
  if (!/^[A-Za-z0-9_-]+$/.test(key)) fail('赛事 API Key 无效。');
  const url = new URL(`https://www.thesportsdb.com/api/v1/json/${key}/${endpoint}.php`);
  for (const [name, value] of Object.entries(params || {})) if (value !== '') url.searchParams.set(name, String(value));
  return url.href;
}
export function normalizeSportsEvents(rows, source = 'TheSportsDB') {
  if (rows === null || rows === undefined) return [];
  if (!Array.isArray(rows) || rows.length > 5000) fail('赛程数据无效。');
  return rows.map((row) => {
    if (!row || !clean(row.idEvent, 100) || !validISODate(row.dateEvent)) fail('赛程数据无效。');
    const time = clean(row.strTime, 16), dateTime = /^\d{2}:\d{2}(?::\d{2})?$/.test(time) ? `${row.dateEvent}T${time.length === 5 ? `${time}:00` : time}Z` : null;
    return { id: `sportsdb:${row.idEvent}`, home: clean(row.strHomeTeam) || clean(row.strEvent), away: clean(row.strAwayTeam), date: row.dateEvent,
      startsAt: dateTime && Number.isFinite(Date.parse(dateTime)) ? dateTime : null, homeScore: number(row.intHomeScore), awayScore: number(row.intAwayScore),
      league: clean(row.strLeague), status: clean(row.strStatus, 80), homeId: clean(row.idHomeTeam, 100), awayId: clean(row.idAwayTeam, 100), source };
  }).sort((a, b) => (a.startsAt || a.date).localeCompare(b.startsAt || b.date));
}
export function normalizeSportsTable(rows) {
  if (rows === null || rows === undefined) return [];
  if (!Array.isArray(rows) || rows.length > 100) fail('积分榜数据无效。');
  return rows.map((row) => ({ id: clean(row.idTeam, 100), name: clean(row.strTeam), rank: number(row.intRank), played: number(row.intPlayed), wins: number(row.intWin), draws: number(row.intDraw), losses: number(row.intLoss), points: number(row.intPoints) }));
}

export function sportsEventDate(row) {
  return row.startsAt && Number.isFinite(Date.parse(row.startsAt)) ? localISODate(new Date(row.startsAt)) : row.date;
}
export function sportsEventPhase(row, now = new Date()) {
  const status = String(row.status || '').trim().toLowerCase();
  if (/^(live|in play|in progress|1h|2h|ht|halftime|half time|进行中|中场)$/.test(status)) return 'live';
  if (/^(cancelled|canceled|postponed|abandoned|suspended|推迟|取消|中断)$/.test(status)) return 'postponed';
  if (/^(ft|aet|ap|finished|match finished|full time|full-time|完场|已结束)$/.test(status)) return 'results';
  if (row.homeScore !== null && row.homeScore !== undefined && row.awayScore !== null && row.awayScore !== undefined) return 'results';
  const timestamp = row.startsAt ? Date.parse(row.startsAt) : NaN;
  if (Number.isFinite(timestamp) ? timestamp > Number(now) : row.date >= localISODate(new Date(now))) return 'upcoming';
  return 'unknown';
}
export function selectSportsEvents(rows, { view = 'matches', date = localISODate(), team, now = new Date() } = {}) {
  const when = (row) => Number.isFinite(Date.parse(row.startsAt)) ? Date.parse(row.startsAt) : new Date(`${row.date}T00:00:00`).getTime();
  return rows.filter((row) => {
    if (team && row.homeId !== team.id && row.awayId !== team.id && ![row.home, row.away].some((name) => name.toLocaleLowerCase() === team.name.toLocaleLowerCase())) return false;
    if (view === 'matches') return sportsEventDate(row) === date;
    if (view === 'upcoming') return sportsEventPhase(row, now) === 'upcoming';
    if (view === 'results') return sportsEventPhase(row, now) === 'results';
    return true;
  }).sort((a, b) => view === 'results' ? when(b) - when(a) : when(a) - when(b));
}

// Imported and synchronized documents must satisfy their domain before mounting.
// Unknown future fields are preserved; known financial and binary values are strict.
export function validateMarketData(id, data) {
  const invalid = () => fail('扩展数据格式无效。');
  const obj = (value) => value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Blob);
  const str = (value, max = 2000) => typeof value === 'string' && value.length <= max;
  const list = (value, max) => Array.isArray(value) && value.length <= max;
  const ids = (rows) => rows.every((row) => obj(row) && str(row.id, 200) && row.id) && new Set(rows.map((row) => row.id)).size === rows.length;
  if (!obj(data)) invalid();
  if (id === 'currency') {
    currencyCode(data.base); currencyCode(data.target);
    if (!str(data.amount, 40) || !list(data.favorites, 20)) invalid();
    for (const code of data.favorites) currencyCode(code);
    if (data.cache !== null) {
      const cache = data.cache;
      if (!obj(cache) || !obj(cache.rates) || Object.keys(cache.rates).length > 300 || !validISODate(cache.date) || !Number.isFinite(cache.fetchedAt) || !obj(cache.dates)) invalid();
      currencyCode(cache.base);
      for (const [code, rate] of Object.entries(cache.rates)) { currencyCode(code); if (!str(rate, 40) || decimal(rate).numerator <= 0n) invalid(); }
      if (!str(cache.source, 80) || Object.values(cache.dates).some((date) => !validISODate(date))) invalid();
    }
  } else if (id === 'stocks') {
    if (!list(data.lists, 10) || !data.lists.length || !ids(data.lists) || !list(data.symbols, 200) || !ids(data.symbols) || !obj(data.settings) || !['public', 'twelve', 'alpha'].includes(data.settings.provider)
      || !str(data.settings.apiKey, 300) || !['unknown', 'realtime', 'delayed', 'eod'].includes(data.settings.delay) || !['red-up', 'green-up'].includes(data.settings.colors) || !obj(data.quotes) || !obj(data.series)) invalid();
    if (!str(data.selectedList, 200) || !data.lists.some((row) => row.id === data.selectedList)) invalid();
    for (const row of data.lists) if (!str(row.name, 80)) invalid();
    for (const row of data.symbols) { stockSymbol(row.symbol); if (!data.lists.some((item) => item.id === row.listId) || !str(row.exchange, 40) || !str(row.name, 100)) invalid(); }
    if (Object.keys(data.quotes).length > 200 || Object.keys(data.series).length > 50) invalid();
    for (const row of Object.values(data.quotes)) {
      if (!obj(row) || !Number.isFinite(row.price) || !Number.isFinite(row.fetchedAt) || !str(row.date, 64) || !str(row.name, 200) || !str(row.symbol, 40) || !str(row.exchange, 60) || !str(row.currency, 10) || !str(row.source, 80)
        || !['change', 'percent', 'open', 'high', 'low', 'previous', 'volume'].every((key) => row[key] === null || Number.isFinite(row[key])) || ![null, true, false].includes(row.marketOpen)) invalid();
    }
    for (const rows of Object.values(data.series)) if (!list(rows, 366) || rows.some((row) => !obj(row) || !str(row.date, 32) || !Number.isFinite(row.price))) invalid();
  } else if (id === 'ledger') {
    if (!list(data.accounts, 30) || !ids(data.accounts) || !list(data.transactions, 10000) || !ids(data.transactions) || !list(data.budgets, 1000) || !ids(data.budgets) || !list(data.bills, 500) || !ids(data.bills)) invalid();
    for (const row of data.accounts) { currencyCode(row.currency); if (!str(row.name, 80) || !Number.isSafeInteger(row.opening)) invalid(); }
    for (const row of [...data.transactions, ...data.bills]) {
      const account = data.accounts.find((item) => item.id === row.accountId);
      if (!account || row.currency !== account.currency || !['income', 'expense'].includes(row.kind) || !Number.isSafeInteger(row.amount) || row.amount <= 0 || !str(row.category, 80) || !validISODate(row.date)) invalid();
      if (row.note !== undefined && !str(row.note, 2000)) invalid();
      if (data.bills.includes(row) && (!validISODate(row.nextDate) || !['weekly', 'monthly', 'yearly'].includes(row.cadence) || !str(row.name, 100)
        || row.anchorDay !== undefined && (!Number.isInteger(row.anchorDay) || row.anchorDay < 1 || row.anchorDay > 31))) invalid();
    }
    for (const row of data.budgets) { currencyCode(row.currency); if (!/^\d{4}-\d{2}$/.test(row.month) || !str(row.category, 80) || !Number.isSafeInteger(row.amount) || row.amount <= 0) invalid(); }
    for (const account of data.accounts) {
      let balance = BigInt(account.opening);
      for (const row of data.transactions) if (row.accountId === account.id) balance += BigInt(row.kind === 'income' ? row.amount : -row.amount);
      if (balance > BigInt(Number.MAX_SAFE_INTEGER) || balance < BigInt(-Number.MAX_SAFE_INTEGER)) invalid();
    }
  } else if (id === 'orders') {
    if (!list(data.items, 300) || !ids(data.items) || !obj(data.tracking) || !str(data.tracking.endpoint, 2000) || !str(data.tracking.apiKey, 300)) invalid();
    let size = 0;
    for (const row of data.items) {
      if (!str(row.title, 200) || !validISODate(row.boughtOn) || !['ordered', 'shipping', 'received', 'returned'].includes(row.status) || !list(row.attachments, 4) || !ids(row.attachments)) invalid();
      for (const key of ['seller', 'orderNumber', 'trackingNumber', 'carrier', 'serial']) if (!str(row[key], 200)) invalid();
      for (const key of ['returnBy', 'warrantyUntil']) if (!str(row[key], 10) || row[key] && !validISODate(row[key])) invalid();
      if (row.note !== undefined && !str(row.note, 2000)) invalid();
      if (row.tracking !== undefined && (!obj(row.tracking) || !str(row.tracking.status, 100) || !Number.isFinite(row.tracking.updatedAt) || !list(row.tracking.events, 100)
        || row.tracking.events.some((event) => !obj(event) || !str(event.time, 64) || !str(event.description, 1000) || !str(event.location, 200)))) invalid();
      for (const file of row.attachments) {
        if (!(file.blob instanceof Blob) || file.blob.size > 2 * 1024 * 1024 || !['application/pdf', 'image/png', 'image/jpeg', 'image/webp'].includes(file.blob.type) || !str(file.name, 200)) invalid(); size += file.blob.size;
      }
    }
    if (size > 8 * 1024 * 1024) invalid();
  } else if (id === 'sports') {
    if (!list(data.teams, 30) || !ids(data.teams) || !list(data.events, 3000) || !ids(data.events) || !obj(data.tables) || !obj(data.settings) || !str(data.settings.apiKey, 200) || !str(data.settings.leagueId, 12) || !str(data.settings.season, 20)) invalid();
    if (data.settings.provider !== undefined && !['openliga', 'sportsdb'].includes(data.settings.provider) || data.settings.league !== undefined && !/^[a-z0-9_-]{1,20}$/i.test(data.settings.league)) invalid();
    for (const row of data.events) {
      if (!str(row.home, 200) || !str(row.away, 200) || !validISODate(row.date) || !str(row.source, 40) || ![row.homeScore, row.awayScore].every((score) => score === null || Number.isSafeInteger(score) && score >= 0)) invalid();
    }
    for (const row of data.teams) if (!str(row.name, 200) || !str(row.league, 200)) invalid();
    if (Object.keys(data.tables).length > 50) invalid();
    for (const rows of Object.values(data.tables)) if (!list(rows, 100) || rows.some((row) => !obj(row) || !str(row.name, 200) || !str(row.id, 100)
      || !['rank', 'played', 'wins', 'draws', 'losses', 'points'].every((key) => row[key] === null || Number.isSafeInteger(row[key])))) invalid();
  } else invalid();
  return data;
}
