// 单因素账户对照与信号路径诊断。只在同一原始候选上改变一个过滤器或离场计划。
import { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync, readdirSync, writeFileSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CHAN_PRESETS, configId } from '../../packages/engine/src/index.ts';
import {
  DEFAULT_BACKTEST_CONFIG, EXIT_RULES, performanceMetrics, simulatePortfolio,
  type BacktestConfig, type EntryCandidate, type ExitRule, type PointClass, type ScenarioResult, type StockSeries,
} from './core.ts';
import { LazyMarket, loadCalendar, loadStock, loadUniverse, scenarioSummary, type StockMeta } from './run_daily.ts';
import type { ExplorationRecord, ReturnStates, TrendStates } from './run_explore.ts';
import { movingTrendState, returnLookback } from './explore.ts';
import {
  candidateKey, EXIT_EXPERIMENTS, EXIT_LABEL, filterExperiments,
  type ExperimentContext, type FilterExperiment,
} from './explore_experiments.ts';

const DB_PATH = process.env.CHAN_DB_PATH ?? '/Users/admin/WorkSpace/baostock_data/data/baostock.db';
const ENGINE_CONFIG_ID = configId(CHAN_PRESETS.originalDefault);
type Summary = Record<string, string | number | null> & { 实验ID: string; 买点类别: PointClass; 总收益率: number };
interface PathMetric {
  code: string;
  klass: PointClass;
  pointKey: string;
  structureDate: string;
  signalDate: string;
  entryDate: string;
  exit20Date: string | null;
  return20: number | null;
  mfe20: number | null;
  mae20: number | null;
  exit60Date: string | null;
  return60: number | null;
  mfe60: number | null;
  mae60: number | null;
}
interface DiagnosticRow {
  实验ID: string; 实验类别: string; 实验名称: string; 买点类别: PointClass; 分组: string;
  候选数: number; 有效20日样本: number; '20日平均收益': number | null; '20日中位收益': number | null;
  '20日MFE中位数': number | null; '20日MAE中位数': number | null;
  有效60日样本: number; '60日平均收益': number | null; '60日中位收益': number | null;
  '60日MFE中位数': number | null; '60日MAE中位数': number | null;
}
interface AccountArtifacts { summaries: Summary[]; yearly: Record<string, string | number>[]; trades: Record<string, string | number | null>[]; opens: Record<string, string | number | null>[]; maxReconcileError: number }

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
function csvCell(value: unknown): string {
  if (value == null) return '';
  const text = typeof value === 'number' ? Number.isFinite(value) ? String(value) : '' : String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
function writeCsv<T extends object>(path: string, rows: readonly T[]) {
  if (!rows.length) { writeFileSync(path, '\ufeff'); return; }
  const headers = [...new Set(rows.flatMap(row => Object.keys(row)))];
  writeFileSync(path, `\ufeff${headers.map(csvCell).join(',')}\n${rows.map(row => headers.map(h => csvCell((row as Record<string, unknown>)[h])).join(',')).join('\n')}\n`);
}
function median(values: readonly number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}
function mean(values: readonly number[]): number | null {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}
function valid(values: readonly (number | null)[]): number[] {
  return values.filter((v): v is number => v != null && Number.isFinite(v));
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
export function pathHorizon(stock: StockSeries, candidate: EntryCandidate, horizonDate: string | undefined) {
  if (!horizonDate) return { exitDate: null, returnValue: null, mfe: null, mae: null };
  const entryIndex = barIndexAtOrAfter(stock, candidate.entryDate);
  const entry = stock.bars[entryIndex];
  if (!entry || entry.date !== candidate.entryDate || entry.hfqOpen == null || !(entry.hfqOpen > 0)) return { exitDate: null, returnValue: null, mfe: null, mae: null };
  let exitIndex = barIndexAtOrAfter(stock, horizonDate);
  while (stock.bars[exitIndex] && (stock.bars[exitIndex]!.tradeStatus !== 1 || !(stock.bars[exitIndex]!.hfqOpen! > 0))) exitIndex++;
  const exit = stock.bars[exitIndex];
  const exitOpen = exit?.hfqOpen;
  if (!exit || exitOpen == null || !(exitOpen > 0)) return { exitDate: null, returnValue: null, mfe: null, mae: null };
  let high = Number.NEGATIVE_INFINITY;
  let low = Number.POSITIVE_INFINITY;
  for (let i = entryIndex; i <= exitIndex; i++) {
    const bar = stock.bars[i]!;
    if (bar.tradeStatus !== 1) continue;
    if (bar.hfqHigh != null && bar.hfqHigh > 0) high = Math.max(high, bar.hfqHigh);
    if (bar.hfqLow != null && bar.hfqLow > 0) low = Math.min(low, bar.hfqLow);
  }
  return {
    exitDate: exit.date,
    returnValue: exitOpen / entry.hfqOpen - 1,
    mfe: Number.isFinite(high) ? high / entry.hfqOpen - 1 : null,
    mae: Number.isFinite(low) ? low / entry.hfqOpen - 1 : null,
  };
}
function pathMetrics(db: DatabaseSync, metas: ReadonlyMap<string, StockMeta>, candidates: readonly EntryCandidate[], calendar: readonly string[], cfg: BacktestConfig): PathMetric[] {
  const calendarIndex = new Map(calendar.map((date, index) => [date, index] as const));
  const byCode = new Map<string, EntryCandidate[]>();
  for (const candidate of candidates) {
    const list = byCode.get(candidate.code) ?? [];
    list.push(candidate);
    byCode.set(candidate.code, list);
  }
  const out: PathMetric[] = [];
  let done = 0;
  for (const [code, items] of byCode) {
    const meta = metas.get(code);
    if (!meta) continue;
    const stock = loadStock(db, meta, cfg.endDate, cfg.startDate);
    for (const candidate of items) {
      const entryIndex = calendarIndex.get(candidate.entryDate);
      const h20 = pathHorizon(stock, candidate, entryIndex == null ? undefined : calendar[entryIndex + 20]);
      const h60 = pathHorizon(stock, candidate, entryIndex == null ? undefined : calendar[entryIndex + 60]);
      out.push({ code, klass: candidate.klass, pointKey: candidate.pointKey, structureDate: candidate.structureDate, signalDate: candidate.signalDate, entryDate: candidate.entryDate,
        exit20Date: h20.exitDate, return20: h20.returnValue, mfe20: h20.mfe, mae20: h20.mae,
        exit60Date: h60.exitDate, return60: h60.returnValue, mfe60: h60.mfe, mae60: h60.mae });
    }
    done++;
    if (done % 100 === 0 || done === byCode.size) console.log(`[路径诊断] ${done}/${byCode.size} 股票，样本${out.length}`);
  }
  return out;
}
function diagnosticRow(experiment: { id: string; family: string; label: string }, klass: PointClass, group: string, items: readonly PathMetric[]): DiagnosticRow {
  const r20 = valid(items.map(x => x.return20));
  const r60 = valid(items.map(x => x.return60));
  return {
    实验ID: experiment.id, 实验类别: experiment.family, 实验名称: experiment.label, 买点类别: klass, 分组: group, 候选数: items.length,
    有效20日样本: r20.length, '20日平均收益': mean(r20), '20日中位收益': median(r20),
    '20日MFE中位数': median(valid(items.map(x => x.mfe20))), '20日MAE中位数': median(valid(items.map(x => x.mae20))),
    有效60日样本: r60.length, '60日平均收益': mean(r60), '60日中位收益': median(r60),
    '60日MFE中位数': median(valid(items.map(x => x.mfe60))), '60日MAE中位数': median(valid(items.map(x => x.mae60))),
  };
}
function diagnostics(experiments: readonly FilterExperiment[], context: ExperimentContext, candidates: readonly EntryCandidate[], records: ReadonlyMap<string, ExplorationRecord>, paths: readonly PathMetric[]): DiagnosticRow[] {
  const pathByKey = new Map(paths.map(p => [candidateKey(p), p] as const));
  const out: DiagnosticRow[] = [];
  for (const experiment of experiments.filter(e => e.id !== 'baseline')) {
    for (const klass of [1, 2, 3] as PointClass[]) {
      const groups = new Map<string, PathMetric[]>([['通过', []], ['未通过', []], ['数据不足', []]]);
      for (const candidate of candidates.filter(c => c.klass === klass)) {
        const result = experiment.test(records.get(candidateKey(candidate)), candidate, context);
        const group = result == null ? '数据不足' : result ? '通过' : '未通过';
        const path = pathByKey.get(candidateKey(candidate));
        if (path) groups.get(group)!.push(path);
      }
      for (const [group, items] of groups) out.push(diagnosticRow(experiment, klass, group, items));
    }
  }
  const volumeExperiment = { id: 'volume-quantile', family: '结构段量能分位', label: '结构段量能比率四分位' };
  for (const klass of [1, 2, 3] as PointClass[]) {
    for (const field of ['volumePrimary', 'volumeSecondary'] as const) {
      const available = candidates.filter(c => c.klass === klass && records.get(candidateKey(c))?.[field] != null);
      const values = available.map(c => records.get(candidateKey(c))![field]!).sort((a, b) => a - b);
      if (values.length < 4) continue;
      const thresholds = [0.25, 0.5, 0.75].map(q => values[Math.min(values.length - 1, Math.floor(q * values.length))]!);
      for (let quartile = 0; quartile < 4; quartile++) {
        const selected = available.filter(c => {
          const value = records.get(candidateKey(c))![field]!;
          const index = thresholds.filter(t => value > t).length;
          return index === quartile;
        }).map(c => pathByKey.get(candidateKey(c))).filter((p): p is PathMetric => !!p);
        const range = `${field === 'volumePrimary' ? '主量能比率' : '副量能比率'}Q${quartile + 1}（阈值${thresholds.map(v => v.toFixed(4)).join('/')}）`;
        out.push(diagnosticRow(volumeExperiment, klass, range, selected));
      }
    }
  }
  return out;
}
function periodReturn(result: ScenarioResult, start: string, end: string): number | null {
  const points = result.equity.filter(p => p.date <= end);
  if (!points.length || points.at(-1)!.date < start) return null;
  const before = result.equity.filter(p => p.date < start).at(-1)?.equity ?? result.initialCapital;
  const last = points.at(-1)!.equity;
  return before > 0 ? last / before - 1 : null;
}
function summarize(result: ScenarioResult, experiment: FilterExperiment | { id: string; family: string; label: string; description: string }, exitLabel: string,
  candidateCount: number, insufficient: number): { summary: Summary; yearly: Record<string, string | number>[] } {
  const base = scenarioSummary(result);
  const realized = result.trades.reduce((sum, t) => sum + t.realizedPnl, 0);
  const unrealized = result.openPositions.reduce((sum, p) => sum + p.unrealizedPnl, 0);
  const utilization = mean(result.equity.map(p => p.equity > 0 ? p.marketValue / p.equity : 0));
  const summary: Summary = {
    实验ID: experiment.id, 实验类别: experiment.family, 实验名称: experiment.label, 实验说明: experiment.description,
    ...base, 离场规则: exitLabel, 候选信号数: candidateCount, 数据不足或缺失数: insufficient,
    实际入场笔数: result.trades.length + result.openPositions.length, 已实现盈亏: realized, 未实现盈亏: unrealized,
    平均资金利用率: utilization,
    '2010至2016权益收益': periodReturn(result, '2010-01-01', '2016-12-31'),
    '2017至2021权益收益': periodReturn(result, '2017-01-01', '2021-12-31'),
    '2022至2026权益收益': periodReturn(result, '2022-01-01', '2026-11-04'),
  };
  const yearly: Record<string, string | number>[] = [];
  const years = [...new Set(result.equity.map(p => p.date.slice(0, 4)))].sort();
  for (const year of years) {
    const points = result.equity.filter(p => p.date.startsWith(year));
    const previous = result.equity.filter(p => p.date < `${year}-01-01`).at(-1)?.equity ?? result.initialCapital;
    const last = points.at(-1)?.equity;
    if (last != null && previous > 0) yearly.push({ 实验ID: experiment.id, 实验类别: experiment.family, 实验名称: experiment.label,
      买点类别: result.klass, 离场规则: exitLabel, 年份: Number(year), 年度收益率: last / previous - 1, 年末权益: last });
  }
  return { summary, yearly };
}
function reconcileError(result: ScenarioResult): number {
  const expected = result.initialCapital + result.trades.reduce((sum, t) => sum + t.realizedPnl, 0)
    + result.openPositions.reduce((sum, p) => sum + p.unrealizedPnl, 0);
  return Math.abs(result.finalEquity - expected);
}

function main() {
  const cli = args();
  const base = resolve(cli.get('base') ?? '报告/缠论策略回测_20261115');
  const output = resolve(cli.get('output') ?? '报告/缠论策略探索_20261115');
  const cfg = { ...DEFAULT_BACKTEST_CONFIG };
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  db.exec('PRAGMA busy_timeout=5000;');
  const universe = loadUniverse(db);
  const metas = new Map(universe.map(m => [m.code, m] as const));
  const calendar = loadCalendar(db, cfg.startDate, cfg.endDate);
  const candidates: EntryCandidate[] = [];
  const records = new Map<string, ExplorationRecord>();
  const featureAudits: Record<string, unknown>[] = [];
  for (const meta of universe) {
    const suffix = `${meta.code.replace('.', '_')}.json`;
    const daily = JSON.parse(readFileSync(join(base, 'cache', 'daily', suffix), 'utf8')) as { candidates: EntryCandidate[]; configId: string; endDate: string };
    if (daily.configId !== ENGINE_CONFIG_ID || daily.endDate !== cfg.endDate) throw new Error(`日线口径不一致：${meta.code}`);
    candidates.push(...daily.candidates);
    const featurePath = join(output, 'cache', 'features', suffix);
    if (!existsSync(featurePath)) throw new Error(`缺少探索特征：${meta.code}`);
    const feature = JSON.parse(readFileSync(featurePath, 'utf8')) as { version: number; configId: string; endDate: string; audit: Record<string, unknown>; records: ExplorationRecord[] };
    if (feature.version !== 4 || feature.configId !== ENGINE_CONFIG_ID || feature.endDate !== cfg.endDate) throw new Error(`探索特征口径不一致：${meta.code}`);
    if (feature.audit.error) throw new Error(`探索特征错误：${meta.code} ${String(feature.audit.error)}`);
    if (feature.records.length !== daily.candidates.length) throw new Error(`候选与特征数量不一致：${meta.code}`);
    for (const record of feature.records) {
      const key = candidateKey(record);
      if (records.has(key)) throw new Error(`重复特征键：${key}`);
      records.set(key, record);
    }
    featureAudits.push(feature.audit);
  }
  candidates.sort((a, b) => a.entryDate.localeCompare(b.entryDate) || b.avgAmount20 - a.avgAmount20 || a.code.localeCompare(b.code) || a.pointKey.localeCompare(b.pointKey));
  if (candidates.length !== records.size) throw new Error(`候选${candidates.length}与特征${records.size}不一致`);
  console.log(`[装载] 候选${candidates.length}，特征${records.size}，股票${universe.length}`);

  const indexRows = db.prepare('SELECT date,close FROM index_kline_d WHERE code=? AND date<=? ORDER BY date').all('sh.000001', cfg.endDate) as unknown as { date: string; close: number }[];
  const indexValues = indexRows.map(r => r.close);
  const indexTrendByDate = new Map<string, TrendStates>();
  const indexReturnByDate = new Map<string, ReturnStates>();
  indexRows.forEach((row, index) => {
    indexTrendByDate.set(row.date, Object.fromEntries([20, 60, 120, 250].map(w => [w, movingTrendState(indexValues, index, w)])));
    indexReturnByDate.set(row.date, Object.fromEntries([20, 60, 120].map(w => [w, returnLookback(indexValues, index, w)])));
  });
  const atrByDate = new Map<string, Map<string, number>>();
  for (const candidate of candidates) {
    const value = records.get(candidateKey(candidate))?.atr14Pct;
    if (value == null) continue;
    const byStock = atrByDate.get(candidate.signalDate) ?? new Map<string, number>();
    byStock.set(candidate.code, value);
    atrByDate.set(candidate.signalDate, byStock);
  }
  const atrMedianByDate = new Map([...atrByDate].map(([date, values]) => [date, median([...values.values()])] as const));
  const context: ExperimentContext = { indexTrendByDate, indexReturnByDate, atrMedianByDate };
  const experiments = filterExperiments();
  const paths = pathMetrics(db, metas, candidates, calendar, cfg);
  const diagnosticRows = diagnostics(experiments, context, candidates, records, paths);
  const artifacts: AccountArtifacts = { summaries: [], yearly: [], trades: [], opens: [], maxReconcileError: 0 };
  const market = new LazyMarket(db, metas, cfg);
  const collect = (result: ScenarioResult, experiment: FilterExperiment | { id: string; family: string; label: string; description: string }, exitLabel: string, count: number, insufficient: number) => {
    const { summary, yearly } = summarize(result, experiment, exitLabel, count, insufficient);
    artifacts.summaries.push(summary);
    artifacts.yearly.push(...yearly);
    artifacts.maxReconcileError = Math.max(artifacts.maxReconcileError, reconcileError(result));
    for (const trade of result.trades) artifacts.trades.push({ 实验ID: experiment.id, 实验类别: experiment.family, 实验名称: experiment.label, 离场规则: exitLabel,
      股票代码: trade.code, 股票名称: trade.name, 买点类别: trade.klass, 结构日期: trade.structureDate, 信号日期: trade.signalDate,
      入场日期: trade.entryDate, 入场不复权价: trade.entryRawPrice, 入場后复权价: trade.entryHfqPrice, 数量: trade.quantity,
      出场日期: trade.exitDate, 出场不复权价: trade.exitRawPrice, 出场后复权价: trade.exitHfqPrice, 离场原因: trade.exitReason,
      已实现盈亏: trade.realizedPnl, 已实现收益率: trade.realizedReturn, 持有自然日: trade.holdingCalendarDays });
    for (const p of result.openPositions) artifacts.opens.push({ 实验ID: experiment.id, 实验类别: experiment.family, 实验名称: experiment.label, 离场规则: exitLabel,
      股票代码: p.code, 股票名称: p.name, 买点类别: p.klass, 结构日期: p.structureDate, 信号日期: p.signalDate, 入场日期: p.entryDate,
      数量: p.quantity, 最后日期: p.lastDate, 期末市值: p.marketValue, 未实现盈亏: p.unrealizedPnl, 计划离场日期: p.plannedExitDate, 离场原因: p.exitReason });
  };
  for (const experiment of experiments) {
    const started = performance.now();
    for (const klass of [1, 2, 3] as PointClass[]) {
      const classCandidates = candidates.filter(c => c.klass === klass);
      const tested = classCandidates.map(c => ({ candidate: c, pass: experiment.test(records.get(candidateKey(c)), c, context) }));
      const selected = tested.filter(x => x.pass === true).map(x => x.candidate);
      const insufficient = tested.filter(x => x.pass == null).length;
      for (const exitRule of EXIT_RULES) {
        const result = simulatePortfolio(klass, exitRule, market, selected, calendar, cfg);
        collect(result, experiment, exitRule, selected.length, insufficient);
      }
    }
    console.log(`[账户] ${experiment.id} 用时${Math.round(performance.now() - started)}ms`);
  }
  const requiredPlans = [...EXIT_EXPERIMENTS];
  const exitCandidates = candidates.filter(c => {
    const record = records.get(candidateKey(c));
    return record && requiredPlans.every(id => record.exitPlans[id]?.ready === true);
  });
  console.log(`[离场共同样本] ${exitCandidates.length}/${candidates.length}`);
  for (const klass of [1, 2, 3] as PointClass[]) {
    const selected = exitCandidates.filter(c => c.klass === klass);
    const insufficient = candidates.filter(c => c.klass === klass).length - selected.length;
    for (const exitRule of EXIT_RULES) {
      const experiment = { id: `exit-original-${exitRule}`, family: '离场共同样本', label: EXIT_LABEL[exitRule]!, description: '仅使用所有新离场计划均可计算的候选，保证离场比较入场一致。' };
      collect(simulatePortfolio(klass, exitRule, market, selected, calendar, cfg), experiment, EXIT_LABEL[exitRule]!, selected.length, insufficient);
    }
    for (const id of EXIT_EXPERIMENTS) {
      const experiment = { id: `exit-${id}`, family: '离场共同样本', label: EXIT_LABEL[id]!, description: '相同候选与账户，只替换预计算离场计划；触发均在收盘后，下一可交易日开盘执行。' };
      const result = simulatePortfolio(klass, 'hold-20', market, selected, calendar, cfg, { exitPlan: candidate => records.get(candidateKey(candidate))?.exitPlans[id] });
      collect(result, experiment, EXIT_LABEL[id]!, selected.length, insufficient);
    }
  }
  const audit = {
    createdAt: new Date().toISOString(), dataSource: DB_PATH, config: cfg, engineConfigId: ENGINE_CONFIG_ID,
    universeCount: universe.length, candidateCount: candidates.length, featureCount: records.size,
    filterExperimentCount: experiments.length, accountScenarioCount: artifacts.summaries.length,
    volumeAvailable: [...records.values()].filter(r => r.volumePass != null).length,
    weeklyPointSupport: [...records.values()].filter(r => r.weeklyPoint.status === '支持').length,
    monthlyPointSupport: [...records.values()].filter(r => r.monthlyPoint.status === '支持').length,
    exitCommonCandidates: exitCandidates.length, maxReconcileError: artifacts.maxReconcileError,
    featureAudits,
  };
  atomicJson(join(output, '探索账户结果.json'), { audit, experiments: experiments.map(({ test: _test, ...e }) => e), summaries: artifacts.summaries, diagnostics: diagnosticRows });
  writeCsv(join(output, '探索场景汇总.csv'), artifacts.summaries);
  writeCsv(join(output, '探索分年度表现.csv'), artifacts.yearly);
  writeCsv(join(output, '探索交易明细.csv'), artifacts.trades);
  writeCsv(join(output, '探索期末持仓.csv'), artifacts.opens);
  writeCsv(join(output, '信号路径诊断.csv'), paths.map(p => ({ 股票代码: p.code, 买点类别: p.klass, 结构日期: p.structureDate, 信号日期: p.signalDate, 入场日期: p.entryDate,
    离场20日期: p.exit20Date, 后复权20日收益_未扣费: p.return20, '20日最大有利变动': p.mfe20, '20日最大不利变动': p.mae20,
    离场60日期: p.exit60Date, 后复权60日收益_未扣费: p.return60, '60日最大有利变动': p.mfe60, '60日最大不利变动': p.mae60 })));
  writeCsv(join(output, '诊断分组.csv'), diagnosticRows);
  atomicJson(join(output, '探索审计.json'), audit);
  console.log(`[完成] 场景${artifacts.summaries.length}，诊断${diagnosticRows.length}，最大对账差${artifacts.maxReconcileError}`);
  db.close();
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
