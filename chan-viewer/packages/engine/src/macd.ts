// MACD(12,26,9)：缠论背驰辅助（24/25课）。零依赖、PIT 因果（第 n 根只用 ≤n 的 close）。
// 实现假设：原文未给 EMA 公式与种子，采用标准 EMA（k=2/(n+1)），种子=首根 close。TS↔Python 必须一致。

/** 指数移动平均。种子=首值。 */
export function emaSeries(values: readonly number[], n: number): number[] {
  const k = 2 / (n + 1);
  const out: number[] = [];
  let prev = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i]!;
    prev = i === 0 ? v : v * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

export interface Macd {
  dif: number[];
  dea: number[];
  hist: number[]; // 柱 = 2*(dif-dea)
}

/** 由 close 序列计算 MACD(12,26,9)，各数组对齐原始K线下标。 */
export function macd(closes: readonly number[]): Macd {
  const e12 = emaSeries(closes, 12);
  const e26 = emaSeries(closes, 26);
  const dif = closes.map((_, i) => e12[i]! - e26[i]!);
  const dea = emaSeries(dif, 9);
  const hist = dif.map((d, i) => 2 * (d - dea[i]!));
  return { dif, dea, hist };
}

/** 段内同向柱面积：up=true 累加红柱(hist>0)，false 累加绿柱(|hist<0|)。区间取 [ceil(a),floor(b)]。 */
export function areaBetween(hist: readonly number[], a: number, b: number, up: boolean): number {
  const s = Math.max(0, Math.ceil(a));
  const e = Math.min(hist.length - 1, Math.floor(b));
  let sum = 0;
  for (let i = s; i <= e; i++) {
    const h = hist[i]!;
    if (up ? h > 0 : h < 0) sum += Math.abs(h);
  }
  return sum;
}
