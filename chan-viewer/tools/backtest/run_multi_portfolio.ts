// 将同一批2020年以来的日线候选按无过滤/30分钟支持/30+5分钟支持过滤，重放账户场景。
import { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { LazyMarket, loadCalendar, loadUniverse, scenarioSummary } from './run_daily.ts';
import { EXIT_RULES, simulatePortfolio, type BacktestConfig, type EntryCandidate, type PointClass, type ScenarioResult } from './core.ts';

interface DailyRaw { config: BacktestConfig; engineConfigId: string; candidates: EntryCandidate[] }
interface ConfluenceRecord { pointKey: string; status30: string; status5: string }
interface ConfluenceFile { records: ConfluenceRecord[] }
type Filter = '无共振过滤' | '日线+30分钟' | '日线+30分钟+5分钟';

function atomicJson(path: string, value: unknown) {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(value));
  renameSync(tmp, path);
}

function main() {
  const output = resolve(process.argv.find(a => a.startsWith('--output='))?.split('=')[1] ?? '报告/缠论策略回测_20261115');
  const daily = JSON.parse(readFileSync(join(output, '日线回测原始结果.json'), 'utf8')) as DailyRaw;
  const file30 = join(output, '分钟30分钟共振汇总.json');
  if (!existsSync(file30)) throw new Error('缺少分钟30分钟共振汇总.json');
  const confluence30 = JSON.parse(readFileSync(file30, 'utf8')) as ConfluenceFile;
  const file5 = join(output, '分钟链式共振汇总.json');
  const confluence5 = existsSync(file5) ? JSON.parse(readFileSync(file5, 'utf8')) as ConfluenceFile : null;
  const map30 = new Map(confluence30.records.map(r => [r.pointKey, r] as const));
  const map5 = new Map((confluence5?.records ?? []).map(r => [r.pointKey, r] as const));
  const startDate = '2020-01-01';
  const cfg: BacktestConfig = { ...daily.config, startDate };
  const recent = daily.candidates.filter(c => c.signalDate >= startDate && c.signalDate <= cfg.endDate);
  const filters: { name: Filter; candidates: EntryCandidate[]; missing: number }[] = [
    { name: '无共振过滤', candidates: recent, missing: 0 },
    { name: '日线+30分钟', candidates: recent.filter(c => map30.get(c.pointKey)?.status30 === '支持'), missing: recent.filter(c => !map30.has(c.pointKey)).length },
  ];
  if (confluence5) filters.push({
    name: '日线+30分钟+5分钟',
    candidates: recent.filter(c => map30.get(c.pointKey)?.status30 === '支持' && map5.get(c.pointKey)?.status5 === '支持'),
    missing: recent.filter(c => map30.get(c.pointKey)?.status30 === '支持' && !map5.has(c.pointKey)).length,
  });
  const db = new DatabaseSync(process.env.CHAN_DB_PATH ?? '/Users/admin/WorkSpace/baostock_data/data/baostock.db', { readOnly: true });
  db.exec('PRAGMA busy_timeout=5000;');
  const universe = loadUniverse(db);
  const metas = new Map(universe.map(m => [m.code, m] as const));
  const calendar = loadCalendar(db, startDate, cfg.endDate);
  const market = new LazyMarket(db, metas, cfg);
  const results: { filter: Filter; result: ScenarioResult }[] = [];
  for (const filter of filters) {
    console.log(`[多周期账户] ${filter.name} 候选${filter.candidates.length} 缺少判定${filter.missing}`);
    for (const klass of [1, 2, 3] as PointClass[]) {
      for (const exitRule of EXIT_RULES) {
        const result = simulatePortfolio(klass, exitRule, market, filter.candidates, calendar, cfg);
        results.push({ filter: filter.name, result });
        console.log(`[多周期账户] ${filter.name} ${klass}买 ${exitRule} 期末${result.finalEquity.toFixed(2)} 平仓${result.trades.length} 持仓${result.openPositions.length}`);
      }
    }
  }
  atomicJson(join(output, '多周期账户回测原始结果.json'), {
    createdAt: new Date().toISOString(), config: cfg, engineConfigId: daily.engineConfigId, startDate, endDate: cfg.endDate,
    filters: filters.map(f => ({ name: f.name, candidates: f.candidates.length, missingDecisions: f.missing, pointKeys: f.candidates.map(c => c.pointKey) })),
    confluence30Status: confluence30.records.reduce<Record<string, number>>((counts, r) => { counts[r.status30] = (counts[r.status30] ?? 0) + 1; return counts; }, {}),
    results: results.map(x => ({ filter: x.filter, ...x.result })),
    summaries: results.map(x => ({ 共振过滤: x.filter, ...scenarioSummary(x.result) })),
  });
  db.close();
  console.log(`[完成] ${join(output, '多周期账户回测原始结果.json')}`);
}

main();
