// 口径面板：四维显式选择，每维带来源徽标与逐字引文（口径注册表唯一来源）。控件用 antd。
import type { ReactNode } from 'react';
import { Select, Tag } from 'antd';
import { 口径注册, type ChanConfig } from '@chan/engine';

interface Props {
  config: ChanConfig;
  onChange: (c: ChanConfig) => void;
  title?: string;
}

const SOURCE_COLOR: Record<string, string> = { 原文: 'success', 社区: 'warning', 错误示范: 'error', 实现假设: 'geekblue' };

function Badge({ source }: { source: string }) {
  return <Tag color={SOURCE_COLOR[source] ?? 'default'} style={{ marginInlineEnd: 0 }}>{source}</Tag>;
}

function Quote({ lesson, quote }: { lesson: readonly string[]; quote: string }) {
  return (
    <div className="quote">
      <span className="lesson">{lesson.map((l) => `${l}课`).join('／')}</span> 「{quote}」
    </div>
  );
}

export function ConfigPanel({ config, onChange, title }: Props) {
  const dim = (name: string, entry: { source: string; lesson: readonly string[]; quote: string }, control: ReactNode) => (
    <div className="cfg-dim">
      <div className="dim-head">
        <span className="dim-name">{name}</span>
        <Badge source={entry.source} />
      </div>
      {control}
      <Quote lesson={entry.lesson} quote={entry.quote} />
    </div>
  );

  const startEntry = 口径注册.startDir[config.startDir];
  const precKey = config.precision.digits === 'raw' ? 'raw' : (`d${config.precision.digits}` as keyof typeof 口径注册.precision);
  const precEntry = 口径注册.precision[precKey];
  const biEntry = 口径注册.biRule[config.biRule];
  const mergeEntry = 口径注册.mergeDir[config.mergeDir];
  const touchEntry = 口径注册.touchOverlap[config.touchOverlap];
  const segMergeEntry = 口径注册.segMerge[config.segMerge];
  const centerUnitEntry = 口径注册.centerUnit[config.centerUnit];
  const centerUpgradeEntry = 口径注册.centerUpgrade[config.centerUpgrade];
  const trendOverlapEntry = 口径注册.trendOverlap[config.trendOverlap];
  const divMetricEntry = 口径注册.divMetric[config.divMetric];
  const bsp3Entry = 口径注册.bsp3Touch[config.bsp3Touch];
  const bsp2Entry = 口径注册.bsp2Filter[config.bsp2Filter];

  return (
    <div>
      {title && <h3>{title}</h3>}
      {dim(
        '起点方向',
        startEntry,
        <Select
          value={config.startDir}
          style={{ width: '100%' }}
          options={Object.values(口径注册.startDir).map((o) => ({ value: o.value, label: o.label }))}
          onChange={(v) => onChange({ ...config, startDir: v as ChanConfig['startDir'] })}
        />,
      )}
      {dim(
        '价格精度',
        precEntry,
        <Select
          value={String(config.precision.digits)}
          style={{ width: '100%' }}
          options={Object.values(口径注册.precision).map((o) => ({ value: String(o.value), label: o.label }))}
          onChange={(v) => onChange({ ...config, precision: { digits: v === 'raw' ? 'raw' : (Number(v) as 0 | 1 | 2 | 3 | 4) } })}
        />,
      )}
      {dim(
        '笔口径',
        biEntry,
        <Select
          value={config.biRule}
          style={{ width: '100%' }}
          options={Object.values(口径注册.biRule).map((o) => ({ value: o.value, label: o.label }))}
          onChange={(v) => onChange({ ...config, biRule: v as ChanConfig['biRule'] })}
        />,
      )}
      {dim(
        '包含方向判定',
        mergeEntry,
        <Select
          value={config.mergeDir}
          style={{ width: '100%' }}
          options={Object.values(口径注册.mergeDir).map((o) => ({ value: o.value, label: o.label }))}
          onChange={(v) => onChange({ ...config, mergeDir: v as ChanConfig['mergeDir'] })}
        />,
      )}
      {dim(
        '端点相接重叠',
        touchEntry,
        <Select
          value={config.touchOverlap}
          style={{ width: '100%' }}
          options={Object.values(口径注册.touchOverlap).map((o) => ({ value: o.value, label: o.label }))}
          onChange={(v) => onChange({ ...config, touchOverlap: v as ChanConfig['touchOverlap'] })}
        />,
      )}
      {dim(
        '特征序列包含',
        segMergeEntry,
        <Select
          value={config.segMerge}
          style={{ width: '100%' }}
          options={Object.values(口径注册.segMerge).map((o) => ({ value: o.value, label: o.label }))}
          onChange={(v) => onChange({ ...config, segMerge: v as ChanConfig['segMerge'] })}
        />,
      )}
      {dim(
        '中枢构件',
        centerUnitEntry,
        <Select
          value={config.centerUnit}
          style={{ width: '100%' }}
          options={Object.values(口径注册.centerUnit).map((o) => ({ value: o.value, label: o.label }))}
          onChange={(v) => onChange({ ...config, centerUnit: v as ChanConfig['centerUnit'] })}
        />,
      )}
      {dim(
        '中枢升级',
        centerUpgradeEntry,
        <Select
          value={config.centerUpgrade}
          style={{ width: '100%' }}
          options={Object.values(口径注册.centerUpgrade).map((o) => ({ value: o.value, label: o.label }))}
          onChange={(v) => onChange({ ...config, centerUpgrade: v as ChanConfig['centerUpgrade'] })}
        />,
      )}
      {dim(
        '趋势不重叠',
        trendOverlapEntry,
        <Select
          value={config.trendOverlap}
          style={{ width: '100%' }}
          options={Object.values(口径注册.trendOverlap).map((o) => ({ value: o.value, label: o.label }))}
          onChange={(v) => onChange({ ...config, trendOverlap: v as ChanConfig['trendOverlap'] })}
        />,
      )}
      {dim(
        '背驰度量',
        divMetricEntry,
        <Select
          value={config.divMetric}
          style={{ width: '100%' }}
          options={Object.values(口径注册.divMetric).map((o) => ({ value: o.value, label: o.label }))}
          onChange={(v) => onChange({ ...config, divMetric: v as ChanConfig['divMetric'] })}
        />,
      )}
      {dim(
        '三买/三卖边界',
        bsp3Entry,
        <Select
          value={config.bsp3Touch}
          style={{ width: '100%' }}
          options={Object.values(口径注册.bsp3Touch).map((o) => ({ value: o.value, label: o.label }))}
          onChange={(v) => onChange({ ...config, bsp3Touch: v as ChanConfig['bsp3Touch'] })}
        />,
      )}
      {dim(
        '二买过滤',
        bsp2Entry,
        <Select
          value={config.bsp2Filter}
          style={{ width: '100%' }}
          options={Object.values(口径注册.bsp2Filter).map((o) => ({ value: o.value, label: o.label }))}
          onChange={(v) => onChange({ ...config, bsp2Filter: v as ChanConfig['bsp2Filter'] })}
        />,
      )}
    </div>
  );
}