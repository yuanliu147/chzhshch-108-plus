import { describe, expect, it } from 'vitest';
import { compute, createReplay, type ComputeResult, type KInput } from '../src/index.ts';
import { CHAN_PRESETS } from '../src/caliberRegistry.ts';

function walk(seed: number, n: number): KInput[] {
  let a = seed >>> 0;
  const rnd = () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  let mid = 100; let drift = 0;
  return Array.from({ length: n }, (_, i) => {
    if (i % 20 === 0) drift = (rnd() - 0.5) * 3;
    mid += drift + (rnd() - 0.5) * 4;
    const range = 0.5 + rnd() * 4;
    return { date: String(i), low: mid - range / 2, high: mid + range / 2, close: mid };
  });
}
const cfg = { ...CHAN_PRESETS.originalDefault, centerUnit: '笔中枢' as const };

describe('确认依赖闭合的已知反例', () => {
  it('生产无完成走势时不能通过分型兼容回退确认三类点', () => {
    const result = compute(walk(1, 370), cfg);
    expect(result.centers.some(c => c.status === 'confirmed')).toBe(true);
    expect(result.segments.some(s => s.status === 'confirmed')).toBe(false);
    expect(result.points.filter(p => p.status === 'confirmed')).toEqual([]);
  });
  it('后到线段不能重新解释已关闭走势的确认背驰窗口', () => {
    const bars = walk(42, 1195);
    const before = compute(bars.slice(0, 1194), cfg);
    const after = compute(bars, cfg);
    expect(before.centers.filter(c => c.status === 'confirmed').length).toBeGreaterThan(0);
    for (const d of before.divergences.filter(d => d.status === 'confirmed')) {
      const same = after.divergences.find(x => x.key === d.key);
      expect(same, d.key).toEqual(d);
    }
  });
  it('每类身份唯一，保留旧id不能与新对象碰撞', () => {
    const result = compute(walk(1, 1450), cfg);
    expect(result.centers.filter(c => c.status === 'confirmed').length).toBeGreaterThan(0);
    for (const items of [result.fractals, result.bis, result.segments, result.centers, result.trends, result.divergences, result.points]) {
      expect(new Set(items.map(x => x.id)).size).toBe(items.length);
      expect(new Set(items.map(x => x.key)).size).toBe(items.length);
    }
  });
  it('递归确认必须有首次可知时刻，不能confirmed但时间为空', () => {
    const result = compute(walk(42, 1195), cfg);
    const higher = result.levels.flatMap(l => l.degree >= 2 ? l.centers : []).filter(c => c.status === 'confirmed');
    expect(higher.length).toBeGreaterThan(0);
    for (const c of higher) expect(c.confirmedAt).not.toBeNull();
  });

  it('较长非空确认集合的几何/身份/依赖/首知时间跨前缀全部冻结', () => {
    const input = walk(42, 2400);
    const snapshots = [1195, 1450, 1800, 2400].map(n => compute(input.slice(0, n), cfg));
    expect(snapshots[0]!.points.filter(p => p.status === 'confirmed').length).toBeGreaterThan(0);
    expect(snapshots[0]!.levels.filter(l => l.degree >= 2).flatMap(l => l.centers).filter(c => c.status === 'confirmed').length).toBeGreaterThan(0);
    const groups = (r: ComputeResult) => [r.fractals, r.bis, r.segments, r.centers, r.trends, r.divergences, r.points,
      r.levels.filter(l => l.degree >= 2).flatMap(l => l.centers), r.levels.filter(l => l.degree >= 2).flatMap(l => l.trends)];
    for (let i = 1; i < snapshots.length; i++) {
      const before = groups(snapshots[i - 1]!); const after = groups(snapshots[i]!);
      for (let kind = 0; kind < before.length; kind++) {
        for (const item of before[kind]!.filter(x => x.status === 'confirmed')) {
          expect(after[kind]!.find(x => x.key === item.key), item.key).toEqual(item);
        }
      }
    }
    const result = snapshots.at(-1)!;
    const structures = groups(result).flat();
    const byKey = new Map(structures.map(x => [x.key, x]));
    for (const x of structures.filter(x => x.status === 'confirmed')) {
      expect(x.quality).toBe('verified');
      expect(Number.isInteger(x.confirmedAt)).toBe(true);
      expect(x.dependencyKeys!.length).toBeGreaterThan(0);
      for (const key of x.dependencyKeys!) {
        if (key.startsWith('raw:')) {
          expect(Number(key.split(':').at(-1))).toBeLessThanOrEqual(x.confirmedAt!);
        } else {
          const dependency = byKey.get(key);
          expect(dependency, key).toBeDefined();
          expect(dependency!.status).toBe('confirmed');
          expect(dependency!.continuityId).toBe(x.continuityId);
          expect(dependency!.confirmedAt!).toBeLessThanOrEqual(x.confirmedAt!);
        }
      }
    }
  });

  it('快照调用频率不分配 id 或递归首知时间，嵌套数组完全隔离', () => {
    const input = walk(42, 1500);
    const sparse = createReplay(cfg); const observed = createReplay(cfg);
    let snapshot: ComputeResult | undefined; let saved = '';
    input.forEach((b, i) => {
      sparse.push(b); observed.push(b);
      if (i % 23 === 0) observed.result();
      if (i === 1194) { snapshot = observed.result(); saved = JSON.stringify(snapshot); }
    });
    expect(observed.result()).toEqual(sparse.result());
    expect(JSON.stringify(snapshot)).toBe(saved);
    const changed = observed.result();
    const c = changed.levels.flatMap(l => l.centers).find(c => c.dependencyKeys?.length)!;
    c.dependencyKeys!.push('mutated-snapshot');
    changed.trends[0]!.centerIds.push(-99);
    expect(observed.result()).toEqual(sparse.result());
  });

  it('缺口后完整新段仍产生线段/中枢，历史确认与全局分型映射保留', () => {
    const first = walk(42, 1200); const second = walk(7, 1800);
    const input = [...first, { date: 'gap', high: 200, low: 100, close: 150 }, ...second].map((b, i) => {
      const endMs = Date.UTC(2026, 0, 1) + i * 300000;
      return { ...b, endMs, time: { endMs, coverage: [{ startMs: endMs - 300000, endMs }], complete: i !== 1200, quality: 'verified' as const, continuityId: 'same' } };
    });
    const before = compute(input.slice(0, 1200), cfg); const result = compute(input, cfg);
    expect(result.inputCount).toBe(3001);
    expect(result.segments.some(s => s.status === 'confirmed' && s.startRaw > 1200)).toBe(true);
    expect(result.centers.some(c => c.status === 'confirmed' && c.startRaw > 1200)).toBe(true);
    for (const s of before.segments.filter(s => s.status === 'confirmed')) expect(result.segments.find(x => x.key === s.key)).toEqual(s);
    const byKey = new Map([...result.fractals, ...result.bis, ...result.segments, ...result.centers, ...result.trends, ...result.divergences, ...result.points].map(x => [x.key, x]));
    for (const s of result.segments) expect(s.startRaw < 1200 && s.endRaw > 1200).toBe(false);
    for (const x of byKey.values()) for (const key of x.dependencyKeys ?? []) {
      if (!key.startsWith('raw:')) expect(byKey.get(key)!.continuityId).toBe(x.continuityId);
    }
    for (const f of result.fractals.filter(f => f.startRaw > 1200)) expect(result.validBars[f.middle]!.startRaw).toBeGreaterThan(1200);
  });
});
