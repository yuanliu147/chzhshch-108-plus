// 全主板探索特征缓存：只处理原日线候选，逐股原子检查点，支持分区续算。
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CHAN_PRESETS, compute, configId, type BuySellPoint, type ComputeResult, type KInput } from '../../packages/engine/src/index.ts';
import { dailyCloseMs, dailyCoverage } from '../../apps/server/src/marketTime.ts';
import { loadCalendar, loadStock, loadUniverse, type StockMeta } from './run_daily.ts';
import type { EntryCandidate, PointSignal } from './core.ts';
import {
  aggregatePeriods, atrTrailingExit, averageTrueRange, channelExit, higherPointSupport, latestCompletedPeriodIndex,
  movingTrendState, returnLookback, structureInvalidationExit, volumeFeature,
  type ExplorationExitPlan, type HigherPointSupport, type PeriodBar, type PeriodUnit,
} from './explore.ts';

const DB_PATH = process.env.CHAN_DB_PATH ?? '/Users/admin/WorkSpace/baostock_data/data/baostock.db';
const ENGINE_CONFIG = CHAN_PRESETS.originalDefault;
const ENGINE_CONFIG_ID = configId(ENGINE_CONFIG);
const CACHE_VERSION = 4;
export const TREND_WINDOWS = [20, 60, 120, 250] as const;
export const RELATIVE_WINDOWS = [20, 60, 120] as const;
export const WEEK_WINDOWS = [5, 10, 20, 60] as const;
export const MONTH_WINDOWS = [3, 6, 12, 24] as const;

export type TrendStates = Record<string, boolean | null>;
export type ReturnStates = Record<string, number | null>;
export interface ExplorationRecord {
  code: string;
  klass: 1 | 2 | 3;
  pointKey: string;
  structureDate: string;
  signalDate: string;
  entryDate: string;
  volumePrimary: number | null;
  volumeSecondary: number | null;
  volumePass: boolean | null;
  volumeDetail: string;
  dailyTrend: TrendStates;
  stockReturn: ReturnStates;
  atr14Pct: number | null;
  weeklyTrend: TrendStates;
  monthlyTrend: TrendStates;
  weeklyPoint: HigherPointSupport;
  monthlyPoint: HigherPointSupport;
  structureLevelRaw: number | null;
  structureLevel: number | null;
  exitPlans: Record<string, ExplorationExitPlan>;
}
interface DailyCache { version: number; configId: string; startDate: string; endDate: string; signals: PointSignal[]; candidates: EntryCandidate[] }
interface StockAudit {
  code: string;
  candidates: number;
  mapped: number;
  volumeAvailable: number;
  weeklyBars: number;
  monthlyBars: number;
  weeklyPoints: number;
  monthlyPoints: number;
  elapsedMs: number;
  error?: string;
}
interface Payload { version: number; configId: string; endDate: string; audit: StockAudit; records: ExplorationRecord[] }

function args() {
  const out = new Map<string, string>();
  for (const arg of process.argv.slice(2)) {
    const match = /^--([^=]+)=(.*)$/.exec(arg);
    if (match) out.set(match[1]!, match[2]!);
  }
  return out;
}
function atomicJson(path: string, value: unknown) {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(value));
  renameSync(tmp, path);
}
function engineInput(bars: readonly { date: string; high: number; low: number; close: number }[], continuityId: string): KInput[] {
  return bars.map(b => ({ date: b.date, high: b.high, low: b.low, close: b.close,
    time: { endMs: dailyCloseMs(b.date), coverage: dailyCoverage(b.date), complete: true, quality: 'verified', continuityId } }));
}
function computePeriods(bars: readonly PeriodBar[], code: string, unit: PeriodUnit): ComputeResult | null {
  if (!bars.length) return null;
  return compute(engineInput(bars, `${unit}:${code}:3`), ENGINE_CONFIG);
}
function trendAt(bars: readonly { hfqClose: number | null }[], index: number, windows: readonly number[]): TrendStates {
  const values = bars.map(b => b.hfqClose ?? Number.NaN);
  return Object.fromEntries(windows.map(window => [window, movingTrendState(values, index, window)]));
}
function returnsAt(bars: readonly { hfqClose: number | null }[], index: number): ReturnStates {
  const values = bars.map(b => b.hfqClose ?? Number.NaN);
  return Object.fromEntries(RELATIVE_WINDOWS.map(window => [window, returnLookback(values, index, window)]));
}
function emptyRecord(candidate: EntryCandidate, detail: string): ExplorationRecord {
  return {
    code: candidate.code, klass: candidate.klass, pointKey: candidate.pointKey, structureDate: candidate.structureDate,
    signalDate: candidate.signalDate, entryDate: candidate.entryDate,
    volumePrimary: null, volumeSecondary: null, volumePass: null, volumeDetail: detail,
    dailyTrend: {}, stockReturn: {}, atr14Pct: null, weeklyTrend: {}, monthlyTrend: {},
    weeklyPoint: { status: '数据不足', klasses: [], periodEndDate: null },
    monthlyPoint: { status: '数据不足', klasses: [], periodEndDate: null }, structureLevelRaw: null, structureLevel: null, exitPlans: {},
  };
}

