// API 路由：/api/symbols、/api/kline、/api/minkline、/api/mincap。只读供数，不做缠论计算（引擎在 web 端）。
import type { IncomingMessage, ServerResponse } from 'node:http';
import { lookupSymbol, minCapability, queryKline, queryMinKlineData, searchSymbols } from './db.js';

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
    if (limit !== 0 && (!Number.isFinite(limit) || limit < 0)) limit = 400;
    if (limit !== 0) limit = Math.min(limit, 2000); // 显式 limit=0 = 全量
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
        timezone: 'Asia/Shanghai',
        timeBasis: 'bar-end',
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
    if (limit !== 0 && (!Number.isFinite(limit) || limit < 0)) limit = 400;
    if (limit !== 0) limit = Math.min(limit, 2000); // 显式 limit=0 = 全量
    const start = url.searchParams.get('start') ?? undefined;
    const end = url.searchParams.get('end') ?? undefined;

    const cap = minCapability(code);
    const warnings: string[] = [];
    if (!cap.hasMin) warnings.push('该标的无分钟线数据（分钟线仅覆盖部分股票，且各股票、各日期可能缺根）。');
    const { bars, ...coverageMeta } = queryMinKlineData({ code, freq, start, end, limit }, cap);
    if (cap.hasMin && bars.length === 0) warnings.push('该区间无分钟数据。');
    if (coverageMeta.coverageGaps.length > 0) warnings.push('已证明的交易覆盖存在缺口（可能整桶或整交易日无来源）；未补行情柱。');
    if (coverageMeta.coverageStatus === 'unknown') warnings.push('部分请求范围缺少分钟库覆盖或可靠交易日证据，来源状态未知。');
    const partialBars = bars.filter((b) => !b.timeMeta.complete).length;
    if (partialBars > 0) warnings.push(`当前返回 ${partialBars} 根不完整分钟柱（来源缺根或边界截断）；不按完整收盘解释。`);
    json(res, 200, {
      // date 为实际 bar 结束时间（YYYY-MM-DD HH:MM:SS）；time 保存来源覆盖、名义桶与完整性。
      bars: bars.map((b) => ({
        date: b.time, open: b.open, high: b.high, low: b.low, close: b.close,
        volume: b.volume, amount: b.amount, pct_chg: null, is_st: null,
        time: b.timeMeta,
      })),
      meta: {
        source: 'baostock_min', code, freq, adjust: '3', adjustLabel: '不复权',
        timezone: 'Asia/Shanghai', timeBasis: 'bar-end',
        hasMin: cap.hasMin, firstTime: cap.firstTime, lastTime: cap.lastTime,
        dataAsOf: cap.lastTime, count: bars.length, partialBars,
        completeBars: bars.length - partialBars, ...coverageMeta, warnings,
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