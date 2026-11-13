import { describe, expect, it } from 'vitest';
import { compute, analyzeAsOf, macd, areaBetween, parseChinaTime, type KInput } from '../src/index.ts';
import { CHAN_PRESETS } from '../src/caliberRegistry.ts';

const cfg = CHAN_PRESETS.originalDefault;
function bars(n: number): KInput[] {
  return Array.from({ length: n }, (_, i) => {
    const mid = 10 + Math.sin(i / 4) * 2;
    const endMs = Date.UTC(2026, 8, 1, 1, 35) + i * 300000;
    return { date: new Date(endMs).toISOString(), endMs, low: mid - 0.3, high: mid + 0.3, close: mid,
      time: { endMs, coverage: [{ startMs: endMs - 300000, endMs }], complete: false } };
  });
}
describe('来源证据与物理截止', () => {
  it('显式不完整输入不得生成确认结构，原始索引不压缩', () => {
    const result = compute(bars(100), cfg);
    expect(result.fractals.filter(f => f.status === 'confirmed')).toEqual([]);
    expect(result.bis.filter(b => b.status === 'confirmed')).toEqual([]);
    expect(result.points.filter(p => p.status === 'confirmed')).toEqual([]);
  });
  it('时间未知在严格入口失败，不把未知日期作为已完成行情', () => {
    expect(() => analyzeAsOf([{ date: 'unparseable', low: 9, high: 10 }], cfg, Date.UTC(2026, 8, 1))).toThrow();
  });
  it('合法带时区ISO未来柱不会放行', () => {
    const result = analyzeAsOf([{ date: '2026-09-02T07:00:00.000Z', low: 9, high: 10 }], cfg, Date.UTC(2026, 8, 1, 7));
    expect(result.validBars).toEqual([]);
  });
  it('可信断点后仍可独立确认，不能把整段数据禁用', () => {
    const input = bars(180).map((b, i) => ({ ...b, time: { ...b.time!, complete: i !== 60,
      quality: i === 60 ? 'incomplete' as const : 'verified' as const, continuityId: i < 60 ? 'first' : i === 60 ? 'gap' : 'second' } }));
    const result = compute(input, cfg);
    expect(result.fractals.some(f => f.status === 'confirmed' && f.startRaw > 60)).toBe(true);
    for (const s of result.segments) expect(s.startRaw < 60 && s.endRaw > 60).toBe(false);
  });

  it('false 优先于 verified；显式 unknown 也没有确认资格', () => {
    for (const quality of ['verified', 'unknown'] as const) {
      const input = bars(100).map(b => ({ ...b, time: { ...b.time!, complete: quality === 'unknown', quality, continuityId: 'one' } }));
      const result = compute(input, cfg);
      expect(result.inputCount).toBe(100);
      expect(result.sourceEvidence).toHaveLength(100);
      expect(result.sourceEvidence!.every(s => s.quality === (quality === 'verified' ? 'incomplete' : 'unknown'))).toBe(true);
      expect(result.fractals.filter(f => f.status === 'confirmed')).toEqual([]);
      expect(result.macd!.hist).toEqual(Array(100).fill(null));
    }
  });

  it('显式连续性边界重启 MACD，完整无缺口数学结果不变', () => {
    const input = bars(40).map((b, i) => ({ ...b, time: { ...b.time!, complete: true, quality: 'verified' as const, continuityId: i < 20 ? 'a' : 'b' } }));
    const result = compute(input, cfg);
    const expectedA = macd(input.slice(0, 20).map(b => b.close!));
    const expectedB = macd(input.slice(20).map(b => b.close!));
    for (const field of ['dif', 'dea', 'hist'] as const) expect(result.macd![field]).toEqual([...expectedA[field], ...expectedB[field]]);
    const unbroken = input.map(b => ({ ...b, time: { ...b.time!, continuityId: 'a' } }));
    expect(compute(unbroken, cfg).macd).toEqual(macd(input.map(b => b.close!)));
  });

  it('缺柱占据原 raw/MACD 位置；面积跨 null 无判据，不是零', () => {
    const input = bars(120).map((b, i) => ({ ...b, time: { ...b.time!, complete: i !== 50, quality: 'verified' as const, continuityId: 'same' } }));
    const result = compute(input, cfg);
    expect(result.inputCount).toBe(120);
    expect(result.macd!.hist).toHaveLength(120);
    expect(result.macd!.hist[50]).toBeNull();
    expect(result.macd!.hist[51]).toBe(0);
    expect(areaBetween(result.macd!.hist, 40, 60, true)).toBeNull();
    expect(areaBetween([0, 0, 0], 0, 2, true)).toBe(0);
    const after = result.fractals.filter(f => f.status === 'confirmed' && f.startRaw > 50);
    expect(after.length).toBeGreaterThan(0);
    expect(after.every(f => f.continuityId !== 'same')).toBe(true);
    expect(after.every(f => result.validBars[f.middle]!.startRaw > 50)).toBe(true);
  });

  it('物理时间有效但质量不足的柱保留在截止前缀，不压缩索引', () => {
    const input = bars(5);
    const result = analyzeAsOf(input, cfg, input[2]!.endMs!);
    expect(result.asOfMs).toBe(input[2]!.endMs);
    expect(result.inputCount).toBe(3);
    expect(result.sourceEvidence).toHaveLength(3);
    expect(result.validBars).toEqual([]);
  });

  it('真实来源的空覆盖不能借 complete=true 获得确认资格', () => {
    const input = bars(100).map(b => ({ ...b, time: { ...b.time!, complete: true, quality: 'verified' as const, coverage: [] } }));
    const result = compute(input, cfg);
    expect(result.sourceEvidence!.every(s => s.quality === 'unknown')).toBe(true);
    expect(result.fractals.filter(f => f.status === 'confirmed')).toEqual([]);
  });
  it('unknown 来源与不完整不能互相冒充，均不授予确认', () => {
    const input = bars(10).map(b => ({ ...b, time: { ...b.time!, complete: false, quality: 'unknown' as const } }));
    const result = compute(input, cfg);
    expect(result.sourceEvidence!.every(s => s.quality === 'unknown')).toBe(true);
    expect(result.fractals.filter(f => f.status === 'confirmed')).toEqual([]);
  });

  it('截止有限、全部日期有序可解析且双 endMs 一致', () => {
    const input = bars(3);
    expect(() => analyzeAsOf(input, cfg, Infinity)).toThrow('asOfMs');
    expect(() => analyzeAsOf([...input].reverse(), cfg, input[2]!.endMs!)).toThrow('逆序');
    expect(() => analyzeAsOf([input[0]!, { date: 'future-unknown', high: 2, low: 1 }], cfg, input[0]!.endMs!)).toThrow('future-unknown');
    expect(() => analyzeAsOf([{ ...input[0]!, endMs: input[0]!.endMs! + 1 }], cfg, input[0]!.endMs!)).toThrow('不一致');
    expect(() => analyzeAsOf([{ date: '2026-02-30', high: 2, low: 1 }], cfg, Date.UTC(2026, 3, 1))).toThrow('2026-02-30');
    expect(parseChinaTime('2026-09-02T15:00:00+08:00')).toBe(Date.UTC(2026, 8, 2, 7));
  });
});
