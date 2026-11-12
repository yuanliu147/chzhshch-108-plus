// 第6关 走势类型：由已确认中枢推导（17/18/20课）。
// 盘整=单中枢；趋势=≥2个同向且依次不重叠的中枢（上涨/下跌）。
// 纯函数：在已确认中枢序列上重算，运行段被新中枢关闭即确认（冻结），末段为候选。
import type { Center, ChanConfig, Trend } from './types.ts';
import { overlapAll, type Iv } from './segment.ts';

/** 相邻两中枢是否同向不重叠（趋势延续）。返回 'up'|'down'|null。 */
function trendStep(a: Center, b: Center, cfg: ChanConfig): 'up' | 'down' | null {
  const touch = cfg.touchOverlap === '相接算重叠';
  const outer = cfg.trendOverlap === '外围也不重叠';
  const ra: Iv = outer ? { low: a.DD, high: a.GG } : { low: a.ZD, high: a.ZG };
  const rb: Iv = outer ? { low: b.DD, high: b.GG } : { low: b.ZD, high: b.ZG };
  if (overlapAll([ra, rb], touch)) return null; // 有重叠 → 非趋势延续
  if (rb.low > ra.high) return 'up'; // b 下沿 > a 上沿 → 向上不重叠
  if (rb.high < ra.low) return 'down'; // b 上沿 < a 下沿 → 向下不重叠
  return null;
}

/** 在已确认中枢序列上分解走势类型（末段候选）。id 由位置+1。 */
export function detectTrends(centers: readonly Center[], cfg: ChanConfig): Trend[] {
  const cs = centers.filter((c) => c.status === 'confirmed');
  const trends: Trend[] = [];
  const n = cs.length;
  let i = 0;
  while (i < n) {
    const ids = [cs[i]!.id];
    let dir: 'up' | 'down' | null = null;
    let j = i + 1;
    while (j < n) {
      const step = trendStep(cs[j - 1]!, cs[j]!, cfg);
      if (step && (dir === null || step === dir)) {
        dir = step;
        ids.push(cs[j]!.id);
        j++;
      } else break;
    }
    const kind: Trend['kind'] = ids.length >= 2 ? (dir === 'up' ? '上涨' : '下跌') : '盘整';
    trends.push({
      id: 0,
      kind,
      centerIds: ids,
      startRaw: cs[i]!.startRaw,
      endRaw: cs[i + ids.length - 1]!.endRaw,
      status: 'candidate',
      confirmedAt: null,
    });
    i += ids.length;
  }
  trends.forEach((t, k) => {
    t.id = k + 1;
    t.status = k < trends.length - 1 ? 'confirmed' : 'candidate'; // 运行段被关闭即确认，末段候选
  });
  return trends;
}
