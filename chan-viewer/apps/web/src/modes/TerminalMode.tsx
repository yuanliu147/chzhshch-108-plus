// 默认多周期分析页：日线出发，按需展开相关30分钟、5分钟。当前层是主图，上级保留上下文。
import { useEffect, useMemo, useState } from 'react';
import { Alert, Button, Checkbox, Drawer, Popover, Segmented, Skeleton, Tag, Tooltip } from 'antd';
import type { ComputeResult } from '@chan/engine';
import { LAYER_LABELS, useStore } from '../store.ts';
import { fetchKline, fetchMinCap, fetchMinKline, type KlineMeta, type RawBar } from '../api.ts';
import { Chart } from '../components/Chart.tsx';
import { ConfigPanel } from '../components/ConfigPanel.tsx';
import { coverageSpan, endOf, findBarIndices, parseChinaMs, formatChinaDateTime } from '../chart/timeMapping.ts';
import { evaluatePointConfluence, evaluatePointInvalidation, pointKnownAt } from '../chart/confluence.ts';
import { useAsOfResult, useEngineResults } from '../chart/useEngineResults.ts';
import {
  currentStep, drillDown, goBack, initialNav, jumpTo, requestView, resetNav, selectOnLevel, updateView,
  type Level, type NavState, type NavStep,
} from '../chart/navigation.ts';
import {
  rawRangeOf, STRUCTURE_LABEL, structureAt, structureItem, structureItems,
  type StructureItem, type StructureKind, type StructureRef,
} from '../nest.ts';

const LEVEL_NAME: Record<Level, string> = { d: '日线', m30: '30分钟', m5: '5分钟' };
const NEXT_LEVEL: Record<Level, Level | null> = { d: 'm30', m30: 'm5', m5: null };
const DEFAULT_VISIBLE: Record<Level, number> = { d: 220, m30: 160, m5: 120 };
const LIST_KINDS: { value: StructureKind | 'all'; label: string }[] = [
  { value: 'all', label: '全部' }, { value: 'center', label: '中枢' }, { value: 'segment', label: '线段' },
  { value: 'bi', label: '笔' }, { value: 'divergence', label: '背驰' }, { value: 'point', label: '买卖点' },
  { value: 'fractal', label: '分型' },
];

function shortDate(value: string | undefined) {
  if (!value) return '—';
  return value.includes(' ') ? `${value.slice(5, 10)} ${value.slice(11, 16)}` : value.slice(2);
}

function durationLabel(a: string | undefined, b: string | undefined) {
  const start = a ? parseChinaMs(a) : null;
  const end = b ? parseChinaMs(b) : null;
  if (start == null || end == null || end < start) return '—';
  const days = Math.floor((end - start) / 86_400_000);
  const hours = Math.floor(((end - start) % 86_400_000) / 3_600_000);
  return days > 0 ? `${days}天${hours > 0 ? `${hours}小时` : ''}` : `${hours}小时${Math.floor(((end - start) % 3_600_000) / 60_000)}分`;
}

function rangeFocus(bars: RawBar[], range: [number, number] | null, key: string, minPad: number) {
  if (!range || !bars.length) return null;
  const pad = Math.max(minPad, Math.round((range[1] - range[0]) * 0.25));
  return {
    start: Math.max(0, Math.floor(range[0] - pad)),
    end: Math.min(bars.length - 1, Math.ceil(range[1] + pad)),
    key,
  };
}

/** 下钻后主图限制可读根数；完整选区仍保存在 step.range，滑块可浏览全部历史。 */
function focusForLevel(bars: RawBar[], range: [number, number] | null, level: Level, key: string) {
  if (!range || !bars.length) return null;
  const cap = level === 'm5' ? 360 : level === 'm30' ? 300 : 220;
  const span = range[1] - range[0] + 1;
  const effective: [number, number] = span > cap ? [Math.max(range[0], range[1] - cap + 1), range[1]] : range;
  return rangeFocus(bars, effective, `${key}:${effective[0]}:${effective[1]}`, level === 'd' ? 18 : 12);
}

function structureRange(result: ComputeResult, bars: RawBar[], ref: StructureRef | null): [number, number] | null {
  const raw = ref ? rawRangeOf(result, ref) : null;
  if (!raw) return null;
  const span = coverageSpan(bars, [Math.max(0, Math.floor(raw[0])), Math.min(bars.length - 1, Math.ceil(raw[1]))]);
  if (!span) return null;
  const idx = findBarIndices(bars, span);
  return idx.length ? [idx[0]!, idx[idx.length - 1]!] : null;
}

