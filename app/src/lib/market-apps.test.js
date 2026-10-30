import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseMoney, minorToDecimal, convertCurrencyAmount, currencyCode, normalizeExchangeRates, exchangeCacheState, exchangeRateURL,
  normalizeStockQuote, normalizeStockSeries, chartPolyline, stockURL, trimStockCache, publicStockInstrument, stockWebURL, effectiveStockProvider,
  nextBillDate, postDueBills, ledgerSummary, validateTransaction, deadlineDays,
  normalizeSportsEvents, normalizeSportsTable, sportsURL, sportsEventPhase, selectSportsEvents, sportsEventDate, localISODate, trackingURL, normalizeTracking,
  MARKET_DEFAULTS, validateMarketData, sportsProvider, openLigaSeason, openLigaURL, openLigaTableKey, normalizeOpenLigaTeams, normalizeOpenLigaEvents, normalizeOpenLigaTable, officialTrackingURL,
} from './market-apps.js';

test('money uses exact minor units and rejects excess precision, unsafe values and malformed currencies', () => {
  assert.equal(parseMoney('0.29', 'USD'), 29);
  assert.equal(parseMoney('100.01', 'CNY'), 10001);
  assert.equal(parseMoney('-0.01', 'CNY'), -1);
  assert.equal(parseMoney('123', 'JPY'), 123);
  assert.equal(parseMoney('0.123', 'KWD'), 123);
  assert.equal(minorToDecimal(123, 'KWD'), '0.123');
  assert.equal(minorToDecimal(-1, 'USD'), '-0.01');
  for (const invalid of ['1e3', 'NaN', '1.001', '', '1,000', '99999999999999999']) assert.throws(() => parseMoney(invalid, 'USD'));
  assert.throws(() => parseMoney('1.0', 'JPY'));
  assert.throws(() => currencyCode('USDX'));
});

test('currency conversion supports reverse cross-rates and rounding without float drift', () => {
  assert.equal(convertCurrencyAmount('1', '1', '7.12345', 2), '7.12');
  assert.equal(convertCurrencyAmount('7.12345', '7.12345', '1', 2), '1.00');
  assert.equal(convertCurrencyAmount('100', '0.8', '1.2', 2), '150.00');
  assert.equal(convertCurrencyAmount('0.1', '1', '3', 2), '0.30');
  assert.equal(convertCurrencyAmount('1.005', '1', '1', 2), '1.01');
  assert.equal(convertCurrencyAmount('0', '1', '156.25', 0), '0');
  assert.equal(convertCurrencyAmount('0.0001', '1', '1', 3), '0.000');
  assert.throws(() => convertCurrencyAmount('1', '0', '1'));
  assert.throws(() => convertCurrencyAmount('-1', '1', '1'));
});

test('rates keep their actual publishing dates and distinguish missing, partial and old cache', () => {
  const rows = [{ base: 'USD', quote: 'CNY', rate: 7.1, date: '2026-10-29' }, { base: 'USD', quote: 'EUR', rate: 0.85, date: '2026-10-28' }];
  const saved = normalizeExchangeRates(rows, 'USD', 123);
  assert.equal(saved.rates.USD, '1'); assert.equal(saved.date, '2026-10-28'); assert.equal(saved.dates.CNY, '2026-10-29'); assert.equal(saved.fetchedAt, 123);
  assert.equal(exchangeCacheState(null, ['USD']), 'missing');
  assert.equal(exchangeCacheState(saved, ['USD', 'CNY'], '2026-10-30'), 'available');
  assert.equal(exchangeCacheState(saved, ['GBP'], '2026-10-30'), 'incomplete');
  assert.equal(exchangeCacheState(saved, ['USD', 'CNY'], '2026-11-20'), 'stale');
  assert.equal(convertCurrencyAmount('1', saved.rates.USD, saved.rates.CNY), '7.10');
  for (const invalid of [[], [{ ...rows[0], rate: null }], [{ ...rows[0], rate: 0 }], [{ ...rows[0], date: '2026-02-31' }], [{ ...rows[0], base: 'EUR' }]]) assert.throws(() => normalizeExchangeRates(invalid));
  const url = new URL(exchangeRateURL(['USD', 'CNY', 'CNY'], '2026-10-28'));
  assert.equal(url.origin, 'https://api.frankfurter.dev'); assert.equal(url.searchParams.get('quotes'), 'CNY'); assert.equal(url.searchParams.get('date'), '2026-10-28');
});