export function extractStockExploration(db: DatabaseSync, meta: StockMeta, daily: DailyCache, calendar: readonly string[], endDate: string): { audit: StockAudit; records: ExplorationRecord[] } {
  const started = performance.now();
  const wanted = daily.candidates;
  const audit: StockAudit = { code: meta.code, candidates: wanted.length, mapped: 0, volumeAvailable: 0, weeklyBars: 0, monthlyBars: 0, weeklyPoints: 0, monthlyPoints: 0, elapsedMs: 0 };
  if (!wanted.length) { audit.elapsedMs = Math.round(performance.now() - started); return { audit, records: [] }; }
  const stock = loadStock(db, meta, endDate);
  const dailyBars = stock.bars.filter(b => b.tradeStatus === 1 && b.high > 0 && b.low > 0 && b.close > 0);
  const dailyResult = compute(engineInput(dailyBars, `daily:${meta.code}:3`), ENGINE_CONFIG);
  const pointByKey = new Map<string, BuySellPoint>(dailyResult.points.map(p => [p.key!, p] as const));
  const dailyIndex = new Map(dailyBars.map((b, index) => [b.date, index] as const));
  const weeks = aggregatePeriods(stock.bars, calendar, 'week');
  const months = aggregatePeriods(stock.bars, calendar, 'month');
  const weeklyResult = computePeriods(weeks, meta.code, 'week');
  const monthlyResult = computePeriods(months, meta.code, 'month');
  audit.weeklyBars = weeks.length;
  audit.monthlyBars = months.length;
  audit.weeklyPoints = weeklyResult?.points.filter(p => p.status === 'confirmed').length ?? 0;
  audit.monthlyPoints = monthlyResult?.points.filter(p => p.status === 'confirmed').length ?? 0;
  const records: ExplorationRecord[] = [];
  for (const candidate of wanted) {
    const point = pointByKey.get(candidate.pointKey);
    const signalIndex = dailyIndex.get(candidate.signalDate) ?? -1;
    if (!point || signalIndex < 0) { records.push(emptyRecord(candidate, '日线点或确认bar无法映射')); continue; }
    audit.mapped++;
    const volume = volumeFeature(dailyBars, dailyResult, point);
    if (volume.pass != null) audit.volumeAvailable++;
    const weeklyIndex = latestCompletedPeriodIndex(weeks, candidate.signalDate);
    const monthlyIndex = latestCompletedPeriodIndex(months, candidate.signalDate);
    const center = point.klass === 3 ? dailyResult.centers.find(c => c.key === point.refKey || c.id === point.refId) : undefined;
    const structureLevelRaw = point.klass === 3 ? center?.ZG ?? null : point.price;
    const stockSignalIndex = stock.bars.findIndex(b => b.date === candidate.signalDate);
    const stockSignalBar = stock.bars[stockSignalIndex];
    const adjustment = stockSignalBar?.hfqClose != null && stockSignalBar.close > 0 ? stockSignalBar.hfqClose / stockSignalBar.close : null;
    const structureLevel = structureLevelRaw != null && adjustment != null ? structureLevelRaw * adjustment : null;
    const atr = averageTrueRange(stock.bars, stockSignalIndex, 14);
    const signalClose = stockSignalBar?.hfqClose ?? null;
    const exitPlans: Record<string, ExplorationExitPlan> = {
      structure: structureInvalidationExit(stock, candidate, structureLevel ?? Number.NaN, endDate),
      'atr14-2': atrTrailingExit(stock, candidate, 14, 2, endDate),
      'atr14-3': atrTrailingExit(stock, candidate, 14, 3, endDate),
      'atr14-4': atrTrailingExit(stock, candidate, 14, 4, endDate),
      'channel-10': channelExit(stock, candidate, 10, endDate),
      'channel-20': channelExit(stock, candidate, 20, endDate),
    };
    records.push({
      code: candidate.code, klass: candidate.klass, pointKey: candidate.pointKey, structureDate: candidate.structureDate,
      signalDate: candidate.signalDate, entryDate: candidate.entryDate,
      volumePrimary: volume.primaryRatio, volumeSecondary: volume.secondaryRatio, volumePass: volume.pass, volumeDetail: volume.detail,
      dailyTrend: trendAt(dailyBars, signalIndex, TREND_WINDOWS), stockReturn: returnsAt(dailyBars, signalIndex),
      atr14Pct: atr != null && signalClose != null && signalClose > 0 ? atr / signalClose : null,
      weeklyTrend: trendAt(weeks, weeklyIndex, WEEK_WINDOWS), monthlyTrend: trendAt(months, monthlyIndex, MONTH_WINDOWS),
      weeklyPoint: higherPointSupport(weeklyResult, weeks, candidate.signalDate),
      monthlyPoint: higherPointSupport(monthlyResult, months, candidate.signalDate),
      structureLevelRaw, structureLevel, exitPlans,
    });
  }
  audit.elapsedMs = Math.round(performance.now() - started);
  return { audit, records };
}

