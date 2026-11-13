// 结构级别递归：只在“已完成的上一级走势”上构造更高一级中枢/走势。
// 这里的 degree 是结构递归深度，不是日线/30分钟/5分钟等看图周期。
import { detectCenters, type Unit } from './center.ts';
import { detectTrends } from './trend.ts';
import type { Center, ChanConfig, LevelSnapshot, Trend } from './types.ts';

function trendUnit(t: Trend): Unit {
  const startPrice = t.startPrice ?? 0;
  const endPrice = t.endPrice ?? 0;
  return {
    low: Math.min(startPrice, endPrice),
    high: Math.max(startPrice, endPrice),
    startRaw: t.startRaw,
    endRaw: t.endRaw,
    dir: t.kind === '上涨' ? 'up' : 'down',
    key: t.key,
    continuityId: t.continuityId,
    quality: t.quality,
    dependencyKeys: t.key ? [t.key] : [],
    confirmedAt: t.confirmedAt,
  };
}

/** 走势的高低区间由其中枢包络确定；仅供结构合成，不替代原始价格。 */
function enrichTrendRange(t: Trend, centers: readonly Center[]): Trend {
  const included = t.centerIds.map((id) => centers.find((c) => c.id === id)).filter((c): c is Center => !!c);
  if (!included.length) return t;
  return {
    ...t,
    startPrice: Math.min(...included.map((c) => c.DD)),
    endPrice: Math.max(...included.map((c) => c.GG)),
  };
}

/**
 * 自底向上生成级别快照。
 * degree 1 使用已确认线段中枢/走势；degree >=2 只把上一级“已完成走势”当构件。
 * 有限数据不足时自然停止，不补造父级结构。
 */
export function buildLevels(
  baseCenters: readonly Center[], baseTrends: readonly Trend[], cfg: ChanConfig, maxDegree = 12,
  register?: (kind: 'center' | 'trend', degree: number, items: (Center | Trend)[]) => void,
): LevelSnapshot[] {
  const basis = cfg.centerUnit === '笔中枢' ? 'bi' as const : 'segment' as const;
  const unitName = basis === 'bi' ? '笔' : '线段';
  const levels: LevelSnapshot[] = [{
    degree: 0,
    basis,
    centers: [],
    trends: [],
    completed: [],
    note: `基础构件层（已确认${unitName}）；中枢从 degree 1 开始。`,
  }];
  let centers = baseCenters.map((c) => ({ ...c, degree: 1 }));
  let trends = baseTrends.map((t) => enrichTrendRange({ ...t, degree: 1 }, centers));
  levels.push({
    degree: 1,
    basis,
    centers,
    trends,
    completed: trends.filter((t) => t.status === 'confirmed'),
    note: `${unitName}级别中枢与本级走势；候选末段不向更高层提供构件。`,
  });

  for (let degree = 2; degree <= maxDegree; degree++) {
    const units = trends.filter((t) => t.status === 'confirmed').map(trendUnit);
    if (units.length < 3) break;
    const nextCenters = detectCenters(units, cfg).map((c) => ({ ...c, unit: 'trend' as const, degree, key: `d${degree}:${c.key}` }));
    register?.('center', degree, nextCenters);
    const nextTrends = detectTrends(nextCenters, cfg).map((t) => enrichTrendRange({
      ...t, degree, key: `d${degree}:${t.key}`,
    }, nextCenters));
    register?.('trend', degree, nextTrends);
    if (!nextCenters.length) break;
    levels.push({
      degree,
      basis: 'completed-trend',
      centers: nextCenters,
      trends: nextTrends,
      completed: nextTrends.filter((t) => t.status === 'confirmed'),
      note: `以 degree ${degree - 1} 已完成走势为构件。`,
    });
    centers = nextCenters;
    trends = nextTrends;
    if (!levels[levels.length - 1]!.completed.length) break;
  }
  return levels;
}
