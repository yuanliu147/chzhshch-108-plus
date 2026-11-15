// 2020年以来日线→30分钟→5分钟共振对照。判定函数复用 apps/web 当前研究规则。
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { CHAN_PRESETS, compute, configId, type BuySellPoint, type ComputeResult } from '../../packages/engine/src/index.ts';
import { dailyCloseMs, dailyCoverage } from '../../apps/server/src/marketTime.ts';
import { queryMinKline, type MinBar } from '../../apps/server/src/db.ts';
import { evaluatePointConfluence, pointKnownAt } from '../../apps/web/src/chart/confluence.ts';
import { formatChinaDateTime, overlaps, verifiedCoverageOf } from '../../apps/web/src/chart/timeMapping.ts';
import type { RawBar } from '../../apps/web/src/api.ts';
import { loadStock, loadUniverse, type StockMeta } from './run_daily.ts';
import type { EntryCandidate, PointSignal } from './core.ts';

const DB_PATH = process.env.CHAN_DB_PATH ?? '/Users/admin/WorkSpace/baostock_data/data/baostock.db';
const ENGINE_CONFIG = CHAN_PRESETS.originalDefault;
const ENGINE_CONFIG_ID = configId(ENGINE_CONFIG);
const START_DATE = '2020-01-01';
const CACHE_VERSION = 1;

type Status = '支持' | '不支持' | '冲突' | '等待' | '数据不足';
interface DailyCache { configId: string; endDate: string; signals: PointSignal[]; candidates: EntryCandidate[] }
interface ConfluenceRecord {
  code: string;
  pointKey: string;
  klass: number;
  structureDate: string;
  confirmDate: string;
  status30: Status;
  summary30: string;
  supporting30Keys: string[];
  status5: Status | '未计算';
  supporting5Keys: string[];
}
interface StockAudit { code: string; candidates: number; mapped: number; m30Bars: number; m30Points: number; m5Bars: number; m5Points: number; elapsedMs: number; error?: string }
interface Payload { version: number; configId: string; endDate: string; audit: StockAudit; records: ConfluenceRecord[] }

function args() {
  const out = new Map<string, string>();
  for (const arg of process.argv.slice(2)) {
    const m = /^--([^=]+)=(.*)$/.exec(arg);
    if (m) out.set(m[1]!, m[2]!);
  }
  return out;
}

function atomicJson(path: string, value: unknown) {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(value));
  renameSync(tmp, path);
}

function dailyBars(stock: ReturnType<typeof loadStock>): RawBar[] {
  return stock.bars.filter(b => b.tradeStatus === 1 && b.high > 0 && b.low > 0 && b.close > 0).map(b => ({
    date: b.date, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume, amount: b.amount,
    pct_chg: null, is_st: b.isSt, endMs: dailyCloseMs(b.date),
    time: { endMs: dailyCloseMs(b.date), coverage: dailyCoverage(b.date), sourceCount: 1, expectedSourceCount: 1, complete: true, quality: 'verified', continuityId: `daily:${stock.code}:3` },
  }));
}

function minuteBars(bars: readonly MinBar[], code: string, freq: number): RawBar[] {
  return bars.map(b => ({
    date: b.time, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume, amount: b.amount,
    pct_chg: null, is_st: null, endMs: b.timeMeta.endMs,
    time: { ...b.timeMeta, continuityId: `${code}:${b.timeMeta.continuityId}` },
  }));
}

function asOfResult(full: ComputeResult, bars: readonly RawBar[], asOfMs: number): ComputeResult {
  const points = full.points.filter(p => {
    const known = pointKnownAt(p, bars);
    return known != null && known <= asOfMs;
  });
  return { ...full, points, asOfMs };
}

/** 与 evaluatePointConfluence 支持条件一致，另返回 supporting point 供5分钟链式检查。 */
function supportingPoints(targetPoint: BuySellPoint, targetBars: readonly RawBar[], lower: ComputeResult, lowerBars: readonly RawBar[], asOfMs: number): BuySellPoint[] {
  const targetBar = targetBars[Math.round(targetPoint.atRaw)];
  if (!targetBar) return [];
  const targetCoverage = targetBar.time?.coverage ?? [];
  return lower.points.filter(p => {
    if (p.side !== targetPoint.side || p.status !== 'confirmed' || p.quality === 'incomplete' || p.quality === 'unknown') return false;
    const known = pointKnownAt(p, lowerBars);
    const bar = lowerBars[Math.round(p.atRaw)];
    return known != null && known <= asOfMs && !!bar && verifiedCoverageOf(bar).length > 0 && overlaps(bar.time?.coverage ?? [], targetCoverage);
  });
}

