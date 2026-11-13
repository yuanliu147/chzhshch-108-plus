import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fetchKline, fetchMinKline, normalizeRawBars, type RawBar } from '../src/api.ts';
import {
  coverageOf, coveredMs, findBarIndexAtTime, findBarIndices, formatChinaDateTime, indexWindowCoverage,
  intersectRanges, mergeRanges, parseChinaMs, verifiedCoverageOf,
} from '../src/chart/timeMapping.ts';

const bar = (date: string, start: string, end: string, complete = true): RawBar => ({
  date, open: 1, high: 1, low: 1, close: 1, volume: 1, amount: 1, pct_chg: null, is_st: null,
  time: {
    endMs: parseChinaMs(end)!,
    coverage: [{ startMs: parseChinaMs(start)!, endMs: parseChinaMs(end)! }],
    sourceCount: 1, expectedSourceCount: 1, complete,
  },
});

test('时间点严格按其实际覆盖映射，不按不同周期数组下标', () => {
  const bars = [
    bar('2026-09-01 10:00:00', '2026-09-01 09:30:00', '2026-09-01 10:00:00'),
    bar('2026-09-01 10:30:00', '2026-09-01 10:00:00', '2026-09-01 10:30:00'),
  ];
  assert.equal(findBarIndexAtTime(bars, parseChinaMs('2026-09-01 10:00:00')!), 0);
  assert.equal(findBarIndexAtTime(bars, parseChinaMs('2026-09-01 10:01:00')!), 1);
  assert.equal(findBarIndexAtTime(bars, parseChinaMs('2026-09-01 09:45:00')!), 0);
  assert.equal(findBarIndexAtTime(bars, parseChinaMs('2026-09-01 12:00:00')!), -1, '午休不属于任何交易bar');
});

test('半小时范围映射到所有真实重叠的5分钟bar，不吸附加班/远邻数据', () => {
  const m5 = [
    bar('2026-09-01 09:35:00', '2026-09-01 09:30:00', '2026-09-01 09:35:00'),
    bar('2026-09-01 09:40:00', '2026-09-01 09:35:00', '2026-09-01 09:40:00'),
    bar('2026-09-01 09:45:00', '2026-09-01 09:40:00', '2026-09-01 09:45:00'),
    bar('2026-09-01 13:05:00', '2026-09-01 13:00:00', '2026-09-01 13:05:00'),
  ];
  const match = findBarIndices(m5, { startMs: parseChinaMs('2026-09-01 09:30:00')!, endMs: parseChinaMs('2026-09-01 09:45:00')! });
  assert.deepEqual(match, [0, 1, 2]);
  const span = indexWindowCoverage(m5, 0, 2);
  assert.equal(formatChinaDateTime(span!.endMs), '2026-09-01 09:45');
});

test('覆盖集合合并与交集去重，不以午休或缺根包络充当覆盖', () => {
  const ranges = [
    { startMs: 0, endMs: 10 }, { startMs: 5, endMs: 15 },
    { startMs: 15, endMs: 20 }, { startMs: 30, endMs: 40 },
  ];
  assert.deepEqual(mergeRanges(ranges), [{ startMs: 0, endMs: 20 }, { startMs: 30, endMs: 40 }]);
  assert.equal(coveredMs(ranges), 30);
  assert.deepEqual(intersectRanges(ranges, [{ startMs: 10, endMs: 35 }, { startMs: 12, endMs: 32 }]), [
    { startMs: 10, endMs: 20 }, { startMs: 30, endMs: 35 },
  ]);
  assert.equal(coveredMs(intersectRanges(ranges, [{ startMs: 20, endMs: 30 }])), 0);
  assert.deepEqual(ranges[0], { startMs: 0, endMs: 10 }, '不修改来源集合');
});

