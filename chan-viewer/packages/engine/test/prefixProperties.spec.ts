// 性质测试 P1–P5：前缀一致/批增量同源/不回填/无包含/笔交替。
// 种子随机游走 + 多口径覆盖。真实样本性质测试见 P4 交叉核验。
import { describe, expect, it } from 'vitest';
import { compute, createReplay, noInclusion, type ChanConfig, type KInput } from '../src/index.ts';

/** mulberry32 种子 PRNG（可复现）。 */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 随机游走K线：含趋势段与震荡段，自然产生包含/分型/笔。 */
function walk(seed: number, n: number): KInput[] {
  const rnd = prng(seed);
  const out: KInput[] = [];
  let mid = 100;
  let drift = 0;
  for (let i = 0; i < n; i++) {
    if (i % 20 === 0) drift = (rnd() - 0.5) * 3; // 周期切换趋势
    mid += drift + (rnd() - 0.5) * 4;
    const range = 0.5 + rnd() * 4;
    const low = mid - range / 2;
    const high = mid + range / 2;
    out.push({ date: String(i), low, high });
  }
  return out;
}

const 口径矩阵: ChanConfig[] = [
  { startDir: 'up', precision: { digits: 'raw' }, biRule: '77课', mergeDir: '回找非包含' },
  { startDir: 'down', precision: { digits: 'raw' }, biRule: '77课', mergeDir: '回找非包含' },
  { startDir: 'up', precision: { digits: 0 }, biRule: '77课', mergeDir: '回找非包含' },
  { startDir: 'up', precision: { digits: 2 }, biRule: '社区老笔', mergeDir: '回找非包含' },
  { startDir: 'up', precision: { digits: 'raw' }, biRule: '社区新笔', mergeDir: '回找非包含' },
  { startDir: 'up', precision: { digits: 'raw' }, biRule: '77课', mergeDir: '直接用前一根' },
];

describe('P2 批==增量拼接 & P1 前缀事件一致', () => {
  for (const cfg of 口径矩阵) {
    it(`口径 ${cfg.biRule}/${cfg.mergeDir}/d${cfg.precision.digits}/${cfg.startDir}`, () => {
      const bars = walk(42, 300);
      const full = compute(bars, cfg);
      // 批==增量
      const r = createReplay(cfg);
      const concat = bars.flatMap((b) => r.push(b));
      expect(concat).toEqual(full.events);
      expect(r.result().validBars).toEqual(full.validBars);
      // 前缀事件一致（蕴含不回填）：∀n，compute(前n根).events == full.events[at<n]
      for (const n of [1, 2, 3, 5, 10, 50, 120, 200, 299, 300]) {
        const pre = compute(bars.slice(0, n), cfg);
        expect(pre.events).toEqual(full.events.filter((e) => e.at < n));
      }
    });
  }
});

describe('P3 已确认对象不回填', () => {
  it('分型撤销只针对候选；改端点只针对候选笔', () => {
    for (const seed of [1, 7, 42, 99, 2026]) {
      const bars = walk(seed, 400);
      for (const cfg of 口径矩阵) {
        const { events } = compute(bars, cfg);
        const confirmedFxAt = new Map<number, number>();
        const confirmedBiAt = new Map<number, number>();
        for (const e of events) {
          if (e.kind === '分型确认' && e.id != null) confirmedFxAt.set(e.id, e.at);
          if (e.kind === '笔确认' && e.id != null) confirmedBiAt.set(e.id, e.at);
          if (e.kind === '分型撤销' && e.id != null) {
            const c = confirmedFxAt.get(e.id);
            expect(c === undefined || c > e.at).toBe(true); // 撤销发生在确认之前（即仍是候选）
          }
          if (e.kind === '改端点' && e.id != null) {
            const c = confirmedBiAt.get(e.id);
            expect(c === undefined || c > e.at).toBe(true);
          }
        }
      }
    }
  });
});

describe('P4 有效K线无包含（原文方向口径）', () => {
  it('随机游走收尾自检', () => {
    for (const seed of [1, 7, 42, 99, 2026, 31415]) {
      const bars = walk(seed, 500);
      const cfg: ChanConfig = { startDir: 'up', precision: { digits: 'raw' }, biRule: '77课', mergeDir: '回找非包含' };
      const r = compute(bars, cfg);
      expect(noInclusion(r.validBars)).toBe(true);
    }
  });
});

describe('P5 笔顶底交替且首尾相接', () => {
  it('随机游走', () => {
    for (const seed of [1, 7, 42, 99, 2026]) {
      const bars = walk(seed, 500);
      for (const cfg of 口径矩阵) {
        const { bis, fractals } = compute(bars, cfg);
        const byId = new Map(fractals.map((f) => [f.id, f]));
        for (let i = 0; i < bis.length; i++) {
          const b = bis[i]!;
          const s = byId.get(b.start)!;
          const e = byId.get(b.end)!;
          expect(s.type).not.toBe(e.type); // 一顶一底
          expect(b.dir).toBe(e.type === 'top' ? 'up' : 'down');
          if (i > 0) {
            expect(bis[i - 1]!.end).toBe(b.start); // 首尾相接
            expect(bis[i - 1]!.dir).not.toBe(b.dir); // 上下交替
          }
        }
      }
    }
  });
});