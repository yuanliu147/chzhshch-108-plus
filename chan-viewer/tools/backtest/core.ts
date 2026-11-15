// 主板缠论账户回测的纯函数核心。行情读取、缠论识别和文件输出均不放在这里。
export type PointClass = 1 | 2 | 3;
export type PointSide = 'buy' | 'sell';
export type ExitRule = 'any-sell' | 'same-class-sell' | 'hold-20' | 'hold-60';

export const EXIT_RULES: readonly ExitRule[] = ['any-sell', 'same-class-sell', 'hold-20', 'hold-60'];

export interface DailyBar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  preclose: number | null;
  volume: number;
  amount: number;
  tradeStatus: number;
  isSt: number;
  hfqOpen: number | null;
  hfqHigh: number | null;
  hfqLow: number | null;
  hfqClose: number | null;
}

export interface StockSeries {
  code: string;
  name: string;
  ipoDate: string | null;
  outDate: string | null;
  bars: DailyBar[];
}

export interface PointSignal {
  code: string;
  side: PointSide;
  klass: PointClass;
  pointKey: string;
  structureDate: string;
  confirmDate: string;
  avgAmount20: number;
  signalIsSt: boolean;
}

export interface EntryCandidate {
  code: string;
  klass: PointClass;
  pointKey: string;
  structureDate: string;
  signalDate: string;
  entryDate: string;
  avgAmount20: number;
  exitDates: Record<ExitRule, string | null>;
  exitSignalDates: Record<'any-sell' | 'same-class-sell', string | null>;
}

export interface BacktestConfig {
  startDate: string;
  endDate: string;
  initialCapital: number;
  maxPositions: number;
  commissionRate: number;
  minCommission: number;
  slippageRate: number;
  stampDutyBefore20230828: number;
  stampDutyFrom20230828: number;
  lotSize: number;
}

export const DEFAULT_BACKTEST_CONFIG: BacktestConfig = {
  startDate: '2010-01-01',
  endDate: '2026-11-04',
  initialCapital: 20_000,
  maxPositions: 2,
  commissionRate: 0.00025,
  minCommission: 5,
  slippageRate: 0.0005,
  stampDutyBefore20230828: 0.001,
  stampDutyFrom20230828: 0.0005,
  lotSize: 100,
};

export interface RejectedCandidate {
  code: string;
  klass: PointClass;
  pointKey: string;
  signalDate: string;
  entryDate: string;
  reason: '无空仓' | '已持有同股' | '涨停不可买' | '行情或复权缺失' | '资金不足一手';
}

export interface Trade {
  code: string;
  name: string;
  klass: PointClass;
  pointKey: string;
  structureDate: string;
  signalDate: string;
  entryDate: string;
  entryRawPrice: number;
  entryHfqPrice: number;
  quantity: number;
  entryGross: number;
  entryCommission: number;
  entrySlippage: number;
  entryTotalCost: number;
  exitDate: string;
  exitRawPrice: number | null;
  exitHfqPrice: number | null;
  exitGross: number;
  exitCommission: number;
  exitSlippage: number;
  exitStampDuty: number;
  exitReason: string;
  exitSignalDate: string | null;
  realizedPnl: number;
  realizedReturn: number;
  holdingCalendarDays: number;
}

export interface OpenPosition {
  code: string;
  name: string;
  klass: PointClass;
  pointKey: string;
  signalDate: string;
  entryDate: string;
  entryRawPrice: number;
  quantity: number;
  entryTotalCost: number;
  lastDate: string;
  marketValue: number;
  unrealizedPnl: number;
  plannedExitDate: string | null;
  exitReason: string;
}

export interface EquityPoint {
  date: string;
  cash: number;
  marketValue: number;
  equity: number;
  positionCount: number;
}

export interface ScenarioResult {
  klass: PointClass;
  exitRule: ExitRule;
  initialCapital: number;
  finalEquity: number;
  finalCash: number;
  finalMarketValue: number;
  trades: Trade[];
  openPositions: OpenPosition[];
  rejected: RejectedCandidate[];
  equity: EquityPoint[];
  totalCommission: number;
  totalSlippage: number;
  totalStampDuty: number;
  delistingWriteOffs: number;
}