function main() {
  const cli = args();
  const endDate = cli.get('end') ?? '2026-11-04';
  const base = resolve(cli.get('base') ?? '报告/缠论策略回测_20261115');
  const output = resolve(cli.get('output') ?? '报告/缠论策略探索_20261115');
  const cacheDir = join(output, 'cache', 'features');
  mkdirSync(cacheDir, { recursive: true });
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  db.exec('PRAGMA busy_timeout=5000;');
  let universe = loadUniverse(db);
  const codes = cli.get('codes');
  if (codes) universe = universe.filter(s => codes.split(',').includes(s.code));
  const offset = Number(cli.get('offset') ?? 0);
  if (offset) universe = universe.slice(offset);
  const limit = Number(cli.get('limit') ?? 0);
  if (limit) universe = universe.slice(0, limit);
  const calendar = loadCalendar(db, '1990-01-01', endDate);
  const fresh = cli.get('fresh') === '1';
  const records: ExplorationRecord[] = [];
  const audits: StockAudit[] = [];
  let index = 0;
  for (const meta of universe) {
    const dailyPath = join(base, 'cache', 'daily', `${meta.code.replace('.', '_')}.json`);
    if (!existsSync(dailyPath)) throw new Error(`缺少原日线检查点：${meta.code}`);
    const daily = JSON.parse(readFileSync(dailyPath, 'utf8')) as DailyCache;
    if (daily.configId !== ENGINE_CONFIG_ID || daily.endDate !== endDate) throw new Error(`原日线口径不一致：${meta.code}`);
    const path = join(cacheDir, `${meta.code.replace('.', '_')}.json`);
    let payload: Payload | null = null;
    if (!fresh && existsSync(path)) {
      try {
        const cached = JSON.parse(readFileSync(path, 'utf8')) as Payload;
        if (cached.version === CACHE_VERSION && cached.configId === ENGINE_CONFIG_ID && cached.endDate === endDate) payload = cached;
      } catch { /* 损坏检查点重算 */ }
    }
    if (!payload) {
      try {
        payload = { version: CACHE_VERSION, configId: ENGINE_CONFIG_ID, endDate, ...extractStockExploration(db, meta, daily, calendar, endDate) };
      } catch (error) {
        payload = { version: CACHE_VERSION, configId: ENGINE_CONFIG_ID, endDate,
          audit: { code: meta.code, candidates: daily.candidates.length, mapped: 0, volumeAvailable: 0, weeklyBars: 0, monthlyBars: 0, weeklyPoints: 0, monthlyPoints: 0, elapsedMs: 0,
            error: String(error instanceof Error ? error.stack ?? error.message : error) }, records: [] };
      }
      atomicJson(path, payload);
    }
    records.push(...payload.records);
    audits.push(payload.audit);
    index++;
    if (index === 1 || index % 10 === 0 || index === universe.length) {
      console.log(`[探索特征] ${index}/${universe.length} ${meta.code} 候选${payload.audit.candidates} 映射${payload.audit.mapped} 量能${payload.audit.volumeAvailable} 周点${payload.audit.weeklyPoints} 月点${payload.audit.monthlyPoints} ${payload.audit.elapsedMs}ms${payload.audit.error ? ` 错误:${payload.audit.error}` : ''}`);
    }
  }
  if (cli.get('summary') === '1') atomicJson(join(output, '探索特征汇总.json'), { createdAt: new Date().toISOString(), endDate, configId: ENGINE_CONFIG_ID, audits, records });
  console.log(`[完成] 候选${records.length} 映射${audits.reduce((s, a) => s + a.mapped, 0)} 错误${audits.filter(a => a.error).length}`);
  db.close();
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
