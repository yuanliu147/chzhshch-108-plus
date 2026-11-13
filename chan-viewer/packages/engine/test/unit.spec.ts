// 单元测试：移植 配图自检.py 第1–3关断言 + 管线级确定性用例 + 边界。
import { describe, expect, it } from 'vitest';
import {
  areaBetween,
  bot3,
  centerBounds,
  checkBi,
  compute,
  contains,
  detectPoints,
  detectTrends,
  either,
  macd,
  merge,
  moreExtreme,
  noInclusion,
  overlap,
  overlapAll,
  segBot3,
  segTop3,
  standardizeSeq,
  top3,
  type Center,
  type ChanConfig,
  type Divergence,
  type Fractal,
  type KInput,
} from '../src/index.ts';

const originalConfig: ChanConfig = {
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

/** 区间 [low, high] → KInput。 */
function bars(ivs: [number, number][]): KInput[] {
  return ivs.map(([low, high], i) => ({ date: String(i), low, high }));
}
const iv = (low: number, high: number) => ({ low, high });

describe('包含处理纯函数（移植 配图自检.py L62–83）', () => {
  it('向上合并', () => expect(merge(iv(10, 14), iv(11, 13), true)).toEqual(iv(11, 14)));
  it('向下合并', () => expect(merge(iv(10, 14), iv(11, 13), false)).toEqual(iv(10, 13)));
  it('1与2包含', () => expect(either(iv(10, 14), iv(11, 13))).toBe(true));
  it('2与3包含', () => expect(either(iv(11, 13), iv(9, 13.5))).toBe(true));
  it('1与3不包含（不传递）', () => expect(either(iv(10, 14), iv(9, 13.5))).toBe(false));
  it('先合并12再与3比无包含', () => expect(either(merge(iv(10, 14), iv(11, 13), true), iv(9, 13.5))).toBe(false));
  it('contains 方向', () => {
    expect(contains(iv(10, 16), iv(12, 15))).toBe(true);
    expect(contains(iv(12, 15), iv(10, 16))).toBe(false);
  });
});

describe('方向来源与反向合并后果（移植 配图自检.py L72–83）', () => {
  const fxK: [number, number][] = [[12, 16], [10, 15], [9, 14], [10, 13]];
  it('只有第3与第4根包含', () => {
    const e = [0, 1, 2].map((i) => either(iv(...fxK[i]!), iv(...fxK[i + 1]!)));
    expect(e).toEqual([false, false, true]);
  });
  it('正确合并得[9,13]，保住新低点9，与前一根无包含', () => {
    const r = compute(bars(fxK), originalConfig);
    const tail = r.validBars[r.validBars.length - 1]!;
    expect([tail.low, tail.high]).toEqual([9, 13]);
    expect(noInclusion(r.validBars)).toBe(true);
  });
  it('错误示范口径抹掉新低点（与原文口径结果不同）', () => {
    // tail=(9,14), new=(10,14)：错误规则 new.high>=tail.high → 向上 → (10,14)；正确向下 → (9,14)。
    const seq: [number, number][] = [[10, 15], [9, 14], [10, 14]];
    const ok = compute(bars(seq), originalConfig);
    const bad = compute(bars(seq), { ...originalConfig, mergeDir: '直接用前一根' });
    const okTail = ok.validBars[ok.validBars.length - 1]!;
    const badTail = bad.validBars[bad.validBars.length - 1]!;
    expect([okTail.low, okTail.high]).toEqual([9, 14]);
    expect([badTail.low, badTail.high]).toEqual([10, 14]);
    expect(badTail.low).toBeGreaterThan(Math.min(9, 10)); // 新低点9被抹掉
  });
});

describe('分型（移植 配图自检.py L85–93）', () => {
  it('顶分型成立', () => expect(top3([iv(10, 13), iv(12, 16), iv(11, 14)])).toBe(true));
  it('底分型成立', () => expect(bot3([iv(11, 14), iv(8, 12), iv(10, 13)])).toBe(true));
  it('上升K线不是分型', () => {
    const s = [iv(8, 12), iv(10, 14), iv(12, 16)];
    expect(top3(s)).toBe(false);
    expect(bot3(s)).toBe(false);
  });
  it('下降K线不是分型', () => {
    const s = [iv(12, 16), iv(10, 14), iv(8, 12)];
    expect(top3(s)).toBe(false);
    expect(bot3(s)).toBe(false);
  });
  it('分型陷阱：先合并再判分型', () => {
    // 原始四根 (8,14),(10,16),(12,15),(11,15)：第3根被第2根包含，合并后成顶分型。
    const r = compute(bars([[8, 14], [10, 16], [12, 15], [11, 15]]), originalConfig);
    expect(r.validBars.length).toBe(3);
    expect(r.fractals.some((f) => f.type === 'top')).toBe(true);
  });
});

describe('笔价格区间条件（移植 配图自检.py L109–111）', () => {
  function fx(type: 'top' | 'bottom', middle: number, low: number, high: number): Fractal {
    return {
      id: middle, type, middle,
      price: type === 'top' ? high : low,
      midHigh: high, midLow: low,
      startRaw: middle - 1, endRaw: middle + 1,
      status: 'confirmed', confirmedAt: middle + 1,
    };
  }
  it('合格：顶区间部分高于底区间（允许重叠）', () => {
    // 顶(8,12) 底(6,10)：12>10 ✓
    expect(checkBi(fx('top', 1, 8, 12), fx('bottom', 6, 6, 10), '77课').ok).toBe(true);
  });
  it('不合格：顶区间整个落在底区间内', () => {
    // 顶(10,12) 底(7,13)：12<=13 ✗（即便顶比底高）
    expect(checkBi(fx('top', 1, 10, 12), fx('bottom', 6, 7, 13), '77课').ok).toBe(false);
  });
  it('社区老笔比两个价：顶高于底即可（同一例老笔通过）', () => {
    expect(checkBi(fx('top', 1, 10, 12), fx('bottom', 6, 7, 13), '社区老笔').ok).toBe(true);
  });
  it('独立K线：middle差2/3不足，4合格（笔①②③）', () => {
    const t = fx('top', 1, 12, 16);
    expect(checkBi(t, fx('bottom', 3, 6, 9), '77课').ok).toBe(false); // 差2
    expect(checkBi(t, fx('bottom', 4, 6, 9), '77课').ok).toBe(false); // 差3
    expect(checkBi(t, fx('bottom', 5, 6, 9), '77课').ok).toBe(true); // 差4
    expect(checkBi(t, fx('bottom', 4, 6, 9), '社区新笔').ok).toBe(true); // 新笔差3合格
  });
  it('moreExtreme 严格（相等不算）', () => {
    expect(moreExtreme(fx('top', 5, 8, 16), fx('top', 1, 8, 14))).toBe(true);
    expect(moreExtreme(fx('top', 5, 8, 14), fx('top', 1, 8, 14))).toBe(false);
    expect(moreExtreme(fx('bottom', 5, 6, 9), fx('bottom', 1, 8, 11))).toBe(true);
  });
});

describe('管线确定性用例：顶→底→顶 成笔与确认时机', () => {
  // 无包含的下降-上升-下降序列，顶middle2、底middle6、顶middle10。
  const seq: [number, number][] = [
    [10, 12], [12, 14], [14, 16], [13, 15], [11, 13], [9, 11], [7, 9],
    [8, 10], [10, 12], [12, 14], [14, 16], [13, 15], [11, 13],
  ];
  const r = compute(bars(seq), originalConfig);
  it('有效K线无包含且等于原始（无包含发生）', () => {
    expect(r.validBars.length).toBe(seq.length);
    expect(noInclusion(r.validBars)).toBe(true);
  });
  it('三个确认分型：顶/底/顶', () => {
    const conf = r.fractals.filter((f) => f.status === 'confirmed');
    expect(conf.map((f) => f.type)).toEqual(['top', 'bottom', 'top']);
    expect(conf.map((f) => f.middle)).toEqual([2, 6, 10]);
  });
  it('两笔：第一笔确认向下，第二笔候选向上', () => {
    expect(r.bis.length).toBe(2);
    expect(r.bis[0]!.status).toBe('confirmed');
    expect(r.bis[0]!.dir).toBe('down');
    expect(r.bis[1]!.status).toBe('candidate');
    expect(r.bis[1]!.dir).toBe('up');
    expect(r.bis[0]!.end).toBe(r.bis[1]!.start);
  });
  it('事件含笔确认与笔候选', () => {
    expect(r.events.some((e) => e.kind === '笔确认')).toBe(true);
    expect(r.events.filter((e) => e.kind === '笔候选').length).toBe(2);
  });
});

describe('线段内核（移植 配图自检.py L118–140）', () => {
  it('前三笔有重叠 / 三笔无重叠则不构成', () => {
    expect(overlapAll([iv(10, 15), iv(12, 15), iv(12, 18)], true)).toEqual({ low: 12, high: 15 });
    expect(overlapAll([iv(11, 15), iv(11, 18), iv(16, 18)], true)).toBeNull();
  });
  it('特征序列无包含即标准', () => {
    const X = [iv(12, 15), iv(14, 18), iv(16, 20)];
    expect(standardizeSeq(X, true)).toEqual(X);
  });
  it('第一种情况：标准化 + 顶分型 + 一二元素无缺口', () => {
    const c1 = [iv(12, 15), iv(14, 19), iv(13, 20), iv(11, 17)];
    const s1 = standardizeSeq(c1, true);
    expect(s1).toEqual([iv(12, 15), iv(14, 20), iv(11, 17)]);
    expect(segTop3(s1)).toBe(true);
    expect(overlap(s1[0]!, s1[1]!, true)).toBe(true); // 无缺口
  });
  it('第二种情况：标准化 + 顶分型 + 一二元素有缺口 + 第二序列底分型', () => {
    const c2 = [iv(11, 14), iv(16, 20), iv(10, 18), iv(12, 13)];
    const s2 = standardizeSeq(c2, true);
    expect(s2).toEqual([iv(11, 14), iv(16, 20), iv(10, 13)]);
    expect(segTop3(s2)).toBe(true);
    expect(overlap(s2[0]!, s2[1]!, true)).toBe(false); // 有缺口
    const second = standardizeSeq([iv(16, 18), iv(10, 13), iv(12, 15)], false);
    expect(segBot3(second)).toBe(true);
  });
  it('端点相接口径：相接算重叠 vs 须严格重叠', () => {
    expect(overlap(iv(10, 14), iv(14, 18), true)).toBe(true); // 相接 lo==hi 算重叠
    expect(overlap(iv(10, 14), iv(14, 18), false)).toBe(false); // 严格 lo<hi 不成立
  });
});

describe('边界与口径校验', () => {
  it('空输入', () => {
    const r = compute([], originalConfig);    expect(r.validBars.length).toBe(0);
    expect(r.fractals.length).toBe(0);
    expect(r.bis.length).toBe(0);
  });
  it('1根/2根无分型', () => {
    expect(compute(bars([[1, 2]]), originalConfig).fractals.length).toBe(0);
    expect(compute(bars([[1, 2], [3, 4]]), originalConfig).fractals.length).toBe(0);
  });
  it('全相等区间：包含合并，起点方向写日志', () => {
    const r = compute(bars([[5, 5], [5, 5], [5, 5]]), originalConfig);
    expect(r.validBars.length).toBe(1);
    expect(r.events.some((e) => e.kind === '起点方向')).toBe(true);
  });
  it('拒绝缺省/非法口径', () => {
    expect(() => compute([], {} as ChanConfig)).toThrow();
    expect(() => compute([], { ...originalConfig, biRule: '随便' as never })).toThrow();
    expect(() => compute([], { ...originalConfig, precision: { digits: 9 as never } })).toThrow();
  });
  it('精度舍入改变包含判定（half-up）', () => {
    // raw 交叉无包含：bar1(10.04,10.12) bar2(10.0,10.06)；取个位都=(10,10) → 包含。
    const seq: [number, number][] = [[10.04, 10.12], [10.0, 10.06]];
    const raw = compute(bars(seq), originalConfig);
    const d0 = compute(bars(seq), { ...originalConfig, precision: { digits: 0 } });
    expect(raw.validBars.length).toBe(2);
    expect(d0.validBars.length).toBe(1);
  });
  it('configId 稳定且随口径变化', () => {
    const a = compute([], originalConfig).configId;
    const b = compute([], originalConfig).configId;
    const c = compute([], { ...originalConfig, startDir: 'down' }).configId;
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe('中枢内核（移植 配图自检.py L142–163）', () => {
  it('三段重叠构成中枢核心（简化式一致）', () => {
    expect(overlapAll([iv(9, 13), iv(10, 13), iv(10, 14)], true)).toEqual({ low: 10, high: 13 });
    expect([Math.max(9, 10), Math.min(13, 14)]).toEqual([10, 13]); // [max(a2,c2),min(a1,c1)]
  });
  it('中枢边界 ZG/ZD/GG/DD/G/D（20课，同向Z段）', () => {
    const b = centerBounds([iv(9, 13), iv(10, 14), iv(11, 12.5)]);
    expect(b.ZG).toBe(13); // min(g1,g2)=min(13,14)
    expect(b.ZD).toBe(10); // max(d1,d2)=max(9,10)
    expect(b.GG).toBe(14); // max(gn)
    expect(b.DD).toBe(9); // min(dn)
    expect(b.G).toBe(12.5); // min(gn)
    expect(b.D).toBe(11); // max(dn)
  });
  it('延伸：后续构件与核心重叠', () => {
    expect(overlap(iv(11, 12.5), iv(10, 13), true)).toBe(true);
  });
});

describe('走势类型（移植 配图自检.py L159–163）', () => {
  const centerOf = (id: number, zd: number, zg: number): Center => ({
    id, unit: 'segment', dir: 'up', startRaw: id * 10, endRaw: id * 10 + 9,
    ZG: zg, ZD: zd, GG: zg + 1, DD: zd - 1, G: zg, D: zd, segCount: 3,
    formedAt: id * 10 + 9, terminatedAt: id * 10 + 10, evolution: 'terminated',
    status: 'confirmed', confirmedAt: null,
  });
  it('两中枢向上不重叠 → 上涨趋势', () => {
    const ts = detectTrends([centerOf(1, 10, 13), centerOf(2, 16, 19)], originalConfig);
    expect(ts.length).toBe(1);
    expect(ts[0]!.kind).toBe('上涨');
    expect(ts[0]!.centerIds).toEqual([1, 2]);
  });
  it('两中枢向下不重叠 → 下跌趋势', () => {
    const ts = detectTrends([centerOf(1, 17, 20), centerOf(2, 11, 14)], originalConfig);
    expect(ts[0]!.kind).toBe('下跌');
  });
  it('单中枢 → 盘整', () => {
    const ts = detectTrends([centerOf(1, 10, 13)], originalConfig);
    expect(ts[0]!.kind).toBe('盘整');
    expect(ts[0]!.centerIds).toEqual([1]);
  });
  it('两中枢重叠 → 不合并为趋势（各自盘整）', () => {
    const ts = detectTrends([centerOf(1, 10, 13), centerOf(2, 12, 15)], originalConfig);
    expect(ts.length).toBe(2);
    expect(ts.every((t) => t.kind === '盘整')).toBe(true);
  });
});

describe('MACD 与背驰（移植 配图自检.py L166–174）', () => {
  it('EMA 种子=首值，常数序列 MACD 全 0', () => {
    const m = macd([10, 10, 10, 10]);
    expect(m.dif).toEqual([0, 0, 0, 0]);
    expect(m.hist).toEqual([0, 0, 0, 0]);
  });
  it('MACD 对齐长度且 PIT（前缀只影响前缀）', () => {
    const closes = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const m = macd(closes);
    expect(m.dif.length).toBe(closes.length);
    const m5 = macd(closes.slice(0, 5));
    expect(m5.dif).toEqual(m.dif.slice(0, 5));
    expect(m5.hist).toEqual(m.hist.slice(0, 5));
  });
  it('areaBetween：同向柱面积，C段<A段构成背驰', () => {
    const hist = [0.3, -0.2, 0.4, -0.1, 0.2, -1.2, -2.0, 0.3, -0.4, 0.2, -0.7, -0.9, 0.8, 0.3, 1.0];
    const areaA = areaBetween(hist, 5, 6, false);
    const areaC = areaBetween(hist, 10, 11, false);
    expect(areaA).toBeCloseTo(3.2);
    expect(areaC).toBeCloseTo(1.6);
    if (areaA == null || areaC == null) throw new Error('完整 MACD 窗口必须有面积判据');
    expect(areaC).toBeLessThan(areaA);
  });
});

describe('买卖点（20/21/101课口径分歧）', () => {
  const kb = (n: number, hl?: (i: number) => [number, number]): KInput[] =>
    Array.from({ length: n }, (_, i) => {
      const [low, high] = hl ? hl(i) : [i, i + 1];
      return { date: String(i), low, high };
    });
  const vb = (bs: KInput[]) => bs.map((b, i) => ({ index: i, high: b.high, low: b.low, startRaw: i, endRaw: i }));
  const fxOf = (id: number, type: 'top' | 'bottom', middle: number, price: number): Fractal => ({
    id, type, middle, price, midHigh: price, midLow: price, startRaw: middle - 1, endRaw: middle + 1, status: 'confirmed', confirmedAt: middle + 1,
  });
  const trendDiv = (dir: 'up' | 'down', cEnd: number): Divergence => ({
    id: 1, kind: '趋势背驰', metric: 'MACD面积', dir, bStart: 0, bEnd: 5, cStart: 5, cEnd, bForce: 2, cForce: 1, est: false, status: 'confirmed', confirmedAt: null,
  });
  const centerOf2 = (zg: number, zd: number, endRaw: number): Center => ({
    id: 1, unit: 'segment', dir: 'up', startRaw: 0, endRaw, ZG: zg, ZD: zd, GG: zg + 1, DD: zd - 1, G: zg, D: zd, segCount: 3, formedAt: 0, terminatedAt: endRaw, evolution: 'terminated', status: 'confirmed', confirmedAt: null,
  });

  it('一买=下跌趋势背驰转折点；一卖=上涨趋势背驰', () => {
    const bars = kb(12);
    expect(detectPoints([trendDiv('down', 10)], [], [], vb(bars), bars, originalConfig, [], 'historical-fractals').some((p) => p.klass === 1 && p.side === 'buy')).toBe(true);
    expect(detectPoints([trendDiv('up', 10)], [], [], vb(bars), bars, originalConfig, [], 'historical-fractals').some((p) => p.klass === 1 && p.side === 'sell')).toBe(true);
  });
  it('三买边界：不跌破ZG(>=) vs 不触及ZG(>) 在端点相接时分歧', () => {
    // 中枢 ZG=13，bars[6].high=14 向上离开，底分型 middle=8 低点=13（==ZG）。
    const bars = kb(12, (i) => (i === 6 ? [12, 14] : [10, 12]));
    const center = centerOf2(13, 10, 5);
    const bot = fxOf(1, 'bottom', 8, 13);
    const yes = detectPoints([], [center], [bot], vb(bars), bars, { ...originalConfig, bsp3Touch: '不跌破ZG' }, [], 'historical-fractals');
    const no = detectPoints([], [center], [bot], vb(bars), bars, { ...originalConfig, bsp3Touch: '不触及ZG' }, [], 'historical-fractals');
    expect(yes.some((p) => p.klass === 3 && p.side === 'buy')).toBe(true); // 13>=13 不跌破→三买
    expect(no.some((p) => p.klass === 3)).toBe(false); // 13>13 不触及→非三买
  });
  it('二买过滤：允许二买低于一买(101课) vs 过滤须高于一买', () => {
    // 一买@10 价10；顶分型@12（回抽），底分型@14 价9（<一买）。
    const bars = kb(16);
    const top = fxOf(2, 'top', 12, 20);
    const bot2 = fxOf(3, 'bottom', 14, 9);
    const allow = detectPoints([trendDiv('down', 10)], [], [top, bot2], vb(bars), bars, { ...originalConfig, bsp2Filter: '允许二买低于一买' }, [], 'historical-fractals');
    const filt = detectPoints([trendDiv('down', 10)], [], [top, bot2], vb(bars), bars, { ...originalConfig, bsp2Filter: '过滤二买须高于一买' }, [], 'historical-fractals');
    expect(allow.some((p) => p.klass === 2 && p.side === 'buy')).toBe(true);
    expect(filt.some((p) => p.klass === 2)).toBe(false);
  });
});