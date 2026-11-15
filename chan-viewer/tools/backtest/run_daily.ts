// 主板日线缠论信号提取 + 多离场场景账户回测。
// 用法：node --no-warnings --import tsx tools/backtest/run_daily.ts --limit=20 --output=报告/缠论回测_试点
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CHAN_PRESETS, createReplay, configId, type BuySellPoint, type ChanEvent, type KInput } from '../../packages/engine/src/index.ts';
import { dailyCloseMs, dailyCoverage } from '../../apps/server/src/marketTime.ts';
import {
  DEFAULT_BACKTEST_CONFIG, EXIT_RULES, performanceMetrics, prepareCandidates, simulatePortfolio,
  type BacktestConfig, type DailyBar, type EntryCandidate, type PointClass, type PointSignal, type ScenarioResult, type StockSeries,
} from './core.ts';

const DB_PATH = process.env.CHAN_DB_PATH ?? '/Users/admin/WorkSpace/baostock_data/data/baostock.db';
const ENGINE_CONFIG = CHAN_PRESETS.originalDefault;
const ENGINE_CONFIG_ID = configId(ENGINE_CONFIG);
const CACHE_VERSION = 1;

export interface StockMeta { code: string; name: string; ipoDate: string | null; outDate: string | null }
interface StockAudit { code: string; bars: number; engineBars: number; buys: number; sells: number; confirmationIndexMismatches: number; elapsedMs: number }
interface CachePayload { version: number; configId: string; startDate: string; endDate: string; audit: StockAudit; signals: PointSignal[]; candidates: EntryCandidate[] }

function args() {
  const map = new Map<string, string>();
  for (const arg of process.argv.slice(2)) {
    const match = /^--([^=]+)=(.*)$/.exec(arg);
    if (match) map.set(match[1]!, match[2]!);
  }
  return map;
}

function mainBoardWhere(): string {
  return `type=1 AND (${['sh.600', 'sh.601', 'sh.603', 'sh.605', 'sz.000', 'sz.001', 'sz.002', 'sz.003'].map(() => 'code LIKE ?').join(' OR ')})`;
}
const PREFIXES = ['sh.600%', 'sh.601%', 'sh.603%', 'sh.605%', 'sz.000%', 'sz.001%', 'sz.002%', 'sz.003%'];

export function loadUniverse(db: DatabaseSync): StockMeta[] {
  const rows = db.prepare(`SELECT code,code_name,ipo_date,out_date FROM stock_basic WHERE ${mainBoardWhere()} ORDER BY code`).all(...PREFIXES) as unknown as { code: string; code_name: string | null; ipo_date: string | null; out_date: string | null }[];
  return rows.map(r => ({ code: r.code, name: r.code_name ?? r.code, ipoDate: r.ipo_date, outDate: r.out_date }));
}

export function loadCalendar(db: DatabaseSync, startDate: string, endDate: string): string[] {
  return (db.prepare('SELECT calendar_date FROM trade_dates WHERE is_trading_day=1 AND calendar_date>=? AND calendar_date<=? ORDER BY calendar_date').all(startDate, endDate) as unknown as { calendar_date: string }[]).map(r => r.calendar_date);
}

export function loadStock(db: DatabaseSync, meta: StockMeta, endDate: string, startDate?: string): StockSeries {
  const params: (string | number)[] = [meta.code, endDate];
  let startSql = '';
  if (startDate) { startSql = 'AND date>=?'; params.push(startDate); }
  const raw = db.prepare(`SELECT date,open,high,low,close,preclose,volume,amount,trade_status,is_st FROM stock_kline_d
    WHERE code=? AND adjustflag=3 AND date<=? ${startSql} ORDER BY date`).all(...params) as unknown as Record<string, number | string | null>[];
  const hfqParams: (string | number)[] = [meta.code, endDate];
  if (startDate) hfqParams.push(startDate);
  const hfq = db.prepare(`SELECT date,open,high,low,close FROM stock_kline_d
    WHERE code=? AND adjustflag=1 AND date<=? ${startSql} ORDER BY date`).all(...hfqParams) as unknown as { date: string; open: number; high: number; low: number; close: number }[];
  const hfqByDate = new Map(hfq.map(r => [r.date, r] as const));
  const bars: DailyBar[] = raw.map(r => {
    const date = r.date as string;
    const h = hfqByDate.get(date);
    return {
      date, open: Number(r.open), high: Number(r.high), low: Number(r.low), close: Number(r.close),
      preclose: r.preclose == null ? null : Number(r.preclose), volume: Number(r.volume), amount: Number(r.amount),
      tradeStatus: Number(r.trade_status), isSt: Number(r.is_st ?? 0), hfqOpen: h?.open ?? null,
      hfqHigh: h?.high ?? null, hfqLow: h?.low ?? null, hfqClose: h?.close ?? null,
    };
  });
  return { code: meta.code, name: meta.name, ipoDate: meta.ipoDate, outDate: meta.outDate, bars };
}