test('quotes retain genuine zero values and never invent absent provider data', () => {
  const quote = normalizeStockQuote({ symbol: 'AAPL', close: '0', change: '0', percent_change: '0', volume: '0', datetime: '2026-10-29', is_market_open: false }, 'twelve', 'AAPL', 1);
  assert.equal(quote.price, 0); assert.equal(quote.change, 0); assert.equal(quote.percent, 0); assert.equal(quote.volume, 0); assert.equal(quote.marketOpen, false); assert.equal(quote.open, null);
  assert.throws(() => normalizeStockQuote({}, 'twelve', 'AAPL'));
  assert.throws(() => normalizeStockQuote({ status: 'error', message: 'limit' }, 'twelve', 'AAPL'));
  assert.throws(() => normalizeStockQuote({ Information: 'API rate limit' }, 'alpha', 'AAPL'));
  const alpha = normalizeStockQuote({ 'Global Quote': { '01. symbol': 'IBM', '05. price': '12.5', '09. change': '-1', '10. change percent': '-8%' } }, 'alpha');
  assert.equal(alpha.price, 12.5); assert.equal(alpha.percent, -8); assert.equal(alpha.currency, '');
  assert.throws(() => stockURL('twelve', 'quote', { symbol: 'AAPL' }, ''));
});

test('stock charts are chronological, bounded, finite for flat prices and keep previous chart on quote-only refresh', () => {
  const points = normalizeStockSeries({ values: [{ datetime: '2026-10-30', close: '2' }, { datetime: '2026-10-29', close: '2' }] }, 'twelve');
  assert.equal(points[0].date, '2026-10-29'); assert.ok(!chartPolyline(points).includes('NaN'));
  assert.ok(chartPolyline([points[0]]).startsWith('300.00,'));
  assert.throws(() => normalizeStockSeries({ values: [] }, 'twelve'));
  const old = { quotes: { a: { fetchedAt: 1 } }, series: { a: points } };
  const next = trimStockCache(old, 'a', { fetchedAt: 2 }, undefined);
  assert.deepEqual(next.series.a, points); assert.equal(old.quotes.a.fetchedAt, 1); assert.equal(next.quotes.a.fetchedAt, 2);
});

test('ledger keeps currencies separate and validates positive entries against their account', () => {
  const accounts = [{ id: 'cny', currency: 'CNY' }, { id: 'usd', currency: 'USD' }];
  const transaction = validateTransaction({ accountId: 'cny', kind: 'expense', amount: '0.29', category: 'Food', date: '2026-10-30' }, accounts);
  assert.equal(transaction.amount, 29); assert.equal(transaction.currency, 'CNY');
  const summary = ledgerSummary({ transactions: [transaction, { ...transaction, accountId: 'usd', currency: 'USD', amount: 500 }] }, '2026-10', 'CNY');
  assert.equal(summary.expense, 29); assert.equal(summary.balance, -29);
  assert.throws(() => validateTransaction({ ...transaction, amount: '0' }, accounts));
  assert.throws(() => validateTransaction({ ...transaction, amount: '1', date: '2026-02-31' }, accounts));
  assert.throws(() => validateTransaction({ ...transaction, amount: '1', accountId: 'removed' }, accounts));
});

test('periodic bills clamp calendar dates and confirmed posting is idempotent', () => {
  assert.equal(nextBillDate('2026-01-31', 'monthly'), '2026-02-28');
  assert.equal(nextBillDate('2028-02-29', 'yearly'), '2029-02-28');
  assert.equal(nextBillDate('2026-02-28', 'monthly', 31), '2026-03-31');
  const input = { accounts: [{ id: 'a', currency: 'CNY' }], transactions: [], bills: [{ id: 'b', name: 'Rent', accountId: 'a', currency: 'CNY', amount: 10000, kind: 'expense', category: 'Home', nextDate: '2026-10-01', cadence: 'monthly' }] };
  const posted = postDueBills(input, '2026-10-30');
  assert.equal(posted.posted, 1); assert.equal(posted.data.transactions[0].date, '2026-10-01'); assert.equal(posted.data.bills[0].nextDate, '2026-11-01');
  assert.equal(postDueBills(posted.data, '2026-10-30').posted, 0); assert.equal(input.transactions.length, 0);
  assert.throws(() => postDueBills({ ...input, accounts: [] }, '2026-10-30'));
});

