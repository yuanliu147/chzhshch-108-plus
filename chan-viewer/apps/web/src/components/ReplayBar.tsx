// 回放条：逐根/播放/游标/速度。游标视图＝对前缀重算（引擎前缀一致保证合法）。控件用 antd。
import { useEffect } from 'react';
import { Button, Select, Slider, Space, Tooltip } from 'antd';
import { useStore } from '../store.ts';

// 回放速度档位（毫秒/根）。默认标准档已放慢，便于逐根观察转换事件。
const SPEEDS = [
  { label: '慢速 · 1.2秒/根', value: 1200 },
  { label: '标准 · 0.6秒/根', value: 600 },
  { label: '快速 · 0.25秒/根', value: 250 },
];

export function ReplayBar() {
  const { bars, cursor, playing, playMs, setCursor, step, setPlaying, setPlayMs } = useStore();
  const max = Math.max(0, bars.length - 1);

  useEffect(() => {
    if (!playing) return;
    const t = setInterval(() => {
      const s = useStore.getState();
      if (s.cursor >= Math.max(0, s.bars.length - 1)) {
        s.setPlaying(false);
      } else {
        s.step(1);
      }
    }, playMs);
    return () => clearInterval(t);
  }, [playing, playMs]);

  const date = bars[cursor]?.date ?? '—';
  return (
    <div className="replaybar">
      <Space size={6}>
        <Tooltip title="回到起点"><Button onClick={() => setCursor(0)}>⏮</Button></Tooltip>
        <Tooltip title="上一根"><Button onClick={() => step(-1)}>−1</Button></Tooltip>
        <Button type="primary" onClick={() => setPlaying(!playing)}>{playing ? '⏸ 暂停' : '▶ 播放'}</Button>
        <Tooltip title="下一根"><Button onClick={() => step(1)}>＋1</Button></Tooltip>
        <Tooltip title="到最新"><Button onClick={() => setCursor(max)}>⏭</Button></Tooltip>
      </Space>
      <div className="field speed-field">
        <span className="field-label">速度</span>
        <Select value={playMs} style={{ width: 150 }} options={SPEEDS} onChange={(v) => setPlayMs(v)} />
      </div>
      <Slider
        className="replay-slider"
        min={0}
        max={max}
        value={cursor}
        onChange={(v) => setCursor(v)}
        tooltip={{ formatter: (v) => `第 ${(v ?? 0) + 1} 根` }}
      />
      <span className="pos">第 {cursor + 1} / {bars.length} 根 · {date}</span>
    </div>
  );
}