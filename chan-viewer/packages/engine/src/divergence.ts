// 第7关 背驰：以中枢为锚比较进入段(b)与离开段(c)力度，c<b 则背驰（24/25/27/33课）。
// 趋势背驰=趋势运行段末中枢；盘整背驰=盘整运行段中枢。
// 窗口（稳健、非退化，标注为实现假设的简化）：
//   b段=[前一同级中枢.startRaw, 末中枢.startRaw]（进入末中枢的推动）；
//   c段=[末中枢.startRaw, 下一运行段首中枢.startRaw（已确认）或最新（候选）]（最后的推动）。
// 纯函数重算：已确认运行段窗口固定 ⇒ 背驰确认冻结；候选 MACD 用 ×2 估算(24课)。
import type { Center, ChanConfig, Divergence, KInput, Trend } from './types.ts';
import { areaBetween } from './macd.ts';

function priceAt(bars: readonly KInput[], raw: number): number {
  const i = Math.max(0, Math.min(bars.length - 1, Math.round(raw)));
  const b = bars[i]!;
  return b.close ?? (b.high + b.low) / 2;
}

/** 区间内走势终结极值所在根：向上取最高价根，向下取最低价根。 */
function extremeRaw(bars: readonly KInput[], a: number, b: number, dir: 'up' | 'down'): number {
  const s = Math.max(0, Math.ceil(a));
  const e = Math.min(bars.length - 1, Math.floor(b));
  let best = s;
  let bv = dir === 'up' ? -Infinity : Infinity;
  for (let i = s; i <= e; i++) {
    const v = dir === 'up' ? bars[i]!.high : bars[i]!.low;
    if (dir === 'up' ? v > bv : v < bv) {
      bv = v;
      best = i;
    }
  }
  return best;
}

/** 段力度：MACD=同向柱面积；几何=段净位移 |末价-初价|（33课 c段力度比b段小=幅度更小）。 */function forceOf(bars: readonly KInput[], hist: readonly number[] | null, a: number, b: number, dir: 'up' | 'down', metric: string): number {
  const s = Math.max(0, Math.ceil(a));
  const e = Math.min(bars.length - 1, Math.floor(b));
  if (e < s) return 0;
  if (metric === 'MACD面积') return hist ? areaBetween(hist, a, b, dir === 'up') : 0;
  return Math.abs(priceAt(bars, b) - priceAt(bars, a)); // 几何：段净位移
}

/** 在走势运行段上检测背驰。hist 为 MACD 柱序列（无 close 时为 null）。id 由位置+1。 */
export function detectDivergences(
  trends: readonly Trend[],
  centers: readonly Center[],
  bars: readonly KInput[],
  hist: readonly number[] | null,
  cfg: ChanConfig,
): Divergence[] {
  const metric = cfg.divMetric;
  if (metric === 'MACD面积' && !hist) return []; // MACD 口径需 close
  const byId = new Map(centers.map((c) => [c.id, c]));
  const lastRaw = bars.length - 1;
  const out: Divergence[] = [];
  const n = trends.length;
  const centersOf = (t: Trend): Center[] => t.centerIds.map((id) => byId.get(id)!).filter(Boolean);

  for (let t = 0; t < n; t++) {
    const T = trends[t]!;
    const cs = centersOf(T);
    if (cs.length === 0) continue;
    const B = cs[cs.length - 1]!; // 运行段末中枢
    const A = byId.get(B.id - 1); // 前一同级中枢（按 id 顺序）
    if (!A) continue; // 首个中枢无前段，无法比较
    const isTrend = T.kind !== '盘整';
    const bStart = A.startRaw;
    const bEnd = B.startRaw;
    const isLast = t === n - 1;
    const cStart = B.startRaw;
    const windowEnd = isLast ? lastRaw : trends[t + 1]!.startRaw;
    let dir: 'up' | 'down';
    if (isTrend) dir = T.kind === '上涨' ? 'up' : 'down';
    else dir = priceAt(bars, windowEnd) >= priceAt(bars, cStart) ? 'up' : 'down';
    // c段终点 = 走势终结极值所在根（向上取区间最高价根、向下取最低价根），而非反转后的下一中枢起点。
    const cEnd = extremeRaw(bars, cStart, windowEnd, dir);
    const bForce = forceOf(bars, hist, bStart, bEnd, dir, metric);
    let cForce = forceOf(bars, hist, cStart, cEnd, dir, metric);
    const est = T.status === 'candidate';
    if (est && metric === 'MACD面积') cForce *= 2; // 24课 候选×2估算整段
    if (!(cForce < bForce)) continue; // 背驰成立：c<b
    out.push({
      id: 0,
      kind: isTrend ? '趋势背驰' : '盘整背驰',
      metric,
      dir,
      bStart,
      bEnd,
      cStart,
      cEnd,
      bForce,
      cForce,
      est,
      status: est ? 'candidate' : 'confirmed',
      confirmedAt: null,
    });
  }
  out.forEach((d, k) => {
    d.id = k + 1;
  });
  return out;
}
