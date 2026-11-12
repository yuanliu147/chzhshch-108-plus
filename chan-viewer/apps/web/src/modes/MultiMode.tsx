// 多周期区间套模式：日线/30分/5分 三图联立（全程不复权对齐基准）。
// 点击大级别背驰段 → 高亮并列出次级别对应背驰段/买卖点，逐级收缩转折点（27课区间套）。
import { useEffect, useMemo, useState } from 'react';
import { Alert, Tag } from 'antd';
import { compute, type ComputeResult, type Divergence } from '@chan/engine';
import { useStore } from '../store.ts';
import { fetchKline, fetchMinCap, fetchMinKline, type RawBar } from '../api.ts';
import { Chart } from '../components/Chart.tsx';
import { ConfigPanel } from '../components/ConfigPanel.tsx';
import { divergenceWindow, nestWithin, rawIndicesWithin } from '../nest.ts';

function hitList(title: string, hit: { divergences: Divergence[]; points: { side: string; klass: number; price: number }[] } | null) {
  if (!hit) return null;
  return (
    <div>
      <h3>{title}</h3>
      {hit.divergences.length === 0 && hit.points.length === 0 ? (
        <div className="empty">该窗口内无背驰/买卖点</div>
      ) : (
        <div className="trend-list">
          {hit.divergences.map((d) => (
            <Tag key={`d${d.id}`} color="warning">
              {d.kind}·{d.dir === 'up' ? '顶' : '底'}
            </Tag>
          ))}
          {hit.points.map((p, i) => (
            <Tag key={`p${i}`} color={p.side === 'buy' ? 'error' : 'success'}>
              {p.side === 'buy' ? '买' : '卖'}
              {['一', '二', '三'][p.klass - 1]}类 @{p.price.toFixed(2)}
            </Tag>
          ))}
        </div>
      )}
    </div>
  );
}

export function MultiMode() {
  const code = useStore((s) => s.code);
  const configA = useStore((s) => s.configA);
  const setConfigA = useStore((s) => s.setConfigA);
  const layers = useStore((s) => s.layers);
  const [d, setD] = useState<RawBar[]>([]);
  const [m30, setM30] = useState<RawBar[]>([]);
  const [m5, setM5] = useState<RawBar[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [warn, setWarn] = useState<string[]>([]);
  const [selD, setSelD] = useState<Divergence | null>(null);
  const [sel30, setSel30] = useState<Divergence | null>(null);

  useEffect(() => {
    let dead = false;
    setErr(null);
    setSelD(null);
    setSel30(null);
    (async () => {
      try {
        const cap = await fetchMinCap(code);
        if (!cap.hasMin) {
          if (!dead) {
            setErr(`标的 ${code} 无分钟线数据（分钟线仅覆盖部分股票，2020年起），多周期区间套不可用。请换有分钟线的股票。`);
            setD([]); setM30([]); setM5([]);
          }
          return;
        }
        // 全程不复权（adjust=3），与分钟线价格基准一致。
        const [dd, mm30, mm5] = await Promise.all([fetchKline(code, '3', 500), fetchMinKline(code, 30, 500), fetchMinKline(code, 5, 500)]);
        if (dead) return;
        setD(dd.bars);
        setM30(mm30.bars);
        setM5(mm5.bars);
        setWarn([...dd.meta.warnings, ...mm30.meta.warnings, ...mm5.meta.warnings]);
      } catch (e) {
        if (!dead) setErr(String(e instanceof Error ? e.message : e));
      }
    })();
    return () => {
      dead = true;
    };
  }, [code]);

  const rd = useMemo(() => (d.length ? compute(d, configA) : null), [d, configA]);
  const r30 = useMemo(() => (m30.length ? compute(m30, configA) : null), [m30, configA]);
  const r5 = useMemo(() => (m5.length ? compute(m5, configA) : null), [m5, configA]);

  // 区间套窗口：日线背驰段 → 30分高亮+命中；再选 30分背驰段 → 进一步收窄到 5分。
  const winD = selD && d.length ? divergenceWindow(selD, d) : null;
  const hi30 = winD ? rawIndicesWithin(m30, winD[0], winD[1]) : null;
  const hit30 = winD && r30 ? nestWithin(r30, m30, winD[0], winD[1]) : null;
  const win5 = sel30 ? divergenceWindow(sel30, m30) : winD;
  const hi5 = win5 ? rawIndicesWithin(m5, win5[0], win5[1]) : null;
  const hit5 = win5 && r5 ? nestWithin(r5, m5, win5[0], win5[1]) : null;

  const clickDiv = (result: ComputeResult | null, rawIndex: number, setter: (d: Divergence | null) => void, cur: Divergence | null) => {
    if (!result) return;
    const found = result.divergences.find((dv) => rawIndex >= dv.cStart - 1 && rawIndex <= dv.cEnd + 1) ?? null;
    setter(found && found !== cur ? found : null);
  };

  if (err) return <div style={{ padding: 24 }}><Alert type="warning" showIcon message={err} /></div>;
  if (!rd || !r30 || !r5) return <div className="empty">加载多周期行情（日线/30分/5分，不复权）…</div>;

  return (
    <div className="main">
      <div className="chart-col multi-col">
        <div className="multi-chart">
          <Chart bars={d} result={rd} layers={layers} label="日线（不复权）· 点背驰段下钻" onBarClick={(i) => clickDiv(rd, i, setSelD, selD)} />
        </div>
        <div className="multi-chart">
          <Chart bars={m30} result={r30} layers={layers} highlight={hi30} label="30分 · 区间套" onBarClick={(i) => clickDiv(r30, i, setSel30, sel30)} />
        </div>
        <div className="multi-chart">
          <Chart bars={m5} result={r5} layers={layers} highlight={hi5} label="5分 · 精确定位" />
        </div>
      </div>
      <div className="side">
        <ConfigPanel config={configA} onChange={setConfigA} title="口径（各级共用）" />
        <div>
          <h3>区间套（点大级别背驰段逐级下钻）</h3>
          <div className="hint" style={{ marginBottom: 8 }}>
            {selD ? `日线背驰段窗口 ${winD?.[0]} ~ ${winD?.[1]}` : '未选中日线背驰段（点击日线图上背驰段）'}
            {sel30 ? `；30分背驰段进一步收窄 ${win5?.[0]} ~ ${win5?.[1]}` : ''}
          </div>
          {warn.length > 0 && <Alert type="info" showIcon style={{ marginBottom: 8 }} message={warn.join('；')} />}
          {hitList('30分窗口内结构', hit30)}
          {hitList('5分窗口内结构（转折点）', hit5)}
        </div>
      </div>
    </div>
  );
}
