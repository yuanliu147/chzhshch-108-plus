// 单因素实验登记：所有条件只依赖信号确认时已知的记录，不在这里叠加过滤器。
import type { EntryCandidate } from './core.ts';
import type { ExplorationRecord, ReturnStates, TrendStates } from './run_explore.ts';

export interface ExperimentContext {
  indexTrendByDate: ReadonlyMap<string, TrendStates>;
  indexReturnByDate: ReadonlyMap<string, ReturnStates>;
  atrMedianByDate: ReadonlyMap<string, number | null>;
}
export interface FilterExperiment {
  id: string;
  family: string;
  label: string;
  description: string;
  test: (record: ExplorationRecord | undefined, candidate: EntryCandidate, context: ExperimentContext) => boolean | null;
}

export function candidateKey(candidate: Pick<EntryCandidate, 'code' | 'pointKey'>): string {
  return `${candidate.code}|${candidate.pointKey}`;
}

export function filterExperiments(): FilterExperiment[] {
  const out: FilterExperiment[] = [
    { id: 'baseline', family: '原基线', label: '不加过滤', description: '原始非风险警示确认买点，账户规则完全不变。', test: () => true },
    { id: 'volume-natural', family: '结构段量能', label: '结构量能符合方向', description: '一买c段缩量；二买回抽缩量；三买离开放量且回踩缩量。历史不足单独计数。', test: r => r?.volumePass ?? null },
  ];
  for (const window of [20, 60, 120, 250]) {
    out.push({ id: `daily-trend-${window}`, family: '个股日线趋势', label: `日线MA${window}多头`, description: `信号日后复权收盘高于MA${window}，且MA${window}较前一日上行。`,
      test: r => r?.dailyTrend[window] ?? null });
    out.push({ id: `index-trend-${window}`, family: '大盘日线趋势', label: `上证MA${window}多头`, description: `信号日上证收盘高于MA${window}，且MA${window}较前一日上行；与个股趋势分开测试。`,
      test: (_r, c, ctx) => ctx.indexTrendByDate.get(c.signalDate)?.[window] ?? null });
  }
  for (const window of [20, 60, 120]) {
    out.push({ id: `relative-${window}`, family: '相对指数强弱', label: `${window}日跑赢上证`, description: `个股后复权${window}日涨幅减去上证同期涨幅>0；不要求个股绝对收益为正。`, test: (r, c, ctx) => {
      const stock = r?.stockReturn[window];
      const index = ctx.indexReturnByDate.get(c.signalDate)?.[window];
      return stock == null || index == null ? null : stock > index;
    } });
  }
  for (const window of [5, 10, 20, 60]) {
    out.push({ id: `weekly-trend-${window}`, family: '已完成周线趋势', label: `周线MA${window}多头`, description: `仅使用信号日已完成的周线；后复权周收盘高于MA${window}且均线上行。`,
      test: r => r?.weeklyTrend[window] ?? null });
  }
  for (const window of [3, 6, 12, 24]) {
    out.push({ id: `monthly-trend-${window}`, family: '已完成月线趋势', label: `月线MA${window}多头`, description: `仅使用信号日已完成的月线；后复权月收盘高于MA${window}且均线上行。`,
      test: r => r?.monthlyTrend[window] ?? null });
  }
  out.push(
    { id: 'weekly-point', family: '高周期缠论点', label: '最近完成周线确认买点', description: '最近一根已完成周线内首次确认任一已验证买点；更早买点不永久有效。', test: r => !r || r.weeklyPoint.status === '数据不足' ? null : r.weeklyPoint.status === '支持' },
    { id: 'monthly-point', family: '高周期缠论点', label: '最近完成月线确认买点', description: '最近一根已完成月线内首次确认任一已验证买点；更早买点不永久有效。', test: r => !r || r.monthlyPoint.status === '数据不足' ? null : r.monthlyPoint.status === '支持' },
    { id: 'atr-low', family: 'ATR波动率', label: '当日候选中低波动半边', description: 'ATR14/信号日后复权收盘低于或等于同日全部候选的中位数；不是固定波动阈值。', test: (r, c, ctx) => {
      const median = ctx.atrMedianByDate.get(c.signalDate);
      return r?.atr14Pct == null || median == null ? null : r.atr14Pct <= median;
    } },
    { id: 'atr-high', family: 'ATR波动率', label: '当日候选中高波动半边', description: 'ATR14/信号日后复权收盘高于同日全部候选的中位数；与低波动方向分开报告。', test: (r, c, ctx) => {
      const median = ctx.atrMedianByDate.get(c.signalDate);
      return r?.atr14Pct == null || median == null ? null : r.atr14Pct > median;
    } },
  );
  return out;
}

export const EXIT_LABEL: Record<string, string> = {
  'any-sell': '任一确认卖点（共同样本）',
  'same-class-sell': '同类确认卖点（共同样本）',
  'hold-20': '持有20个市场交易日（共同样本）',
  'hold-60': '持有60个市场交易日（共同样本）',
  structure: '结构失效离场',
  'atr14-2': '2倍ATR14移动离场',
  'atr14-3': '3倍ATR14移动离场',
  'atr14-4': '4倍ATR14移动离场',
  'channel-10': '跌破此前10日最低价',
  'channel-20': '跌破此前20日最低价',
};
export const EXIT_EXPERIMENTS = ['structure', 'atr14-2', 'atr14-3', 'atr14-4', 'channel-10', 'channel-20'] as const;
