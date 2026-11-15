import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BuySellPoint, Center, ComputeResult, Segment } from '../../../packages/engine/src/index.ts';
import {
  DEFAULT_BACKTEST_CONFIG, prepareCandidates, simulatePortfolio,
  type DailyBar, type PointSignal, type StockSeries,
} from '../../../tools/backtest/core.ts';
import {
  aggregatePeriods, atrTrailingExit, averageTrueRange, channelExit, higherPointSupport, latestCompletedPeriodIndex,
  movingTrendState, returnLookback, structureInvalidationExit, volumeFeature,
} from '../../../tools/backtest/explore.ts';
import { pathHorizon } from '../../../tools/backtest/run_explore_portfolio.ts';

const dates = ['2024-01-01', '2024-01-02', '2024-01-03', '2024-01-04', '2024-01-05', '2024-01-08'];
function makeBars(values: number[], volumes = values.map(() => 100)): DailyBar[] {
  return values.map((price, i) => ({
    date: dates[i]!, open: price, high: price * 1.02, low: price * 0.98, close: price,
    preclose: i ? values[i - 1]! : null, volume: volumes[i]!, amount: volumes[i]! * price,
    tradeStatus: 1, isSt: 0, hfqOpen: price, hfqHigh: price * 1.02, hfqLow: price * 0.98, hfqClose: price,
  }));
}
function makeStock(values: number[], volumes?: number[]): StockSeries {
  return { code: 'sh.600000', name: '测试', ipoDate: '2000-01-01', outDate: null, bars: makeBars(values, volumes) };
}
const cfg = { ...DEFAULT_BACKTEST_CONFIG, startDate: dates[0]!, endDate: dates.at(-1)! };
function candidateFor(stock: StockSeries) {
  const signal: PointSignal = { code: stock.code, side: 'buy', klass: 3, pointKey: 'p3', structureDate: dates[0]!, confirmDate: dates[0]!, avgAmount20: 1, signalIsSt: false };
  return prepareCandidates(new Map([[stock.code, stock]]), [signal], dates, cfg)[0]!;
}

test('周线只在本周最后一个交易日收盘后可见，月线同理', () => {
  const stockCalendar = ['2024-01-02', '2024-01-03', '2024-01-05', '2024-01-08', '2024-01-30', '2024-01-31', '2024-02-01'];
  const calendar = [...stockCalendar, '2024-01-09', '2024-02-02'].sort();
  const stock: StockSeries = { ...makeStock([10, 11, 12]), bars: stockCalendar.map((date, i) => ({ ...makeBars([10, 11, 12, 13, 14, 15, 16])[i]!, date })) };
  const weeks = aggregatePeriods(stock.bars, calendar, 'week');
  assert.equal(latestCompletedPeriodIndex(weeks, '2024-01-03'), -1);
  assert.equal(latestCompletedPeriodIndex(weeks, '2024-01-05'), 0);
  assert.equal(latestCompletedPeriodIndex(weeks, '2024-01-08'), 0);
  const months = aggregatePeriods(stock.bars, calendar, 'month');
  assert.equal(latestCompletedPeriodIndex(months, '2024-01-30'), -1);
  assert.equal(latestCompletedPeriodIndex(months, '2024-01-31'), 0);
  assert.equal(latestCompletedPeriodIndex(months, '2024-02-01'), 0);
  assert.equal(aggregatePeriods(stock.bars.slice(0, 2), ['2024-01-02', '2024-01-03'], 'week').length, 0);
});

test('均线趋势使用信号日及此前数据，并要求均线向上', () => {
  assert.equal(movingTrendState([1, 2, 3, 4], 3, 3), true);
  assert.equal(movingTrendState([4, 3, 2, 1], 3, 3), false);
  assert.equal(movingTrendState([1, 2, 100], 1, 3), null);
  assert.equal(returnLookback([10, 12, 15], 2, 2), 0.5);
  assert.equal(returnLookback([10, 12], 1, 2), null);
  assert.equal(movingTrendState([1, 2, Number.NaN, 4], 3, 3), null);
});

