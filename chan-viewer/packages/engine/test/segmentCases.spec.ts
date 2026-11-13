import { describe, expect, it } from 'vitest';
import { detectSegments } from '../src/segment.ts';
import type { Bi, ChanConfig, Fractal, MergedBar } from '../src/types.ts';

const cfg: ChanConfig = {
  startDir: 'up',
  precision: { digits: 'raw' },
  biRule: '77课',
  mergeDir: '回找非包含',
  touchOverlap: '相接算重叠',
  segMerge: '做包含处理',
  centerUnit: '线段中枢',
  centerUpgrade: '9段升级',
  trendOverlap: '核心不重叠',
  divMetric: 'MACD面积',
  bsp3Touch: '不跌破ZG',
  bsp2Filter: '允许二买低于一买',
};

function fixture(prices: number[]) {
  const fx: Fractal[] = prices.map((price, i) => ({
    id: i + 1,
    type: i % 2 === 0 ? 'bottom' : 'top',
    middle: i,
    price,
    midHigh: price,
    midLow: price,
    startRaw: i,
    endRaw: i,
    status: 'confirmed',
    confirmedAt: i,
  }));
  const bis: Bi[] = prices.slice(0, -1).map((p, i) => ({
    id: i + 1,
    start: fx[i]!.id,
    end: fx[i + 1]!.id,
    dir: i % 2 === 0 ? 'up' : 'down',
    status: 'confirmed',
    confirmedAt: i + 1,
  }));
  const bars: MergedBar[] = prices.map((p, i) => ({ index: i, low: p, high: p, startRaw: i, endRaw: i }));
  return { fx, bis, bars };
}

describe('线段黄金正反例', () => {
  it('前三笔没有共同重叠时不构成线段', () => {
    const { fx, bis, bars } = fixture([10, 20, 21, 25, 26, 30]);
    const segs = detectSegments(bis, new Map(fx.map((f) => [f.id, f])), bars, cfg);
    expect(segs).toHaveLength(0);
  });

  it('有缺口的第二种破坏：第二特征序列使用与原线段同向的笔，出现相反分型才确认', () => {
    const { fx, bis, bars } = fixture([10, 20, 10, 27, 21, 25, 15, 20, 18, 23]);
    const segs = detectSegments(bis, new Map(fx.map((f) => [f.id, f])), bars, cfg);
    expect(segs.length).toBeGreaterThan(0);
    const first = segs[0]!;
    expect(first.dir).toBe('up');
    expect(first.status).toBe('confirmed');
    expect(first.endFx).toBe(fx[3]!.id);
    expect(first.endRaw).toBe(3);
  });
});