function extractStock(stock: StockSeries, calendar: readonly string[], cfg: BacktestConfig): { audit: StockAudit; signals: PointSignal[]; candidates: EntryCandidate[] } {
  const started = performance.now();
  const engineBars = stock.bars.filter(b => b.tradeStatus === 1 && b.high > 0 && b.low > 0 && b.close > 0);
  const replay = createReplay(ENGINE_CONFIG);
  const pointEvents: { event: ChanEvent; side: 'buy' | 'sell' }[] = [];
  const amountPrefix = [0];
  for (let i = 0; i < engineBars.length; i++) {
    const b = engineBars[i]!;
    amountPrefix.push(amountPrefix[i]! + b.amount);
    const input: KInput = {
      date: b.date, high: b.high, low: b.low, close: b.close,
      time: { endMs: dailyCloseMs(b.date), coverage: dailyCoverage(b.date), complete: true, quality: 'verified', continuityId: `daily:${stock.code}:3` },
    };
    const events = replay.push(input);
    for (const event of events) {
      if (event.kind === '买点确认') pointEvents.push({ event, side: 'buy' });
      else if (event.kind === '卖点确认') pointEvents.push({ event, side: 'sell' });
    }
  }
  const result = replay.result();
  const pointsById = new Map<number, BuySellPoint>(result.points.map(p => [p.id, p] as const));
  const signals: PointSignal[] = [];
  let confirmationIndexMismatches = 0;
  for (const { event, side } of pointEvents) {
    if (event.id == null) continue;
    const point = pointsById.get(event.id);
    const confirmBar = engineBars[event.at];
    if (!point || point.status !== 'confirmed' || !confirmBar) continue;
    if (point.confirmedAt !== event.at) confirmationIndexMismatches++;
    const structureBar = engineBars[Math.max(0, Math.min(engineBars.length - 1, Math.round(point.atRaw)))];
    const from = Math.max(0, event.at - 19);
    const avgAmount20 = (amountPrefix[event.at + 1]! - amountPrefix[from]!) / (event.at - from + 1);
    signals.push({
      code: stock.code, side, klass: point.klass, pointKey: point.key ?? `point:${point.id}`,
      structureDate: structureBar?.date ?? confirmBar.date, confirmDate: confirmBar.date, avgAmount20, signalIsSt: confirmBar.isSt === 1,
    });
  }
  const candidates = prepareCandidates(new Map([[stock.code, stock]]), signals, calendar, cfg);
  return {
    audit: {
      code: stock.code, bars: stock.bars.length, engineBars: engineBars.length,
      buys: signals.filter(s => s.side === 'buy').length, sells: signals.filter(s => s.side === 'sell').length,
      confirmationIndexMismatches, elapsedMs: Math.round(performance.now() - started),
    },
    signals, candidates,
  };
}

function atomicJson(path: string, value: unknown) {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(value));
  renameSync(tmp, path);
}

function extractWithCache(db: DatabaseSync, meta: StockMeta, calendar: readonly string[], cfg: BacktestConfig, cacheDir: string, fresh: boolean): CachePayload {
  const path = join(cacheDir, `${meta.code.replace('.', '_')}.json`);
  if (!fresh && existsSync(path)) {
    try {
      const cached = JSON.parse(readFileSync(path, 'utf8')) as CachePayload;
      if (cached.version === CACHE_VERSION && cached.configId === ENGINE_CONFIG_ID && cached.startDate === cfg.startDate && cached.endDate === cfg.endDate) return cached;
    } catch { /* 损坏检查点自动重算，不沿用。 */ }
  }
  const stock = loadStock(db, meta, cfg.endDate);
  const extracted = extractStock(stock, calendar, cfg);
  const payload: CachePayload = { version: CACHE_VERSION, configId: ENGINE_CONFIG_ID, startDate: cfg.startDate, endDate: cfg.endDate, ...extracted };
  atomicJson(path, payload);
  return payload;
}

export class LazyMarket {
  private cache = new Map<string, StockSeries>();
  constructor(private db: DatabaseSync, private metas: ReadonlyMap<string, StockMeta>, private cfg: BacktestConfig, private capacity = 48) {}
  get(code: string): StockSeries | undefined {
    const hit = this.cache.get(code);
    if (hit) { this.cache.delete(code); this.cache.set(code, hit); return hit; }
    const meta = this.metas.get(code);
    if (!meta) return undefined;
    const stock = loadStock(this.db, meta, this.cfg.endDate, this.cfg.startDate);
    this.cache.set(code, stock);
    if (this.cache.size > this.capacity) {
      const oldest = this.cache.keys().next().value as string | undefined;
      if (oldest) this.cache.delete(oldest);
    }
    return stock;
  }
}

