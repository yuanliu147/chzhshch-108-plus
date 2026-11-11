// 单元测试：移植 配图自检.py 第1–3关断言 + 管线级确定性用例 + 边界。
import { describe, expect, it } from 'vitest';
import {
  bot3,
  checkBi,
  compute,
  contains,
  either,
  merge,
  moreExtreme,
  noInclusion,
  top3,
  type ChanConfig,
  type Fractal,
  type KInput,
} from '../src/index.ts';

const 原文: ChanConfig = { startDir: 'up', precision: { digits: 'raw' }, biRule: '77课', mergeDir: '回找非包含' };

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
    const r = compute(bars(fxK), 原文);
    const tail = r.validBars[r.validBars.length - 1]!;
    expect([tail.low, tail.high]).toEqual([9, 13]);
    expect(noInclusion(r.validBars)).toBe(true);
  });
  it('错误示范口径抹掉新低点（与原文口径结果不同）', () => {
    // tail=(9,14), new=(10,14)：错误规则 new.high>=tail.high → 向上 → (10,14)；正确向下 → (9,14)。
    const seq: [number, number][] = [[10, 15], [9, 14], [10, 14]];
    const ok = compute(bars(seq), 原文);
    const bad = compute(bars(seq), { ...原文, mergeDir: '直接用前一根' });
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
    const r = compute(bars([[8, 14], [10, 16], [12, 15], [11, 15]]), 原文);
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
  const r = compute(bars(seq), 原文);
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

describe('边界与口径校验', () => {
  it('空输入', () => {
    const r = compute([], 原文);
    expect(r.validBars.length).toBe(0);
    expect(r.fractals.length).toBe(0);
    expect(r.bis.length).toBe(0);
  });
  it('1根/2根无分型', () => {
    expect(compute(bars([[1, 2]]), 原文).fractals.length).toBe(0);
    expect(compute(bars([[1, 2], [3, 4]]), 原文).fractals.length).toBe(0);
  });
  it('全相等区间：包含合并，起点方向写日志', () => {
    const r = compute(bars([[5, 5], [5, 5], [5, 5]]), 原文);
    expect(r.validBars.length).toBe(1);
    expect(r.events.some((e) => e.kind === '起点方向')).toBe(true);
  });
  it('拒绝缺省/非法口径', () => {
    expect(() => compute([], {} as ChanConfig)).toThrow();
    expect(() => compute([], { ...原文, biRule: '随便' as never })).toThrow();
    expect(() => compute([], { ...原文, precision: { digits: 9 as never } })).toThrow();
  });
  it('精度舍入改变包含判定（half-up）', () => {
    // raw 交叉无包含：bar1(10.04,10.12) bar2(10.0,10.06)；取个位都=(10,10) → 包含。
    const seq: [number, number][] = [[10.04, 10.12], [10.0, 10.06]];
    const raw = compute(bars(seq), 原文);
    const d0 = compute(bars(seq), { ...原文, precision: { digits: 0 } });
    expect(raw.validBars.length).toBe(2);
    expect(d0.validBars.length).toBe(1);
  });
  it('configId 稳定且随口径变化', () => {
    const a = compute([], 原文).configId;
    const b = compute([], 原文).configId;
    const c = compute([], { ...原文, startDir: 'down' }).configId;
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});