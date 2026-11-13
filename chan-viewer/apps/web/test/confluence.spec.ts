import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluatePointConfluence, evaluatePointInvalidation } from '../src/chart/confluence.ts';
import type { BuySellPoint, ComputeResult } from '@chan/engine';
import type { RawBar } from '../src/api.ts';
import { formatChinaDateTime } from '../src/chart/timeMapping.ts';

const cutoff = Date.UTC(2026, 8, 1, 2);
const raw = (endMs: number, minutes = 5, complete = true): RawBar => ({
  date: formatChinaDateTime(endMs, true), open: 10, high: 10.2, low: 9.8, close: 10,
  volume: 1, amount: 10, pct_chg: null, is_st: null,
  time: { endMs, coverage: [{ startMs: endMs - minutes * 60000, endMs }], sourceCount: minutes / 5,
    expectedSourceCount: minutes / 5, complete, quality: complete ? 'verified' : 'incomplete', continuityId: 'test' },
});
const point = (overrides: Partial<BuySellPoint> = {}): BuySellPoint => ({
  id: 1, side: 'buy', klass: 3, atRaw: 0, price: 10, refId: 1, status: 'confirmed', confirmedAt: 0, ...overrides,
});
function result(points: BuySellPoint[], asOfMs = cutoff): ComputeResult {
  return { configId: 'x', config: {} as never, validBars: [], fractals: [], bis: [], segments: [], centers: [],
    trends: [], divergences: [], points, levels: [], events: [], asOfMs };
}
const target = () => ({ levelName: '30分钟', result: result([point()]), bars: [raw(cutoff, 30)] });
const completeLower = () => Array.from({ length: 6 }, (_, i) => raw(cutoff - (5 - i) * 300000));

test('没有更低周期覆盖时明确返回数据不足，不伪造支持', () => {
  assert.equal(evaluatePointConfluence(point(), target(), null, cutoff).status, '数据不足');
});
test('完整覆盖且截止前完成的子级同向点才支持', () => {
  const bars = completeLower();
  const p = point({ klass: 1, atRaw: 5, confirmedAt: 5 });
  assert.equal(evaluatePointConfluence(point(), target(), { levelName: '5分钟', bars, result: result([p]) }, cutoff).status, '支持');
  assert.equal(evaluatePointConfluence(point(), target(), { levelName: '5分钟', bars, result: result([]) }, cutoff).status, '不支持');
});
test('只覆盖父30分钟中的5分钟不能声称支持或不支持', () => {
  const bars = [raw(cutoff)];
  for (const points of [[point({ klass: 1 })], []]) {
    assert.equal(evaluatePointConfluence(point(), target(), { levelName: '5分钟', bars, result: result(points) }, cutoff).status, '数据不足');
  }
});
test('有同向点也必须先拒绝不完整柱', () => {
  const bars = completeLower(); bars[2] = raw(cutoff - 3 * 300000, 5, false);
  assert.equal(evaluatePointConfluence(point(), target(), { levelName: '5分钟', bars, result: result([point({ klass: 1, atRaw: 5, confirmedAt: 5 })]) }, cutoff).status, '数据不足');
});
test('未来确认或最新全量快照不能参与当时证据', () => {
  const bars = [...completeLower(), raw(cutoff + 300000)];
  const p = point({ klass: 1, atRaw: 4, confirmedAt: 6 });
  assert.notEqual(evaluatePointConfluence(point(), target(), { levelName: '5分钟', bars, result: result([p]) }, cutoff).status, '支持');
  assert.notEqual(evaluatePointConfluence(point(), target(), { levelName: '5分钟', bars, result: result([point({ klass: 1, atRaw: 5, confirmedAt: 5 })], cutoff + 300000) }, cutoff).status, '支持');
});
test('候选父点整体等待，不被子级支持升级成确认', () => {
  const bars = completeLower();
  assert.equal(evaluatePointConfluence(point({ status: 'candidate', confirmedAt: null }), target(), { levelName: '5分钟', bars, result: result([point({ klass: 1, atRaw: 5, confirmedAt: 5 })]) }, cutoff).status, '等待');
});
test('父点位置到实际确认的交易窗口也要覆盖，不能只检查端点桶', () => {
  const later = cutoff + 30 * 60000;
  const p = point({ confirmedAt: 1 });
  const parent = { levelName: '30分钟', bars: [raw(cutoff, 30), raw(later, 30)], result: result([p], later) };
  const lower = { levelName: '5分钟', bars: completeLower(), result: result([point({ klass: 1, atRaw: 5, confirmedAt: 5 })], later) };
  assert.equal(evaluatePointConfluence(p, parent, lower, later).status, '数据不足');
});
test('完整柱但来源未知仍不能确认共振', () => {
  const parent = target(); parent.bars[0].time!.quality = 'unknown';
  assert.equal(evaluatePointConfluence(point(), parent, { levelName: '5分钟', bars: completeLower(), result: result([point({ klass: 1, atRaw: 5, confirmedAt: 5 })]) }, cutoff).status, '数据不足');
});
test('后来失效单独显示，不能改写首次可知时刻的历史支持', () => {
  const latest = cutoff + 3600000;
  const r = result([point()]);
  r.centers = [{ id: 1, unit: 'segment', dir: 'up', startRaw: 0, endRaw: 0, ZG: 10, ZD: 9,
    GG: 11, DD: 8, G: 10, D: 9, segCount: 3, formedAt: 0, terminatedAt: 0, evolution: 'terminated', status: 'confirmed', confirmedAt: 0 }];
  r.segments = [{ id: 1, dir: 'down', startFx: 1, endFx: 2, startRaw: 0.5, endRaw: 1, high: 11, low: 9,
    status: 'confirmed', confirmedAt: 1, quality: 'verified' }];
  const parent = { levelName: '30分钟', result: r, bars: [raw(cutoff, 30), raw(latest, 30)] };
  const lower = { levelName: '5分钟', bars: completeLower(), result: result([point({ klass: 1, atRaw: 5, confirmedAt: 5 })]) };
  assert.equal(evaluatePointConfluence(point(), parent, lower, cutoff).status, '支持');
  assert.equal(evaluatePointInvalidation(point(), parent, cutoff), null);
  assert.equal(evaluatePointInvalidation(point(), parent, latest)?.status, '冲突');
  assert.equal(evaluatePointConfluence(point(), parent, lower, cutoff).status, '支持');
});