/** 由当前结构或当前视窗覆盖映射到下一周期的真实 bar 下标；没有覆盖返回 null。 */
function mapToNextBars(step: NavStep, currentBars: RawBar[], nextBars: RawBar[], result: ComputeResult): [number, number] | null {
  let range = structureRange(result, currentBars, step.ref);
  if (!range && step.view) range = [step.view.start, step.view.end];
  if (!range) range = [Math.max(0, currentBars.length - DEFAULT_VISIBLE[step.level]), currentBars.length - 1];
  const span = coverageSpan(currentBars, range);
  if (!span) return null;
  const indices = findBarIndices(nextBars, span);
  return indices.length ? [indices[0]!, indices[indices.length - 1]!] : null;
}

function PeriodHeader({ title, role, range, active, onLocate, compact }: { title: string; role: string; range: string; active?: boolean; onLocate: () => void; compact?: boolean }) {
  return (
    <div className={`period-head${compact ? ' is-compact' : ''}`}>
      <div className="period-title"><strong>{title}</strong><span>{role}</span>{active && <i>当前</i>}</div>
      <div className="period-range">{range}</div>
      <Button type="text" size="small" onClick={onLocate}>重新定位</Button>
    </div>
  );
}

function StructureRows({ items, bars, selected, onSelect }: { items: StructureItem[]; bars: RawBar[]; selected: StructureRef | null; onSelect: (ref: StructureRef) => void }) {
  if (!items.length) return <div className="inspector-empty">当前窗口暂无已识别结构</div>;
  return (
    <div className="structure-list">
      {items.map((item) => {
        const active = selected?.kind === item.kind && selected.id === item.id;
        const date = shortDate(bars[Math.max(0, Math.min(bars.length - 1, Math.round(item.endRaw)))]?.date);
        return (
          <button type="button" key={`${item.kind}:${item.id}`} className={`structure-row${active ? ' is-selected' : ''}`} onClick={() => onSelect({ kind: item.kind, id: item.id })} title={`${item.label} · ${item.description}`}>
            <span className={`structure-kind k-${item.kind}`}>{item.label}</span>
            <span className="structure-desc">{item.description}</span>
            <span className="structure-date">{date}{item.status === 'candidate' ? ' · 候选' : ''}</span>
          </button>
        );
      })}
    </div>
  );
}

