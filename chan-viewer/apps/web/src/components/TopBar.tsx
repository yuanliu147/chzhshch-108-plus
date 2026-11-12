// 顶栏：标的远程搜索、复权选择、模式切换、数据元信息。标准控件交给 antd。
import { useEffect } from 'react';
import { Segmented, Select, Tag, Tooltip } from 'antd';
import { useStore, type Mode } from '../store.ts';

const MODES: { key: Mode; label: string }[] = [
  { key: 'learn', label: '学习回放' },
  { key: 'compare', label: '口径对比' },
  { key: 'practice', label: '分型练习' },
  { key: 'multi', label: '多周期区间套' },
];

const ADJUSTS = [
  { value: '1', label: '后复权' },
  { value: '2', label: '前复权' },
  { value: '3', label: '不复权' },
];

export function TopBar() {
  const { code, adjust, meta, mode, symbols, searchSymbols, load, setAdjust, setMode } = useStore();

  useEffect(() => {
    void searchSymbols('');
  }, [searchSymbols]);

  const symbolOptions = symbols.map((s) => ({
    value: s.code,
    label: `${s.code} ${s.code_name ?? ''}${s.status === 0 ? ' ·退市' : ''}${s.kind === 'index' ? ' ·指数' : ''}`,
  }));
  if (!symbols.some((s) => s.code === code)) symbolOptions.unshift({ value: code, label: code });

  return (
    <div className="topbar">
      <div className="brand">
        缠论视图<small>包含 · 分型 · 笔 · 线段</small>
      </div>
      <Segmented
        value={mode}
        onChange={(v) => setMode(v as Mode)}
        options={MODES.map((m) => ({ label: m.label, value: m.key }))}
      />
      <div className="field">
        <span className="field-label">标的</span>
        <Select
          showSearch
          filterOption={false}
          value={code}
          style={{ width: 220 }}
          placeholder="代码/名称，如 600000"
          options={symbolOptions}
          onSearch={(v) => void searchSymbols(v)}
          onChange={(c) => void load(c, adjust)}
        />
      </div>
      <div className="field">
        <span className="field-label">复权</span>
        <Select
          value={adjust}
          style={{ width: 96 }}
          options={ADJUSTS}
          onChange={(a) => setAdjust(a)}
          disabled={meta?.kind === 'index'}
        />
      </div>
      <div className="meta">
        {meta && (
          <>
            <span>{meta.codeName ?? meta.code}</span>
            <span>{meta.adjustLabel}</span>
            <span>数据截至 {meta.dataAsOf ?? '—'}</span>
            <span>{meta.count} 根</span>
            {meta.warnings.map((w, i) => (
              <Tooltip key={i} title={w}>
                <Tag color="warning" style={{ cursor: 'help', marginInlineEnd: 0 }}>
                  ⚠ {w.length > 22 ? w.slice(0, 22) + '…' : w}
                </Tag>
              </Tooltip>
            ))}
          </>
        )}
      </div>
    </div>
  );
}