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
    out.push({ date: String(i), low, high, close: mid });
  }
  return out;
}

const base: ChanConfig = {
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
const CALIBER_MATRIX: ChanConfig[] = [
  base,
  { ...base, startDir: 'down' },
  { ...base, precision: { digits: 0 } },
  { ...base, precision: { digits: 2 }, biRule: '社区老笔' },
  { ...base, biRule: '社区新笔' },
  { ...base, mergeDir: '直接用前一根' },
  { ...base, touchOverlap: '须严格重叠' },
  { ...base, segMerge: '不做包含处理' },
  { ...base, centerUnit: '笔中枢' },
  { ...base, centerUpgrade: '不自动升级' },
  { ...base, trendOverlap: '外围也不重叠' },
  { ...base, divMetric: '中枢视角几何' },
  { ...base, bsp3Touch: '不触及ZG' },
  { ...base, bsp2Filter: '过滤二买须高于一买' },
];

describe('P2 批==增量拼接 & P1 前缀事件一致', () => {
  for (const cfg of CALIBER_MATRIX) {
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
      for (const cfg of CALIBER_MATRIX) {
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
      const cfg: ChanConfig = { ...base };
      const r = compute(bars, cfg);
      expect(noInclusion(r.validBars)).toBe(true);
    }
  });
});

describe('P5 笔顶底交替且首尾相接', () => {  it('随机游走', () => {
    for (const seed of [1, 7, 42, 99, 2026]) {
      const bars = walk(seed, 500);
      for (const cfg of CALIBER_MATRIX) {
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

describe('P6 线段：方向交替、首尾相接、已确认对前缀稳定', () => {
  it('随机游走 + 多口径', () => {
    for (const seed of [1, 7, 42, 99, 2026]) {
      const bars = walk(seed, 500);
      for (const cfg of CALIBER_MATRIX) {
        const full = compute(bars, cfg);
        const { segments } = full;
        const byId = new Map(full.fractals.map((f) => [f.id, f]));
        for (let i = 0; i < segments.length; i++) {
          const s = segments[i]!;
          const sf = byId.get(s.startFx)!;
          const ef = byId.get(s.endFx)!;
          expect(sf.type).not.toBe(ef.type); // 起止一顶一底
          expect(s.dir).toBe(ef.type === 'top' ? 'up' : 'down'); // 向上线段止于顶
          expect(s.startRaw).toBeLessThanOrEqual(s.endRaw);
          if (i > 0) {
            expect(segments[i - 1]!.endFx).toBe(s.startFx); // 首尾相接（共享分型）
            expect(segments[i - 1]!.dir).not.toBe(s.dir); // 方向交替
          }
        }
        // 已确认线段对前缀稳定（不回填）：前 n 根已确认线段，在全量中同 id 且几何一致。
        const pre = compute(bars.slice(0, 250), cfg);
        for (const ps of pre.segments.filter((s) => s.status === 'confirmed')) {
          const fs = full.segments.find((x) => x.id === ps.id);
          expect(fs).toBeDefined();
          expect([fs!.startRaw, fs!.endRaw, fs!.high, fs!.low, fs!.dir]).toEqual([
            ps.startRaw, ps.endRaw, ps.high, ps.low, ps.dir,
          ]);
        }
      }
    }
  });
});

describe('P7 中枢：核心有效、外围包络、已确认对前缀稳定', () => {
  it('随机游走 + 多口径', () => {
    for (const seed of [1, 7, 42, 99, 2026]) {
      const bars = walk(seed, 500);
      for (const cfg of CALIBER_MATRIX) {
        const full = compute(bars, cfg);
        for (const c of full.centers) {
          expect(c.ZD).toBeLessThanOrEqual(c.ZG); // 核心有效
          expect(c.GG).toBeGreaterThanOrEqual(c.ZG); // 外围上沿≥核心上沿
          expect(c.DD).toBeLessThanOrEqual(c.ZD); // 外围下沿≤核心下沿
          expect(c.segCount).toBeGreaterThanOrEqual(3); // 至少三构件
          expect(c.startRaw).toBeLessThanOrEqual(c.endRaw);
        }
        // 已确认中枢对前缀稳定（不回填）。
        const pre = compute(bars.slice(0, 250), cfg);
        for (const pc of pre.centers.filter((c) => c.status === 'confirmed')) {
          const fc = full.centers.find((x) => x.id === pc.id);
          expect(fc).toBeDefined();
          expect([fc!.ZG, fc!.ZD, fc!.startRaw, fc!.endRaw, fc!.segCount]).toEqual([
            pc.ZG, pc.ZD, pc.startRaw, pc.endRaw, pc.segCount,
          ]);
        }
      }
    }
  });
});

describe('P8 走势类型：盘整单中枢、趋势同向不重叠、已确认对前缀稳定', () => {
  it('随机游走 + 多口径', () => {
    for (const seed of [1, 7, 42, 99, 2026]) {
      const bars = walk(seed, 500);
      for (const cfg of CALIBER_MATRIX) {
        const full = compute(bars, cfg);
        const centerById = new Map(full.centers.map((c) => [c.id, c]));
        for (const t of full.trends) {
          if (t.kind === '盘整') expect(t.centerIds.length).toBe(1);
          else expect(t.centerIds.length).toBeGreaterThanOrEqual(2);
          // 趋势同向不重叠（核心口径必然成立；外围口径更严，蕴含核心不重叠）。
          for (let k = 1; k < t.centerIds.length; k++) {
            const a = centerById.get(t.centerIds[k - 1]!)!;
            const b = centerById.get(t.centerIds[k]!)!;
            if (t.kind === '上涨') expect(b.ZD).toBeGreaterThan(a.ZG);
            if (t.kind === '下跌') expect(b.ZG).toBeLessThan(a.ZD);
          }
        }
        // 已确认走势段对前缀稳定（不回填）。
        const pre = compute(bars.slice(0, 250), cfg);
        for (const pt of pre.trends.filter((t) => t.status === 'confirmed')) {
          const ft = full.trends.find((x) => x.id === pt.id);
          expect(ft).toBeDefined();
          expect(ft!.kind).toBe(pt.kind);
          expect(ft!.centerIds).toEqual(pt.centerIds);
        }
      }
    }
  });
});

describe('P9 背驰：c<b、已确认对前缀稳定', () => {
  it('随机游走 + 多口径', () => {
    for (const seed of [1, 7, 42, 99, 2026]) {
      const bars = walk(seed, 500);
      for (const cfg of CALIBER_MATRIX) {
        const full = compute(bars, cfg);
        for (const d of full.divergences) {
          expect(d.cForce).toBeLessThan(d.bForce); // 背驰成立条件
          expect(d.cStart).toBeLessThanOrEqual(d.cEnd);
        }
        const pre = compute(bars.slice(0, 250), cfg);
        for (const pd of pre.divergences.filter((d) => d.status === 'confirmed')) {
          const fd = full.divergences.find((x) => x.id === pd.id);
          expect(fd).toBeDefined();
          expect([fd!.kind, fd!.bForce, fd!.cForce, fd!.cEnd]).toEqual([pd.kind, pd.bForce, pd.cForce, pd.cEnd]);
        }
      }
    }
  });
});