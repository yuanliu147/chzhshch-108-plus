// 数据服务 API 封装与响应类型。
export interface RawBar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  amount: number;
  pct_chg: number | null;
  is_st: number | null;
}

export interface KlineMeta {
  source: string;
  code: string;
  codeName: string | null;
  kind: 'stock' | 'index';
  status: number;
  adjust: string | null;
  adjustLabel: string;
  adjustBasisDate: string | null;
  filteredSuspended: number;
  firstDate: string | null;
  lastDate: string | null;
  dataAsOf: string | null;
  count: number;
  warnings: string[];
}

export interface SymbolItem {
  code: string;
  code_name: string | null;
  kind: 'stock' | 'index';
  status: number;
  ipo_date: string | null;
  out_date: string | null;
}

export async function fetchSymbols(q: string, includeDelisted = false): Promise<SymbolItem[]> {
  const r = await fetch(`/api/symbols?q=${encodeURIComponent(q)}&includeDelisted=${includeDelisted ? 1 : 0}`);
  if (!r.ok) throw new Error((await r.json()).error ?? '标的搜索失败');
  return (await r.json()).symbols;
}

export async function fetchKline(code: string, adjust: string, limit = 500): Promise<{ bars: RawBar[]; meta: KlineMeta }> {
  const r = await fetch(`/api/kline?code=${encodeURIComponent(code)}&adjust=${adjust}&limit=${limit}`);
  const body = await r.json();
  if (!r.ok) throw new Error(body.error ?? 'K线获取失败');
  return body;
}

export interface MinMeta {
  source: string;
  code: string;
  freq: number;
  adjustLabel: string;
  hasMin: boolean;
  firstTime: string | null;
  lastTime: string | null;
  dataAsOf: string | null;
  count: number;
  warnings: string[];
}

export interface MinCap {
  hasMin: boolean;
  count: number;
  firstTime: string | null;
  lastTime: string | null;
}

/** 分钟K线（仅股票、仅不复权）。date 字段为完整时间戳。 */
export async function fetchMinKline(code: string, freq: number, limit = 500): Promise<{ bars: RawBar[]; meta: MinMeta }> {
  const r = await fetch(`/api/minkline?code=${encodeURIComponent(code)}&freq=${freq}&limit=${limit}`);
  const body = await r.json();
  if (!r.ok) throw new Error(body.error ?? '分钟K线获取失败');
  return body;
}

/** 探测标的分钟线可用性。 */
export async function fetchMinCap(code: string): Promise<MinCap> {
  const r = await fetch(`/api/mincap?code=${encodeURIComponent(code)}`);
  if (!r.ok) throw new Error((await r.json()).error ?? '分钟线探测失败');
  return r.json();
}