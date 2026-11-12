// 多级别联立·区间套（27课）：大级别背驰段 → 次级别对应背驰段/买卖点，逐级收缩转折点范围。
// 纯函数：基于已 0 diff 核验的各级 ComputeResult，按时间窗筛选，不再重算结构。
import type { BuySellPoint, ComputeResult, Divergence } from '@chan/engine';
import type { RawBar } from './api.ts';

function dateAt(bars: RawBar[], raw: number): string {
  const i = Math.max(0, Math.min(bars.length - 1, Math.round(raw)));
  return bars[i]!.date;
}

/** 大级别背驰段 c段 的时间窗 [t0,t1]。 */
export function divergenceWindow(d: Divergence, bars: RawBar[]): [string, string] {
  return [dateAt(bars, d.cStart), dateAt(bars, d.cEnd)];
}

/** 区间套：筛出次级别中落在 [t0,t1] 内的背驰段与买卖点（转折点在次级别上的对应）。 */
export function nestWithin(lower: ComputeResult, lowerBars: RawBar[], t0: string, t1: string): { divergences: Divergence[]; points: BuySellPoint[] } {
  const inWin = (raw: number) => {
    const t = dateAt(lowerBars, raw);
    return t >= t0 && t <= t1;
  };
  return {
    divergences: lower.divergences.filter((d) => inWin(d.cEnd)),
    points: lower.points.filter((p) => inWin(p.atRaw)),
  };
}

/** 次级别中落在 [t0,t1] 的 raw 下标（供 highlight markArea）。 */
export function rawIndicesWithin(lowerBars: RawBar[], t0: string, t1: string): number[] {
  const out: number[] = [];
  lowerBars.forEach((b, i) => {
    if (b.date >= t0 && b.date <= t1) out.push(i);
  });
  return out;
}
