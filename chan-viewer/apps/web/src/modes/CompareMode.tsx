// 口径对比模式（千人千缠）：同数据双配置并排 + 结构差异清单（带引文）。
import { useMemo } from 'react';
import { Select } from 'antd';
import { compute, type ComputeResult } from '@chan/engine';
import { useStore, 对比预设对 } from '../store.ts';
import { Chart } from '../components/Chart.tsx';
import { ConfigPanel } from '../components/ConfigPanel.tsx';
import type { RawBar } from '../api.ts';

function buildDiff(bars: RawBar[], ra: ComputeResult, rb: ComputeResult): string[] {
  const items: string[] = [];
  const cA = ra.fractals.filter((f) => f.status === 'confirmed');
  const cB = rb.fractals.filter((f) => f.status === 'confirmed');
  const cnt = (fs: typeof cA) => `顶${fs.filter((f) => f.type === 'top').length}/底${fs.filter((f) => f.type === 'bottom').length}`;
  items.push(`有效K线：A ${ra.validBars.length} 根 ／ B ${rb.validBars.length} 根`);
  items.push(`确认分型：A ${cA.length}（${cnt(cA)}）／ B ${cB.length}（${cnt(cB)}）`);
  items.push(`笔：A ${ra.bis.length} 笔 ／ B ${rb.bis.length} 笔`);

  // 首个结构分歧（有效K线序列首次不同处）。
  const n = Math.min(ra.validBars.length, rb.validBars.length);
  let firstDiv: string | null = null;
  for (let i = 0; i < n; i++) {
    const a = ra.validBars[i]!;
    const b = rb.validBars[i]!;
    if (a.low !== b.low || a.high !== b.high || a.startRaw !== b.startRaw || a.endRaw !== b.endRaw) {
      firstDiv = bars[a.startRaw]?.date ?? `#${a.startRaw}`;
      break;
    }
  }
  if (firstDiv) items.push(`首个结构分歧：${firstDiv}（此前两口径一致）`);
  else if (ra.validBars.length === rb.validBars.length) items.push('有效K线完全一致（分歧可能仅在分型/笔判定）');

  // 分型增删（按 类型+中间根原始起点 对齐）。
  const keyA = (f: (typeof cA)[number]) => `${f.type}:${ra.validBars[f.middle]?.startRaw}`;
  const keyB = (f: (typeof cB)[number]) => `${f.type}:${rb.validBars[f.middle]?.startRaw}`;
  const setA = new Map(cA.map((f) => [keyA(f), f]));
  const setB = new Map(cB.map((f) => [keyB(f), f]));
  const onlyA = cA.filter((f) => !setB.has(keyA(f)));
  const onlyB = cB.filter((f) => !setA.has(keyB(f)));
  const desc = (f: (typeof cA)[number], r: ComputeResult) => {
    const mb = r.validBars[f.middle];
    const date = mb ? bars[mb.startRaw]?.date : '?';
    return `${f.type === 'top' ? '顶' : '底'} ${date} ${f.price.toFixed(2)}`;
  };
  for (const f of onlyA.slice(0, 6)) items.push(`仅A有分型：${desc(f, ra)}`);
  for (const f of onlyB.slice(0, 6)) items.push(`仅B有分型：${desc(f, rb)}`);
  if (onlyA.length === 0 && onlyB.length === 0) items.push('确认分型集合一致');
  return items;
}

export function CompareMode() {
  const { bars, configA, configB, layers, setConfigA, setConfigB } = useStore();
  const ra = useMemo(() => compute(bars, configA), [bars, configA]);
  const rb = useMemo(() => compute(bars, configB), [bars, configB]);
  const diff = useMemo(() => buildDiff(bars, ra, rb), [bars, ra, rb]);
  const presetName = 对比预设对.find((p) => JSON.stringify(p.a) === JSON.stringify(configA) && JSON.stringify(p.b) === JSON.stringify(configB))?.name;

  return (
    <div className="main">
      <div className="chart-col">
        <div className="compare-head">
          <label className="field">
            <span className="field-label">预设分歧对</span>
            <Select
              value={presetName}
              placeholder="自定义（右侧可改）"
              style={{ minWidth: 200 }}
              options={对比预设对.map((p) => ({ value: p.name, label: p.name }))}
              onChange={(name) => {
                const p = 对比预设对.find((x) => x.name === name);
                if (p) {
                  setConfigA({ ...p.a });
                  setConfigB({ ...p.b });
                }
              }}
            />
          </label>
          <span className="hint">{对比预设对.find((p) => p.name === presetName)?.note ?? '同一份数据，两套口径，结构差异如下。'}</span>
        </div>
        <div className="compare-charts">
          <div>
            {bars.length > 0 && <Chart bars={bars} result={ra} layers={layers} label={`口径 A · ${configA.biRule}`} />}
          </div>
          <div>
            {bars.length > 0 && <Chart bars={bars} result={rb} layers={layers} label={`口径 B · ${configB.biRule}`} />}
          </div>
        </div>
        <div className="diff-list">
          {diff.map((d, i) => (
            <div key={i} className="diff-item">
              <span className="tag">▸</span> {d}
            </div>
          ))}
        </div>
      </div>
      <div className="side">
        <ConfigPanel config={configA} onChange={setConfigA} title="口径 A" />
        <ConfigPanel config={configB} onChange={setConfigB} title="口径 B" />
      </div>
    </div>
  );
}