interface Position {
  code: string;
  name: string;
  klass: PointClass;
  pointKey: string;
  structureDate: string;
  signalDate: string;
  entryDate: string;
  entryRawPrice: number;
  entryHfqPrice: number;
  quantity: number;
  units: number;
  entryGross: number;
  entryCommission: number;
  entrySlippage: number;
  entryTotalCost: number;
  plannedExitDate: string | null;
  exitReason: string;
  exitSignalDate: string | null;
  lastDate: string;
  lastHfqClose: number;
}

export function stampDutyRate(date: string, cfg: BacktestConfig): number {
  return date < '2023-08-28' ? cfg.stampDutyBefore20230828 : cfg.stampDutyFrom20230828;
}

export function roundPriceHalfUp(value: number): number {
  return Math.floor((value + 1e-9) * 100 + 0.5) / 100;
}

export function priceLimits(bar: Pick<DailyBar, 'preclose' | 'isSt'>): { up: number; down: number } | null {
  if (bar.preclose == null || !(bar.preclose > 0)) return null;
  const rate = bar.isSt === 1 ? 0.05 : 0.10;
  return { up: roundPriceHalfUp(bar.preclose * (1 + rate)), down: roundPriceHalfUp(bar.preclose * (1 - rate)) };
}

export function buyCost(quantity: number, rawPrice: number, cfg: BacktestConfig) {
  const gross = quantity * rawPrice;
  const commission = Math.max(cfg.minCommission, gross * cfg.commissionRate);
  const slippage = gross * cfg.slippageRate;
  return { gross, commission, slippage, total: gross + commission + slippage };
}

export function sellProceeds(gross: number, date: string, cfg: BacktestConfig) {
  const commission = Math.max(cfg.minCommission, gross * cfg.commissionRate);
  const slippage = gross * cfg.slippageRate;
  const stampDuty = gross * stampDutyRate(date, cfg);
  return { gross, commission, slippage, stampDuty, net: gross - commission - slippage - stampDuty };
}

export function affordableQuantity(budget: number, rawPrice: number, cfg: BacktestConfig): number {
  if (!(budget > 0) || !(rawPrice > 0)) return 0;
  let quantity = Math.floor(budget / (rawPrice * cfg.lotSize)) * cfg.lotSize;
  while (quantity > 0 && buyCost(quantity, rawPrice, cfg).total > budget + 1e-8) quantity -= cfg.lotSize;
  return Math.max(0, quantity);
}

function barIndexAtOrAfter(stock: StockSeries, date: string): number {
  let lo = 0;
  let hi = stock.bars.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (stock.bars[mid]!.date < date) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function nextTradableAfter(stock: StockSeries, date: string): DailyBar | null {
  for (let i = barIndexAtOrAfter(stock, date + '\uffff'); i < stock.bars.length; i++) {
    const bar = stock.bars[i]!;
    if (bar.tradeStatus === 1 && bar.open > 0 && bar.close > 0) return bar;
  }
  return null;
}

function firstSellAfter(signals: readonly PointSignal[], date: string, klass: PointClass | null): PointSignal | null {
  let lo = 0;
  let hi = signals.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (signals[mid]!.confirmDate <= date) lo = mid + 1;
    else hi = mid;
  }
  for (let i = lo; i < signals.length; i++) {
    const signal = signals[i]!;
    if (klass == null || signal.klass === klass) return signal;
  }
  return null;
}

