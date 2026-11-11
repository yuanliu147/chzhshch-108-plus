// 口径面板：四维显式选择，每维带来源徽标与逐字引文（口径注册表唯一来源）。控件用 antd。
import type { ReactNode } from 'react';
import { Select, Tag } from 'antd';
import { 口径注册, type ChanConfig } from '@chan/engine';

interface Props {
  config: ChanConfig;
  onChange: (c: ChanConfig) => void;
  title?: string;
}

const SOURCE_COLOR: Record<string, string> = { 原文: 'success', 社区: 'warning', 错误示范: 'error' };

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
    </div>
  );
}