test('真实RawBar归一化保留数量、顺序和价格，并传递唯一time及endMs', () => {
  const complete = bar('2026-09-01 10:00:00', '2026-09-01 09:30:00', '2026-09-01 10:00:00');
  const partial = bar('2026-09-01 10:25:00', '2026-09-01 10:00:00', '2026-09-01 10:25:00', false);
  partial.time!.quality = 'verified';
  complete.time!.continuityId = 'server:stable';
  const missing: RawBar = { ...complete, date: '2026-09-02', time: undefined };
  const source = [complete, partial, missing];
  const normalized = normalizeRawBars(source);
  assert.deepEqual(normalized.map((b) => b.date), source.map((b) => b.date));
  assert.equal(normalized.length, 3);
  assert.deepEqual(normalized.map((b) => [b.open, b.high, b.low, b.close, b.volume, b.amount]), source.map((b) => [b.open, b.high, b.low, b.close, b.volume, b.amount]));
  assert.equal(normalized[0]!.time!.quality, 'verified');
  assert.equal(normalized[0]!.time!.continuityId, 'server:stable');
  assert.equal(normalized[0]!.endMs, complete.time!.endMs);
  assert.equal(normalized[1]!.time!.quality, 'incomplete', 'complete=false不可被verified覆盖');
  assert.equal(normalized[2]!.time!.quality, 'unknown');
  assert.equal(normalized[2]!.time!.complete, false);
  assert.deepEqual(normalized[2]!.time!.coverage, []);
  assert.equal(formatChinaDateTime(normalized[2]!.endMs!), '2026-09-02 15:00');
  assert.deepEqual(normalizeRawBars(normalized), normalized, '重复适配幂等');
  assert.equal(source[1]!.time!.quality, 'verified', '不改服务端对象');
});

test('显式unknown及无效/空覆盖不得获得verified，回退仅供绘图', () => {
  const unknown = bar('2026-09-01 09:35:00', '2026-09-01 09:30:00', '2026-09-01 09:35:00');
  unknown.time!.quality = 'unknown';
  const empty = { ...unknown, time: { ...unknown.time!, coverage: [], quality: 'verified' as const } };
  const missing = { ...unknown, time: undefined };
  const normalized = normalizeRawBars([unknown, empty, missing, { ...missing, date: '不可解析' }]);
  assert.ok(normalized.every((b) => b.time!.quality === 'unknown'));
  assert.ok(Number.isNaN(normalized[3]!.endMs));
  assert.ok(coverageOf(normalized[2]!).length, '未知来源仍可绘图');
  assert.deepEqual(verifiedCoverageOf(normalized[2]!), []);
  assert.deepEqual(verifiedCoverageOf(empty), []);
  assert.deepEqual(verifiedCoverageOf(bar('x', '2026-09-01 09:30:00', '2026-09-01 09:35:00')), [], '旧元信息未经适配不当成verified');
});

test('不完整或缺字段的来源不能借日期回退获得verified，原顺序不排序', () => {
  const complete = bar('2026-09-01 10:00:00', '2026-09-01 09:30:00', '2026-09-01 10:00:00');
  const malformed = { ...complete, time: { ...complete.time!, endMs: undefined } } as unknown as RawBar;
  const absentComplete = { ...complete, time: { ...complete.time!, complete: undefined } } as unknown as RawBar;
  const out = normalizeRawBars([malformed, absentComplete, { ...complete, date: '2026-08-31 10:00:00' }]);
  assert.equal(out[0]!.time!.quality, 'unknown');
  assert.equal(out[1]!.time!.quality, 'unknown');
  assert.deepEqual(out.map((b) => b.date), [malformed.date, absentComplete.date, '2026-08-31 10:00:00']);
});

test('所有fetchKline/fetchMinKline成功出口一致归一化，不额外请求', async () => {
  const oldFetch = globalThis.fetch;
  let requests = 0;
  const rows = [bar('2026-09-01 10:00:00', '2026-09-01 09:30:00', '2026-09-01 10:00:00')];
  const meta = { expectedCoverage: rows[0]!.time!.coverage, coverageGaps: [], coverageStatus: 'verified' };
  globalThis.fetch = (async () => {
    requests++;
    return { ok: true, json: async () => ({ bars: rows, meta }) } as Response;
  }) as typeof fetch;
  try {
    for (const response of [await fetchKline('sh.600000', '3'), await fetchMinKline('sh.600000', 30)]) {
      assert.equal(response.bars[0]!.time!.quality, 'verified');
      assert.equal(response.bars[0]!.endMs, rows[0]!.time!.endMs);
      assert.equal(response.meta, meta);
    }
    assert.equal(requests, 2);
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test('旧响应缺少 time 元数据时的回退覆盖仍覆盖全天/五分钟', () => {
  const daily: RawBar = { date: '2026-09-01', open: 1, high: 1, low: 1, close: 1, volume: 1, amount: 1, pct_chg: null, is_st: null };
  const cov = coverageOf(daily);
  assert.equal(formatChinaDateTime(cov[0]!.startMs), '2026-09-01 09:30');
  assert.equal(formatChinaDateTime(cov[1]!.endMs), '2026-09-01 15:00');
});
