// 探索性研究的纯函数：周期聚合、指标、结构段量能和预计算离场。无数据库与文件副作用。
import type { BuySellPoint, ComputeResult, Segment } from '../../packages/engine/src/index.ts';
import { nextTradableAfter, type DailyBar, type EntryCandidate, type StockSeries } from './core.ts';

export type PeriodUnit = 'week' | 'month';
export interface PeriodBar extends DailyBar {
  period: string;
  marketEndDate: string;
  sourceCount: number;
}

export function periodKey(date: string, unit: PeriodUnit): string {
  if (unit === 'month') return date.slice(0, 7);
  const day = new Date(`${date}T00:00:00Z`);
  const mondayOffset = (day.getUTCDay() + 6) % 7;
  day.setUTCDate(day.getUTCDate() - mondayOffset);
  return day.toISOString().slice(0, 10);
}

/** marketEndDate 是全市场该周期最后交易日；只有到达该日收盘，聚合bar才可使用。 */
export function aggregatePeriods(bars: readonly DailyBar[], calendar: readonly string[], unit: PeriodUnit): PeriodBar[] {
  const periodEnds = new Map<string, string>();
  for (const date of calendar) periodEnds.set(periodKey(date, unit), date);
  // 日历末尾所在周期没有后续交易周/月证明其完成；即使凑巧是周五/月末也保守不发布。
  const unprovenLastPeriod = calendar.length ? periodKey(calendar.at(-1)!, unit) : null;
  const groups = new Map<string, DailyBar[]>();
  for (const bar of bars) {
    if (bar.tradeStatus !== 1 || !(bar.high > 0) || !(bar.low > 0) || !(bar.close > 0)) continue;
    const key = periodKey(bar.date, unit);
    const list = groups.get(key) ?? [];
    list.push(bar);
    groups.set(key, list);
  }
  const out: PeriodBar[] = [];
  for (const [period, source] of groups) {
    if (period === unprovenLastPeriod) continue;
    const marketEndDate = periodEnds.get(period);
    if (!marketEndDate || !source.length) continue;
    const first = source[0]!;
    const last = source.at(-1)!;
    const validHfq = source.filter(b => b.hfqOpen != null && b.hfqHigh != null && b.hfqLow != null && b.hfqClose != null);
    out.push({
      date: marketEndDate,
      period,
      marketEndDate,
      sourceCount: source.length,
      open: first.open,
      high: Math.max(...source.map(b => b.high)),
      low: Math.min(...source.map(b => b.low)),
      close: last.close,
      preclose: null,
      volume: source.reduce((sum, b) => sum + b.volume, 0),
      amount: source.reduce((sum, b) => sum + b.amount, 0),
      tradeStatus: 1,
      isSt: last.isSt,
      hfqOpen: validHfq.length === source.length ? validHfq[0]!.hfqOpen : null,
      hfqHigh: validHfq.length === source.length ? Math.max(...validHfq.map(b => b.hfqHigh!)) : null,
      hfqLow: validHfq.length === source.length ? Math.min(...validHfq.map(b => b.hfqLow!)) : null,
      hfqClose: validHfq.length === source.length ? validHfq.at(-1)!.hfqClose : null,
    });
  }
  return out.sort((a, b) => a.marketEndDate.localeCompare(b.marketEndDate));
}