export function TerminalMode() {
  const code = useStore((s) => s.code);
  const configA = useStore((s) => s.configA);
  const setConfigA = useStore((s) => s.setConfigA);
  const layers = useStore((s) => s.layers);
  const toggleLayer = useStore((s) => s.toggleLayer);
  const resetLayers = useStore((s) => s.resetLayers);
  const mergeStyle = useStore((s) => s.mergeStyle);
  const setMergeStyle = useStore((s) => s.setMergeStyle);
  const [d, setD] = useState<RawBar[]>([]);
  const [m30, setM30] = useState<RawBar[]>([]);
  const [m5, setM5] = useState<RawBar[]>([]);
  const [dailyMeta, setDailyMeta] = useState<KlineMeta | null>(null);
  const [minuteAvailable, setMinuteAvailable] = useState(false);
  const [warn, setWarn] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [nav, setNav] = useState<NavState>(initialNav);
  const [listScope, setListScope] = useState<'view' | 'all'>('view');
  const [listKind, setListKind] = useState<StructureKind | 'all'>('segment');
  const [listPage, setListPage] = useState(1);
  const [hoverTime, setHoverTime] = useState<number | null>(null);
  const [measureMode, setMeasureMode] = useState(false);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let dead = false;
    setLoading(true); setErr(null); setNotice(null); setMinuteAvailable(false); setNav((old) => resetNav(old)); setD([]); setM30([]); setM5([]);
    (async () => {
      try {
        const daily = await fetchKline(code, '3', 0);
        if (dead) return;
        setD(daily.bars); setDailyMeta(daily.meta);
        setWarn(daily.meta.warnings);
        setLoading(false);
      } catch (e) {
        if (!dead) { setErr(String(e instanceof Error ? e.message : e)); setLoading(false); }
        return;
      }
      try {
        const cap = await fetchMinCap(code);
        if (dead) return;
        setMinuteAvailable(cap.hasMin);
        if (!cap.hasMin) {
          setWarn((old) => [...new Set([...old, '该标的没有分钟线数据；日线可正常分析，30分钟/5分钟下钻不可用。'])]);
          return;
        }
        const [mm30, mm5] = await Promise.all([fetchMinKline(code, 30, 0), fetchMinKline(code, 5, 0)]);
        if (dead) return;
        setM30(mm30.bars); setM5(mm5.bars);
        setWarn((old) => [...new Set([...old, ...mm30.meta.warnings, ...mm5.meta.warnings])]);
        const partial = (mm30.meta.partialBars ?? 0) + (mm5.meta.partialBars ?? 0);
        if (partial > 0) setWarn((old) => [...new Set([...old, `分钟数据有 ${partial} 根不完整柱；相关判断会按待确认或数据不足显示。`])]);
      } catch (e) {
        if (!dead) {
          setMinuteAvailable(false);
          setWarn((old) => [...new Set([...old, `分钟数据加载失败：${String(e instanceof Error ? e.message : e)}；日线不受影响。`])]);
        }
      }
    })();
    return () => { dead = true; };
  }, [code, reload]);

  // 口径改变后旧id不再代表同一来源；保留时间视窗，但清空结构选中。
  useEffect(() => {
    setNav(old => old.path.some(step => step.ref) ? { ...old, path: old.path.map(step => ({ ...step, ref: null })) } : old);
  }, [configA]);

  const { results, error: computeError, errors: levelErrors } = useEngineResults(d, m30, m5, configA);
  const barsOf: Record<Level, RawBar[]> = { d, m30, m5 };
  const cur = currentStep(nav);
  const curResult = results[cur.level];
  const curBars = barsOf[cur.level];
  const curItem = curResult && cur.ref ? structureItem(curResult, cur.ref) : null;
  const currentIndex = nav.path.length - 1;
  const nextLevel = NEXT_LEVEL[cur.level];
  const nextAvailable = nextLevel != null && !!results[nextLevel] && barsOf[nextLevel].length > 0;

  const nextFocusRange = useMemo(() => {
    if (!nextLevel || !curResult) return null;
    return mapToNextBars(cur, curBars, barsOf[nextLevel], curResult);
  }, [nextLevel, curResult, cur, curBars, m30, m5]);

  const viewRangeText = (level: Level, step: NavStep) => {
    if (step.view) {
      return `${shortDate(barsOf[level][step.view.start]?.date)} 至 ${shortDate(barsOf[level][step.view.end]?.date)} · 可见 ${step.view.end - step.view.start + 1}/${barsOf[level].length} 根`;
    }
    return step.range
      ? `${shortDate(barsOf[level][step.range[0]]?.date)} 至 ${shortDate(barsOf[level][step.range[1]]?.date)}`
      : `共 ${barsOf[level].length} 根`;
  };

  const handleDrill = () => {
    if (!nextLevel) return;
    if (!minuteAvailable || !nextAvailable) { setNotice(`${LEVEL_NAME[nextLevel]} 无可用数据，不能生成该层结构。`); return; }
    if (!nextFocusRange) {
      setNotice(`当前范围与 ${LEVEL_NAME[nextLevel]} 数据不重叠，未建立伪关联。请回到有分钟数据的日期再下钻。`);
      return;
    }
    setNotice(null);
    const focus = focusForLevel(barsOf[nextLevel], nextFocusRange, nextLevel, `drill:${nextLevel}`);
    setNav((old) => requestView(drillDown(old, nextFocusRange), nextLevel, focus ? [focus.start, focus.end] : nextFocusRange));
    setListPage(1);
  };

  const handleSelect = (level: Level, ref: StructureRef, locateObject = false) => {
    const result = results[level];
    const range = result ? rawRangeOf(result, ref) : null;
    const focus = rangeFocus(barsOf[level], range, `object:${ref.kind}:${ref.id}`, level === 'd' ? 18 : 12);
    setNav((old) => {
      const selected = selectOnLevel(old, level, ref);
      return locateObject && focus ? requestView(selected, level, [focus.start, focus.end]) : selected;
    });
    setListPage(1);
  };
  const selectAt = (level: Level, result: ComputeResult, index: number) => {
    const ref = structureAt(result, index);
    if (ref) handleSelect(level, ref);
    else setNotice('该位置没有可定位结构；可调节当前视窗后按“按当前视窗进入内部”。');
  };
  const clearCurrent = () => setNav((old) => selectOnLevel(old, cur.level, null));
  const restore = () => {
    setNav((old) => resetNav(old)); setNotice(null); setListPage(1);
  };
  const back = () => { setNav((old) => goBack(old)); setNotice(null); setListPage(1); };
  const jump = (level: Level) => { setNav((old) => jumpTo(old, level)); setNotice(null); setListPage(1); };
  const locate = (level: Level) => {
    const step = nav.path.find((s) => s.level === level);
    const result = results[level];
    if (!step || !result) return;
    const range = step.ref ? rawRangeOf(result, step.ref) : null;
    const focus = range
      ? rangeFocus(barsOf[level], range, `locate:${level}`, level === 'd' ? 18 : 12)
      : focusForLevel(barsOf[level], step.range, level, `locate:${level}`);
    setNav((old) => requestView(old, level, focus ? [focus.start, focus.end] : null));
  };

  // 仅结构身份变化才重建高亮；viewport 回写不改变装饰引用。
  const selectionKey = nav.path.map((s) => `${s.level}:${s.ref?.kind}:${s.ref?.id}`).join('|');
  const highlights = useMemo(() => Object.fromEntries(nav.path.map((s) => {
    const result = results[s.level];
    return [s.level, result && s.ref ? rawRangeOf(result, s.ref) : null];
  })) as Partial<Record<Level, [number, number] | null>>, [selectionKey, results]);

  // 所有上级投影当前主图的真实视窗；主图平移不能继续显示中间层的旧覆盖。
  const childViewsKey = nav.path.slice(1).map((s) => `${s.level}:${s.view?.start}:${s.view?.end}`).join('|');
  const contextBands = useMemo(() => nav.path.map((step, i) => {
    if (i >= nav.path.length - 1) return null;
    const child = nav.path[nav.path.length - 1]!;
    if (!child.view) return null;
    const childBars = barsOf[child.level];
    const span = coverageSpan(childBars, [child.view.start, child.view.end]);
    if (!span) return null;
    const idx = findBarIndices(barsOf[step.level], span);
    return idx.length ? [idx[0]!, idx[idx.length - 1]!] as [number, number] : null;
  }), [childViewsKey, d, m30, m5]);

  const selectedPoint = cur.ref?.kind === 'point' ? curResult?.points.find(p => p.id === cur.ref!.id) ?? null : null;
  const evidenceAsOfMs = selectedPoint ? pointKnownAt(selectedPoint, curBars) : null;
  const lowerAsOf = useAsOfResult(selectedPoint ? nextLevel : null, nextLevel ? barsOf[nextLevel] : m5, configA, evidenceAsOfMs);
  const pointConfluence = useMemo(() => {
    if (!curResult || !selectedPoint) return null;
    const low = lowerAsOf.result;
    const decision = evaluatePointConfluence(
      selectedPoint,
      { levelName: LEVEL_NAME[cur.level], result: curResult, bars: curBars },
      nextLevel && low ? { levelName: LEVEL_NAME[nextLevel], result: low, bars: barsOf[nextLevel] } : nextLevel && results[nextLevel] ? { levelName: LEVEL_NAME[nextLevel], result: results[nextLevel]!, bars: barsOf[nextLevel] } : null,
      evidenceAsOfMs ?? undefined,
    );
    return lowerAsOf.error ? { ...decision, status: '数据不足' as const, summary: '子级截止快照计算失败，不能以最新结果代替历史证据。' } : decision;
  }, [curResult, selectedPoint, cur.level, curBars, nextLevel, lowerAsOf.result, lowerAsOf.error, evidenceAsOfMs, results, m30, m5]);
  const latestInvalidation = useMemo(() => selectedPoint && curResult && curBars.length
    ? evaluatePointInvalidation(selectedPoint, { levelName: LEVEL_NAME[cur.level], result: curResult, bars: curBars }, endOf(curBars[curBars.length - 1]!)) : null,
  [selectedPoint, curResult, cur.level, curBars]);
  const computationWarnings = [levelErrors.m30 && `30分钟计算失败：${levelErrors.m30}；日线保持可用`, levelErrors.m5 && `5分钟计算失败：${levelErrors.m5}；日线保持可用`].filter(Boolean);

  const allListItems = useMemo(() => {
    if (!curResult) return [];
    const start = cur.view?.start ?? Math.max(0, curBars.length - DEFAULT_VISIBLE[cur.level]);
    const end = cur.view?.end ?? curBars.length - 1;
    return structureItems(curResult)
      .filter((x) => (listScope === 'all' || (x.endRaw >= start && x.startRaw <= end)) && (listKind === 'all' || x.kind === listKind))
      .sort((a, b) => b.endRaw - a.endRaw || a.kind.localeCompare(b.kind));
  }, [curResult, curBars, cur.view, cur.level, listScope, listKind]);
  const listVisible = allListItems.slice(0, listPage * 80);

  if (err || computeError) return <div className="multi-error"><Alert type="warning" showIcon message={err ?? computeError ?? '计算失败'} /><Button onClick={() => setReload(n => n + 1)}>重新加载行情</Button></div>;
  if (!loading && !d.length) return <div className="multi-error"><Alert type="info" showIcon message="该标的日线区间暂无行情，可换标的或重新加载。" /><Button onClick={() => setReload(n => n + 1)}>重新加载行情</Button></div>;
  if (loading || !results.d) return <div className="multi-loading"><Skeleton active paragraph={{ rows: 10 }} /></div>;

  const layerCount = Object.values(layers).filter(Boolean).length;
  const isIndex = dailyMeta?.kind === 'index';
  const priceUnit = isIndex ? '点' : '元';
  const layerContent = (
    <div className="layer-popover">
      <div className="layer-popover-head"><span>统一图层</span><Button type="link" size="small" onClick={resetLayers}>恢复默认</Button></div>
      {LAYER_LABELS.map((item) => <Checkbox key={item.key} checked={layers[item.key]} onChange={() => toggleLayer(item.key)}>{item.label}</Checkbox>)}
      <div className="layer-popover-note">全量结构保留；缩放只影响标签密度，不丢失全量对象。</div>
    </div>
  );

  return (
    <div className="multi-page">
      <div className="multi-toolbar">
        <div className="instrument-block">
          <div><strong>{dailyMeta?.codeName ?? code}</strong><span>{code}</span><Tag>日线主分析</Tag></div>
          <span>日线全量 {d.length} 根 · 分钟 {minuteAvailable ? `${m30.length}/${m5.length} 根` : '不可用'} · 统一不复权 · 价格单位 {priceUnit}</span>
        </div>
        <div className="terminal-legend" aria-label="统一图例">
          <span><i className="lg-up" />涨</span><span><i className="lg-down" />跌</span>
          <span><i className="lg-bi" />笔</span><span><i className="lg-segment" />线段</span><span><i className="lg-center" />中枢</span>
        </div>
        <div className="multi-tools">
          <Popover content={layerContent} trigger="click" placement="bottomLeft"><Button size="small">图层 {layerCount}/{LAYER_LABELS.length}</Button></Popover>
          <Segmented className="merge-switch" size="small" value={mergeStyle} onChange={(v) => setMergeStyle(v as 'outline' | 'solid')} options={[{ label: '原始实体', value: 'outline' }, { label: '合并实体', value: 'solid' }]} />
          <Tooltip title="两点测距：价差/百分比/K线根数/自然间隔；不改变结构">
            <Button size="small" type={measureMode ? 'primary' : 'default'} onClick={() => setMeasureMode((v) => !v)}>测距</Button>
          </Tooltip>
          <Button size="small" onClick={() => setDrawerOpen(true)}>口径设置</Button>
        </div>
      </div>

      <div className="drillbar">
        <div className="drill-path">
          {nav.path.map((step, i) => (
            <span key={step.level}>
              {i > 0 && <b>›</b>}
              <button type="button" className={i === currentIndex ? 'is-current' : ''} onClick={() => jump(step.level)}>
                {LEVEL_NAME[step.level]}{step.ref ? `·${STRUCTURE_LABEL[step.ref.kind]}` : ''}
              </button>
            </span>
          ))}
          <span className="drill-hint">当前层是主图；上级保留上下文。单击选中，按钮下钻。</span>
        </div>
        <div className="drill-actions">
          <Button size="small" type="text" disabled={nav.path.length <= 1} onClick={back}>返回上级</Button>
          <Button size="small" type="text" disabled={!cur.ref} onClick={clearCurrent}>清除选中</Button>
          <Button size="small" type="text" onClick={() => locate(cur.level)}>重新定位</Button>
          <Button size="small" onClick={restore}>恢复全局</Button>
          {nextLevel ? <Tooltip title={!nextAvailable ? `${LEVEL_NAME[nextLevel]} 数据不可用或会超出分钟覆盖` : '使用当前结构或当前视窗的真实时间覆盖'}>
            <Button size="small" type="primary" disabled={!curResult || !nextAvailable} onClick={handleDrill}>
              {cur.ref ? `查看${LEVEL_NAME[nextLevel]}内部` : `按当前视窗进入${LEVEL_NAME[nextLevel]}`}
            </Button>
          </Tooltip> : <Tag>5分钟 · 已到支持下限</Tag>}
        </div>
      </div>
      {(warn.length > 0 || notice || computationWarnings.length > 0) && <div className="multi-notice" role="status">{[notice, ...new Set(warn), ...computationWarnings].filter(Boolean).join('；')}</div>}

      <div className="multi-workspace">
        <div className={`multi-charts layout-stack depth-${nav.path.length}`}>
          {nav.path.map((step, i) => {
            const result = results[step.level];
            if (!result) return <section key={step.level} className={`multi-chart period-${step.level} ${i === currentIndex ? 'is-primary' : 'is-context'}`}>
              <PeriodHeader title={LEVEL_NAME[step.level]} role="日线上下文保持可用" range={viewRangeText(step.level, step)} onLocate={() => locate(step.level)} />
              <div className="period-canvas">{levelErrors[step.level] ? <Alert type="warning" showIcon message={`${LEVEL_NAME[step.level]}计算失败，可返回上级继续分析。`} /> : <Skeleton active paragraph={{ rows: 4 }} />}</div>
            </section>;
            const bars = barsOf[step.level];
            const primary = i === currentIndex;
            const item = step.ref ? structureItem(result, step.ref) : null;
            const hi = highlights[step.level] ?? null;
            return (
              <section key={step.level} className={`multi-chart period-${step.level} ${primary ? 'is-primary' : 'is-context'}`}>
                <PeriodHeader title={LEVEL_NAME[step.level]} role={primary ? (step.level === 'd' ? '主分析 · 先看结构，再决定下钻' : '当前内部结构') : '上级上下文 · 点击可返回'} range={viewRangeText(step.level, step)} active={!!step.ref} compact={!primary} onLocate={() => locate(step.level)} />
                <div className="period-canvas">
                  <Chart
                    bars={bars} result={result} layers={layers} selected={step.ref} highlight={hi}
                    contextBand={contextBands[i] ?? null} syncHoverTime={hoverTime}
                    viewRequest={step.viewRequest} defaultVisible={DEFAULT_VISIBLE[step.level]} semantic
                    showChrome={false} allowMacd={primary} showSlider={primary} showLastPrice={primary}
                    showVolume={primary} showDataWindow={primary} compactContext={!primary} measureMode={primary && measureMode}
                    pricePrecision={2} priceUnit={priceUnit} volumeUnit={isIndex ? '源单位' : '股'}
                    onStructureClick={(ref) => handleSelect(step.level, ref)}
                    onBarClick={(idx) => selectAt(step.level, result, idx)}
                    onHoverIndex={(idx) => setHoverTime(idx == null ? null : endOf(bars[idx]!) ?? null)}
                    onViewportChange={(start, end) => setNav((old) => updateView(old, step.level, { start, end, total: bars.length }))}
                  />
                </div>
                {!primary && item && <div className="context-selection">{item.label} · {shortDate(bars[Math.round(item.startRaw)]?.date)}—{shortDate(bars[Math.round(item.endRaw)]?.date)}</div>}
              </section>
            );
          })}
        </div>

        <aside className="multi-side">
          <section className="inspector-section config-summary">
            <div className="inspector-title"><h3>当前口径</h3><Button type="link" size="small" onClick={() => setDrawerOpen(true)}>完整设置与原文</Button></div>
            <div className="config-tags"><Tag>{configA.biRule}</Tag><Tag>{configA.centerUnit}</Tag><Tag>{configA.divMetric}</Tag></div>
            <dl><div><dt>包含方向</dt><dd>{configA.mergeDir}</dd></div><div><dt>特征序列</dt><dd>{configA.segMerge}</dd></div><div><dt>价格单位</dt><dd>{priceUnit}（{isIndex ? '指数点' : '股票元'}）</dd></div></dl>
          </section>

          {curResult ? <><section className="inspector-section current-object">
            <div className="inspector-title"><h3>{LEVEL_NAME[cur.level]}当前对象</h3>{curItem && <Tag color={curItem.status === 'candidate' ? 'warning' : 'blue'}>{curItem.status === 'candidate' ? '候选/运行中' : '已确认'}</Tag>}</div>
            {curItem ? <>
              <div className="object-name">{curItem.label}</div>
              <div className="object-description">{curItem.description}</div>
              <div className="object-time">{shortDate(curBars[Math.round(curItem.startRaw)]?.date)} 至 {shortDate(curBars[Math.round(curItem.endRaw)]?.date)}</div>
              <div className="object-deps">
                <span>
                  {Math.max(0, Math.round(curItem.endRaw) - Math.round(curItem.startRaw) + 1)} 根 ·
                  自然时长 {durationLabel(curBars[Math.round(curItem.startRaw)]?.date, curBars[Math.round(curItem.endRaw)]?.date)} ·
                  端点 {shortDate(curBars[Math.round(curItem.startRaw)]?.date)}—{shortDate(curBars[Math.round(curItem.endRaw)]?.date)}
                </span>
                {curItem.kind === 'segment' && (() => {
                  const s = curResult?.segments.find((x) => x.id === curItem.id);
                  return s ? <span>价格包络 {priceUnit} {s.low.toFixed(2)}–{s.high.toFixed(2)} · 幅度 {((s.high - s.low) / Math.max(0.0001, s.low) * 100).toFixed(2)}%</span> : null;
                })()}
                {curItem.kind === 'center' && (() => {
                  const c = curResult?.centers.find((x) => x.id === curItem.id);
                  return c ? <>
                    <span>核心 ZD {c.ZD.toFixed(2)} / ZG {c.ZG.toFixed(2)} · 核心宽度 {((c.ZG - c.ZD) / Math.max(0.0001, c.ZD) * 100).toFixed(2)}% · 外围 {c.DD.toFixed(2)}–{c.GG.toFixed(2)}</span>
                    <span>形成位置 {shortDate(c.formedRaw == null ? undefined : curBars[Math.round(c.formedRaw)]?.date)} · 首次可知 {shortDate(curBars[Math.round(c.formedAt)]?.date)}</span>
                    <span>{c.evolution === 'forming' ? '已形成未终结' : c.evolution === 'extending' ? '延伸中' : c.evolution === 'upgraded' ? '九段升级终结' : '已终结'}{c.terminatedAt != null ? ` · 终结位置 ${shortDate(curBars[Math.round(c.terminatedRaw ?? c.endRaw)]?.date)} · 终结首次可知 ${shortDate(curBars[Math.round(c.terminatedAt)]?.date)}` : ''} · {c.segCount}构件 · {c.relation === 'expanded' ? '相对前中枢扩展' : c.relation === 'new' ? '相对前中枢新生' : '首个中枢'}</span>
                  </> : null;
                })()}
                {curItem.kind === 'point' && pointConfluence && (
                  <div className={`confluence is-${pointConfluence.status}`}>
                    <div className="confluence-head"><Tag color={pointConfluence.status === '支持' ? 'success' : pointConfluence.status === '冲突' ? 'error' : pointConfluence.status === '不支持' ? 'default' : 'warning'}>{pointConfluence.status}</Tag><strong>跨级别研究证据</strong><span>{pointConfluence.ruleId}</span></div>
                    <p>历史截止：{pointConfluence.asOfMs == null ? '暂无可验证的首次可知时刻' : formatChinaDateTime(pointConfluence.asOfMs, true)}</p>
                    <p>{pointConfluence.summary}</p>
                    {lowerAsOf.error && <p>截止快照计算失败：{lowerAsOf.error}；不使用最新全量结果补证据。</p>}
                    {pointConfluence.evidence.map((e, i) => <p key={i} className="confluence-evidence"><b>{e.level}</b> · {e.status} · {e.detail}</p>)}
                    <p>最新失效检查（{curBars[curBars.length - 1]?.date ?? '—'}）：{latestInvalidation ? <><Tag color="error">冲突</Tag>{latestInvalidation.detail}</> : '未发现截止前已验证的失效证据'}；不覆盖历史状态。</p>
                    <p className="confluence-note">研究假设，不修改原文买卖点，也不构成收益验证。</p>
                  </div>
                )}
                <span>周期 {LEVEL_NAME[cur.level]}；结构级别以引擎 degree 为准，不把看图周期自动当缠论上级。</span>
              </div>
              <div className="object-actions">
                {nextLevel ? <Button size="small" type="primary" disabled={!curResult || !nextAvailable} onClick={handleDrill}>查看{LEVEL_NAME[nextLevel]}内部</Button> : <Tag>5分钟 · 已到支持下限</Tag>}
              </div>
            </> : <div className="object-default">
              <strong>{LEVEL_NAME[cur.level]} · 全局分析</strong>
              <span>{curResult!.segments.length} 线段 · {curResult!.centers.length} 中枢 · {curResult!.bis.length} 笔 · {curResult!.points.length} 买卖点</span>
              <span>结构级别 {curResult!.levels.length} 层 · 价格单位 {priceUnit} · 成交量源单位在图表数据窗列明</span>
              {curResult!.segments.length === 0 && <span>当前窗口还没有完成线段；不代表数据缺失。</span>}
              {curResult!.centers.length === 0 && curResult!.bis.length > 0 && <span>当前“{configA.centerUnit}”口径无中枢，可切换笔中枢对照，不伪造标记。</span>}
            </div>}
          </section>

          <section className="inspector-section levels-summary">
            <div className="inspector-title"><h3>结构递归</h3><span>{LEVEL_NAME[cur.level]} · {curResult!.levels.length} 层</span></div>
            <div className="levels-list">
              {curResult!.levels.map((lv) => (
                <div key={lv.degree} className={`level-row${lv.completed.length ? ' has-completed' : ''}`}>
                  <b>degree {lv.degree}</b>
                  <span>{lv.degree === 0 ? `基础构件 ${lv.basis === 'bi' ? curResult!.bis.filter(b => b.status === 'confirmed').length : curResult!.segments.filter(s => s.status === 'confirmed').length} 个` : `${lv.centers.length} 中枢 · ${lv.trends.length} 走势 · 已完成 ${lv.completed.length}`}</span>
                  <i>{lv.note}</i>
                </div>
              ))}
            </div>
            <div className="inspector-help">degree 是结构递归深度，不是 5/30/日线周期；不足三个完成子级走势时自然停止。</div>
          </section>

          <section className="inspector-section related-section">
            <div className="inspector-title">
              <h3>{LEVEL_NAME[cur.level]}结构</h3><span>{allListItems.length} 项</span>
            </div>
            <div className="list-filter">
              <Segmented size="small" value={listScope} onChange={(v) => { setListScope(v as 'view' | 'all'); setListPage(1); }} options={[{ label: '当前视窗', value: 'view' }, { label: '全部历史', value: 'all' }]} />
              <Segmented size="small" value={listKind} onChange={(v) => { setListKind(v as StructureKind | 'all'); setListPage(1); }} options={LIST_KINDS} />
            </div>
            <div className="inspector-help">列表点击选中并定位一次，不自动跳层；图上点击只选中。</div>
            <StructureRows items={listVisible} bars={curBars} selected={cur.ref} onSelect={(ref) => handleSelect(cur.level, ref, true)} />
            {allListItems.length > listVisible.length && <Button size="small" type="link" onClick={() => setListPage((n) => n + 1)}>继续加载（{listVisible.length}/{allListItems.length}）</Button>}
          </section></> : <section className="inspector-section"><Alert type={levelErrors[cur.level] ? 'warning' : 'info'} showIcon message={levelErrors[cur.level] ?? `${LEVEL_NAME[cur.level]}正在计算，日线上下文保持可用。`} /><Button size="small" onClick={back}>返回上级继续分析</Button></section>}
        </aside>
      </div>

      <Drawer title="三周期共用口径" size={420} open={drawerOpen} onClose={() => setDrawerOpen(false)} destroyOnHidden>
        <div className="drawer-note">设置同时作用于日线、30分钟和5分钟。下钻只能使用真实重叠的分钟数据；时间重合不是结构父子证明。</div>
        <ConfigPanel config={configA} onChange={setConfigA} />
      </Drawer>
    </div>
  );
}