test('imported market documents validate domain types and binary receipts before mounting', () => {
  for (const [id, defaults] of Object.entries(MARKET_DEFAULTS)) assert.equal(validateMarketData(id, defaults), defaults);
  assert.throws(() => validateMarketData('currency', { ...MARKET_DEFAULTS.currency, favorites: ['TOOLONG'] }));
  assert.throws(() => validateMarketData('stocks', { ...MARKET_DEFAULTS.stocks, lists: [] }));
  assert.throws(() => validateMarketData('ledger', { ...MARKET_DEFAULTS.ledger, accounts: [{ id: 'bad', currency: 'USD', name: 'x', opening: 0.1 }] }));
  assert.throws(() => validateMarketData('orders', { ...MARKET_DEFAULTS.orders, items: [{}] }));
  assert.throws(() => validateMarketData('sports', { ...MARKET_DEFAULTS.sports, events: [{ id: 'a', home: 'x', away: 'y', date: '2026-10-30', source: 'manual', homeScore: -1, awayScore: null }] }));
});

test('order deadlines and tracking preserve data-only events and encode tracking IDs', () => {
  assert.equal(deadlineDays('2026-10-31', '2026-10-30'), 1); assert.equal(deadlineDays('2026-02-31', '2026-10-30'), null);
  const url = new URL(trackingURL('https://example.com/track/{number}', 'A/B?x'));
  assert.equal(url.pathname, '/track/A%2FB%3Fx');
  assert.throws(() => trackingURL('http://example.com/{number}', '123'));
  assert.throws(() => trackingURL('https://example.com/', '123'));
  assert.deepEqual(normalizeTracking({ status: 'In transit', events: [{ description: 'Arrived', time: '2026-10-30', location: 'Depot' }] }).events[0], { description: 'Arrived', time: '2026-10-30', location: 'Depot' });
  assert.throws(() => normalizeTracking({ events: [{ description: '' }] }));
});

test('sports parsing retains nil and zero scores, UTC source times and no-data responses', () => {
  assert.deepEqual(normalizeSportsEvents(null), []); assert.deepEqual(normalizeSportsTable(null), []);
  const [event] = normalizeSportsEvents([{ idEvent: '123', dateEvent: '2026-10-30', strTime: '20:30:00', strHomeTeam: 'Home', strAwayTeam: 'Away', intHomeScore: '0', intAwayScore: null }]);
  assert.equal(event.homeScore, 0); assert.equal(event.awayScore, null); assert.equal(event.startsAt, '2026-10-30T20:30:00Z');
  assert.throws(() => normalizeSportsEvents([{ idEvent: '123', dateEvent: '2026-02-31' }]));
  assert.throws(() => sportsURL('eventsnext', { id: '123' }));
  assert.equal(new URL(sportsURL('eventsnext', { id: '123' }, 'USER_TEST_KEY')).pathname, '/api/v1/json/USER_TEST_KEY/eventsnext.php');
  assert.throws(() => sportsURL('eventsnext', { id: '123' }, '../bad'));
});

test('public sources are keyless defaults while explicitly configured existing providers remain selected', () => {
  assert.equal(MARKET_DEFAULTS.stocks.settings.provider, 'public');
  assert.equal(effectiveStockProvider({ provider: 'twelve', apiKey: '' }), 'public');
  assert.equal(effectiveStockProvider({ provider: 'alpha', apiKey: 'existing-user-key' }), 'alpha');
  assert.equal(sportsProvider(MARKET_DEFAULTS.sports.settings), 'openliga');
  assert.equal(sportsProvider({ apiKey: 'existing-user-key' }), 'sportsdb');
  assert.equal(sportsProvider({ apiKey: '', leagueId: '4328' }), 'openliga');
  assert.equal(validateMarketData('sports', { ...MARKET_DEFAULTS.sports, settings: { apiKey: 'existing', leagueId: '4328', season: '2026-2027' } }).settings.apiKey, 'existing');
});

