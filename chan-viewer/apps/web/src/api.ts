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