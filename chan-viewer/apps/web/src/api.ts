// 数据服务 API 封装与响应类型。
import type { InputTime, SourceQuality, TimeRange } from '@chan/engine';
import { endOf } from './chart/timeMapping.ts';
export type { SourceQuality, TimeRange } from '@chan/engine';

/** bar 结束时刻、真实来源覆盖与完整性。区间均按 (startMs,endMs] 交易时段。 */
export interface BarTimeMeta extends InputTime {
  sourceCount: number;
  expectedSourceCount: number;
  /** 聚合后的名义桶边界；原始5m可为空。 */
  bucketStartMs?: number;
  bucketEndMs?: number;
}

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
  time?: BarTimeMeta;
  /** 与 time.endMs 同源，兼容既有引擎入口。 */
  endMs?: number;
}

/** 所有真实行情出口统一适配；不筛选/排序/补柱，不推断来源覆盖。 */
export function normalizeRawBars(bars: readonly RawBar[]): RawBar[] {
  return bars.map((bar) => {
    const source = bar.time;
    const endMs = endOf(bar);
    const coverage = source?.coverage?.map((range) => ({ ...range })) ?? [];
    const valid = source != null && Number.isFinite(source.endMs) && source.complete === true && coverage.length > 0 && coverage.every((range) =>
      Number.isFinite(range.startMs) && Number.isFinite(range.endMs) && range.endMs > range.startMs && range.endMs <= endMs,
    );
    const quality: SourceQuality = !source || source.quality === 'unknown' ? 'unknown' : source.complete === false ? 'incomplete'
      : !valid ? 'unknown' : source.quality === 'incomplete' ? 'incomplete' : 'verified';
    return {
      ...bar,
      endMs,
      time: {
        ...source,
        endMs,
        coverage,
        complete: source?.complete === true,
        quality,
        // 旧响应没有日历/断点证明，保守隔离单柱，不猜跨日期连续性。
        continuityId: source?.continuityId ?? `legacy:${quality}:${bar.date}`,
        sourceCount: source?.sourceCount ?? 0,
        expectedSourceCount: source?.expectedSourceCount ?? 0,
      },
    };
  });
}

export interface SourceCoverageMeta {
  expectedCoverage: TimeRange[];
  coverageGaps: TimeRange[];
  coverageStatus: SourceQuality;
  unknownCoverage: TimeRange[];
  declaredRange: { startDate: string; endDate: string } | null;
}

export interface KlineMeta {
  source: string;
  timezone?: string;
  timeBasis?: 'bar-end';
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

/** 日线K线。limit=0 显式请求全部已入库数据。 */
export async function fetchKline(code: string, adjust: string, limit = 500): Promise<{ bars: RawBar[]; meta: KlineMeta }> {
  const r = await fetch(`/api/kline?code=${encodeURIComponent(code)}&adjust=${adjust}&limit=${limit}`);
  const body = await r.json();
  if (!r.ok) throw new Error(body.error ?? 'K线获取失败');
  return { ...body, bars: normalizeRawBars(body.bars) };
}

export interface MinMeta extends Partial<SourceCoverageMeta> {
  source: string;
  code: string;
  freq: number;
  adjustLabel: string;
  timezone?: string;
  timeBasis?: 'bar-end';
  hasMin: boolean;
  firstTime: string | null;
  lastTime: string | null;
  dataAsOf: string | null;
  count: number;
  partialBars?: number;
  completeBars?: number;
  warnings: string[];
}

export interface MinCap {
  hasMin: boolean;
  count: number;
  firstTime: string | null;
  lastTime: string | null;
}

/** 分钟K线（仅股票、仅不复权）。date 字段为完整时间戳；limit=0 显式请求全部已入库数据。 */
export async function fetchMinKline(code: string, freq: number, limit = 500): Promise<{ bars: RawBar[]; meta: MinMeta }> {
  const r = await fetch(`/api/minkline?code=${encodeURIComponent(code)}&freq=${freq}&limit=${limit}`);
  const body = await r.json();
  if (!r.ok) throw new Error(body.error ?? '分钟K线获取失败');
  return { ...body, bars: normalizeRawBars(body.bars) };
}

/** 探测标的分钟线可用性。 */
export async function fetchMinCap(code: string): Promise<MinCap> {
  const r = await fetch(`/api/mincap?code=${encodeURIComponent(code)}`);
  if (!r.ok) throw new Error((await r.json()).error ?? '分钟线探测失败');
  return r.json();
}