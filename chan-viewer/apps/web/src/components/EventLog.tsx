// 事件日志：按时间倒序，点事件→图上高亮 refs。原因+课号引文。
import type { ComputeResult } from '@chan/engine';
import { useStore } from '../store.ts';

export function EventLog({ result }: { result: ComputeResult }) {
  const setHighlight = useStore((s) => s.setHighlight);
  const events = [...result.events].reverse();
  return (
    <div>
      <h3>转换事件日志（{events.length}）</h3>
      <div className="hint">每根K线到达触发的合并/分型/笔事件，含原因与课号。点击在图上高亮。</div>
      <div className="events" style={{ marginTop: 8 }}>
        {events.length === 0 && <div className="hint">暂无事件。拖动回放游标逐步观察。</div>}
        {events.map((e, i) => (
          <div key={i} className={`event k-${e.kind}`} onClick={() => setHighlight(e.refs)}>
            <div className="e-head">
              <span className="e-kind">{e.kind}</span>
              <span className="e-at">#{e.at}</span>
              <span className="e-cite">{e.cite.map((c) => `${c}课`).join(' ')}</span>
            </div>
            <div className="e-reason">{e.reason}</div>
          </div>
        ))}
      </div>
    </div>
  );
}