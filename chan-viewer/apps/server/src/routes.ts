// API 路由：/api/symbols、/api/kline、/api/minkline、/api/mincap。只读供数，不做缠论计算（引擎在 web 端）。
import type { IncomingMessage, ServerResponse } from 'node:http';
import { lookupSymbol, minCapability, queryKline, queryMinKline, searchSymbols } from './db.js';

const ADJUST_LABEL: Record<string, string> = { '1': '后复权', '2': '前复权', '3': '不复权' };

function json(res: ServerResponse, status: number, body: unknown): void {
  const s = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(s);
}

export function handleApi(req: IncomingMessage, res: ServerResponse, url: URL): boolean {
  const p = url.pathname;
  if (p === '/api/symbols') {
    const q = url.searchParams.get('q') ?? '';
    const kind = url.searchParams.get('kind') ?? 'all';
    const includeDelisted = url.searchParams.get('includeDelisted') === '1';
    const symbols = searchSymbols(q, kind, includeDelisted);
    json(res, 200, { symbols });
    return true;
  }
  if (p === '/api/kline') {
    const code = url.searchParams.get('code');
    if (!code) return json(res, 400, { error: '缺少 code 参数' }), true;
    const sym = lookupSymbol(code);
    if (!sym) return json(res, 404, { error: `未知标的：${code}` }), true;

    const isIndex = sym.kind === 'index';
    const adjust = url.searchParams.get('adjust');
    if (!isIndex && !adjust) return json(res, 400, { error: 'adjust 必填（1后复权/2前复权/3不复权），无隐式默认' }), true;
    if (!isIndex && !ADJUST_LABEL[adjust!]) return json(res, 400, { error: `adjust 非法：${adjust}` }), true;

    let limit = Number(url.searchParams.get('limit') ?? 400);
    if (!Number.isFinite(limit) || limit <= 0) limit = 400;
    limit = Math.min(limit, 2000);
    const start = url.searchParams.get('start') ?? undefined;
    const end = url.searchParams.get('end') ?? undefined;

    const data = queryKline({ code, kind: sym.kind, adjust: adjust ?? '3', start, end, limit });
    const warnings: string[] = [];
    if (!isIndex && adjust === '2') {
      warnings.push('前复权价格随最新分红送转改写历史，PIT 审计建议用后复权（adjust=1）。复权基准日约为数据最新日。');
    }
    if (isIndex && adjust) warnings.push('指数无复权概念，已忽略 adjust 参数。');
    if (data.filteredSuspended > 0) warnings.push(`已过滤 ${data.filteredSuspended} 个停牌占位行（trade_status=0）。`);
    if (data.bars.length === 0) warnings.push('该区间无数据。');

    json(res, 200, {
      bars: data.bars,
      meta: {
        source: 'baostock',
        code: sym.code,
        codeName: sym.code_name,
        kind: sym.kind,
        status: sym.status,
        adjust: isIndex ? null : adjust,
        adjustLabel: isIndex ? '指数不复权' : ADJUST_LABEL[adjust!],
        adjustBasisDate: !isIndex && adjust === '2' ? data.lastDate : null,
        filteredSuspended: data.filteredSuspended,
        firstDate: data.firstDate,
        lastDate: data.lastDate,
        dataAsOf: data.lastDate,
        count: data.bars.length,
        warnings,
      },
    });
    return true;
  }
  if (p === '/api/mincap') {
    const code = url.searchParams.get('code');
    if (!code) return json(res, 400, { error: '缺少 code 参数' }), true;
    json(res, 200, minCapability(code));
    return true;
  }
  if (p === '/api/minkline') {
    const code = url.searchParams.get('code');
    if (!code) return json(res, 400, { error: '缺少 code 参数' }), true;
    const sym = lookupSymbol(code);
    if (!sym) return json(res, 404, { error: `未知标的：${code}` }), true;
    if (sym.kind === 'index') return json(res, 400, { error: '指数无分钟线（分钟数据仅覆盖部分股票）' }), true;

    let freq = Number(url.searchParams.get('freq') ?? 30);
    if (![5, 15, 30, 60].includes(freq)) freq = 30;
    let limit = Number(url.searchParams.get('limit') ?? 400);
    if (!Number.isFinite(limit) || limit <= 0) limit = 400;
    limit = Math.min(limit, 2000);
    const start = url.searchParams.get('start') ?? undefined;
    const end = url.searchParams.get('end') ?? undefined;

    const cap = minCapability(code);
    const warnings: string[] = [];
    if (!cap.hasMin) warnings.push('该标的无分钟线数据（分钟线仅覆盖部分股票，2020年起）。');
    const bars = cap.hasMin ? queryMinKline({ code, freq, start, end, limit }) : [];
    if (cap.hasMin && bars.length === 0) warnings.push('该区间无分钟数据。');
    json(res, 200, {
      // date 字段承载完整时间戳（YYYY-MM-DD HH:MM:SS），供引擎/图表使用。
      bars: bars.map((b) => ({ date: b.time, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume, amount: b.amount, pct_chg: null, is_st: null })),
      meta: {
        source: 'baostock_min', code, freq, adjust: '3', adjustLabel: '不复权',
        hasMin: cap.hasMin, firstTime: cap.firstTime, lastTime: cap.lastTime,
        dataAsOf: cap.lastTime, count: bars.length, warnings,
      },
    });
    return true;
  }
  if (p.startsWith('/api/')) {
    json(res, 404, { error: `未知接口：${p}` });
    return true;
  }
  return false;
}