test('public stock URLs cover only MOEX equities and external global quote links encode the entire ticker', () => {
  assert.equal(publicStockInstrument('SBER.ME'), 'SBER'); assert.equal(publicStockInstrument('GAZP', 'MOEX'), 'GAZP');
  assert.equal(publicStockInstrument('AAPL'), null);
  assert.throws(() => stockURL('public', 'quote', { symbol: 'AAPL' }));
  const url = new URL(stockURL('public', 'series', { symbol: 'SBER.ME' }));
  assert.equal(url.origin, 'https://iss.moex.com'); assert.ok(url.pathname.endsWith('/SBER/candles.json')); assert.equal(url.searchParams.get('interval'), '24'); assert.equal(url.searchParams.has('apikey'), false);
  assert.equal(new URL(stockWebURL('^GSPC')).pathname, '/quote/%5EGSPC/'); assert.throws(() => stockWebURL('javascript:alert(1)'));
});

test('MOEX quotes map actual fields, preserve zero values and label previous-close fallback without inventing daily stats', () => {
  const securities = { columns: ['SECID', 'LATNAME', 'PREVPRICE', 'PREVDATE', 'CURRENCYID'], data: [['SBER', 'Sberbank', 294.45, '2026-10-29', 'SUR']] };
  const marketdata = { columns: ['LAST', 'CHANGE', 'LASTTOPREVPRICE', 'OPEN', 'LOW', 'HIGH', 'VOLTODAY', 'TRADINGSTATUS', 'SYSTIME', 'UPDATETIME'], data: [[295.36, 0, 0, 294, 293, 296, 0, 'T', '2026-10-30 12:06:11', '11:51:10']] };
  const quote = normalizeStockQuote({ securities, marketdata }, 'public', 'SBER.ME', 1234);
  assert.equal(quote.price, 295.36); assert.equal(quote.currency, 'RUB'); assert.equal(quote.percent, 0); assert.equal(quote.volume, 0); assert.equal(quote.marketOpen, true); assert.equal(quote.date, '2026-10-30 11:51:10 MSK'); assert.equal(quote.fetchedAt, 1234);
  const previous = normalizeStockQuote({ securities, marketdata: { ...marketdata, data: [] } }, 'public', 'SBER.ME');
  assert.equal(previous.price, 294.45); assert.equal(previous.change, null); assert.equal(previous.open, null); assert.equal(previous.date, '2026-10-29'); assert.ok(previous.source.includes('previous close'));
  assert.throws(() => normalizeStockQuote({ securities: { ...securities, data: [] }, marketdata }, 'public', 'SBER.ME'));
  assert.throws(() => normalizeStockQuote({ securities, marketdata }, 'public', 'GAZP.ME'));
  assert.deepEqual(normalizeStockSeries({ candles: { columns: ['begin', 'close'], data: [['2026-10-29 00:00:00', 0], ['2026-10-30 00:00:00', 295]] } }, 'public').map(row => row.price), [0, 295]);
});

test('OpenLiga public URLs select actual community league seasons with no implicit test key', () => {
  assert.equal(openLigaSeason({}, new Date('2026-02-03')), '2025'); assert.equal(openLigaSeason({}, new Date('2026-10-30')), '2026');
  assert.equal(openLigaSeason({ season: '2025-2026' }), '2025');
  assert.equal(openLigaURL('getmatchdata', { league: 'bl2', season: '2026' }), 'https://api.openligadb.de/getmatchdata/bl2/2026');
  assert.equal(openLigaTableKey({ league: 'bl1', season: '2026' }), 'openliga:bl1:2026');
  assert.throws(() => openLigaURL('getmatchdata', { league: '../private' })); assert.throws(() => openLigaURL('delete', {}));
});

