// 学习回放模式：原始K线 + 可开关图层 + 逐根回放 + 事件日志。
import { useMemo } from 'react';
import { Checkbox, Tag } from 'antd';
import { compute } from '@chan/engine';
import { useStore, type Layers } from '../store.ts';
import { Chart } from '../components/Chart.tsx';
import { ConfigPanel } from '../components/ConfigPanel.tsx';
import { ReplayBar } from '../components/ReplayBar.tsx';
import { EventLog } from '../components/EventLog.tsx';

const LAYER_LABELS: { key: keyof Layers; label: string }[] = [
  { key: 'merged', label: '合并K线' },
  { key: 'fractal', label: '分型' },
  { key: 'bi', label: '笔' },
  { key: 'segment', label: '线段' },
  { key: 'center', label: '中枢' },
  { key: 'divergence', label: '背驰/MACD' },
  { key: 'point', label: '买卖点' },
  { key: 'candidate', label: '候选' },
];

export function LearnMode() {
  const { bars, cursor, configA, layers, highlight, setConfigA, toggleLayer } = useStore();
  const shown = useMemo(() => bars.slice(0, cursor + 1), [bars, cursor]);
  const result = useMemo(() => compute(shown, configA), [shown, configA]);

  return (
    <div className="main">
      <div className="chart-col">
        <div className="chart-wrap">
          {bars.length > 0 ? (
            <Chart bars={shown} result={result} layers={layers} highlight={highlight} />
          ) : (
            <div className="empty">加载行情中…</div>
          )}
        </div>
        <ReplayBar />
      </div>
      <div className="side">
        <ConfigPanel config={configA} onChange={setConfigA} title="口径（当前）" />
        <div>
          <h3>图层</h3>
          <div className="layers">
            {LAYER_LABELS.map((l) => (
              <Checkbox key={l.key} checked={layers[l.key]} onChange={() => toggleLayer(l.key)}>
                {l.label}
              </Checkbox>
            ))}
          </div>
        </div>
        {result.trends.length > 0 && (
          <div>
            <h3>走势类型</h3>
            <div className="trend-list">
              {result.trends.map((t) => (
                <span key={t.id} className="trend-item">
                  <Tag color={t.kind === '上涨' ? 'error' : t.kind === '下跌' ? 'success' : 'default'}>{t.kind}</Tag>
                  <span className="trend-sub">{t.centerIds.length}中枢{t.status === 'candidate' ? '·候选' : ''}</span>
                </span>
              ))}
            </div>
          </div>
        )}
        <EventLog result={result} />
      </div>
    </div>
  );
}