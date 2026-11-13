import assert from 'node:assert/strict';
import { test } from 'node:test';
import { aggregate5m } from '../src/db.ts';
import { coveredMs, describeCoverage, formatChinaTime, parseChinaTime, sessionAt, sessionsOf, type CoverageCalendar } from '../src/marketTime.ts';

const raw = (time: string, price = 10) => ({ time, open: price, high: price + 0.1, low: price - 0.1, close: price + 0.05, volume: 1, amount: 10 });

test('10:00 的30分钟桶完整覆盖 09:35..10:00 六根源5分钟', () => {
  const bars = aggregate5m([
    raw('2026-09-01 09:35:00'), raw('2026-09-01 09:40:00'), raw('2026-09-01 09:45:00'),
    raw('2026-09-01 09:50:00'), raw('2026-09-01 09:55:00'), raw('2026-09-01 10:00:00'),
    raw('2026-09-01 10:05:00'),
  ], 30);
  assert.equal(bars.length, 2);
  const first = bars[0]!;
  assert.equal(first.time, '2026-09-01 10:00:00');
  assert.equal(first.timeMeta.sourceCount, 6);
  assert.equal(first.timeMeta.expectedSourceCount, 6);
  assert.equal(first.timeMeta.complete, true);
  assert.equal(formatChinaTime(first.timeMeta.coverage[0]!.startMs), '2026-09-01 09:30:00');
  assert.equal(formatChinaTime(first.timeMeta.coverage[0]!.endMs), '2026-09-01 10:00:00');
  assert.equal(first.volume, 6);

  const partial = bars[1]!;
  assert.equal(partial.timeMeta.sourceCount, 1);
  assert.equal(partial.timeMeta.complete, false, '边界截断桶不能冒充完整30分钟');
});

test('缺根不补齐且完整性为false，午休不并入同一个30分钟桶', () => {
  const gap = aggregate5m([
    raw('2026-09-01 09:35:00'), raw('2026-09-01 09:40:00'), raw('2026-09-01 09:45:00'),
    raw('2026-09-01 09:55:00'), raw('2026-09-01 10:00:00'),
    raw('2026-09-01 11:30:00'), raw('2026-09-01 13:05:00'),
  ], 30);
  const first = gap[0]!;
  assert.equal(first.timeMeta.complete, false);
  assert.equal(first.timeMeta.sourceCount, 5);
  assert.equal(first.timeMeta.coverage.length, 2, '09:50 缺口应保留为两个已观察覆盖段');
  const lunchEnds = gap.filter((b) => b.time === '2026-09-01 11:30:00' || b.time === '2026-09-01 13:05:00');
  assert.equal(lunchEnds.length, 2);
  assert.notEqual(lunchEnds[0]!.timeMeta.bucketStartMs, lunchEnds[1]!.timeMeta.bucketStartMs);
});

const ms = (time: string) => parseChinaTime(time)!;
const daySource = (date: string) => sessionsOf(date).flatMap((session) =>
  Array.from({ length: 24 }, (_, i) => raw(formatChinaTime(session.startMs + (i + 1) * 5 * 60_000))),
);
const calendar = (days: CoverageCalendar['days'], startDate = '2026-09-01', endDate = '2026-09-03'): CoverageCalendar => ({
  declaredRange: { startDate, endDate }, days,
});
const windowOf = (start: string, end: string) => ({ startMs: ms(`${start} 00:00:00`), endMs: ms(`${end} 23:59:59`) });

test('整桶缺失留下缺口摘要和稳定连续性边界，不生成OHLC占位', () => {
  const evidence = calendar([{ date: '2026-09-01', tradeStatus: 1 }], '2026-09-01', '2026-09-01');
  const source = daySource('2026-09-01').filter((b) => b.time <= '2026-09-01 10:00:00' || b.time > '2026-09-01 10:30:00');
  const bars = aggregate5m(source, 30, evidence);
  const summary = describeCoverage(bars.flatMap((b) => b.timeMeta.coverage), evidence, windowOf('2026-09-01', '2026-09-01'));
  assert.equal(bars.length, 7);
  assert.equal(summary.coverageStatus, 'incomplete');
  assert.deepEqual(summary.coverageGaps, [{ startMs: ms('2026-09-01 10:00:00'), endMs: ms('2026-09-01 10:30:00') }]);
  assert.equal(coveredMs(summary.expectedCoverage), 240 * 60_000);
  assert.ok(bars.every((b) => b.timeMeta.quality === 'verified'));
  assert.notEqual(bars[0]!.timeMeta.continuityId, bars[1]!.timeMeta.continuityId);
  assert.equal(bars[1]!.timeMeta.continuityId, bars.at(-1)!.timeMeta.continuityId);
  assert.equal(bars[1]!.timeMeta.continuityId, aggregate5m([...source, ...daySource('2026-09-02')], 30, evidence)[1]!.timeMeta.continuityId);
});

test('不完整柱前后切断，原始部分柱和量额保持', () => {
  const evidence = calendar([{ date: '2026-09-01', tradeStatus: 1 }], '2026-09-01', '2026-09-01');
  const bars = aggregate5m(daySource('2026-09-01').filter((b) => b.time !== '2026-09-01 10:15:00'), 30, evidence);
  assert.equal(bars.length, 8);
  assert.equal(bars[1]!.timeMeta.quality, 'incomplete');
  assert.equal(bars[1]!.timeMeta.sourceCount, 5);
  assert.equal(bars[1]!.volume, 5);
  assert.equal(bars[1]!.amount, 50);
  assert.equal(new Set(bars.slice(0, 3).map((b) => b.timeMeta.continuityId)).size, 3);
  assert.equal(bars[2]!.timeMeta.continuityId, bars.at(-1)!.timeMeta.continuityId);
});