test('OpenLiga normalization chooses the final result, never treats future default zero scores as results and namespaces teams', () => {
  const now = Date.parse('2026-10-30T12:00:00Z');
  const row = { matchID: 83156, team1: { teamId: 40, teamName: 'Bayern' }, team2: { teamId: 16, teamName: 'Stuttgart' }, matchDateTimeUTC: '2026-10-30T10:00:00Z', matchIsFinished: true, leagueName: 'Bundesliga', matchResults: [{ resultOrderID: 1, pointsTeam1: 1, pointsTeam2: 0 }, { resultOrderID: 2, pointsTeam1: 5, pointsTeam2: 1 }] };
  const result = normalizeOpenLigaEvents([row], 'openliga:bl1:2026', now)[0]; assert.equal(result.homeScore, 5); assert.equal(result.awayScore, 1); assert.equal(result.homeId, 'openliga:40'); assert.equal(result.status, 'FT');
  const future = normalizeOpenLigaEvents([{ ...row, matchIsFinished: false, matchDateTimeUTC: '2026-11-01T10:00:00Z' }], 'k', now)[0]; assert.equal(future.homeScore, null); assert.equal(future.awayScore, null);
  const stale = normalizeOpenLigaEvents([{ ...row, matchIsFinished: false, matchDateTimeUTC: '2026-10-01T10:00:00Z' }], 'k', now)[0]; assert.equal(stale.homeScore, null); assert.equal(sportsEventPhase(stale, now), 'unknown');
  assert.equal(normalizeOpenLigaTeams([{ teamId: 40, teamName: 'Bayern', teamIconUrl: 'https://unlicensed.example/image' }])[0].id, 'openliga:40');
  const table = normalizeOpenLigaTable([{ teamInfoId: 40, teamName: 'Bayern', points: 0, matches: 0, won: 0, draw: 0, lost: 0 }]); assert.equal(table[0].points, 0); assert.equal(table[0].rank, 1); assert.equal(Object.hasOwn(table[0], 'teamIconUrl'), false);
  assert.throws(() => normalizeOpenLigaTable([{}])); assert.throws(() => normalizeOpenLigaEvents([{ ...row, matchDateTimeUTC: '' }], 'k'));
});

test('official carrier links are fixed trusted sites, preserve tracking IDs safely and require no API configuration', () => {
  const ups = new URL(officialTrackingURL('UPS', 'A/B?secret=#x')); assert.equal(ups.origin, 'https://www.ups.com'); assert.equal(ups.searchParams.get('tracknum'), 'A/B?secret=#x');
  assert.equal(new URL(officialTrackingURL('FedEx', '123')).searchParams.get('trknbr'), '123');
  assert.equal(new URL(officialTrackingURL('DHL', '123')).searchParams.get('tracking-id'), '123');
  assert.equal(new URL(officialTrackingURL('USPS', '123')).searchParams.get('tLabels'), '123');
  assert.equal(new URL(officialTrackingURL('顺丰', '123')).hostname, 'www.sf-express.com');
  assert.equal(officialTrackingURL('Unknown carrier', '123'), null); assert.equal(officialTrackingURL('UPS', ''), null);
});

test('sports views order nearest upcoming and newest finished, excluding old unknown and live zero scores', () => {
  const now = new Date('2026-10-30T12:00:00Z');
  const fixture = (id, date, extras = {}) => ({ id, home: 'Home', away: 'Away', date, homeScore: null, awayScore: null, status: '', ...extras });
  const rows = [fixture('later', '2026-11-04'), fixture('near', '2026-11-01'), fixture('oldUnknown', '2026-10-01'), fixture('oldResult', '2026-10-01', { homeScore: 0, awayScore: 0 }), fixture('recentResult', '2026-10-29', { status: 'FT', homeScore: 0, awayScore: 2 }), fixture('live', '2026-10-30', { status: '1H', homeScore: 0, awayScore: 0 }), fixture('postponed', '2026-11-02', { status: 'Postponed' })];
  assert.deepEqual(selectSportsEvents(rows, { view: 'upcoming', now }).map((row) => row.id), ['near', 'later']);
  assert.deepEqual(selectSportsEvents(rows, { view: 'results', now }).map((row) => row.id), ['recentResult', 'oldResult']);
  assert.equal(sportsEventPhase(rows.find((row) => row.id === 'oldUnknown'), now), 'unknown');
  assert.equal(sportsEventPhase(rows.find((row) => row.id === 'live'), now), 'live');
  assert.equal(rows[0].id, 'later', 'selection must not mutate persistent event order');
});

test('sports calendar uses local start date and filters provider IDs as well as manually followed names', () => {
  const startsAt = '2026-10-30T23:30:00-08:00', date = localISODate(new Date(startsAt));
  const rows = [{ id: 'real', home: 'Arsenal', away: 'Chelsea', homeId: '133604', awayId: '133610', date: '2026-10-30', startsAt }, { id: 'manual', home: 'arsenal', away: 'Home', date }, { id: 'other', home: 'Other', away: 'Else', date }];
  assert.equal(sportsEventDate(rows[0]), date);
  assert.deepEqual(selectSportsEvents(rows, { view: 'matches', date, team: { id: '133604', name: 'Arsenal' } }).map((row) => row.id).sort(), ['manual', 'real']);
  assert.equal(selectSportsEvents(rows, { view: 'matches', date: '2020-01-01' }).length, 0);
});
