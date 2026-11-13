import { describe, expect, it } from 'vitest';
import { detectPoints } from '../src/point.ts';
import type { Center, ChanConfig, Divergence, Segment } from '../src/types.ts';

const cfg: ChanConfig = {
  startDir: 'up', precision: { digits: 'raw' }, biRule: '77课', mergeDir: '回找非包含',
  touchOverlap: '相接算重叠', segMerge: '做包含处理', centerUnit: '线段中枢',
  centerUpgrade: '9段升级', trendOverlap: '核心不重叠', divMetric: 'MACD面积',
  bsp3Touch: '不跌破ZG', bsp2Filter: '允许二买低于一买',
};

const center = (overrides: Partial<Center> = {}): Center => ({
  id: 1, unit: 'segment', dir: 'up', startRaw: 0, endRaw: 5, ZG: 13, ZD: 10,
  GG: 15, DD: 9, G: 14, D: 10, segCount: 3, formedAt: 5, terminatedAt: 8,
  evolution: 'terminated', status: 'confirmed', confirmedAt: 8, ...overrides,
});

const seg = (id: number, dir: 'up' | 'down', startRaw: number, endRaw: number, low: number, high: number): Segment => ({
  id, dir, startFx: id, endFx: id + 1, startRaw, endRaw, low, high, status: 'confirmed', confirmedAt: endRaw,
});

const div = (status: 'candidate' | 'confirmed', cEnd = 3): Divergence => ({
  id: 1, kind: '趋势背驰', metric: 'MACD面积', dir: 'down', bStart: 0, bEnd: 2, cStart: 2, cEnd,
  bForce: 3, cForce: 1, est: status === 'candidate', status, confirmedAt: status === 'confirmed' ? cEnd : null,
});

const bars = Array.from({ length: 30 }, (_, i) => ({ date: String(i), low: 9 + i * 0.1, high: 10 + i * 0.1, close: 9.5 + i * 0.1 }));

describe('买卖点依赖已完成次级别走势', () => {
  it('三买要求完成的次级别离开与首次回试守住 ZG', () => {
    const movements = [
      seg(1, 'up', 6, 8, 10, 14),
      seg(2, 'down', 8, 10, 13, 13.5),
    ];
    const points = detectPoints([], [center()], [], [], bars, cfg, movements);
    const p3 = points.find((p) => p.klass === 3 && p.side === 'buy');
    expect(p3).toBeDefined();
    expect(p3!.atRaw).toBe(10);
    expect(p3!.price).toBe(13);
    expect(p3!.status).toBe('confirmed');
    expect(p3!.confirmedAt).toBe(10);
    expect(p3!.refKind).toBe('center');
    expect(p3!.dependencyKeys).toHaveLength(3);
    expect(detectPoints([], [center()], [], [], bars, cfg, [])).toEqual([]);
  });

  it('二买来自一买后的完成反弹与完成回试，不由候选一类点派生', () => {
    const center2 = center({ id: 2, startRaw: 8, endRaw: 12, ZG: 15, ZD: 12, status: 'candidate' });
    const movements = [
      seg(1, 'up', 4, 6, 9, 11),
      seg(2, 'down', 6, 8, 8.8, 9.5),
    ];
    const confirmedDraft = detectPoints([div('confirmed')], [center2], [], [], bars, cfg, movements);
    expect(confirmedDraft.some((p) => p.klass === 2 && p.side === 'buy')).toBe(true);
    const second = confirmedDraft.find(p => p.klass === 2)!;
    expect(second.refKind).toBe('point');
    expect(second.refId).not.toBe(0);
    expect(confirmedDraft.find(p => p.klass === 1 && p.id === second.refId)?.key).toBe(second.refKey);
    expect(second.confirmedAt).toBe(8);
    expect(second.dependencyKeys).toContain(second.refKey);
    expect(detectPoints([div('confirmed')], [], [], [], bars, cfg, []).every(p => p.status === 'candidate')).toBe(true);

    const candidateOnly = detectPoints([div('candidate')], [center2], [], [], bars, cfg, movements);
    expect(candidateOnly.some((p) => p.klass === 1 && p.status === 'confirmed')).toBe(false);
    expect(candidateOnly.some((p) => p.klass === 2 && p.status === 'confirmed')).toBe(false);
  });

  it('首知时间包含完成依赖的延迟确认，未知来源不能升级', () => {
    const movements = [
      { ...seg(1, 'up', 6, 8, 10, 14), key: 'leave', confirmedAt: 19, continuityId: 'run', quality: 'verified' as const },
      { ...seg(2, 'down', 8, 10, 13, 13.5), key: 'retest', confirmedAt: 25, continuityId: 'run', quality: 'verified' as const },
    ];
    const c = center({ key: 'center', continuityId: 'run', quality: 'verified', confirmedAt: 22 });
    const points = detectPoints([], [c], [], [], bars, cfg, movements);
    expect(points).toHaveLength(1);
    expect(points[0]!.confirmedAt).toBe(25);
    expect(points[0]!.dependencyKeys).toEqual(['center', 'leave', 'retest']);
    expect(points[0]!.refKey).toBe('center');
    const unknown = detectPoints([], [{ ...c, quality: 'unknown' }], [], [], bars, cfg, movements);
    expect(unknown[0]!.status).toBe('candidate');
    const other = movements.map(m => ({ ...m, continuityId: 'other' }));
    expect(detectPoints([], [c], [], [], bars, cfg, other)).toEqual([]);
  });
});