test('午休、隔夜和已证明停牌或休市不是缺口', () => {
  const evidence = calendar([
    { date: '2026-09-04', tradeStatus: 1 },
    { date: '2026-09-05', tradeStatus: null, isTradingDay: 0 },
    { date: '2026-09-06', tradeStatus: null, isTradingDay: 0 },
    { date: '2026-09-07', tradeStatus: 0 },
    { date: '2026-09-08', tradeStatus: 1 },
  ], '2026-09-04', '2026-09-08');
  const bars = aggregate5m([...daySource('2026-09-04'), ...daySource('2026-09-08')], 30, evidence);
  const summary = describeCoverage(bars.flatMap((b) => b.timeMeta.coverage), evidence, windowOf('2026-09-04', '2026-09-08'));
  assert.equal(summary.coverageStatus, 'verified');
  assert.deepEqual(summary.coverageGaps, []);
  assert.equal(new Set(bars.map((b) => b.timeMeta.continuityId)).size, 1);
  assert.ok(bars[0]!.timeMeta.continuityId);
});

test('内部整交易日缺失有证据，下一真实柱开启新连续段', () => {
  const evidence = calendar(['2026-09-01', '2026-09-02', '2026-09-03'].map((date) => ({ date, tradeStatus: 1 })));
  const bars = aggregate5m([...daySource('2026-09-01'), ...daySource('2026-09-03')], 30, evidence);
  const summary = describeCoverage(bars.flatMap((b) => b.timeMeta.coverage), evidence, windowOf('2026-09-01', '2026-09-03'));
  assert.equal(bars.length, 16);
  assert.equal(coveredMs(summary.coverageGaps), 240 * 60_000);
  assert.deepEqual(summary.coverageGaps, sessionsOf('2026-09-02').map(({ startMs, endMs }) => ({ startMs, endMs })));
  assert.notEqual(bars[7]!.timeMeta.continuityId, bars[8]!.timeMeta.continuityId);
  assert.equal(bars[8]!.timeMeta.continuityId, bars[15]!.timeMeta.continuityId);
});

test('无日线证据、未知日历和分钟库日期范围外不猜缺口或可信来源', () => {
  const evidence = calendar([{ date: '2026-09-01', tradeStatus: 1 }, { date: '2026-09-03', tradeStatus: 1 }]);
  const bars = aggregate5m([...daySource('2026-09-01'), ...daySource('2026-09-03'), ...daySource('2026-09-04')], 30, evidence);
  const summary = describeCoverage(bars.flatMap((b) => b.timeMeta.coverage), evidence, windowOf('2026-08-31', '2026-09-04'));
  assert.equal(summary.coverageStatus, 'unknown');
  assert.deepEqual(summary.coverageGaps, []);
  assert.equal(coveredMs(summary.expectedCoverage), 480 * 60_000);
  assert.notEqual(bars[7]!.timeMeta.continuityId, bars[8]!.timeMeta.continuityId, '未知中间日期不能桥接来源');
  assert.equal(bars.at(-1)!.timeMeta.quality, 'unknown');
  assert.equal(aggregate5m(daySource('2026-09-01'), 30)[0]!.timeMeta.quality, 'unknown');
});

test('整日请求没有真实柱也返回预期缺口；已声明范围外只报未知', () => {
  const evidence = calendar([{ date: '2026-09-02', tradeStatus: 1 }]);
  const missing = describeCoverage([], evidence, windowOf('2026-09-02', '2026-09-02'));
  assert.equal(missing.coverageStatus, 'incomplete');
  assert.equal(coveredMs(missing.coverageGaps), 240 * 60_000);
  assert.deepEqual(missing.coverageGaps, missing.expectedCoverage);
  assert.deepEqual(aggregate5m([], 30, evidence), []);
  const outside = describeCoverage([], evidence, windowOf('2026-08-31', '2026-08-31'));
  assert.equal(outside.coverageStatus, 'unknown');
  assert.deepEqual(outside.expectedCoverage, []);
  assert.deepEqual(outside.coverageGaps, []);
});

test('原始5分钟缺桶同样切断，重复时间不重复聚合量额', () => {
  const evidence = calendar([{ date: '2026-09-01', tradeStatus: 1 }], '2026-09-01', '2026-09-01');
  const source = daySource('2026-09-01');
  const m5 = aggregate5m(source.filter((b) => b.time !== '2026-09-01 09:40:00'), 5, evidence);
  assert.equal(m5.length, 47);
  assert.notEqual(m5[0]!.timeMeta.continuityId, m5[1]!.timeMeta.continuityId);
  const m30 = aggregate5m([...source.slice(0, 6), source[5]!], 30, evidence)[0]!;
  assert.equal(m30.timeMeta.sourceCount, 6);
  assert.equal(m30.volume, 6);
  assert.equal(m30.amount, 60);
});

test('中国市场时间解析不经过本机时区', () => {
  const ms = parseChinaTime('2026-09-01 09:35:00');
  assert.ok(ms != null);
  assert.equal(formatChinaTime(ms!), '2026-09-01 09:35:00');
  assert.equal(sessionAt(parseChinaTime('2026-09-01 12:00:00')!), null);
  assert.notEqual(sessionAt(parseChinaTime('2026-09-01 10:00:00')!), null);
});