function evaluateStock(db: DatabaseSync, meta: StockMeta, daily: DailyCache, endDate: string, withFive: boolean): { audit: StockAudit; records: ConfluenceRecord[] } {
  const started = performance.now();
  const wanted = daily.candidates.filter(c => c.signalDate >= START_DATE && c.signalDate <= endDate);
  const audit: StockAudit = { code: meta.code, candidates: wanted.length, mapped: 0, m30Bars: 0, m30Points: 0, m5Bars: 0, m5Points: 0, elapsedMs: 0 };
  if (!wanted.length) { audit.elapsedMs = Math.round(performance.now() - started); return { audit, records: [] }; }
  const stock = loadStock(db, meta, endDate);
  const dBars = dailyBars(stock);
  const dResult = compute(dBars, ENGINE_CONFIG);
  const dPoints = new Map(dResult.points.map(p => [p.key, p] as const));
  const wantedPoints = wanted.map(c => ({ candidate: c, point: dPoints.get(c.pointKey) })).filter((x): x is { candidate: EntryCandidate; point: BuySellPoint } => !!x.point);
  audit.mapped = wantedPoints.length;
  const records: ConfluenceRecord[] = wanted.filter(c => !dPoints.has(c.pointKey)).map(c => ({
    code: c.code, pointKey: c.pointKey, klass: c.klass, structureDate: c.structureDate, confirmDate: c.signalDate,
    status30: '数据不足', summary30: '日线点无法映射到同一引擎结果', supporting30Keys: [], status5: '未计算', supporting5Keys: [],
  }));
  if (!wantedPoints.length) { audit.elapsedMs = Math.round(performance.now() - started); return { audit, records }; }

  const lastNeededDaily = wantedPoints.reduce((max, x) => x.candidate.signalDate > max ? x.candidate.signalDate : max, START_DATE);
  const m30Bars = minuteBars(queryMinKline({ code: meta.code, freq: 30, end: `${lastNeededDaily} 23:59:59`, limit: 0 }), meta.code, 30);
  audit.m30Bars = m30Bars.length;
  if (!m30Bars.length) {
    records.push(...wantedPoints.map(({ candidate: c }) => ({ code: c.code, pointKey: c.pointKey, klass: c.klass, structureDate: c.structureDate, confirmDate: c.signalDate,
      status30: '数据不足' as const, summary30: '无30分钟行情', supporting30Keys: [], status5: '未计算' as const, supporting5Keys: [] })));
    audit.elapsedMs = Math.round(performance.now() - started);
    return { audit, records };
  }
  const m30Result = compute(m30Bars, ENGINE_CONFIG);
  audit.m30Points = m30Result.points.filter(p => p.status === 'confirmed').length;
  const m30Target = { levelName: '30分钟', result: m30Result, bars: m30Bars };
  const m5Needed = new Set<string>();
  const pending5: { record: ConfluenceRecord; point30: BuySellPoint; asOf30: number }[] = [];
  for (const { candidate, point } of wantedPoints) {
    const asOf = pointKnownAt(point, dBars);
    if (asOf == null) {
      records.push({ code: candidate.code, pointKey: candidate.pointKey, klass: candidate.klass, structureDate: candidate.structureDate, confirmDate: candidate.signalDate,
        status30: '数据不足', summary30: '日线点首次可知时刻无效', supporting30Keys: [], status5: '未计算', supporting5Keys: [] });
      continue;
    }
    const lower30 = asOfResult(m30Result, m30Bars, asOf);
    const decision = evaluatePointConfluence(point, { levelName: '日线', result: dResult, bars: dBars }, { levelName: '30分钟', result: lower30, bars: m30Bars }, asOf);
    const supported = decision.status === '支持' ? supportingPoints(point, dBars, lower30, m30Bars, asOf) : [];
    const record: ConfluenceRecord = {
      code: candidate.code, pointKey: candidate.pointKey, klass: candidate.klass, structureDate: candidate.structureDate, confirmDate: candidate.signalDate,
      status30: decision.status, summary30: decision.summary, supporting30Keys: supported.map(p => p.key!).filter(Boolean), status5: withFive && supported.length ? '数据不足' : '未计算', supporting5Keys: [],
    };
    records.push(record);
    if (withFive) {
      for (const point30 of supported) {
        const asOf30 = pointKnownAt(point30, m30Bars);
        if (asOf30 != null) { pending5.push({ record, point30, asOf30 }); m5Needed.add(point30.key!); }
      }
    }
  }
  if (pending5.length) {
    const lastNeeded5 = formatChinaDateTime(Math.max(...pending5.map(x => x.asOf30))).slice(0, 10);
    const m5Bars = minuteBars(queryMinKline({ code: meta.code, freq: 5, end: `${lastNeeded5} 23:59:59`, limit: 0 }), meta.code, 5);
    audit.m5Bars = m5Bars.length;
    if (m5Bars.length) {
      const m5Result = compute(m5Bars, ENGINE_CONFIG);
      audit.m5Points = m5Result.points.filter(p => p.status === 'confirmed').length;
      const grouped = new Map<ConfluenceRecord, { point30: BuySellPoint; asOf30: number }[]>();
      for (const item of pending5) { const list = grouped.get(item.record) ?? []; list.push(item); grouped.set(item.record, list); }
      for (const [record, items] of grouped) {
        const statuses: Status[] = [];
        const strictKeys = new Set<string>();
        for (const { point30, asOf30 } of items) {
          const lower5 = asOfResult(m5Result, m5Bars, asOf30);
          const decision5 = evaluatePointConfluence(point30, m30Target, { levelName: '5分钟', result: lower5, bars: m5Bars }, asOf30);
          statuses.push(decision5.status);
          if (decision5.status === '支持') {
            strictKeys.add(point30.key!);
            for (const p5 of supportingPoints(point30, m30Bars, lower5, m5Bars, asOf30)) if (p5.key) strictKeys.add(p5.key);
          }
        }
        record.supporting5Keys = [...strictKeys];
        record.status5 = statuses.includes('支持') ? '支持' : statuses.length && statuses.every(s => s === '数据不足' || s === '等待') ? '数据不足' : '不支持';
      }
    }
  }
  audit.elapsedMs = Math.round(performance.now() - started);
  return { audit, records };
}