export function scenarioSummary(result: ScenarioResult) {
  const metrics = performanceMetrics(result);
  return {
    买点类别: result.klass, 离场规则: result.exitRule, 初始资金: result.initialCapital, 期末权益: result.finalEquity,
    总收益率: metrics.totalReturn, 年化收益率: metrics.annualizedReturn, 最大回撤: metrics.maxDrawdown,
    夏普比率: metrics.sharpe, 卡玛比率: metrics.calmar, 已平仓交易数: metrics.closedTrades,
    胜率: metrics.winRate, 盈亏比: metrics.payoffRatio, 盈利因子: metrics.profitFactor,
    平均持有自然日: metrics.averageHoldingCalendarDays, 期末持仓数: result.openPositions.length,
    期末持仓市值: result.finalMarketValue, 佣金: result.totalCommission, 滑点: result.totalSlippage,
    印花税: result.totalStampDuty, 退市核销笔数: result.delistingWriteOffs, 未成交信号数: result.rejected.length,
  };
}

function main() {
  const cli = args();
  const cfg: BacktestConfig = {
    ...DEFAULT_BACKTEST_CONFIG,
    startDate: cli.get('start') ?? DEFAULT_BACKTEST_CONFIG.startDate,
    endDate: cli.get('end') ?? DEFAULT_BACKTEST_CONFIG.endDate,
    initialCapital: Number(cli.get('capital') ?? DEFAULT_BACKTEST_CONFIG.initialCapital),
    maxPositions: Number(cli.get('slots') ?? DEFAULT_BACKTEST_CONFIG.maxPositions),
  };
  const output = resolve(cli.get('output') ?? '报告/缠论策略回测_20261115');
  const cacheDir = join(output, 'cache', 'daily');
  mkdirSync(cacheDir, { recursive: true });
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  db.exec('PRAGMA busy_timeout=5000;');
  let universe = loadUniverse(db);
  const codes = cli.get('codes');
  if (codes) universe = universe.filter(s => codes.split(',').includes(s.code));
  const offset = Number(cli.get('offset') ?? 0);
  if (offset > 0) universe = universe.slice(offset);
  const limit = Number(cli.get('limit') ?? 0);
  if (limit > 0) universe = universe.slice(0, limit);
  if (!universe.length) throw new Error('股票池为空');
  const calendar = loadCalendar(db, cfg.startDate, cfg.endDate);
  const signals: PointSignal[] = [];
  const candidates: EntryCandidate[] = [];
  const audits: StockAudit[] = [];
  const fresh = cli.get('fresh') === '1';
  let index = 0;
  for (const meta of universe) {
    const payload = extractWithCache(db, meta, calendar, cfg, cacheDir, fresh);
    signals.push(...payload.signals);
    candidates.push(...payload.candidates);
    audits.push(payload.audit);
    index++;
    if (index % 10 === 0 || index === universe.length || index === 1) {
      console.log(`[日线] ${index}/${universe.length} ${meta.code} 信号${payload.audit.buys + payload.audit.sells} 候选累计${candidates.length} 用时${payload.audit.elapsedMs}ms`);
    }
  }
  candidates.sort((a, b) => a.entryDate.localeCompare(b.entryDate) || b.avgAmount20 - a.avgAmount20 || a.code.localeCompare(b.code) || a.pointKey.localeCompare(b.pointKey));
  console.log(`[日线] 信号提取完成：股票${universe.length}，买卖点${signals.length}，非风险警示买入候选${candidates.length}，确认下标不一致${audits.reduce((s, a) => s + a.confirmationIndexMismatches, 0)}`);
  if (cli.get('cache-only') === '1') { db.close(); return; }
  if (cli.get('signals-only') === '1') {
    atomicJson(join(output, '日线信号与候选.json'), { cfg, engineConfig: ENGINE_CONFIG, audits, signals, candidates });
    db.close();
    return;
  }
  const metas = new Map(universe.map(m => [m.code, m] as const));
  const results: ScenarioResult[] = [];
  for (const klass of [1, 2, 3] as PointClass[]) {
    for (const exitRule of EXIT_RULES) {
      const started = performance.now();
      const result = simulatePortfolio(klass, exitRule, new LazyMarket(db, metas, cfg), candidates, calendar, cfg);
      results.push(result);
      const summary = scenarioSummary(result);
      console.log(`[账户] ${klass}买 ${exitRule} 期末${result.finalEquity.toFixed(2)} 收益${(summary.总收益率 * 100).toFixed(2)}% 交易${summary.已平仓交易数} 持仓${summary.期末持仓数} ${Math.round(performance.now() - started)}ms`);
    }
  }
  atomicJson(join(output, '日线回测原始结果.json'), {
    createdAt: new Date().toISOString(), dataSource: DB_PATH, config: cfg, engineConfig: ENGINE_CONFIG, engineConfigId: ENGINE_CONFIG_ID,
    universe: universe.map(m => m.code), calendarDays: calendar.length, audits, signals, candidates,
    results, summaries: results.map(scenarioSummary),
  });
  console.log(`[完成] ${join(output, '日线回测原始结果.json')}`);
  db.close();
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
