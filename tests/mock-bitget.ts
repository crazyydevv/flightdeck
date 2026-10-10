// A stand-in for api.bitget.com, shaped like the real v2 mix responses, so the
// live path can be tested without network or keys. It checks the request
// signature and the demo-trading header on every signed call.
//
// Run it on its own to try the app's Live feed offline:
//   npx tsx tests/mock-bitget.ts            (then BITGET_BASE_URL=http://localhost:4810 npm run dev)

import { createHmac } from 'node:crypto';
import { createServer, Server } from 'node:http';
import { snapshot } from '../src/core/market';

export const MOCK_SECRET = 'mock-secret';

export function startMock(port = 0): Promise<{ server: Server; url: string; orders: Record<string, unknown>[] }> {
  const m = snapshot();
  const orders: Record<string, unknown>[] = [];
  // shift the recorded bars so the newest one ends "now", as live data would
  const shift = Math.floor(Date.now() / 3_600_000) * 3_600_000 + 3_600_000 - m.asOf;
  const rows = (symbol: string, daily: boolean) =>
    (daily ? m.daily : m.hourly)[symbol].map((c) => [String(c.t + shift), String(c.o), String(c.h), String(c.l), String(c.c), '100', '10000']);
  const ok = (data: unknown) => JSON.stringify({ code: '00000', msg: 'success', requestTime: Date.now(), data });

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://mock');
    const symbol = url.searchParams.get('symbol') ?? '';
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'GET' && /history/.test(url.pathname)) {
      // signed reads: the signature covers the path and the exact query string
      const ts = String(req.headers['access-timestamp']);
      const want = createHmac('sha256', MOCK_SECRET).update(ts + 'GET' + url.pathname + url.search).digest('base64');
      if (req.headers['access-sign'] !== want) return res.end(JSON.stringify({ code: '40009', msg: 'sign signature error', data: null }));
      const now = Date.now();
      if (url.pathname.endsWith('/history-position')) {
        return res.end(ok({ endId: '9', list: [
          { positionId: '1300000000000000111', symbol: 'NVDAUSDT', marginCoin: 'USDT', holdSide: 'long', openAvgPrice: '230', closeAvgPrice: '226', marginMode: 'isolated', openTotalPos: '10', closeTotalPos: '10', pnl: '-40', netProfit: '-42.76', totalFunding: '0', openFee: '-1.38', closeFee: '-1.38', ctime: String(now - 5 * 86_400_000), utime: String(now - 5 * 86_400_000 + 7_200_000) },
          { positionId: '1300000000000000222', symbol: 'BTCUSDT', marginCoin: 'USDT', holdSide: 'short', openAvgPrice: '84000', closeAvgPrice: '83000', marginMode: 'isolated', openTotalPos: '0.02', closeTotalPos: '0.02', pnl: '20', netProfit: '18', totalFunding: '0', openFee: '-1', closeFee: '-1', ctime: String(now - 3 * 86_400_000), utime: String(now - 3 * 86_400_000 + 3_600_000) },
          { positionId: 'broken', symbol: 'ETHUSDT' },
        ] }));
      }
      return res.end(ok({ entrustedList: [
        { symbol: 'NVDAUSDT', leverage: '12', posSide: 'long', tradeSide: 'open', cTime: String(now - 5 * 86_400_000 - 1000) },
        { symbol: 'NVDAUSDT', leverage: '3', posSide: 'long', tradeSide: 'open', cTime: String(now - 9 * 86_400_000) },
        { symbol: 'BTCUSDT', leverage: '4', posSide: 'short', tradeSide: 'open', cTime: String(now - 3 * 86_400_000 - 500) },
      ] }));
    }
    if (req.method === 'GET') {
      if (url.pathname.endsWith('/tickers')) {
        return res.end(ok(Object.keys(m.hourly).map((s) => {
          const last = m.hourly[s][167].c;
          return { symbol: s, lastPr: String(last), indexPrice: String(last * 0.999), markPrice: String(last), fundingRate: String(m.funding[s] ?? 0), holdingAmount: '1000' };
        })));
      }
      if (!m.hourly[symbol]) return res.end(JSON.stringify({ code: '40034', msg: 'Parameter does not exist', data: null }));
      if (url.pathname.endsWith('/candles')) return res.end(ok(rows(symbol, url.searchParams.get('granularity') === '1D')));
      if (url.pathname.endsWith('/contracts')) {
        const i = m.instruments[symbol];
        return res.end(ok([{ symbol, maxLever: String(i.maxLever), takerFeeRate: '0.0006', makerFeeRate: '0.0002', pricePlace: String(i.pricePlace), volumePlace: String(i.sizePlace), isRwa: i.cls === 'rwa' ? 'YES' : 'NO' }]));
      }
    }
    if (req.method === 'POST') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const ts = String(req.headers['access-timestamp']);
        const want = createHmac('sha256', MOCK_SECRET).update(ts + 'POST' + url.pathname + body).digest('base64');
        if (req.headers['access-sign'] !== want) return res.end(JSON.stringify({ code: '40009', msg: 'sign signature error', data: null }));
        if (req.headers.paptrading !== '1') return res.end(JSON.stringify({ code: '40099', msg: 'mock only accepts demo trading', data: null }));
        const payload = JSON.parse(body);
        orders.push({ path: url.pathname, ...payload });
        res.end(ok(url.pathname.endsWith('/place-order') ? { orderId: '1300000000000000001', clientOid: payload.clientOid } : { symbol: payload.symbol, longLeverage: payload.leverage }));
      });
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ code: '40404', msg: 'Request URL NOT FOUND', data: null }));
  });
  return new Promise((resolve) => server.listen(port, () => {
    const addr = server.address();
    resolve({ server, url: `http://localhost:${typeof addr === 'object' && addr ? addr.port : port}`, orders });
  }));
}

if (process.argv[1]?.endsWith('mock-bitget.ts')) {
  startMock(4810).then(({ url }) => console.log(`Mock Bitget on ${url}`));
}
