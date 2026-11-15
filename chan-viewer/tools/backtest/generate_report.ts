// 生成中文CSV、审计JSON和单文件HTML报告。输入为 run_daily/run_multi_portfolio 的原始结果。
import { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { performanceMetrics, type BacktestConfig, type EntryCandidate, type PointSignal, type ScenarioResult } from './core.ts';

interface DailyRaw {
  createdAt: string; dataSource: string; config: BacktestConfig; engineConfigId: string; universe: string[];
  audits: { confirmationIndexMismatches: number }[]; signals: PointSignal[]; candidates: EntryCandidate[]; results: ScenarioResult[];
}
interface MultiResult extends ScenarioResult { filter: string }
interface MultiRaw { config: BacktestConfig; engineConfigId: string; filters: { name: string; candidates: number; missingDecisions: number; pointKeys: string[] }[]; results: MultiResult[]; confluence30Status: Record<string, number> }
interface Row { sample: string; filter: string; result: ScenarioResult; candidates: number }
interface Summary extends ReturnType<typeof performanceMetrics> {
  sample: string; filter: string; klass: number; exitRule: string; candidates: number; entries: number; fillRate: number;
  initialCapital: number; finalEquity: number; realizedPnl: number; unrealizedPnl: number; fees: number; exposure: number; daysInvested: number;
  rejected: Record<string, number>; openPositions: number; delistingWriteOffs: number; reconciliation: number;
}

const EXIT_LABEL: Record<string, string> = { 'any-sell': '任一确认卖点', 'same-class-sell': '同类确认卖点', 'hold-20': '持有20个市场交易日', 'hold-60': '持有60个市场交易日' };
const output = resolve(process.argv.find(a => a.startsWith('--output='))?.split('=')[1] ?? '报告/缠论策略回测_20261115');
const daily = JSON.parse(readFileSync(join(output, '日线回测原始结果.json'), 'utf8')) as DailyRaw;
const multiPath = join(output, '多周期账户回测原始结果.json');
const multi = existsSync(multiPath) ? JSON.parse(readFileSync(multiPath, 'utf8')) as MultiRaw : null;
const rows: Row[] = daily.results.map(result => ({ sample: '2010—2026纯日线', filter: '无共振过滤', result, candidates: daily.candidates.filter(c => c.klass === result.klass).length }));
if (multi) for (const result of multi.results) {
  const filter = multi.filters.find(f => f.name === result.filter);
  const keys = new Set(filter?.pointKeys ?? []);
  rows.push({ sample: '2020—2026同期对照', filter: result.filter, result, candidates: daily.candidates.filter(c => c.signalDate >= '2020-01-01' && c.klass === result.klass && (result.filter === '无共振过滤' || keys.has(c.pointKey))).length });
}

function rejectedCounts(result: ScenarioResult): Record<string, number> {
  return result.rejected.reduce<Record<string, number>>((counts, r) => { counts[r.reason] = (counts[r.reason] ?? 0) + 1; return counts; }, {});
}
function summarize(row: Row): Summary {
  const { result } = row;
  const metrics = performanceMetrics(result);
  const realizedPnl = result.trades.reduce((sum, t) => sum + t.realizedPnl, 0);
  const unrealizedPnl = result.openPositions.reduce((sum, p) => sum + p.unrealizedPnl, 0);
  const entries = result.trades.length + result.openPositions.length;
  return {
    sample: row.sample, filter: row.filter, klass: result.klass, exitRule: result.exitRule, candidates: row.candidates,
    entries, fillRate: row.candidates ? entries / row.candidates : 0, initialCapital: result.initialCapital, finalEquity: result.finalEquity, realizedPnl, unrealizedPnl,
    fees: result.totalCommission + result.totalSlippage + result.totalStampDuty,
    exposure: result.equity.length ? result.equity.reduce((sum, p) => sum + (p.equity > 0 ? p.marketValue / p.equity : 0), 0) / result.equity.length : 0,
    daysInvested: result.equity.length ? result.equity.filter(p => p.positionCount > 0).length / result.equity.length : 0,
    rejected: rejectedCounts(result), openPositions: result.openPositions.length, delistingWriteOffs: result.delistingWriteOffs,
    reconciliation: result.finalEquity - result.initialCapital - realizedPnl - unrealizedPnl, ...metrics,
  };
}
const summaries = rows.map(summarize);
const summaryKey = (s: { sample: string; filter: string; klass: number; exitRule: string }) => `${s.sample}|${s.filter}|${s.klass}|${s.exitRule}`;
const rowByKey = new Map(rows.map(r => [summaryKey({ sample: r.sample, filter: r.filter, klass: r.result.klass, exitRule: r.result.exitRule }), r] as const));

function round(value: number | null, digits = 4): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.sign(value) * Math.round((Math.abs(value) + Number.EPSILON) * factor) / factor;
}
function csvEscape(value: unknown): string {
  if (value == null) return '';
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
function writeCsv(name: string, headers: string[], records: readonly unknown[][]) {
  writeFileSync(join(output, name), '﻿' + [headers, ...records].map(r => r.map(csvEscape).join(',')).join('\n') + '\n');
}
const pct = (v: number | null, digits = 2) => v == null || !Number.isFinite(v) ? '—' : `${(v * 100).toFixed(digits)}%`;
const money = (v: number) => `${v.toFixed(2)}元`;
const num = (v: number | null, digits = 2) => v == null || !Number.isFinite(v) ? '—' : v.toFixed(digits);

writeCsv('账户场景汇总.csv',
  ['样本', '共振过滤', '买点类别', '离场规则', '买入候选数', '实际入场数', '成交率(%)', '初始资金(元)', '期末权益(元)', '总收益率(%)', '年化收益率(%)', '最大回撤(%)', '夏普比率', '卡玛比率', '已平仓交易数', '胜率(%)', '盈亏比', '盈利因子', '已实现盈亏(元)', '未实现盈亏(元)', '期末持仓数', '平均仓位(%)', '有持仓交易日占比(%)', '佣金滑点印花税(元)', '平均持有自然日', '无空仓未成交数', '资金不足一手未成交数', '退市核销笔数', '账务核对差额(元)'],
  summaries.map(s => [s.sample, s.filter, `${s.klass}类买点`, EXIT_LABEL[s.exitRule], s.candidates, s.entries, round(s.fillRate * 100), s.initialCapital, round(s.finalEquity), round(s.totalReturn * 100), round(s.annualizedReturn * 100), round(s.maxDrawdown * 100), round(s.sharpe), round(s.calmar), s.closedTrades, s.winRate == null ? null : round(s.winRate * 100), round(s.payoffRatio), round(s.profitFactor), round(s.realizedPnl), round(s.unrealizedPnl), s.openPositions, round(s.exposure * 100), round(s.daysInvested * 100), round(s.fees), round(s.averageHoldingCalendarDays), s.rejected['无空仓'] ?? 0, s.rejected['资金不足一手'] ?? 0, s.delistingWriteOffs, round(s.reconciliation, 8)]));

const tradeRows = rows.flatMap(({ sample, filter, result }) => result.trades.map(t => [sample, filter, `${result.klass}类买点`, EXIT_LABEL[result.exitRule], t.code, t.name, t.structureDate, t.signalDate, t.entryDate, t.exitDate, t.exitReason, t.quantity, t.entryRawPrice, t.entryHfqPrice, t.exitRawPrice, t.exitHfqPrice, t.entryGross, t.entryCommission, t.entrySlippage, t.exitGross, t.exitCommission, t.exitSlippage, t.exitStampDuty, t.realizedPnl, t.realizedReturn * 100, t.holdingCalendarDays, t.pointKey]));
writeCsv('交易明细.csv', ['样本', '共振过滤', '买点类别', '离场场景', '证券代码', '证券名称', '结构位置日', '买点确认日', '买入日', '卖出日', '卖出原因', '买入股数', '买入不复权价', '买入后复权价', '卖出不复权价', '卖出后复权价', '买入成交额', '买入佣金', '买入滑点', '卖出等价总额', '卖出佣金', '卖出滑点', '卖出印花税', '已实现盈亏(元)', '已实现收益率(%)', '持有自然日', '信号来源键'], tradeRows);
const openRows = rows.flatMap(({ sample, filter, result }) => result.openPositions.map(p => [sample, filter, `${result.klass}类买点`, EXIT_LABEL[result.exitRule], p.code, p.name, p.signalDate, p.entryDate, p.quantity, p.entryRawPrice, p.entryTotalCost, p.lastDate, p.marketValue, p.unrealizedPnl, p.plannedExitDate, p.exitReason, p.pointKey]));
writeCsv('期末持仓.csv', ['样本', '共振过滤', '买点类别', '离场场景', '证券代码', '证券名称', '买点确认日', '买入日', '买入股数', '买入不复权价', '买入总成本', '最后计价日', '期末市值', '未实现盈亏', '原计划退出日', '离场规则', '信号来源键'], openRows);
const rejectedRows = rows.flatMap(({ sample, filter, result }) => result.rejected.map(r => [sample, filter, `${result.klass}类买点`, EXIT_LABEL[result.exitRule], r.code, r.signalDate, r.entryDate, r.reason, r.pointKey]));
writeCsv('未成交信号.csv', ['样本', '共振过滤', '买点类别', '离场场景', '证券代码', '买点确认日', '原拟买入日', '未成交原因', '信号来源键'], rejectedRows);
const equityRows = rows.flatMap(({ sample, filter, result }) => result.equity.map(p => [sample, filter, result.klass, EXIT_LABEL[result.exitRule], p.date, p.cash, p.marketValue, p.equity, p.positionCount]));
writeCsv('每日净值.csv', ['样本', '共振过滤', '买点类别', '离场场景', '日期', '现金', '持仓市值', '总权益', '持仓数'], equityRows);

interface AnnualRow { sample: string; filter: string; klass: number; exitRule: string; year: number; returnPct: number; maxDrawdown: number; closed: number; endPositions: number }
const annual: AnnualRow[] = [];
for (const row of rows) {
  const years = new Map<number, typeof row.result.equity>();
  for (const point of row.result.equity) { const year = Number(point.date.slice(0, 4)); const list = years.get(year) ?? []; list.push(point); years.set(year, list); }
  let previous = row.result.initialCapital;
  for (const [year, points] of years) {
    let peak = previous; let dd = 0;
    for (const p of points) { peak = Math.max(peak, p.equity); if (peak > 0) dd = Math.max(dd, 1 - p.equity / peak); }
    const last = points.at(-1)!;
    annual.push({ sample: row.sample, filter: row.filter, klass: row.result.klass, exitRule: row.result.exitRule, year,
      returnPct: last.equity / previous - 1, maxDrawdown: dd, closed: row.result.trades.filter(t => t.exitDate.startsWith(String(year))).length, endPositions: last.positionCount });
    previous = last.equity;
  }
}
writeCsv('分年度表现.csv', ['样本', '共振过滤', '买点类别', '离场场景', '年份', '年度收益率(%)', '年内最大回撤(%)', '当年平仓数', '年末持仓数'], annual.map(a => [a.sample, a.filter, `${a.klass}类买点`, EXIT_LABEL[a.exitRule], a.year, round(a.returnPct * 100), round(a.maxDrawdown * 100), a.closed, a.endPositions]));

const db = new DatabaseSync(process.env.CHAN_DB_PATH ?? '/Users/admin/WorkSpace/baostock_data/data/baostock.db', { readOnly: true });
const indexRows = db.prepare("SELECT date,open,close FROM index_kline_d WHERE code='sh.000001' AND date>=? AND date<=? ORDER BY date").all(daily.config.startDate, daily.config.endDate) as unknown as { date: string; open: number; close: number }[];
const stockStatus = db.prepare('SELECT code,status FROM stock_basic WHERE type=1').all() as unknown as { code: string; status: number }[];
const universeSet = new Set(daily.universe);
const delistedUniverseCount = stockStatus.filter(s => universeSet.has(s.code) && s.status === 0).length;
db.close();
function benchmark(start: string) {
  const rows = indexRows.filter(r => r.date >= start);
  const first = rows[0]; const last = rows.at(-1);
  return first && last ? { start: first.date, end: last.date, return: last.close / first.open - 1, points: rows.map(r => ({ date: r.date, value: 20_000 * r.close / first.open })) } : null;
}
const benchmarks = { '2010—2026纯日线': benchmark(daily.config.startDate), '2020—2026同期对照': benchmark('2020-01-01') };

const audit = {
  generatedAt: new Date().toISOString(), dataSource: daily.dataSource, dataAsOf: daily.config.endDate,
  universeCount: daily.universe.length, delistedUniverseCount, engineConfigId: daily.engineConfigId,
  signalCounts: daily.signals.reduce<Record<string, number>>((counts, s) => { const key = `${s.side === 'buy' ? '买' : '卖'}${s.klass}`; counts[key] = (counts[key] ?? 0) + 1; return counts; }, {}),
  candidateCounts: daily.candidates.reduce<Record<string, number>>((counts, c) => { counts[`买${c.klass}`] = (counts[`买${c.klass}`] ?? 0) + 1; return counts; }, {}),
  sameDateClass12Pairs: (() => { const one = new Set(daily.candidates.filter(c => c.klass === 1).map(c => `${c.code}|${c.signalDate}`)); return daily.candidates.filter(c => c.klass === 2 && one.has(`${c.code}|${c.signalDate}`)).length; })(),
  confirmationIndexMismatches: daily.audits.reduce((sum, a) => sum + a.confirmationIndexMismatches, 0),
  maxAbsoluteReconciliation: Math.max(...summaries.map(s => Math.abs(s.reconciliation))), benchmarks,
  confluence30Status: multi?.confluence30Status ?? null, multiFilters: multi?.filters.map(f => ({ name: f.name, candidates: f.candidates, missingDecisions: f.missingDecisions })) ?? null,
  assumptions: {
    signalPrice: '与当前图表一致的不复权日线/分钟线；后复权仅用于总收益连续记账', entry: '确认日后下一可交易日开盘；开盘涨停不买；满仓信号不递补',
    exit: '任一卖点/同类卖点/20或60个市场交易日；开盘跌停顺延；期末不强制平仓', st: '仅按信号日is_st过滤，不用当前名称或未来ST回填',
    costs: daily.config, corporateActions: '后复权总收益口径，含复权因子体现的分红再投资；不另造现金分红流水',
    delisting: '退市后仍持仓且无行情时保守核销为零', ranking: '同日候选按信号日前20个有效交易日平均成交额降序，代码作稳定次序',
    limitations: ['未单独模拟过户费、涨停排队和盘口流动性', '日线不复权结构可能受除权除息影响', '20/60日退出为研究假设，不是缠论原文', '一/二类点在当前引擎同股同确认日成对出现，不是独立样本', '分钟数据不足不计为支持，也不计入无过滤对照的剔除样本'],
  },
};
writeFileSync(join(output, '回测审计.json'), JSON.stringify(audit, null, 2));

const chartData = rows.map(row => ({ key: summaryKey({ sample: row.sample, filter: row.filter, klass: row.result.klass, exitRule: row.result.exitRule }),
  label: `${row.sample}｜${row.filter}｜${row.result.klass}买｜${EXIT_LABEL[row.result.exitRule]}`, points: row.result.equity.map(p => [p.date, Math.round(p.equity * 100) / 100]) }));
const htmlSummaries = summaries.map(s => ({ ...s, key: summaryKey(s), exitLabel: EXIT_LABEL[s.exitRule] }));
const best = [...summaries].sort((a, b) => b.totalReturn - a.totalReturn)[0]!;
const fixed20 = summaries.filter(s => s.sample === '2010—2026纯日线' && s.exitRule === 'hold-20');
const fixed60 = summaries.filter(s => s.sample === '2010—2026纯日线' && s.exitRule === 'hold-60');
const support30Count = multi?.confluence30Status['支持'] ?? 0;
const insufficient30Count = multi?.confluence30Status['数据不足'] ?? 0;
const recentCandidateCount = multi?.filters.find(f => f.name === '无共振过滤')?.candidates ?? 0;
const strict5Count = multi?.filters.find(f => f.name === '日线+30分钟+5分钟')?.candidates ?? null;
const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>主板缠论策略账户回测</title>
<style>:root{color-scheme:dark;--bg:#0b1020;--panel:#121a2c;--text:#e8edf7;--muted:#94a3b8;--line:#26344d;--blue:#60a5fa;--green:#34d399;--red:#fb7185;--amber:#fbbf24}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif}main{max-width:1440px;margin:auto;padding:32px 22px 60px}h1{font-size:30px;margin:0 0 8px}h2{font-size:20px;margin:0 0 16px}h3{font-size:16px;margin:22px 0 8px}.muted{color:var(--muted)}.badges{display:flex;gap:8px;flex-wrap:wrap;margin:16px 0 24px}.badge{padding:4px 10px;border:1px solid var(--line);border-radius:99px;color:var(--muted)}.notice{padding:16px 18px;border-left:3px solid var(--amber);background:#2a2112;border-radius:8px;margin:20px 0}.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:12px;margin:20px 0}.card,.panel{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:18px}.card b{display:block;font-size:23px;margin-top:4px}.panel{margin-top:18px;overflow:hidden}.positive{color:var(--green)}.negative{color:var(--red)}select{width:100%;padding:10px;background:#0d1526;color:var(--text);border:1px solid var(--line);border-radius:8px;margin-bottom:12px}.table-wrap{overflow:auto}table{border-collapse:collapse;width:100%;min-width:1180px;font-variant-numeric:tabular-nums}th,td{padding:9px 10px;border-bottom:1px solid var(--line);text-align:right;white-space:nowrap}th{position:sticky;top:0;background:#182238;color:var(--muted);z-index:1}th:first-child,td:first-child,th:nth-child(2),td:nth-child(2),th:nth-child(3),td:nth-child(3){text-align:left}tr:hover td{background:#172139}canvas{width:100%;height:360px;display:block}.grid2{display:grid;grid-template-columns:1fr 1fr;gap:18px}.files a{color:var(--blue);margin-right:16px}.small{font-size:12px}@media(max-width:760px){main{padding:20px 12px}.grid2{grid-template-columns:1fr}canvas{height:280px}h1{font-size:24px}}</style></head><body><main>
<h1>主板缠论策略账户回测</h1><div class="muted">买卖点确认后交易｜一/二/三类独立账户｜四种离场｜多周期共振对照</div>
<div class="badges"><span class="badge">${daily.universe.length}只主板股，含${delistedUniverseCount}只退市</span><span class="badge">日线：${daily.config.startDate}—${daily.config.endDate}</span><span class="badge">分钟对照：2020年起</span><span class="badge">每账户本金${daily.config.initialCapital / 10000}万元，最多${daily.config.maxPositions}仓</span><span class="badge">${daily.config.lotSize}股整手，最低佣金${daily.config.minCommission}元</span></div>
<div class="notice"><b>先看结论口径：</b>累计收益不等于稳定盈利。等卖点场景可能长期占满两个仓位，期末浮盈未扣卖出成本；一/二类点在当前引擎同股同确认日成对出现，不能视为两份独立证据。本报告是历史研究，不构成收益保证或个股买卖建议。</div>
<div class="cards"><div class="card"><span class="muted">最高账面总收益（路径敏感）</span><b>${best.klass}买 · ${EXIT_LABEL[best.exitRule]}</b><span>${best.filter}｜${pct(best.totalReturn)}</span></div><div class="card"><span class="muted">日线20日离场</span><b>${fixed20.map(s => `${s.klass}买 ${pct(s.totalReturn)}`).join('｜')}</b><span>一/二类相同</span></div><div class="card"><span class="muted">日线60日离场</span><b>${fixed60.map(s => `${s.klass} ${pct(s.totalReturn)}`).join('｜')}</b><span>一/二类相同</span></div><div class="card"><span class="muted">同期上证指数</span><b>${pct(benchmarks['2010—2026纯日线']?.return ?? null)}</b><span>2010首个交易日开盘至期末收盘</span></div></div>
${multi ? `<section class="panel"><h2>多周期共振样本</h2><p>2020年以来共有 <b>${recentCandidateCount}</b> 个非风险警示日线买入候选；其中 <b class="positive">${support30Count}</b> 个获得30分钟同向确认支持，<b>${insufficient30Count}</b> 个因覆盖或来源问题记为数据不足。${strict5Count == null ? '5分钟链式场景尚未并入本次报告。' : `进一步获得5分钟链式支持的候选为 <b>${strict5Count}</b> 个。`}</p><p class="muted">共振只过滤入场，离场仍使用同一套日线规则。过滤后样本和成交路径都会改变，必须与同期无过滤账户逐项比较，不能把交易减少本身当成收益改善。</p></section>` : ''}
<section class="panel"><h2>账户场景汇总</h2><div class="table-wrap"><table><thead><tr><th>样本/过滤</th><th>买点</th><th>离场</th><th>候选/入场</th><th>期末权益</th><th>总收益</th><th>年化</th><th>最大回撤</th><th>平仓数</th><th>胜率</th><th>已实现</th><th>未实现</th><th>平均仓位</th></tr></thead><tbody>${htmlSummaries.map(s => `<tr><td>${s.sample}<br><span class="muted small">${s.filter}</span></td><td>${s.klass}类</td><td>${s.exitLabel}</td><td>${s.candidates}/${s.entries}</td><td>${money(s.finalEquity)}</td><td class="${s.totalReturn >= 0 ? 'positive' : 'negative'}">${pct(s.totalReturn)}</td><td>${pct(s.annualizedReturn)}</td><td>${pct(s.maxDrawdown)}</td><td>${s.closedTrades}</td><td>${pct(s.winRate)}</td><td>${money(s.realizedPnl)}</td><td>${money(s.unrealizedPnl)}</td><td>${pct(s.exposure)}</td></tr>`).join('')}</tbody></table></div></section>
<section class="panel"><h2>净值与基准</h2><select id="scenario">${chartData.map((d, i) => `<option value="${i}">${d.label}</option>`).join('')}</select><canvas id="chart" width="1200" height="360"></canvas><div id="chartLegend" class="muted small"></div></section>
<div class="grid2"><section class="panel"><h2>盈利解释</h2><p>“任一/同类卖点”场景中，两个仓位可能多年无法轮换。报告同时列出已实现与未实现盈亏；未平仓不进入胜率分母。</p><p>一买同类卖点退出的高账面收益主要来自格力电器长期浮盈；三买等卖点场景的已平仓交易全部亏损，账面盈利依赖未平仓股票。固定20/60日结果应作为是否具备可重复交易价值的重要对照。</p><p>同日候选超过空位时按此前20个有效交易日平均成交额排序，未成交不递补，因此账户结果具有路径依赖。</p></section><section class="panel"><h2>数据与限制</h2><p>信号与当前图表一致使用不复权结构价；后复权只负责跨除权日总收益记账。信号日风险警示被排除，历史退市股保留。</p><p>计佣金万2.5（最低5元）、双边滑点万5、卖出印花税按日期0.1%/0.05%。未单独模拟过户费、盘口排队和流动性。</p><p>分钟覆盖不足记为“数据不足”，不冒充“不支持”。5分钟链式确认是严格研究场景；离场仍使用日线规则。</p></section></div>
<section class="panel files"><h2>审计文件</h2><a href="账户场景汇总.csv">账户场景汇总</a><a href="交易明细.csv">交易明细</a><a href="期末持仓.csv">期末持仓</a><a href="未成交信号.csv">未成交信号</a><a href="每日净值.csv">每日净值</a><a href="分年度表现.csv">分年度表现</a><a href="回测审计.json">回测审计</a><a href="独立核验.json">独立核验</a><p class="muted small">生成时间：${new Date().toISOString()}｜数据截止：2026-11-04｜引擎口径：${daily.engineConfigId}</p></section>
</main><script>const charts=${JSON.stringify(chartData)};const summaries=${JSON.stringify(htmlSummaries)};const benchmarks=${JSON.stringify(Object.fromEntries(Object.entries(benchmarks).map(([k,v])=>[k,v?.points.map(p=>[p.date,Math.round(p.value*100)/100])??null])))};const select=document.getElementById('scenario'),canvas=document.getElementById('chart'),ctx=canvas.getContext('2d');function draw(){const d=charts[select.value],s=summaries[select.value],b=benchmarks[s.sample]||[];const all=[...d.points,...b];if(!all.length)return;const dates=[...new Set(all.map(p=>p[0]))].sort(),values=all.map(p=>p[1]);const min=Math.min(...values),max=Math.max(...values),pad=Math.max(100,(max-min)*.08),lo=min-pad,hi=max+pad,W=canvas.width,H=canvas.height,L=76,R=20,T=20,B=42;ctx.clearRect(0,0,W,H);ctx.font='13px sans-serif';ctx.textAlign='right';ctx.strokeStyle='#26344d';ctx.fillStyle='#94a3b8';for(let i=0;i<=5;i++){const y=T+(H-T-B)*i/5,v=hi-(hi-lo)*i/5;ctx.beginPath();ctx.moveTo(L,y);ctx.lineTo(W-R,y);ctx.stroke();ctx.fillText(v.toFixed(0),L-10,y+4)}const idx=new Map(dates.map((x,i)=>[x,i]));function line(points,color){if(!points.length)return;ctx.strokeStyle=color;ctx.lineWidth=2;ctx.beginPath();points.forEach((p,i)=>{const x=L+(W-L-R)*idx.get(p[0])/Math.max(1,dates.length-1),y=T+(H-T-B)*(hi-p[1])/(hi-lo);i?ctx.lineTo(x,y):ctx.moveTo(x,y)});ctx.stroke()}line(d.points,'#60a5fa');line(b,'#94a3b8');ctx.textAlign='left';ctx.fillStyle='#cbd5e1';ctx.fillText(dates[0],L,H-12);ctx.textAlign='right';ctx.fillText(dates.at(-1),W-R,H-12);document.getElementById('chartLegend').textContent='蓝线：策略账户；灰线：同期上证指数（均按2万元归一）。 '+d.label}select.addEventListener('change',draw);draw();</script></body></html>`;
writeFileSync(join(output, '缠论策略回测报告.html'), html);
console.log(`[报告] ${join(output, '缠论策略回测报告.html')}，场景${summaries.length}，交易${tradeRows.length}，净值行${equityRows.length}，最大账务差${audit.maxAbsoluteReconciliation}`);