export function prepareCandidates(
  stocks: ReadonlyMap<string, StockSeries>,
  signals: readonly PointSignal[],
  calendar: readonly string[],
  cfg: BacktestConfig,
): EntryCandidate[] {
  const calendarIndex = new Map(calendar.map((date, index) => [date, index] as const));
  const sellsByCode = new Map<string, PointSignal[]>();
  for (const signal of signals) {
    if (signal.side !== 'sell') continue;
    const list = sellsByCode.get(signal.code) ?? [];
    list.push(signal);
    sellsByCode.set(signal.code, list);
  }
  for (const list of sellsByCode.values()) list.sort((a, b) => a.confirmDate.localeCompare(b.confirmDate));
  const out: EntryCandidate[] = [];
  for (const signal of signals) {
    if (signal.side !== 'buy' || signal.signalIsSt || signal.confirmDate < cfg.startDate || signal.confirmDate > cfg.endDate) continue;
    const stock = stocks.get(signal.code);
    if (!stock) continue;
    const entry = nextTradableAfter(stock, signal.confirmDate);
    if (!entry || entry.date > cfg.endDate || !calendarIndex.has(entry.date)) continue;
    const stockSells = sellsByCode.get(signal.code) ?? [];
    const exitSignalDates = {
      'any-sell': firstSellAfter(stockSells, signal.confirmDate, null)?.confirmDate ?? null,
      'same-class-sell': firstSellAfter(stockSells, signal.confirmDate, signal.klass)?.confirmDate ?? null,
    };
    const exitFromSignal = (date: string | null) => {
      if (!date) return null;
      const bar = nextTradableAfter(stock, date);
      return bar && bar.date <= cfg.endDate ? bar.date : null;
    };
    const entryIndex = calendarIndex.get(entry.date)!;
    const fixedExit = (sessions: number) => calendar[entryIndex + sessions] ?? null;
    out.push({
      code: signal.code,
      klass: signal.klass,
      pointKey: signal.pointKey,
      structureDate: signal.structureDate,
      signalDate: signal.confirmDate,
      entryDate: entry.date,
      avgAmount20: signal.avgAmount20,
      exitSignalDates,
      exitDates: {
        'any-sell': exitFromSignal(exitSignalDates['any-sell']),
        'same-class-sell': exitFromSignal(exitSignalDates['same-class-sell']),
        'hold-20': fixedExit(20),
        'hold-60': fixedExit(60),
      },
    });
  }
  return out.sort((a, b) => a.entryDate.localeCompare(b.entryDate) || b.avgAmount20 - a.avgAmount20 || a.code.localeCompare(b.code) || a.pointKey.localeCompare(b.pointKey));
}

function daysBetween(start: string, end: string): number {
  return Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000);
}

function reasonLabel(rule: ExitRule): string {
  return rule === 'any-sell' ? '任一确认卖点' : rule === 'same-class-sell' ? '同类确认卖点' : rule === 'hold-20' ? '持有20个市场交易日' : '持有60个市场交易日';
}

