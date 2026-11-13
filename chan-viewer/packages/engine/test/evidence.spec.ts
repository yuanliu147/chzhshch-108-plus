import { describe, expect, it } from 'vitest';
import { analyzeAsOf, compute, createReplay, buildLevels, detectTrends, detectDivergences, detectSegments, type Bi, type Fractal, type MergedBar, type Center, type Segment, type Trend, type ChanConfig, type KInput } from '../src/index.ts';
import { CHAN_PRESETS } from '../src/caliberRegistry.ts';

const cfg: ChanConfig = CHAN_PRESETS.originalDefault;

function walk(n: number): KInput[] {
  let mid = 100;
  return Array.from({ length: n }, (_, i) => {
    mid += ((i * 37) % 11 - 5) * 0.35;
    const range = 0.8 + ((i * 19) % 7) * 0.2;
    return { date: String(i), low: mid - range, high: mid + range, close: mid };
  });
}

describe('asOf 与快照因果', () => {
  it('日线在收盘前不可见，收盘后才进入计算', () => {
    const bars: KInput[] = [
      { date: '2026-09-01', low: 9, high: 10, close: 9.8 },
      { date: '2026-09-02', low: 9.5, high: 10.5, close: 10.2 },
    ];
    const before = analyzeAsOf(bars, cfg, Date.UTC(2026, 8, 1, 6, 0)); // 北京 14:00
    expect(before.validBars.length).toBe(0);
    const after = analyzeAsOf(bars, cfg, Date.UTC(2026, 8, 1, 7, 0)); // 北京 15:00
    expect(after.validBars.length).toBe(1);
  });

  it('Replay.result() 是快照，继续喂数据不会改写旧结果', () => {
    const bars = walk(80);
    const replay = createReplay(cfg);
    for (const b of bars.slice(0, 40)) replay.push(b);
    const snapshot = replay.result();
    const oldJson = JSON.stringify({ v: snapshot.validBars, f: snapshot.fractals, b: snapshot.bis, s: snapshot.segments });
    for (const b of bars.slice(40)) replay.push(b);
    expect(JSON.stringify({ v: snapshot.validBars, f: snapshot.fractals, b: snapshot.bis, s: snapshot.segments })).toBe(oldJson);
    expect(replay.result().validBars.length).toBeGreaterThan(snapshot.validBars.length);
  });

  it('已确认结构的首次可知时间在追加数据后保持不变', () => {
    const bars = walk(320);
    const prefix = compute(bars.slice(0, 220), cfg);
    const full = compute(bars, cfg);
    for (const s of prefix.segments.filter((x) => x.status === 'confirmed')) {
      const same = full.segments.find((x) => x.key === s.key);
      expect(same, s.key).toBeDefined();
      expect(same!.confirmedAt).toBe(s.confirmedAt);
    }
    for (const c of prefix.centers.filter((x) => x.status === 'confirmed')) {
      const same = full.centers.find((x) => x.key === c.key);
      expect(same, c.key).toBeDefined();
      expect(same!.confirmedAt).toBe(c.confirmedAt);
      expect(same!.formedAt).toBe(c.formedAt);
    }
  });
});

const evidenceCenter = (id: number, startRaw: number, endRaw: number): Center => ({
  id, key: `center:${id}`, unit: 'segment', dir: 'up', startRaw, endRaw,
  ZG: 14, ZD: 10, GG: 15, DD: 9, G: 14, D: 10, segCount: 3, degree: 1,
  formedAt: endRaw + 5, formedRaw: endRaw, terminatedAt: endRaw + 15,
  terminatedRaw: endRaw + 10, evolution: 'terminated', status: 'confirmed', confirmedAt: endRaw + 15,
  continuityId: 'golden', quality: 'verified', dependencyKeys: [`unit:${id}:1`, `unit:${id}:2`, `unit:${id}:3`],
});
const evidenceMovement = (id: number, startRaw: number, endRaw: number, confirmedAt: number): Segment => ({
  id, key: `movement:${id}`, dir: 'up', startFx: id, endFx: id + 1, startRaw, endRaw,
  high: 130, low: 100, status: 'confirmed', confirmedAt,
  continuityId: 'golden', quality: 'verified', dependencyKeys: [`bi:${id}`],
});