function main() {
  const cli = args();
  const endDate = cli.get('end') ?? '2026-11-04';
  const output = resolve(cli.get('output') ?? '报告/缠论策略回测_20261115');
  const dailyDir = join(output, 'cache', 'daily');
  const withFive = cli.get('five') !== '0';
  const cacheDir = join(output, 'cache', withFive ? 'confluence' : 'confluence30');
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
  const fresh = cli.get('fresh') === '1';
  const allRecords: ConfluenceRecord[] = [];
  const audits: StockAudit[] = [];
  let index = 0;
  for (const meta of universe) {
    const dailyPath = join(dailyDir, `${meta.code.replace('.', '_')}.json`);
    if (!existsSync(dailyPath)) continue;
    const daily = JSON.parse(readFileSync(dailyPath, 'utf8')) as DailyCache;
    if (daily.configId !== ENGINE_CONFIG_ID || daily.endDate !== endDate) throw new Error(`日线检查点口径不一致：${meta.code}`);
    const path = join(cacheDir, `${meta.code.replace('.', '_')}.json`);
    let payload: Payload | null = null;
    if (!fresh && existsSync(path)) {
      try {
        const cached = JSON.parse(readFileSync(path, 'utf8')) as Payload;
        if (cached.version === CACHE_VERSION && cached.configId === ENGINE_CONFIG_ID && cached.endDate === endDate) payload = cached;
      } catch { /* 重算损坏检查点 */ }
    }
    if (!payload) {
      try {
        const evaluated = evaluateStock(db, meta, daily, endDate, withFive);
        payload = { version: CACHE_VERSION, configId: ENGINE_CONFIG_ID, endDate, ...evaluated };
      } catch (error) {
        payload = { version: CACHE_VERSION, configId: ENGINE_CONFIG_ID, endDate,
          audit: { code: meta.code, candidates: 0, mapped: 0, m30Bars: 0, m30Points: 0, m5Bars: 0, m5Points: 0, elapsedMs: 0, error: String(error instanceof Error ? error.message : error) }, records: [] };
      }
      atomicJson(path, payload);
    }
    allRecords.push(...payload.records);
    audits.push(payload.audit);
    index++;
    console.log(`[共振] ${index}/${universe.length} ${meta.code} 候选${payload.audit.candidates} 30分支持${payload.records.filter(r => r.status30 === '支持').length} 5分支持${payload.records.filter(r => r.status5 === '支持').length} 30分柱${payload.audit.m30Bars} 5分柱${payload.audit.m5Bars} ${payload.audit.elapsedMs}ms${payload.audit.error ? ` 错误:${payload.audit.error}` : ''}`);
  }
  if (cli.get('cache-only') !== '1') {
    const name = cli.get('summary') === '1' ? (withFive ? '分钟链式共振汇总.json' : '分钟30分钟共振汇总.json') : codes || limit ? '分钟共振试点.json' : withFive ? '分钟链式共振汇总.json' : '分钟30分钟共振汇总.json';
    atomicJson(join(output, name), { createdAt: new Date().toISOString(), startDate: START_DATE, endDate, engineConfigId: ENGINE_CONFIG_ID, withFive, audits, records: allRecords });
  }
  console.log(`[完成] 候选${allRecords.length}，30分支持${allRecords.filter(r => r.status30 === '支持').length}，5分支持${allRecords.filter(r => r.status5 === '支持').length}`);
  db.close();
}

main();