export function simulatePortfolio(
  klass: PointClass,
  exitRule: ExitRule,
  stocks: Pick<ReadonlyMap<string, StockSeries>, 'get'>,
  candidates: readonly EntryCandidate[],
  calendar: readonly string[],
  config: BacktestConfig,
): ScenarioResult {
  const cfg = { ...config, initialCapital: config.initialCapital };
  const relevant = candidates.filter(c => c.klass === klass && c.entryDate >= cfg.startDate && c.entryDate <= cfg.endDate);
  const byEntryDate = new Map<string, EntryCandidate[]>();
  for (const candidate of relevant) {
    const list = byEntryDate.get(candidate.entryDate) ?? [];
    list.push(candidate);
    byEntryDate.set(candidate.entryDate, list);
  }
  let cash = cfg.initialCapital;
  let totalCommission = 0;
  let totalSlippage = 0;
  let totalStampDuty = 0;
  let delistingWriteOffs = 0;
  const positions = new Map<string, Position>();
  const trades: Trade[] = [];
  const rejected: RejectedCandidate[] = [];
  const equity: EquityPoint[] = [];
  const dates = calendar.filter(date => date >= cfg.startDate && date <= cfg.endDate);
  const reject = (candidate: EntryCandidate, reason: RejectedCandidate['reason']) => rejected.push({
    code: candidate.code, klass, pointKey: candidate.pointKey, signalDate: candidate.signalDate, entryDate: candidate.entryDate, reason,
  });

  for (const date of dates) {
    // 先按开盘处理离场，释放的现金当天可以用于新入场。
    for (const [code, position] of [...positions]) {
      const stock = stocks.get(code)!;
      if (stock.outDate && date > stock.outDate) {
        positions.delete(code);
        delistingWriteOffs++;
        trades.push({
          code, name: position.name, klass, pointKey: position.pointKey, structureDate: position.structureDate, signalDate: position.signalDate,
          entryDate: position.entryDate, entryRawPrice: position.entryRawPrice, entryHfqPrice: position.entryHfqPrice,
          quantity: position.quantity, entryGross: position.entryGross, entryCommission: position.entryCommission,
          entrySlippage: position.entrySlippage, entryTotalCost: position.entryTotalCost, exitDate: date,
          exitRawPrice: null, exitHfqPrice: null, exitGross: 0, exitCommission: 0, exitSlippage: 0,
          exitStampDuty: 0, exitReason: '退市后无行情，保守核销为零', exitSignalDate: null,
          realizedPnl: -position.entryTotalCost, realizedReturn: -1, holdingCalendarDays: daysBetween(position.entryDate, date),
        });
        continue;
      }
      if (!position.plannedExitDate || date < position.plannedExitDate) continue;
      const bar = stock.bars[barIndexAtOrAfter(stock, date)];
      if (!bar || bar.date !== date || bar.tradeStatus !== 1 || !(bar.hfqOpen! > 0)) continue;
      const limits = priceLimits(bar);
      if (limits && bar.open <= limits.down + 1e-8) continue;
      const exit = sellProceeds(position.units * bar.hfqOpen!, date, cfg);
      cash += exit.net;
      totalCommission += exit.commission;
      totalSlippage += exit.slippage;
      totalStampDuty += exit.stampDuty;
      const realizedPnl = exit.net - position.entryTotalCost;
      trades.push({
        code, name: position.name, klass, pointKey: position.pointKey, structureDate: position.structureDate, signalDate: position.signalDate,
        entryDate: position.entryDate, entryRawPrice: position.entryRawPrice, entryHfqPrice: position.entryHfqPrice,
        quantity: position.quantity, entryGross: position.entryGross, entryCommission: position.entryCommission,
        entrySlippage: position.entrySlippage, entryTotalCost: position.entryTotalCost, exitDate: date,
        exitRawPrice: bar.open, exitHfqPrice: bar.hfqOpen, exitGross: exit.gross, exitCommission: exit.commission,
        exitSlippage: exit.slippage, exitStampDuty: exit.stampDuty, exitReason: position.exitReason,
        exitSignalDate: position.exitSignalDate, realizedPnl, realizedReturn: realizedPnl / position.entryTotalCost,
        holdingCalendarDays: daysBetween(position.entryDate, date),
      });
      positions.delete(code);
    }

    const todays = byEntryDate.get(date) ?? [];
    if (todays.length) {
      const equityAtOpen = cash + [...positions.values()].reduce((sum, p) => {
        const stock = stocks.get(p.code)!;
        const bar = stock.bars[barIndexAtOrAfter(stock, date)];
        const mark = bar?.date === date && bar.tradeStatus === 1 && bar.hfqOpen! > 0 ? bar.hfqOpen! : p.lastHfqClose;
        return sum + p.units * mark;
      }, 0);
      const slotBudget = equityAtOpen / cfg.maxPositions;
      for (const candidate of todays) {
        if (positions.size >= cfg.maxPositions) { reject(candidate, '无空仓'); continue; }
        if (positions.has(candidate.code)) { reject(candidate, '已持有同股'); continue; }
        const stock = stocks.get(candidate.code)!;
        const bar = stock.bars[barIndexAtOrAfter(stock, date)];
        if (!bar || bar.date !== date || bar.tradeStatus !== 1 || !(bar.open > 0) || !(bar.hfqOpen! > 0)) {
          reject(candidate, '行情或复权缺失'); continue;
        }
        const limits = priceLimits(bar);
        if (limits && bar.open >= limits.up - 1e-8) { reject(candidate, '涨停不可买'); continue; }
        const quantity = affordableQuantity(Math.min(slotBudget, cash), bar.open, cfg);
        if (quantity < cfg.lotSize) { reject(candidate, '资金不足一手'); continue; }
        const entry = buyCost(quantity, bar.open, cfg);
        cash -= entry.total;
        totalCommission += entry.commission;
        totalSlippage += entry.slippage;
        positions.set(candidate.code, {
          code: candidate.code, name: stock.name, klass, pointKey: candidate.pointKey, structureDate: candidate.structureDate, signalDate: candidate.signalDate,
          entryDate: date, entryRawPrice: bar.open, entryHfqPrice: bar.hfqOpen!, quantity,
          units: entry.gross / bar.hfqOpen!, entryGross: entry.gross, entryCommission: entry.commission,
          entrySlippage: entry.slippage, entryTotalCost: entry.total, plannedExitDate: candidate.exitDates[exitRule],
          exitReason: reasonLabel(exitRule), exitSignalDate: exitRule === 'hold-20' || exitRule === 'hold-60' ? null : candidate.exitSignalDates[exitRule],
          lastDate: date, lastHfqClose: bar.hfqClose ?? bar.hfqOpen!,
        });
      }
    }

    let marketValue = 0;
    for (const position of positions.values()) {
      const stock = stocks.get(position.code)!;
      const bar = stock.bars[barIndexAtOrAfter(stock, date)];
      if (bar?.date === date && bar.hfqClose! > 0) {
        position.lastHfqClose = bar.hfqClose!;
        position.lastDate = date;
      }
      marketValue += position.units * position.lastHfqClose;
    }
    equity.push({ date, cash, marketValue, equity: cash + marketValue, positionCount: positions.size });
  }

  const openPositions: OpenPosition[] = [...positions.values()].map(p => ({
    code: p.code, name: p.name, klass, pointKey: p.pointKey, signalDate: p.signalDate, entryDate: p.entryDate,
    entryRawPrice: p.entryRawPrice, quantity: p.quantity, entryTotalCost: p.entryTotalCost, lastDate: p.lastDate,
    marketValue: p.units * p.lastHfqClose, unrealizedPnl: p.units * p.lastHfqClose - p.entryTotalCost,
    plannedExitDate: p.plannedExitDate, exitReason: p.exitReason,
  }));
  const last = equity.at(-1);
  return {
    klass, exitRule, initialCapital: cfg.initialCapital, finalEquity: last?.equity ?? cfg.initialCapital,
    finalCash: cash, finalMarketValue: last?.marketValue ?? 0, trades, openPositions, rejected, equity,
    totalCommission, totalSlippage, totalStampDuty, delistingWriteOffs,
  };
}