describe('闭合证据黄金例（不能以全空结果修复早确认）', () => {
  it('第二特征序列闭合消耗到最后观测笔，而非线段几何终点', () => {
    const prices = [10, 20, 10, 27, 21, 25, 15, 20, 18, 23];
    const fx: Fractal[] = prices.map((price, i) => ({
      id: i + 1, key: `fx:${i}`, type: i % 2 === 0 ? 'bottom' : 'top', middle: i,
      price, midHigh: price, midLow: price, startRaw: i, endRaw: i, status: 'confirmed', confirmedAt: i,
      continuityId: 'golden', quality: 'verified', dependencyKeys: [`raw:golden:${i}`],
    }));
    const bis: Bi[] = prices.slice(0, -1).map((_, i) => ({
      id: i + 1, key: `bi:${i}`, start: i + 1, end: i + 2, dir: i % 2 === 0 ? 'up' : 'down',
      status: 'confirmed', confirmedAt: 100 + i, continuityId: 'golden', quality: 'verified', dependencyKeys: [`fx:${i}`, `fx:${i + 1}`],
    }));
    const valid: MergedBar[] = prices.map((price, i) => ({ index: i, low: price, high: price, startRaw: i, endRaw: i }));
    const segments = detectSegments(bis, new Map(fx.map(f => [f.id, f])), valid, cfg);
    expect(segments[0]!.status).toBe('confirmed');
    expect(segments[0]!.endRaw).toBe(3);
    expect(segments[0]!.confirmedAt).toBe(108);
    expect(segments[0]!.dependencyKeys).toEqual(bis.map(b => b.key));
    const split = bis.map((b, i) => ({ ...b, continuityId: i < 4 ? 'left' : 'right' }));
    const separated = detectSegments(split, new Map(fx.map(f => [f.id, f])), valid, cfg);
    expect(separated.every(s => !(s.startRaw < 4 && s.endRaw > 4))).toBe(true);
  });

  it('盘整的完成进入/离开在已关闭窗口内，传播延迟确认', () => {
    const centers = [evidenceCenter(10, 20, 30), evidenceCenter(40, 60, 70)];
    const trends = detectTrends(centers, cfg);
    expect(trends[0]!.status).toBe('confirmed');
    expect(trends[0]!.confirmedAt).toBe(85);
    const bars = Array.from({ length: 150 }, (_, i) => {
      const close = i < 20 ? 100 + i : i < 30 ? 120 : i <= 45 ? 120 + (i - 30) / 3 : 110;
      return { date: String(i), low: close - 0.1, high: close + 0.1, close };
    });
    const entry = evidenceMovement(1, 0, 20, 31);
    const leave = evidenceMovement(2, 30, 45, 95);
    const geometric = { ...cfg, divMetric: '中枢视角几何' as const };
    const divs = detectDivergences(trends, centers, bars, null, geometric, [entry, leave]);
    const d = divs.find(x => x.status === 'confirmed');
    expect(d).toBeDefined();
    expect([d!.bStart, d!.bEnd, d!.cStart, d!.cEnd]).toEqual([0, 20, 30, 45]);
    expect(d!.cForce).toBeLessThan(d!.bForce);
    expect(d!.confirmedAt).toBe(95);
    expect(d!.dependencyKeys).toContain(leave.key);
    const hist: (number | null)[] = bars.map((_, i) => i <= 20 ? 1 : i >= 30 && i <= 45 ? 0.1 : 0);
    const macdDiv = detectDivergences(trends, centers, bars, hist, cfg, [entry, leave]).find(x => x.status === 'confirmed');
    expect(macdDiv).toBeDefined();
    expect(macdDiv!.bForce).toBe(21);
    expect(macdDiv!.cForce).toBeCloseTo(1.6);
    expect(macdDiv!.confirmedAt).toBe(95);
    hist[10] = null;
    expect(detectDivergences(trends, centers, bars, hist, cfg, [entry, leave]).filter(x => x.status === 'confirmed')).toEqual([]);
    const outside = evidenceMovement(3, 30, 100, 130);
    const future = detectDivergences(trends, centers, bars, null, geometric, [entry, leave, outside]);
    expect(future.find(x => x.key === d!.key)).toEqual(d);
    expect(detectDivergences(trends, centers, bars, null, geometric, [entry, outside]).filter(x => x.status === 'confirmed')).toEqual([]);
    const candidate = detectDivergences(trends, centers, bars, null, geometric, [entry]);
    expect(candidate.filter(x => x.status === 'confirmed')).toEqual([]);
  });

  it('趋势前驱按有序同级来源查找，不假设 center.id - 1', () => {
    const centers = [evidenceCenter(10, 10, 20), evidenceCenter(40, 30, 40), evidenceCenter(90, 60, 70)];
    const trends: Trend[] = [
      { id: 1, key: 'trend:up', kind: '上涨', centerIds: [10, 40], startRaw: 10, endRaw: 40, status: 'confirmed', confirmedAt: 85, continuityId: 'golden', quality: 'verified', dependencyKeys: centers.map(c => c.key!) },
      { id: 2, key: 'trend:next', kind: '盘整', centerIds: [90], startRaw: 60, endRaw: 70, status: 'candidate', confirmedAt: null, continuityId: 'golden', quality: 'verified', dependencyKeys: ['center:90'] },
    ];
    const bars = Array.from({ length: 100 }, (_, i) => {
      const close = i < 30 ? 100 + i : i <= 55 ? 130 + (i - 40) / 5 : 100;
      return { date: String(i), low: close - 0.1, high: close + 0.1, close };
    });
    const divs = detectDivergences(trends, centers, bars, null, { ...cfg, divMetric: '中枢视角几何' }, [evidenceMovement(1, 40, 55, 95)]);
    const d = divs.find(x => x.kind === '趋势背驰' && x.status === 'confirmed');
    expect(d).toBeDefined();
    expect(d!.bStart).toBe(10);
    expect(d!.bEnd).toBe(30);
    expect(d!.dependencyKeys).toContain('center:10');
    expect(d!.confirmedAt).toBe(95);
  });

  it('九个真正闭合的 degree1 走势生成非空 degree2，时间包括关闭证据', () => {
    const centers = Array.from({ length: 10 }, (_, i) => evidenceCenter(i + 1, i * 10, i * 10 + 5));
    const trends = detectTrends(centers, cfg);
    expect(trends.filter(t => t.status === 'confirmed')).toHaveLength(9);
    const levels = buildLevels(centers, trends, cfg);
    const higher = levels.find(l => l.degree === 2)!;
    expect(higher.centers).toHaveLength(1);
    const c = higher.centers[0]!;
    expect(c.status).toBe('confirmed');
    expect(c.evolution).toBe('upgraded');
    expect(c.formedRaw).toBe(25);
    expect(c.formedAt).toBe(50);
    expect(c.terminatedAt).toBe(110);
    expect(c.confirmedAt).toBe(110);
    expect(c.dependencyKeys).toEqual(trends.slice(0, 9).map(t => t.key));
    expect(c.quality).toBe('verified');
    const split = trends.map((t, i) => ({ ...t, continuityId: i < 4 ? 'left' : 'right' }));
    const separated = buildLevels(centers, split, cfg).find(l => l.degree === 2)!;
    expect(separated.centers.every(x => x.status === 'candidate')).toBe(true);
  });
});