test('三买量能使用离开段、中枢底部和回踩段，而非任意固定窗口', () => {
  const stock = makeStock([10, 10, 10, 10, 11, 12, 11], [100, 100, 100, 100, 200, 200, 50]);
  const center = { id: 1, key: 'c', startRaw: 0, endRaw: 6 } as Center;
  const leave = { id: 2, key: 'leave', dir: 'up', startRaw: 4, endRaw: 5 } as Segment;
  const retest = { id: 3, key: 'retest', dir: 'down', startRaw: 6, endRaw: 6 } as Segment;
  const point = { id: 4, side: 'buy', klass: 3, atRaw: 6, refKey: 'c', dependencyKeys: ['c', 'leave', 'retest'] } as BuySellPoint;
  const result = { centers: [center], segments: [leave, retest], points: [point] } as ComputeResult;
  const feature = volumeFeature(stock.bars, result, point);
  assert.equal(feature.pass, true);
  assert.ok(Math.abs(feature.primaryRatio! - 2) < 1e-12);
  assert.ok(Math.abs(feature.secondaryRatio! - 0.25) < 1e-12);
});

test('高周期同向点只取最近已完成周期内首次确认的点', () => {
  const stock = makeStock([10, 11, 12]);
  const periods = aggregatePeriods(stock.bars, dates, 'week');
  const current = { id: 1, side: 'buy', klass: 2, status: 'confirmed', confirmedAt: 0, quality: 'verified' } as BuySellPoint;
  const old = { id: 2, side: 'buy', klass: 3, status: 'confirmed', confirmedAt: -1, quality: 'verified' } as BuySellPoint;
  const sell = { id: 3, side: 'sell', klass: 1, status: 'confirmed', confirmedAt: 0, quality: 'verified' } as BuySellPoint;
  const result = { points: [old, sell, current] } as ComputeResult;
  const supported = higherPointSupport(result, periods, dates[4]!);
  assert.equal(supported.status, '支持');
  assert.deepEqual(supported.klasses, [2]);
  assert.equal(higherPointSupport({ points: [old, sell] } as ComputeResult, periods, dates[4]!).status, '不支持');
});

test('结构失效在收盘后确认，下一交易日才离场', () => {
  const stock = makeStock([10, 10, 9, 8, 8, 8]);
  const candidate = candidateFor(stock);
  const plan = structureInvalidationExit(stock, candidate, 9.5);
  assert.equal(plan.signalDate, dates[2]);
  assert.equal(plan.date, dates[3]);
});

test('结构失效按后复权价格比较，不被不复权价格掩盖', () => {
  const stock = makeStock([10, 10, 10, 10, 10, 10]);
  stock.bars[2]!.hfqClose = 9;
  const plan = structureInvalidationExit(stock, candidateFor(stock), 9.5);
  assert.equal(plan.signalDate, dates[2]);
  assert.equal(plan.date, dates[3]);
});

test('ATR移动与反向通道都只根据已完成K线触发', () => {
  const stock = makeStock([10, 10, 10, 12, 12, 8]);
  const candidate = candidateFor(stock);
  const atr = atrTrailingExit(stock, candidate, 1, 0.5);
  assert.equal(atr.signalDate, dates[5]);
  assert.equal(atr.date, null);
  const channel = channelExit(stock, candidate, 1);
  assert.equal(channel.signalDate, dates[5]);
  assert.equal(channel.date, null);
});

test('停牌占位不进入ATR、通道和MFE/MAE路径', () => {
  const stock = makeStock([10, 10, 10, 12, 12, 8]);
  const candidate = candidateFor(stock);
  Object.assign(stock.bars[2]!, { open: 0, high: 0, low: 0, close: 0, tradeStatus: 0, hfqOpen: 0, hfqHigh: 0, hfqLow: 0, hfqClose: 0 });
  assert.ok(Math.abs(averageTrueRange(stock.bars, 4, 3)! - 1.04) < 1e-12);
  assert.equal(channelExit(stock, { ...candidate, entryDate: dates[4]! }, 3).signalDate, dates[5]);
  const path = pathHorizon(stock, candidate, dates[4]);
  assert.ok(Math.abs(path.returnValue! - 0.2) < 1e-12);
  assert.ok(Math.abs(path.mae! + 0.02) < 1e-12);
});

test('账户核心接受独立离场计划但不改变原成交和费用逻辑', () => {
  const stock = makeStock([10, 10, 10, 11, 11, 11]);
  const candidate = candidateFor(stock);
  const result = simulatePortfolio(3, 'hold-20', new Map([[stock.code, stock]]), [candidate], dates, cfg, {
    exitPlan: () => ({ date: dates[3], signalDate: dates[2], reason: '测试结构离场' }),
  });
  assert.equal(result.trades.length, 1);
  assert.equal(result.trades[0]!.exitDate, dates[3]);
  assert.equal(result.trades[0]!.exitReason, '测试结构离场');
  assert.ok(Math.abs(result.finalEquity - (cfg.initialCapital + result.trades[0]!.realizedPnl)) < 1e-8);
});