export interface PerformanceMetrics {
  totalReturn: number;
  annualizedReturn: number;
  maxDrawdown: number;
  sharpe: number | null;
  calmar: number | null;
  closedTrades: number;
  winRate: number | null;
  payoffRatio: number | null;
  profitFactor: number | null;
  averageHoldingCalendarDays: number | null;
}

export function performanceMetrics(result: Pick<ScenarioResult, 'initialCapital' | 'finalEquity' | 'trades' | 'equity'>): PerformanceMetrics {
  const totalReturn = result.finalEquity / result.initialCapital - 1;
  const first = result.equity[0]?.date;
  const last = result.equity.at(-1)?.date;
  const years = first && last ? Math.max(daysBetween(first, last) / 365.25, 1 / 365.25) : 1;
  const annualizedReturn = result.finalEquity > 0 ? Math.pow(result.finalEquity / result.initialCapital, 1 / years) - 1 : -1;
  let peak = result.initialCapital;
  let maxDrawdown = 0;
  const returns: number[] = [];
  for (let i = 0; i < result.equity.length; i++) {
    const point = result.equity[i]!;
    peak = Math.max(peak, point.equity);
    if (peak > 0) maxDrawdown = Math.max(maxDrawdown, 1 - point.equity / peak);
    const previous = i === 0 ? result.initialCapital : result.equity[i - 1]!.equity;
    if (previous > 0) returns.push(point.equity / previous - 1);
  }
  const mean = returns.length ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;
  const variance = returns.length > 1 ? returns.reduce((sum, r) => sum + (r - mean) ** 2, 0) / (returns.length - 1) : 0;
  const sharpe = variance > 0 ? mean / Math.sqrt(variance) * Math.sqrt(252) : null;
  const wins = result.trades.filter(t => t.realizedPnl > 0);
  const losses = result.trades.filter(t => t.realizedPnl < 0);
  const averageWin = wins.length ? wins.reduce((sum, t) => sum + t.realizedPnl, 0) / wins.length : null;
  const averageLoss = losses.length ? Math.abs(losses.reduce((sum, t) => sum + t.realizedPnl, 0) / losses.length) : null;
  const grossWin = wins.reduce((sum, t) => sum + t.realizedPnl, 0);
  const grossLoss = Math.abs(losses.reduce((sum, t) => sum + t.realizedPnl, 0));
  return {
    totalReturn, annualizedReturn, maxDrawdown, sharpe, calmar: maxDrawdown > 0 ? annualizedReturn / maxDrawdown : null,
    closedTrades: result.trades.length, winRate: result.trades.length ? wins.length / result.trades.length : null,
    payoffRatio: averageWin != null && averageLoss != null && averageLoss > 0 ? averageWin / averageLoss : null,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Number.POSITIVE_INFINITY : null,
    averageHoldingCalendarDays: result.trades.length ? result.trades.reduce((sum, t) => sum + t.holdingCalendarDays, 0) / result.trades.length : null,
  };
}
