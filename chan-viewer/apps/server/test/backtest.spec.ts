import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_BACKTEST_CONFIG, affordableQuantity, performanceMetrics, prepareCandidates, priceLimits, simulatePortfolio,
  type DailyBar, type PointSignal, type StockSeries,
} from '../../../tools/backtest/core.ts';

const dates = ['2024-01-01', '2024-01-02', '2024-01-03', '2024-01-04', '2024-01-05', '2024-01-08'];
function bars(prices: number[]): DailyBar[] {
  return prices.map((price, i) => ({
    date: dates[i]!, open: price, high: price * 1.02, low: price * 0.98, close: price,
    preclose: i ? prices[i - 1]! : null, volume: 1_000_000, amount: 10_000_000 + i,
    tradeStatus: 1, isSt: 0, hfqOpen: price, hfqHigh: price * 1.02, hfqLow: price * 0.98, hfqClose: price,
  }));
}
function stock(code: string, prices: number[], overrides: Partial<StockSeries> = {}): StockSeries {
  return { code, name: `测试${code}`, ipoDate: '2000-01-01', outDate: null, bars: bars(prices), ...overrides };
}
function signal(code: string, side: 'buy' | 'sell', confirmDate: string, klass: 1 | 2 | 3 = 1, isSt = false): PointSignal {
  return { code, side, klass, pointKey: `${code}:${side}:${klass}:${confirmDate}`, structureDate: dates[0]!, confirmDate, avgAmount20: code === 'sh.600000' ? 20_000_000 : 10_000_000, signalIsSt: isSt };
}
const cfg = { ...DEFAULT_BACKTEST_CONFIG, startDate: dates[0]!, endDate: dates.at(-1)! };

test('买入预算同时受每仓上限、100股整手和最低5元佣金约束', () => {
  assert.equal(affordableQuantity(10_000, 10, cfg), 900);
  assert.equal(affordableQuantity(10_000, 101, cfg), 0);
  assert.ok(Math.abs(affordableQuantity(20_000, 10, { ...cfg, maxPositions: 1 }) - 1900) < 1e-9);
});

test('主板普通股和风险警示股分别按10%与5%计算四舍五入涨跌停价', () => {
  assert.deepEqual(priceLimits({ preclose: 10.03, isSt: 0 }), { up: 11.03, down: 9.03 });
  assert.deepEqual(priceLimits({ preclose: 10.03, isSt: 1 }), { up: 10.53, down: 9.53 });
});

test('结构位置不提前成交：确认日次日开盘买入，卖点确认日次日开盘卖出', () => {
  const s = stock('sh.600000', [10, 10, 10, 11, 11, 11]);
  const stocks = new Map([[s.code, s]]);
  const signals = [signal(s.code, 'buy', dates[0]!), signal(s.code, 'sell', dates[2]!)];
  const candidates = prepareCandidates(stocks, signals, dates, cfg);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]!.signalDate, dates[0]);
  assert.equal(candidates[0]!.entryDate, dates[1]);
  assert.equal(candidates[0]!.exitDates['any-sell'], dates[3]);
  const result = simulatePortfolio(1, 'any-sell', stocks, candidates, dates, cfg);
  assert.equal(result.trades.length, 1);
  const trade = result.trades[0]!;
  assert.equal(trade.entryDate, dates[1]);
  assert.equal(trade.exitDate, dates[3]);
  assert.equal(trade.quantity, 900);
  assert.ok(Math.abs(trade.entryTotalCost - 9009.5) < 1e-8);
  assert.ok(Math.abs(result.finalEquity - 20875.6) < 1e-8);
  assert.ok(Math.abs(result.finalEquity - (cfg.initialCapital + trade.realizedPnl)) < 1e-8);
});

test('信号日风险警示被排除，不使用之后的名称或风险警示状态回填', () => {
  const s = stock('sh.600000', [10, 10, 10, 10, 10, 10]);
  const stocks = new Map([[s.code, s]]);
  const excluded = signal(s.code, 'buy', dates[0]!, 1, true);
  const allowed = signal(s.code, 'buy', dates[1]!, 1, false);
  const candidates = prepareCandidates(stocks, [excluded, allowed], dates, cfg);
  assert.deepEqual(candidates.map(c => c.signalDate), [dates[1]]);
});

test('开盘跌停时离场顺延，不能把不存在的成交记成已实现收益', () => {
  const s = stock('sh.600000', [10, 10, 10, 9, 9.5, 9.5]);
  const stocks = new Map([[s.code, s]]);
  const signals = [signal(s.code, 'buy', dates[0]!), signal(s.code, 'sell', dates[2]!)];
  const candidates = prepareCandidates(stocks, signals, dates, cfg);
  const result = simulatePortfolio(1, 'any-sell', stocks, candidates, dates, cfg);
  assert.equal(result.trades.length, 1);
  assert.equal(result.trades[0]!.exitDate, dates[4]);
  assert.ok(Math.abs(result.finalEquity - (cfg.initialCapital + result.trades[0]!.realizedPnl)) < 1e-8);
});

test('满仓候选不递补，按信号日前20日平均成交额排序', () => {
  const a = stock('sh.600000', [10, 10, 10, 10, 10, 10]);
  const b = stock('sz.000001', [10, 10, 10, 10, 10, 10]);
  const stocks = new Map([[a.code, a], [b.code, b]]);
  const signals = [signal(b.code, 'buy', dates[0]!), signal(a.code, 'buy', dates[0]!)];
  const candidates = prepareCandidates(stocks, signals, dates, cfg);
  const result = simulatePortfolio(1, 'hold-20', stocks, candidates, dates, { ...cfg, maxPositions: 1 });
  assert.equal(result.openPositions[0]?.code, a.code);
  assert.equal(result.rejected.filter(r => r.reason === '无空仓').length, 1);
  const open = result.openPositions[0]!;
  assert.ok(Math.abs(result.finalEquity - (cfg.initialCapital + open.unrealizedPnl)) < 1e-8);
  assert.equal(performanceMetrics(result).closedTrades, 0);
});
