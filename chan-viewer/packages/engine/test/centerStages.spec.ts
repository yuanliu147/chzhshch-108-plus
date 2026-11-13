import { describe, expect, it } from 'vitest';
import { detectCenters, type Unit } from '../src/center.ts';
import type { ChanConfig } from '../src/types.ts';

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

const u = (i: number, low: number, high: number): Unit => ({ low, high, startRaw: i * 5, endRaw: i * 5 + 4, dir: i % 2 === 0 ? 'up' : 'down' });

describe('中枢形成不等于终结', () => {
  it('三个完成构件形成后即可依赖，仍在运行标 forming', () => {
    const [c] = detectCenters([u(0, 10, 14), u(1, 11, 15), u(2, 12, 16)], cfg);
    expect(c).toBeDefined();
    expect(c!.evolution).toBe('forming');
    expect(c!.formedAt).toBe(14);
    expect(c!.terminatedAt).toBeNull();
    expect(c!.status).toBe('candidate');
  });

  it('延伸扩大外围但保持已形成身份与形成时刻', () => {
    const [c] = detectCenters([u(0, 10, 14), u(1, 11, 15), u(2, 12, 16), u(3, 10.5, 17)], cfg);
    expect(c!.evolution).toBe('extending');
    expect(c!.formedAt).toBe(14);
    expect(c!.segCount).toBe(4);
    expect(c!.GG).toBe(16); // 外围按同向Z段统计；反向延伸段不篡改Z段GG/DD
    expect(c!.terminatedAt).toBeNull();
  });

  it('离开后再回抽不回才终结，并记录首次可知时刻', () => {
    const centers = detectCenters([
      u(0, 10, 14), u(1, 11, 15), u(2, 12, 16),
      u(3, 30, 36), u(4, 40, 46),
    ], cfg);
    expect(centers).toHaveLength(1);
    expect(centers[0]!.evolution).toBe('terminated');
    expect(centers[0]!.terminatedAt).toBe(24);
    expect(centers[0]!.endRaw).toBe(14);
  });

  it('九段升级是终结并保留升级标记，不把前面中枢丢掉', () => {
    const units = Array.from({ length: 9 }, (_, i) => u(i, 10 + (i % 2) * 0.5, 14 + (i % 2) * 0.5));
    const centers = detectCenters(units, cfg);
    expect(centers).toHaveLength(1);
    expect(centers[0]!.evolution).toBe('upgraded');
    expect(centers[0]!.segCount).toBe(9);
    expect(centers[0]!.formedAt).toBe(14);
  });

  it('形成和终结传播构件的真实确认时间，不用几何端点冒充', () => {
    const units = [u(0, 10, 14), u(1, 11, 15), u(2, 12, 16), u(3, 30, 36), u(4, 40, 46)]
      .map((unit, i) => ({ ...unit, startRaw: i * 5 + 11, endRaw: i * 5 + 16, key: `unit:${i}`, confirmedAt: [22, 28, 36, 45, 52][i]!, continuityId: 'run', quality: 'verified' as const }));
    const [c] = detectCenters(units, cfg);
    expect(c!.formedRaw).toBe(26);
    expect(c!.formedAt).toBe(36);
    expect(c!.terminatedRaw).toBe(36);
    expect(c!.terminatedAt).toBe(52);
    expect(c!.confirmedAt).toBe(52);
    expect(c!.dependencyKeys).toEqual(units.map(x => x.key));
    expect(c!.key).toBe(detectCenters(units.slice(0, 3), cfg)[0]!.key);
  });

  it('两侧不足三构件不能跨连续性形成；未完成依赖不能确认', () => {
    const units = Array.from({ length: 4 }, (_, i) => ({ ...u(i, 10, 14), continuityId: i < 2 ? 'a' : 'b' }));
    expect(detectCenters(units, cfg)).toEqual([]);
    const unfinished = [u(0, 10, 14), u(1, 11, 15), u(2, 12, 16), u(3, 30, 36), { ...u(4, 40, 46), confirmedAt: null }];
    const [c] = detectCenters(unfinished, cfg);
    expect(c!.status).toBe('candidate');
    expect(c!.quality).toBe('unknown');
  });
});