export function latestCompletedPeriodIndex(bars: readonly PeriodBar[], signalDate: string): number {
  let lo = 0;
  let hi = bars.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (bars[mid]!.marketEndDate <= signalDate) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** 收盘价在均线之上且均线较前一周/月/日上行；历史不足返回null。 */
export function movingTrendState(values: readonly number[], index: number, window: number): boolean | null {
  if (window <= 0 || index < window || index >= values.length) return null;
  const currentValues = values.slice(index - window + 1, index + 1);
  const previousValues = values.slice(index - window, index);
  if ([...currentValues, ...previousValues].some(v => !Number.isFinite(v) || v <= 0)) return null;
  const current = mean(currentValues);
  const previous = mean(previousValues);
  return values[index]! > current && current > previous;
}

export function returnLookback(values: readonly number[], index: number, window: number): number | null {
  if (window <= 0 || index < window || index >= values.length || !(values[index - window]! > 0)
    || !Number.isFinite(values[index]) || !Number.isFinite(values[index - window])) return null;
  return values[index]! / values[index - window]! - 1;
}

/** 最近window个真实交易日的简单ATR；停牌占位不占窗口，也不制造0价格。 */
export function averageTrueRange(bars: readonly DailyBar[], index: number, window: number): number | null {
  if (window <= 0 || index < 0 || index >= bars.length) return null;
  const values: number[] = [];
  let currentIndex = index;
  while (currentIndex > 0 && values.length < window) {
    const bar = bars[currentIndex]!;
    if (bar.tradeStatus !== 1 || !(bar.hfqHigh! > 0) || !(bar.hfqLow! > 0)) { currentIndex--; continue; }
    let previousIndex = currentIndex - 1;
    while (previousIndex >= 0 && (bars[previousIndex]!.tradeStatus !== 1 || !(bars[previousIndex]!.hfqClose! > 0))) previousIndex--;
    if (previousIndex < 0) break;
    const previousClose = bars[previousIndex]!.hfqClose!;
    values.push(Math.max(bar.hfqHigh! - bar.hfqLow!, Math.abs(bar.hfqHigh! - previousClose), Math.abs(bar.hfqLow! - previousClose)));
    currentIndex = previousIndex;
  }
  return values.length === window ? mean(values) : null;
}

function averageVolume(bars: readonly DailyBar[], startRaw: number, endRaw: number): number | null {
  const start = Math.max(0, Math.ceil(startRaw));
  const end = Math.min(bars.length - 1, Math.floor(endRaw));
  if (end < start) return null;
  let total = 0;
  for (let i = start; i <= end; i++) total += bars[i]!.volume;
  return total / (end - start + 1);
}

function ratio(numerator: number | null, denominator: number | null): number | null {
  return numerator != null && denominator != null && denominator > 0 ? numerator / denominator : null;
}

export interface VolumeFeature {
  primaryRatio: number | null;
  secondaryRatio: number | null;
  pass: boolean | null;
  detail: string;
}

/** 一买比较背驰c/b段，二买比较回抽/反弹段，三买比较离开/中枢及回踩/离开段日均量。 */
export function volumeFeature(bars: readonly DailyBar[], result: ComputeResult, point: BuySellPoint): VolumeFeature {
  if (point.klass === 1) {
    const divergence = result.divergences.find(d => d.key === point.refKey || d.id === point.refId);
    if (!divergence) return { primaryRatio: null, secondaryRatio: null, pass: null, detail: '缺少背驰来源' };
    const value = ratio(averageVolume(bars, divergence.cStart, divergence.cEnd), averageVolume(bars, divergence.bStart, divergence.bEnd));
    return { primaryRatio: value, secondaryRatio: null, pass: value == null ? null : value < 1, detail: '一买：背驰c段日均量/b段日均量<1' };
  }
  const segments = new Map(result.segments.map(s => [s.key, s] as const));
  const movements = (point.dependencyKeys ?? []).map(key => segments.get(key)).filter((s): s is Segment => !!s);
  if (point.klass === 2) {
    const rebound = movements.find(s => s.dir === 'up');
    const retest = movements.find(s => s.dir === 'down' && s.startRaw >= (rebound?.endRaw ?? -1) - 0.6);
    if (!rebound || !retest) return { primaryRatio: null, secondaryRatio: null, pass: null, detail: '缺少二买反弹或回抽段' };
    const reboundVolume = averageVolume(bars, rebound.startRaw, rebound.endRaw);
    const retestVolume = averageVolume(bars, retest.startRaw, retest.endRaw);
    const value = ratio(retestVolume, reboundVolume);
    return { primaryRatio: value, secondaryRatio: null, pass: value == null ? null : value < 1, detail: '二买：回抽段日均量/反弹段日均量<1' };
  }
  const leave = movements.find(s => s.dir === 'up');
  const retest = movements.find(s => s.dir === 'down' && s.startRaw >= (leave?.endRaw ?? -1) - 0.6);
  const center = result.centers.find(c => c.key === point.refKey || c.id === point.refId);
  if (!leave || !retest || !center) return { primaryRatio: null, secondaryRatio: null, pass: null, detail: '缺少三买中枢、离开或回踩段' };
  const centerVolume = averageVolume(bars, center.startRaw, Math.min(center.endRaw, leave.startRaw - 1));
  const leaveVolume = averageVolume(bars, leave.startRaw, leave.endRaw);
  const retestVolume = averageVolume(bars, retest.startRaw, retest.endRaw);
  const primary = ratio(leaveVolume, centerVolume);
  const secondary = ratio(retestVolume, leaveVolume);
  return { primaryRatio: primary, secondaryRatio: secondary, pass: primary == null || secondary == null ? null : primary > 1 && secondary < 1,
    detail: '三买：离开段日均量>中枢段日均量，且回踩段日均量<离开段日均量' };
}

export interface HigherPointSupport {
  status: '支持' | '不支持' | '数据不足';
  klasses: number[];
  periodEndDate: string | null;
}

/** 仅最近已完成周/月内首次确认的已验证买点算支持；更早的历史点不永久有效。 */
export function higherPointSupport(result: ComputeResult | null, periods: readonly PeriodBar[], signalDate: string): HigherPointSupport {
  const index = latestCompletedPeriodIndex(periods, signalDate);
  if (!result || index < 0) return { status: '数据不足', klasses: [], periodEndDate: null };
  const klasses = result.points.filter(p => p.side === 'buy' && p.status === 'confirmed' && p.confirmedAt === index
    && p.quality !== 'unknown' && p.quality !== 'incomplete').map(p => p.klass);
  return { status: klasses.length ? '支持' : '不支持', klasses, periodEndDate: periods[index]!.marketEndDate };
}

export interface ExplorationExitPlan {
  date: string | null;
  signalDate: string | null;
  reason: string;
  ready: boolean;
}

function barIndex(stock: StockSeries, date: string): number {
  let lo = 0;
  let hi = stock.bars.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (stock.bars[mid]!.date < date) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function noExit(reason: string, ready = true): ExplorationExitPlan {
  return { date: null, signalDate: null, reason, ready };
}

function triggeredExit(stock: StockSeries, index: number, endDate: string, reason: string): ExplorationExitPlan {
  const signalDate = stock.bars[index]!.date;
  const next = nextTradableAfter(stock, signalDate);
  return { date: next && next.date <= endDate ? next.date : null, signalDate, reason, ready: true };
}

/** level为信号日换算的后复权结构位；买入后后复权收盘跌破，下一可交易日开盘离场。 */
export function structureInvalidationExit(stock: StockSeries, candidate: EntryCandidate, level: number, endDate = '9999-12-31'): ExplorationExitPlan {
  const reason = candidate.klass === 3 ? '收盘跌回原中枢上沿' : '收盘跌破原买点结构低点';
  if (!(level > 0)) return noExit(reason, false);
  const start = barIndex(stock, candidate.entryDate);
  for (let i = start; i < stock.bars.length && stock.bars[i]!.date <= endDate; i++) {
    const bar = stock.bars[i]!;
    if (bar.tradeStatus === 1 && bar.hfqClose != null && bar.hfqClose < level) return triggeredExit(stock, i, endDate, reason);
  }
  return noExit(reason);
}

/** 以入场后最高后复权收盘价减去k倍ATR为移动线，收盘跌破后下一日离场。 */
export function atrTrailingExit(stock: StockSeries, candidate: EntryCandidate, window: number, multiple: number, endDate = '9999-12-31'): ExplorationExitPlan {
  const reason = `最高收盘价回撤${multiple}倍ATR${window}`;
  const start = barIndex(stock, candidate.entryDate);
  const entry = stock.bars[start];
  if (!entry || entry.date !== candidate.entryDate || entry.hfqOpen == null || averageTrueRange(stock.bars, start, window) == null) return noExit(reason, false);
  let highestClose = entry.hfqOpen;
  for (let i = start; i < stock.bars.length && stock.bars[i]!.date <= endDate; i++) {
    const bar = stock.bars[i]!;
    if (bar.tradeStatus !== 1 || bar.hfqClose == null) continue;
    highestClose = Math.max(highestClose, bar.hfqClose);
    const atr = averageTrueRange(stock.bars, i, window);
    if (atr != null && bar.hfqClose < highestClose - multiple * atr) return triggeredExit(stock, i, endDate, reason);
  }
  return noExit(reason);
}

/** 收盘跌破此前N个真实交易日的后复权最低价（不含当日及停牌占位），下一日离场。 */
export function channelExit(stock: StockSeries, candidate: EntryCandidate, window: number, endDate = '9999-12-31'): ExplorationExitPlan {
  const reason = `收盘跌破此前${window}日最低价`;
  const start = barIndex(stock, candidate.entryDate);
  for (let i = start; i < stock.bars.length && stock.bars[i]!.date <= endDate; i++) {
    const bar = stock.bars[i]!;
    if (bar.tradeStatus !== 1 || !(bar.hfqClose! > 0)) continue;
    const previous: DailyBar[] = [];
    for (let j = i - 1; j >= 0 && previous.length < window; j--) {
      const candidateBar = stock.bars[j]!;
      if (candidateBar.tradeStatus === 1 && candidateBar.hfqLow! > 0) previous.push(candidateBar);
    }
    if (previous.length !== window) return noExit(reason, false);
    const lowest = Math.min(...previous.map(b => b.hfqLow!));
    if (bar.hfqClose! < lowest) return triggeredExit(stock, i, endDate, reason);
  }
  return noExit(reason);
}
