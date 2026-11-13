// 分型标记练习：选题窗→遮答案→点选顶/底→提交对照→逐标记判定+解释→计分+本机审计记录。
import { useEffect, useMemo, useState } from 'react';
import { Button, Select, Tag } from 'antd';
import { compute } from '@chan/engine';
import { useStore } from '../store.ts';
import { Chart } from '../components/Chart.tsx';

const WINDOW = 120;
const LS_KEY = 'chan-viewer-practice-v1';

interface Mark {
  middle: number;
  type: 'top' | 'bottom';
}
interface Judgment {
  kind: '命中' | '漏' | '多';
  label: string;
  explain: string;
}
interface PracticeRecord {
  time: string;
  code: string | null;
  configId: string;
  dataAsOf: string | null;
  window: [number, number];
  seed: number;
  hits: number;
  miss: number;
  extra: number;
  confirmedCount: number;
}

function loadHistory(): PracticeRecord[] {
  try {
    return JSON.parse(localStorage.getItem(LS_KEY) ?? '[]') as PracticeRecord[];
  } catch {
    return [];
  }
}

export function PracticeMode() {
  const { bars, configA, meta } = useStore();
  const [seed, setSeed] = useState(1);
  const [markType, setMarkType] = useState<'top' | 'bottom'>('top');
  const [marks, setMarks] = useState<Mark[]>([]);
  const [submitted, setSubmitted] = useState(false);
  const [history, setHistory] = useState<PracticeRecord[]>([]);

  useEffect(() => setHistory(loadHistory()), []);

  const offset = bars.length > WINDOW ? (seed * 37) % (bars.length - WINDOW) : 0;
  const windowBars = useMemo(() => bars.slice(offset, offset + WINDOW), [bars, offset]);
  const result = useMemo(() => compute(windowBars, configA), [windowBars, configA]);
  const confirmed = useMemo(() => result.fractals.filter((f) => f.status === 'confirmed'), [result]);

  const reset = (s: number) => {
    setSeed(s);
    setMarks([]);
    setSubmitted(false);
  };

  const onBarClick = (rawIndex: number) => {
    if (submitted) return;
    const mb = result.validBars.find((b) => rawIndex >= b.startRaw && rawIndex <= b.endRaw);
    if (!mb) return;
    setMarks((prev) => {
      const exists = prev.some((m) => m.middle === mb.index);
      if (exists) return prev.filter((m) => m.middle !== mb.index);
      return [...prev, { middle: mb.index, type: markType }];
    });
  };

  const judgments = useMemo<Judgment[]>(() => {
    if (!submitted) return [];
    const out: Judgment[] = [];
    const markByMiddle = new Map(marks.map((m) => [m.middle, m]));
    const fxByMiddle = new Map(confirmed.map((f) => [f.middle, f]));
    const dateOf = (middle: number) => {
      const mb = result.validBars[middle];
      return mb ? windowBars[mb.startRaw]?.date ?? '?' : '?';
    };
    for (const f of confirmed) {
      const m = markByMiddle.get(f.middle);
      const label = `${f.type === 'top' ? '顶' : '底'} ${dateOf(f.middle)} ${f.price.toFixed(2)}`;
      if (m && m.type === f.type) {
        out.push({ kind: '命中', label, explain: '与算法确认分型一致。' });
      } else if (m) {
        out.push({ kind: '多', label: `你标${m.type === 'top' ? '顶' : '底'} @ ${label}`, explain: `类型不符：算法判定为${f.type === 'top' ? '顶' : '底'}分型。` });
      } else {
        const ev = result.events.find((e) => e.kind === '分型确认' && e.id === f.id);
        out.push({ kind: '漏', label, explain: ev?.reason ?? '算法确认了此分型，你未标出。' });
      }
    }
    for (const m of marks) {
      if (!fxByMiddle.has(m.middle)) {
        const cand = result.fractals.find((f) => f.middle === m.middle && f.status === 'candidate');
        const explain = cand ? '此处只是候选分型（第三根仍可能被合并改写），尚未确认。' : '此处三根结构不构成确认分型。';
        out.push({ kind: '多', label: `你标${m.type === 'top' ? '顶' : '底'} @ ${dateOf(m.middle)}`, explain });
      }
    }
    return out;
  }, [submitted, marks, confirmed, result, windowBars]);

  const hits = judgments.filter((j) => j.kind === '命中').length;
  const miss = judgments.filter((j) => j.kind === '漏').length;
  const extra = judgments.filter((j) => j.kind === '多').length;

  const submit = () => {
    setSubmitted(true);
    const record: PracticeRecord = {
      time: new Date().toISOString(),
      code: meta?.code ?? null,
      configId: result.configId,
      dataAsOf: meta?.dataAsOf ?? null,
      window: [offset, offset + WINDOW],
      seed,
      hits,
      miss,
      extra,
      confirmedCount: confirmed.length,
    };
    const arr = [record, ...loadHistory()].slice(0, 50);
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(arr));
    } catch {
      /* 忽略存储失败 */
    }
    setHistory(arr);
  };

  const layers = { merged: true, fractal: submitted, bi: false, candidate: submitted, segment: false, center: false, divergence: false, point: false, volume: false };

  return (
    <div className="main">
      <div className="chart-col">
        <div className="compare-head">
          <Button onClick={() => reset(seed + 1)}>换一题</Button>
          <div className="field">
            <span className="field-label">标记</span>
            <Select
              value={markType}
              style={{ width: 100 }}
              disabled={submitted}
              options={[{ value: 'top', label: '顶分型' }, { value: 'bottom', label: '底分型' }]}
              onChange={(v) => setMarkType(v as 'top' | 'bottom')}
            />
          </div>
          <Button type="primary" onClick={submit} disabled={submitted || marks.length === 0}>
            提交对照
          </Button>
          {submitted && <Button onClick={() => setSubmitted(false)}>继续修改</Button>}
          <span className="hint">在合并K线上点击标记（再点取消）。题窗 {WINDOW} 根 · 偏移 {offset} · 口径 {configA.biRule}。</span>
        </div>
        <div className="chart-wrap">
          {windowBars.length > 0 ? (
            <Chart bars={windowBars} result={result} layers={layers} onBarClick={onBarClick} hideAnswers={!submitted} userMarks={marks} />
          ) : (
            <div className="empty">加载行情中…</div>
          )}
        </div>
        <div className="replaybar">
          <span className="pos">已标 {marks.length} 处{submitted ? ` · 算法确认 ${confirmed.length} 处` : ''}</span>
          {submitted && (
            <span className="pos" style={{ color: 'var(--gold)' }}>
              命中 {hits} · 漏 {miss} · 多 {extra} · 命中率 {confirmed.length ? Math.round((hits / confirmed.length) * 100) : 0}%
            </span>
          )}
        </div>
      </div>
      <div className="side practice-panel">
        <h3>分型标记练习</h3>
        <div className="hint">先遮答案自己标，再对照算法。每次提交记录口径/数据截至日/题窗，存于本机浏览器，可审计。</div>
        <div className="mark-list" style={{ marginTop: 8 }}>
          {!submitted &&
            marks.map((m, i) => {
              const mb = result.validBars[m.middle];
              const date = mb ? windowBars[mb.startRaw]?.date : '?';
              return (
                <div key={i} className="mark">
                  已标 {m.type === 'top' ? '顶' : '底'} @ {date}
                </div>
              );
            })}
          {submitted &&
            judgments.map((j, i) => (
              <div key={i} className={`mark ${j.kind}`}>
                <Tag color={j.kind === '命中' ? 'success' : j.kind === '漏' ? 'error' : 'warning'} style={{ marginInlineEnd: 6 }}>{j.kind}</Tag>
                {j.label}
                <div className="hint">{j.explain}</div>
              </div>
            ))}
          {marks.length === 0 && !submitted && <div className="hint">尚未标记。点击图中K线开始。</div>}
        </div>
        <h3 style={{ marginTop: 12 }}>练习记录（{history.length}）</h3>
        <div className="mark-list">
          {history.slice(0, 8).map((h, i) => (
            <div key={i} className="hint" style={{ borderBottom: '1px dashed var(--border)', padding: '3px 0' }}>
              {h.time.slice(0, 16).replace('T', ' ')} · {h.code} · 命中{h.hits}/漏{h.miss}/多{h.extra} · 口径{h.configId}
            </div>
          ))}
          {history.length === 0 && <div className="hint">暂无记录。</div>}
        </div>
      </div>
    </div>
  );
}