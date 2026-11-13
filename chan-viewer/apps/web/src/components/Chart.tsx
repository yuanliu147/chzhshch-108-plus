// ECharts K线渲染：原始K线 + 合并K线/分型/笔 叠加图层。
// 坐标系按交易终端惯例精修：右侧价格轴、最新价标签、月界网格与智能日期刻度、
// 调色板十字光标、定制 dataZoom、图例直标（8 色可分离）。
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { Button, Segmented, Tooltip } from 'antd';
import * as echarts from 'echarts/core';
import { CandlestickChart, CustomChart, ScatterChart, LineChart, BarChart } from 'echarts/charts';
import { GridComponent, TooltipComponent, DataZoomComponent, MarkLineComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import type { ComputeResult, Fractal } from '@chan/engine';
import type { RawBar } from '../api.ts';
import { findBarIndexAtTime, parseChinaMs } from '../chart/timeMapping.ts';
import type { StructureRef } from '../nest.ts';
import type { ViewRequest } from '../chart/navigation.ts';
import { useStore, type Layers } from '../store.ts';

echarts.use([CandlestickChart, CustomChart, ScatterChart, LineChart, BarChart, GridComponent, TooltipComponent, DataZoomComponent, MarkLineComponent, CanvasRenderer]);

// 主题色：涨跌红绿（A股惯例）+ 结构层各自独立色相，图例直标保证可分离。
const C = {
  up: '#ff5c5c',
  down: '#2fd08c',
  merged: '#4c8dff',
  bi: '#ffd43b',
  segment: '#9ece6a',
  center: '#a855f7',
  divergence: '#ff7a45',
  top: '#ff4fd8',
  bottom: '#35e0ff',
  candidate: '#ffb020',
  mark: '#b197fc',
  grid: 'rgba(215,222,239,0.07)',
  gridV: 'rgba(215,222,239,0.045)',
  axis: 'rgba(215,222,239,0.20)',
  label: '#8b96b3',
  text: '#d7deef',
  surface: '#171e2e',
  surface2: '#1f2840',
  accent: '#4c8dff',
};

export interface ChartProps {
  bars: RawBar[];
  result: ComputeResult;
  layers: Layers;
  highlight?: number[] | null;
  /** 上级上下文中的子层视窗覆盖带；与选中结构高亮区分颜色。 */
  contextBand?: [number, number] | null;
  /** 其他周期传来的真实 bar 结束时刻；跨图显示同一时间光标。 */
  syncHoverTime?: number | null;
  measureMode?: boolean;
  onBarClick?: (rawIndex: number) => void;
  hideAnswers?: boolean;
  userMarks?: { middle: number; type: 'top' | 'bottom' }[];
  /** 图例行首标题（对比模式的 口径A/B）。 */
  label?: string;
  /** 多周期结构选中与精确定位。 */
  selected?: StructureRef | null;
  onStructureClick?: (ref: StructureRef) => void;
  focus?: { start: number; end: number; key: string } | null;
  viewRequest?: ViewRequest | null;
  resetKey?: number;
  defaultVisible?: number;
  /** 语义缩放：全局看线段/中枢，中景看笔，局部再看分型与包含。 */
  semantic?: boolean;
  showChrome?: boolean;
  allowMacd?: boolean;
  showSlider?: boolean;
  showLastPrice?: boolean;
  showVolume?: boolean;
  showDataWindow?: boolean;
  /** 上级上下文缩略图：隐藏时间轴、tooltip与副图，只保留价格/结构和跨图光标。 */
  compactContext?: boolean;
  pricePrecision?: number;
  priceUnit?: string;
  volumeUnit?: string;
  onViewportChange?: (start: number, end: number) => void;
  onHoverIndex?: (index: number | null) => void;
}

function fxPoint(f: Fractal, r: ComputeResult): { x: number; y: number } | null {
  const mb = r.validBars[f.middle];
  if (!mb) return null;
  return { x: (mb.startRaw + mb.endRaw) / 2, y: f.type === 'top' ? mb.high : mb.low };
}

interface MeasurePoint {
  index: number;
  price: number;
}

/** 两点测距只做图形叠层，不改变缩放和结构计算。 */
function drawMeasure(chart: echarts.ECharts, points: readonly MeasurePoint[], precision: number) {
  if (!points.length) return;
  const graphic: any[] = [];
  const pixels = points.map((p) => chart.convertToPixel({ xAxisIndex: 0, yAxisIndex: 0 }, [p.index, p.price]) as number[]);
  if (pixels[0]) {
    graphic.push({ type: 'circle', shape: { cx: pixels[0][0]!, cy: pixels[0][1]!, r: 3 }, style: { fill: '#ffd43b', stroke: '#0f1420', lineWidth: 1 }, z: 100 });
  }
  if (pixels[0] && pixels[1]) {
    const [x1, y1] = pixels[0] as [number, number];
    const [x2, y2] = pixels[1] as [number, number];
    const diff = points[1]!.price - points[0]!.price;
    const pct = points[0]!.price === 0 ? 0 : diff / points[0]!.price * 100;
    graphic.push(
      { type: 'line', shape: { x1, y1, x2, y2 }, style: { stroke: '#ffd43b', lineWidth: 1, lineDash: [4, 3], opacity: 0.9 }, z: 100 },
      { type: 'line', shape: { x1, y1, x2: x1, y2 }, style: { stroke: 'rgba(255,212,59,0.65)', lineWidth: 1 }, z: 100 },
      { type: 'line', shape: { x1: x2, y1, x2, y2 }, style: { stroke: 'rgba(255,212,59,0.65)', lineWidth: 1 }, z: 100 },
      { type: 'circle', shape: { cx: x2, cy: y2, r: 3 }, style: { fill: '#ffd43b', stroke: '#0f1420', lineWidth: 1 }, z: 100 },
      {
        type: 'text', left: (x1 + x2) / 2 + 6, top: Math.min(y1, y2) - 20,
        style: { text: `${diff >= 0 ? '+' : ''}${diff.toFixed(precision)} / ${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`, fill: '#ffe08a', font: '11px sans-serif', backgroundColor: 'rgba(15,20,32,.88)', padding: [2, 5] },
        z: 101,
      },
    );
  }
  chart.setOption({ graphic: [{ id: 'measure-overlay', type: 'group', $action: 'replace', children: graphic }] });
}

function defaultWindow(total: number, visible: number) {
  return { start: Math.max(0, total - visible), end: Math.max(0, total - 1) };
}

/** ECharts 的实际 category 下标；不从百分比推算含端点的索引。 */
function readWindow(chart: echarts.ECharts, bars: RawBar[]) {
  const dz = (chart.getOption() as { dataZoom?: { startValue?: number | string; endValue?: number | string }[] }).dataZoom?.[0];
  const indexOf = (value: number | string | undefined) => typeof value === 'number' ? value : bars.findIndex((b) => b.date === value);
  const start = indexOf(dz?.startValue);
  const end = indexOf(dz?.endValue);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || !bars.length) return null;
  return { start: Math.max(0, Math.round(start)), end: Math.min(bars.length - 1, Math.round(end)) };
}

function priceBounds(bars: RawBar[], view: { start: number; end: number }, precision: number) {
  let min = Infinity;
  let max = -Infinity;
  for (let i = Math.max(0, view.start); i <= Math.min(bars.length - 1, view.end); i++) {
    const b = bars[i]!;
    min = Math.min(min, b.low, b.open, b.close);
    max = Math.max(max, b.high, b.open, b.close);
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { min: 0, max: 1 };
  const pad = Math.max(10 ** -precision * 2, (max - min) * 0.06);
  return { min: min - pad, max: max + pad };
}

/** 自定义构件显式裁剪到价格 grid，保留跨视窗两端都在外面的线/带。 */
function clipped(params: any, element: any) {
  const { x, y, width, height } = params.coordSys;
  return { type: 'group', clipPath: { type: 'rect', shape: { x, y, width, height } }, children: [element] };
}

/** 装饰只映射已缓存的系列，不重建坐标轴、布局或定位。 */
function decorateSeries(option: any, result: ComputeResult, selected: StructureRef | null | undefined, highlight: number[] | null | undefined, band: [number, number] | null | undefined, semantic: boolean, detail: number, solidMerge: boolean, layers: Layers) {
  const hiMin = highlight?.length ? Math.min(...highlight) : null;
  const hiMax = highlight?.length ? Math.max(...highlight) : null;
  const relatedFx = new Set<number>();
  if (selected?.kind === 'fractal') relatedFx.add(selected.id);
  if (selected?.kind === 'bi') {
    const b = result.bis.find((x) => x.id === selected.id);
    if (b) { relatedFx.add(b.start); relatedFx.add(b.end); }
  }
  if (selected?.kind === 'segment') {
    const s = result.segments.find((x) => x.id === selected.id);
    if (s) { relatedFx.add(s.startFx); relatedFx.add(s.endFx); }
  }
  return option.series.map((series: any) => {
    if (series.id === '视窗覆盖') return { id: series.id, data: [
      ...(hiMin != null && hiMax != null ? [{ value: [hiMin, hiMax, 0] }] : []),
      ...(band ? [{ value: [band[0], band[1], 1] }] : []),
    ] };
    if (series.id === '合并K线') return { id: series.id, data: !semantic || detail === 2 || solidMerge ? series.data : [] };
    if (!['K线', '成交量', '中枢', '笔', '线段', '顶分型', '底分型', '候选分型', '背驰', '买卖点'].includes(series.id)) return null;
    let data = series.data;
    if (semantic && detail === 0 && (['顶分型', '底分型', '候选分型'].includes(series.id) || (series.id === '笔' && layers.segment))) data = [];
    if (series.id === '顶分型' || series.id === '底分型') {
      const type = series.id === '顶分型' ? 'top' : 'bottom';
      const extra = result.fractals.filter((f) => f.type === type && relatedFx.has(f.id) && !data.some((d: any) => d.fx.id === f.id)).flatMap((f) => {
        const p = fxPoint(f, result);
        return p ? [{ value: [p.x, p.y], fx: f, target: { kind: 'fractal', id: f.id }, itemStyle: { color: type === 'top' ? C.top : C.bottom } }] : [];
      });
      if (extra.length) data = [...data, ...extra];
    }
    data = data.map((item: any, i: number) => {
      const value = Array.isArray(item) ? item : item.value;
      const target = item.target as StructureRef | undefined;
      const sel = !!target && ((target.kind === selected?.kind && target.id === selected.id) || (target.kind === 'fractal' && relatedFx.has(target.id)));
      const a = target?.kind === 'fractal' ? item.fx.startRaw : target?.kind === 'divergence' ? item.div.cStart : target ? value[0] : i;
      const b = target?.kind === 'fractal' ? item.fx.endRaw : target?.kind === 'divergence' ? item.div.cEnd : target?.kind === 'center' ? value[1] : target?.kind === 'bi' || target?.kind === 'segment' ? value[2] : a;
      const alpha = hiMin == null || hiMax == null ? 1 : Math.max(a, b) >= hiMin && Math.min(a, b) <= hiMax ? 0.82 : 0.16;
      if (target?.kind === 'center' || target?.kind === 'bi' || target?.kind === 'segment') {
        const next = [...value];
        const slot = target.kind === 'center' ? 7 : 5;
        next[slot] = sel ? 1 : 0;
        next[slot + 1] = sel ? 1 : alpha;
        return { ...item, value: next };
      }
      if (series.id === 'K线' || series.id === '成交量') return { ...(Array.isArray(item) ? {} : item), value, itemStyle: { ...item.itemStyle, opacity: series.id === 'K线' && series.silent ? 0 : hiMin == null || hiMax == null || (i >= hiMin && i <= hiMax) ? 1 : series.id === 'K线' ? 0.34 : 0.3 } };
      if (!target) return item;
      const size = target.kind === 'point' ? (sel ? 32 : 23) : target.kind === 'divergence' ? (sel ? 19 : 12) : sel ? 15 : detail === 2 ? 10 : 8;
      return { ...item, symbolSize: size, itemStyle: { ...item.itemStyle, opacity: sel ? 1 : alpha, borderColor: sel ? '#ffffff' : item.itemStyle?.borderColor, borderWidth: sel ? 2 : item.itemStyle?.borderWidth } };
    });
    const patch: any = { id: series.id, data };
    if (series.id === '买卖点') patch.label = { formatter: (p: { data: { label: string; target: StructureRef } }) => !semantic || detail === 2 || (selected?.kind === 'point' && selected.id === p.data.target.id) ? p.data.label : '' };
    return patch;
  }).filter(Boolean);
}

interface Chip {
  color: string;
  label: string;
  dashed?: boolean;
  hollow?: boolean;
  show: boolean;
}

export function Chart({
  bars, result, layers, highlight, contextBand, syncHoverTime, measureMode = false, onBarClick, hideAnswers, userMarks, label,
  selected, onStructureClick, focus, viewRequest, resetKey = 0, defaultVisible = 150, semantic = false,
  showChrome = true, allowMacd = true, showSlider = true, showLastPrice = true,
  showVolume = true, showDataWindow = true, compactContext = false, pricePrecision = 2, priceUnit = '元', volumeUnit = '源单位',
  onViewportChange, onHoverIndex,
}: ChartProps) {
  const ref = useRef<HTMLDivElement>(null);
  const chartRef = useRef<echarts.ECharts | null>(null);
  const clickRef = useRef(onBarClick);
  const structureClickRef = useRef(onStructureClick);
  const viewportRef = useRef(onViewportChange);
  const hoverRef = useRef(onHoverIndex);
  clickRef.current = onBarClick;
  structureClickRef.current = onStructureClick;
  viewportRef.current = onViewportChange;
  hoverRef.current = onHoverIndex;
  const [semanticLevel, setSemanticLevel] = useState(1);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const [measurePoints, setMeasurePoints] = useState<MeasurePoint[]>([]);
  const [paneSizes, setPaneSizes] = useState({ price: 54, volume: 12, macd: 12 });
  const paneWrapRef = useRef<HTMLDivElement>(null);
  const measureModeRef = useRef(measureMode);
  measureModeRef.current = measureMode;
  const measurePointsRef = useRef(measurePoints);
  measurePointsRef.current = measurePoints;
  const measurePointerAtRef = useRef(0);
  const barsLenRef = useRef(bars.length);
  barsLenRef.current = bars.length;
  const barsRef = useRef(bars);
  barsRef.current = bars;
  const precisionRef = useRef(pricePrecision);
  precisionRef.current = pricePrecision;
  const syncZoomRef = useRef<() => void>(() => {});
  const axisBoundsRef = useRef<{ min: number; max: number } | null>(null);
  const lastRequestRef = useRef(-1);
  // 合并展示方式（全局显示偏好）：solid 时仅显示合并K线实体，隐藏原始K线。
  const mergeStyle = useStore((s) => s.mergeStyle);
  const setMergeStyle = useStore((s) => s.setMergeStyle);
  // 合并实体视角：仅当合并图层开启时生效；此时隐藏原始K线、只留合并实体。
  const solidMerge = mergeStyle === 'solid' && layers.merged;
  // 记住用户手动缩放；仅当K线数量变化（换标的/回放步进）时回到默认窗口。
  const zoomRef = useRef<{ start: number; end: number } | null>(null);
  const lastLenRef = useRef(-1);
  const lastFocusRef = useRef<string | null>(null);
  const lastResetRef = useRef(resetKey);
  const seriesClickAtRef = useRef(0);

  useEffect(() => {
    if (!ref.current) return;
    const dom = ref.current;
    const chart = echarts.init(dom);
    chartRef.current = chart;
    const syncZoom = () => {
      const view = readWindow(chart, barsRef.current);
      if (!view) return;
      zoomRef.current = view;
      viewportRef.current?.(view.start, view.end);
      const count = view.end - view.start + 1;
      const level = count <= 70 ? 2 : count <= 210 ? 1 : 0;
      setSemanticLevel((old) => old === level ? old : level);
      const bounds = priceBounds(barsRef.current, view, precisionRef.current);
      if (axisBoundsRef.current?.min !== bounds.min || axisBoundsRef.current?.max !== bounds.max) {
        axisBoundsRef.current = bounds;
        chart.setOption({ yAxis: [{ id: 'price-axis', ...bounds }] });
      }
      drawMeasure(chart, measurePointsRef.current, precisionRef.current);
    };
    syncZoomRef.current = syncZoom;
    chart.on('dataZoom', syncZoom);
    chart.on('click', (p: unknown) => {
      if (measureModeRef.current) return;
      const target = (p as { data?: { target?: StructureRef } | null }).data?.target;
      if (!target || !structureClickRef.current) return;
      seriesClickAtRef.current = Date.now();
      structureClickRef.current(target);
    });
    const addMeasurePoint = (x: number, y: number) => {
      const point = [x, y];
      if (!chart.containPixel({ gridIndex: 0 }, point)) return;
      const data = chart.convertFromPixel({ gridIndex: 0 }, point) as unknown;
      if (!Array.isArray(data) || data.length < 2) return;
      const index = Math.round(Number(data[0]));
      const price = Number(data[1]);
      if (!Number.isFinite(index) || !Number.isFinite(price)) return;
      setMeasurePoints((old) => old.length >= 2 ? [{ index, price }] : [...old, { index, price }]);
    };
    chart.getZr().on('click', (e: { offsetX: number; offsetY: number }) => {
      if (measureModeRef.current) {
        if (Date.now() - measurePointerAtRef.current < 220) return;
        addMeasurePoint(e.offsetX, e.offsetY);
        return;
      }
      if (Date.now() - seriesClickAtRef.current < 80) return;
      const point = [e.offsetX, e.offsetY];
      if (!chart.containPixel({ gridIndex: 0 }, point)) return;
      const idx = Math.round(chart.convertFromPixel({ xAxisIndex: 0 }, e.offsetX) as number);
      if (Number.isFinite(idx) && idx >= 0) clickRef.current?.(idx);
    });
    const onPointerDown = (e: PointerEvent) => {
      if (!measureModeRef.current || e.button !== 0) return;
      const rect = dom.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      if (!chart.containPixel({ gridIndex: 0 }, [x, y])) return;
      e.preventDefault();
      e.stopPropagation();
      measurePointerAtRef.current = Date.now();
      addMeasurePoint(x, y);
    };
    dom.addEventListener('pointerdown', onPointerDown, true);
    const zr = chart.getZr();
    let hoverFrame = 0;
    let pendingX: number | null = null;
    const flushHover = () => {
      hoverFrame = 0;
      if (pendingX == null) return;
      const idx = Math.round(chart.convertFromPixel({ xAxisIndex: 0 }, pendingX) as number);
      const ok = Number.isFinite(idx) && idx >= 0 && idx < barsLenRef.current;
      setHoverIndex((old) => (old === (ok ? idx : null) ? old : ok ? idx : null));
      hoverRef.current?.(ok ? idx : null);
      pendingX = null;
    };
    const onMove = (e: { offsetX: number; offsetY: number }) => {
      pendingX = e.offsetX;
      if (!hoverFrame) hoverFrame = requestAnimationFrame(flushHover);
    };
    const onLeave = () => {
      pendingX = null;
      setHoverIndex((old) => (old == null ? old : null));
      hoverRef.current?.(null);
    };
    zr.on('mousemove', onMove);
    zr.on('globalout', onLeave);
    const ro = new ResizeObserver(() => {
      chart.resize();
      drawMeasure(chart, measurePointsRef.current, precisionRef.current);
    });
    ro.observe(ref.current);
    // 滚轮/触摸板横滑 = 平移；Ctrl/⌘+滚轮 = 缩放（缩放的专属手势）；拖拽 = 平移。
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const dz = readWindow(chart, barsRef.current);
      if (!dz) return;
      const last = Math.max(0, barsLenRef.current - 1);
      const span = dz.end - dz.start;
      let start: number;
      let end: number;
      if (e.ctrlKey || e.metaKey) {
        const factor = e.deltaY > 0 ? 1.2 : 1 / 1.2;
        // 最小窗口按 K 线根数而非全量百分比：6420 根时 2% 仍会有约128根，无法逐根查看。
        const minSpan = Math.min(11, last);
        const ns = Math.min(last, Math.max(minSpan, span * factor));
        const rect = dom.getBoundingClientRect();
        const ratio = Math.min(1, Math.max(0, (e.offsetX - 14) / Math.max(1, rect.width - 78)));
        const anchor = dz.start + span * ratio;
        start = anchor - ns * ratio;
        end = anchor + ns * (1 - ratio);
      } else {
        const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
        const shift = (delta / 400) * span;
        start = dz.start + shift;
        end = dz.end + shift;
      }
      if (start < 0) { end -= start; start = 0; }
      if (end > last) { start -= end - last; end = last; }
      chart.dispatchAction({ type: 'dataZoom', startValue: Math.max(0, Math.round(start)), endValue: Math.min(last, Math.round(end)) });
    };
    dom.addEventListener('wheel', onWheel, { passive: false, capture: true });
    return () => {
      dom.removeEventListener('wheel', onWheel, { capture: true });
      dom.removeEventListener('pointerdown', onPointerDown, true);
      if (hoverFrame) cancelAnimationFrame(hoverFrame);
      zr.off('mousemove', onMove);
      zr.off('globalout', onLeave);
      ro.disconnect();
      chart.dispose();
      chartRef.current = null;
      lastRequestRef.current = -1;
      lastFocusRef.current = null;
    };
  }, []);

  const structureOption = useMemo(() => {
    const dates = bars.map((b) => b.date);
    const dz = bars.length === lastLenRef.current && zoomRef.current ? zoomRef.current : defaultWindow(bars.length, defaultVisible);
    const showMerged = layers.merged;
    const showFractal = layers.fractal && !hideAnswers;
    const showBi = layers.bi && !hideAnswers;
    const showSegment = layers.segment && !hideAnswers;
    const showCenter = layers.center && !hideAnswers;
    const showDivergence = layers.divergence && !hideAnswers;
    // 买卖点属于高级别结果，即使全量总览也保留；仅文字标签随缩放密度收起。
    const showPoint = layers.point && !hideAnswers;
    const showMacd = allowMacd && showDivergence && !!result.macd && result.config.divMetric === 'MACD面积';
    const showVol = showVolume && layers.volume !== false && bars.some((b) => b.volume > 0);
    const fmtPrice = (v: number) => v.toFixed(pricePrecision);
    const gridCount = 1 + (showVol ? 1 : 0) + (showMacd ? 1 : 0);
    const lastGrid = gridCount - 1;
    // 缓存结构的中性样式；选中/高亮由独立装饰补丁更新。

    // 月界 / 年界刻度集合（智能日期轴）。
    const monthStart = new Set<number>();
    const yearStart = new Set<number>();
    let pm = '';
    let py = '';
    dates.forEach((d, i) => {
      const m = d.slice(0, 7);
      const y = d.slice(0, 4);
      if (m !== pm) { monthStart.add(i); pm = m; }
      if (y !== py) { yearStart.add(i); py = y; }
    });
    const isMonth = (i: number) => monthStart.has(i);
    // 分钟线（date 含空格时间戳）：按日界分隔，日界显 M-D、其余显 HH:MM。
    const intraday = dates[0]?.includes(' ') ?? false;
    const dayStart = new Set<number>();
    if (intraday) {
      let pd = '';
      dates.forEach((d, i) => {
        const dd = d.slice(0, 10);
        if (dd !== pd) { dayStart.add(i); pd = dd; }
      });
    }
    const tickAt = (i: number) => (intraday ? dayStart.has(i) : isMonth(i));
    const dateLabel = (val: string, i: number) => {
      if (intraday) return `${val.slice(5, 10)} ${val.slice(11, 16)}`; // 日内：MM-DD HH:MM
      return yearStart.has(i) ? val.slice(0, 4) : `${Number(val.slice(5, 7))}月`;
    };

    const confirmed = result.fractals.filter((f) => f.status === 'confirmed');
    const candidate = result.fractals.filter((f) => f.status === 'candidate');
    const fxData = (fs: Fractal[]) =>
      fs.map((f) => {
        const p = fxPoint(f, result);
        if (!p) return null;
        return {
          value: [p.x, p.y] as [number, number], fx: f, target: { kind: 'fractal' as const, id: f.id }, symbolSize: 10,
          itemStyle: { color: f.type === 'top' ? C.top : C.bottom, opacity: 1, borderColor: 'transparent', borderWidth: 0 },
        };
      }).filter(Boolean) as { value: [number, number]; fx: Fractal; target: StructureRef }[];
    const fractalsFor = (type: Fractal['type']) => fxData(showFractal ? confirmed.filter((f) => f.type === type) : []);

    const mergedData = result.validBars.map((b) => ({ value: [b.startRaw, b.endRaw, b.low, b.high] }));
    const biById = new Map(result.fractals.map((f) => [f.id, f]));
    const biData = result.bis.map((bi) => {
      const s = biById.get(bi.start);
      const e = biById.get(bi.end);
      const ps = s ? fxPoint(s, result) : null;
      const pe = e ? fxPoint(e, result) : null;
      if (!ps || !pe) return null;
      return {
        value: [ps.x, ps.y, pe.x, pe.y, bi.status === 'candidate' ? 1 : 0, 0, 1],
        target: { kind: 'bi', id: bi.id },
      };
    }).filter(Boolean) as { value: number[]; target: StructureRef }[];

    // 线段：起止点（向上段起底止顶，向下段起顶止底），候选虚线。
    const segData = result.segments.map((s) => {
      return {
        value: [
          s.startRaw, s.dir === 'up' ? s.low : s.high,
          s.endRaw, s.dir === 'up' ? s.high : s.low,
          s.status === 'candidate' ? 1 : 0, 0, 1,
        ],
        target: { kind: 'segment', id: s.id },
      };
    });

    // 中枢：核心带 [ZD,ZG] + 外围 [DD,GG]，候选虚线框。
    const centerData = result.centers.map((c) => {
      return {
        value: [c.startRaw, c.endRaw, c.ZD, c.ZG, c.DD, c.GG, c.status === 'candidate' ? 1 : 0, 0, 1],
        target: { kind: 'center', id: c.id },
      };
    });

    // 背驰标记：c段终结极值处（顶背驰=高点菱形，底背驰=低点菱形），候选空心虚线。
    const divData = result.divergences.map((d) => {
      const b = bars[Math.max(0, Math.min(bars.length - 1, Math.round(d.cEnd)))];
      if (!b) return null;
      const col = C.divergence;
      const cand = d.status === 'candidate';
      return {
        value: [d.cEnd, d.dir === 'up' ? b.high : b.low],
        div: d, target: { kind: 'divergence', id: d.id }, symbolSize: 12,
        itemStyle: cand
          ? { color: 'transparent', borderColor: col, borderWidth: 1.2, borderType: 'dashed', opacity: 1 }
          : { color: col, borderColor: col, borderWidth: 1, opacity: 1 },
      };
    }).filter(Boolean);

    // 买卖点：pin 标记（买红卖绿，一/二/三类标签，候选空心虚线，卖点旋转180）。
    const pointData = result.points.map((p) => {
      const col = p.side === 'buy' ? C.up : C.down;
      const cand = p.status === 'candidate';
      return {
        value: [p.atRaw, p.price],
        side: p.side,
        label: `${p.side === 'buy' ? '买' : '卖'}${['一', '二', '三'][p.klass - 1]}`,
        target: { kind: 'point', id: p.id }, symbolSize: 23,
        itemStyle: cand
          ? { color: 'transparent', borderColor: col, borderWidth: 1.2, borderType: 'dashed', opacity: 1 }
          : { color: col, borderColor: '#0f1420', borderWidth: 1, opacity: 1 },
      };
    });

    const last = bars[bars.length - 1];
    const prev = bars[bars.length - 2];
    const lastUp = last ? (prev ? last.close >= prev.close : last.close >= last.open) : true;
    const lastColor = lastUp ? C.up : C.down;

    const markLine = last && showLastPrice
      ? {
          silent: true,
          symbol: 'none',
          lineStyle: { color: lastColor, type: 'dashed', width: 1, opacity: 0.65 },
          label: {
            show: true, position: 'end', formatter: `${fmtPrice(last.close)} ${priceUnit}`,
            backgroundColor: lastColor, color: '#0f1420', padding: [2, 5], borderRadius: 3, fontSize: 10, fontWeight: 700,
          },
          data: [{ yAxis: last.close }],
        }
      : undefined;

    // 主图坐标轴（提取以便 MACD 副图时转为双 grid）。
    const xAxisFor = (gridIndex: number, labels: boolean) => ({
      id: `time-axis-${gridIndex}`, type: 'category', data: dates, gridIndex, boundaryGap: true,
      axisLine: { lineStyle: { color: C.axis } }, axisTick: { show: false },
      axisLabel: labels
        ? { color: C.label, fontSize: 10, interval: intraday ? 0 : tickAt, formatter: dateLabel, hideOverlap: true, margin: 10 }
        : { show: false },
      splitLine: { show: labels, interval: tickAt, lineStyle: { color: C.gridV, type: 'dashed' } },
      axisPointer: { label: { backgroundColor: C.surface2, borderColor: C.accent, borderWidth: 1, color: C.text, fontSize: 10, formatter: (p: { value: string }) => p.value } },
      min: 'dataMin', max: 'dataMax',
    });
    const xAxes = Array.from({ length: gridCount }, (_, i) => xAxisFor(i, !compactContext && i === lastGrid));
    const yAxisMain = {
      id: 'price-axis', ...priceBounds(bars, dz, pricePrecision),
      scale: true, position: 'right',
      axisLine: { show: true, lineStyle: { color: C.axis } }, axisTick: { show: true, lineStyle: { color: C.axis } },
      axisLabel: { color: C.label, fontSize: 10, margin: 8, formatter: (v: number) => fmtPrice(v) },
      splitLine: { lineStyle: { color: C.grid, type: 'dashed' } },
      axisPointer: { label: { backgroundColor: C.accent, color: '#0f1420', fontSize: 10, fontWeight: 600, precision: pricePrecision, formatter: (p: { value: number }) => fmtPrice(p.value) } },
    };
    const yAxes: any[] = [yAxisMain];
    const grids: any[] = [];
    const sliderSpace = showSlider ? 38 : 20;
    if (compactContext) {
      grids.push({ left: 12, right: 64, top: 2, bottom: 2 });
    } else if (gridCount === 1) {
      grids.push({ left: 12, right: 64, top: 16, bottom: sliderSpace + 10 });
    } else if (gridCount === 2) {
      const secondHeight = showVol ? 15 : 14;
      const priceHeight = showVol ? 66 : 68;
      grids.push({ left: 12, right: 64, top: 16, height: `${priceHeight}%` });
      grids.push({ left: 12, right: 64, top: `${priceHeight + 6}%`, height: `${secondHeight}%` });
    } else {
      grids.push({ left: 12, right: 64, top: 16, height: `${paneSizes.price}%` });
      grids.push({ left: 12, right: 64, top: `${paneSizes.price + 4}%`, height: `${paneSizes.volume}%` });
      grids.push({ left: 12, right: 64, top: `${paneSizes.price + paneSizes.volume + 8}%`, height: `${paneSizes.macd}%` });
    }
    if (showVol) {
      yAxes.push({
        id: 'volume-axis', scale: true, gridIndex: 1, position: 'right', axisLine: { show: true, lineStyle: { color: C.axis } },
        axisLabel: { color: C.label, fontSize: 9, formatter: (v: number) => v >= 1e8 ? `${(v / 1e8).toFixed(1)}亿` : v >= 1e4 ? `${(v / 1e4).toFixed(0)}万` : String(v) },
        splitLine: { lineStyle: { color: C.gridV, type: 'dashed' } },
      });
    }
    if (showMacd) {
      yAxes.push({ id: 'macd-axis', scale: true, gridIndex: gridCount - 1, position: 'right', axisLine: { show: true, lineStyle: { color: C.axis } }, axisLabel: { color: C.label, fontSize: 9 }, splitLine: { lineStyle: { color: C.gridV, type: 'dashed' } } });
    }

    const option: any = {
      animation: false,
      backgroundColor: 'transparent',
      grid: grids.map((grid, i) => ({ id: `grid-${i}`, ...grid })),
      tooltip: {
        show: !compactContext,
        trigger: 'axis',
        axisPointer: {
          type: 'cross',
          link: [{ xAxisIndex: 'all' }],
          crossStyle: { color: 'rgba(215,222,239,0.35)', type: 'dashed' },
          label: { backgroundColor: C.surface2, borderColor: C.accent, borderWidth: 1, color: C.text, fontSize: 10, precision: pricePrecision },
        },
        backgroundColor: 'rgba(23,30,46,0.96)',
        borderColor: C.axis,
        textStyle: { color: C.text, fontSize: 12 },
        formatter: (params: unknown) => {
          const arr = params as { dataIndex: number; seriesType: string }[];
          const candle = arr.find((p) => p.seriesType === 'candlestick');
          if (!candle) return '';
          const b = bars[candle.dataIndex];
          if (!b) return '';
          const st = b.is_st ? ' · <span style="color:#ffb020">ST</span>' : '';
          const chg = b.pct_chg == null ? '' : ` <span style="color:${b.pct_chg >= 0 ? C.up : C.down}">${b.pct_chg >= 0 ? '+' : ''}${b.pct_chg.toFixed(2)}%</span>`;
          const coverage = b.time ? `<br/><span style="color:#8b96b3">实际覆盖 ${b.time.coverage.map((r) => `${new Date(r.startMs + 8 * 3600_000).toISOString().slice(11, 16)}-${new Date(r.endMs + 8 * 3600_000).toISOString().slice(11, 16)}`).join(' / ')} · ${b.time.complete ? '完整' : '不完整'}</span>` : '';
          return `<b>${b.date}</b> <span style="color:#8b96b3">（柱结束时间）</span>${st}${chg}<br/>开 ${fmtPrice(b.open)}${priceUnit}　高 ${fmtPrice(b.high)}${priceUnit}　低 ${fmtPrice(b.low)}${priceUnit}　收 ${fmtPrice(b.close)}${priceUnit}<br/><span style="color:#8b96b3">量 ${(b.volume / 1e4).toFixed(0)}万${volumeUnit} · 额 ${(b.amount / 1e8).toFixed(2)}亿元</span>${coverage}`;
        },
      },
      xAxis: xAxes,
      yAxis: yAxes,
      dataZoom: [
        {
          id: 'inside-zoom', type: 'inside', filterMode: 'weakFilter', rangeMode: ['value', 'value'],
          xAxisIndex: Array.from({ length: gridCount }, (_, i) => i), startValue: dz.start, endValue: dz.end,
          minValueSpan: Math.min(11, Math.max(0, bars.length - 1)),
          zoomOnMouseWheel: false,
          moveOnMouseWheel: false,
          moveOnMouseMove: true,
          preventDefaultMouseMove: true,
        },
        ...(showSlider ? [{
          id: 'slider-zoom', type: 'slider', filterMode: 'weakFilter', rangeMode: ['value', 'value'],
          xAxisIndex: Array.from({ length: gridCount }, (_, i) => i), height: 16, bottom: 4,
          startValue: dz.start, endValue: dz.end,
          minValueSpan: Math.min(11, Math.max(0, bars.length - 1)),
          borderColor: 'transparent',
          backgroundColor: 'rgba(23,30,46,0.6)',
          fillerColor: 'rgba(76,141,255,0.16)',
          dataBackground: { lineStyle: { color: 'rgba(76,141,255,0.4)' }, areaStyle: { color: 'rgba(76,141,255,0.10)' } },
          selectedDataBackground: { lineStyle: { color: C.accent }, areaStyle: { color: 'rgba(76,141,255,0.25)' } },
          handleStyle: { color: C.accent, borderColor: C.accent },
          moveHandleStyle: { color: C.accent },
          emphasis: { handleStyle: { color: '#7fb0ff' }, moveHandleStyle: { color: '#7fb0ff' } },
          textStyle: { color: C.label, fontSize: 9 },
          brushSelect: false,
          labelFormatter: (i: number) => dates[Math.round(i)] ?? '',
        }] : []),
      ],
      series: [
        {
          name: '视窗覆盖', type: 'custom', data: [], silent: true, tooltip: { show: false },
          renderItem: (p: any, api: { coord: (v: number[]) => number[]; size: (v: number[]) => number[]; value: (i: number) => unknown }) => {
            const start = api.value(0) as number;
            const end = api.value(1) as number;
            const bw = Math.abs(api.size([1, 0])[0]!);
            const x = api.coord([start, 0])[0]! - bw / 2;
            return clipped(p, { type: 'rect', shape: { x, y: p.coordSys.y, width: Math.max(1, (end - start + 1) * bw), height: p.coordSys.height }, style: { fill: api.value(2) === 1 ? 'rgba(255,176,32,0.075)' : 'rgba(76,141,255,0.12)' } });
          },
          encode: { x: [0, 1], y: [] }, z: 0,
        },
        {
          name: 'K线',
          type: 'candlestick',
          // 合并实体视角下隐藏原始K线，仅保留合并结果。
          data: bars.map((b) => [b.open, b.close, b.low, b.high]),
          // 保留原始数据用于数据窗/tooltip，合并实体只隐藏其绘制。
          silent: solidMerge,
          // 不显式给 barWidth：ECharts 6 中显式宽度会绕过 min/max 夹限。
          barMinWidth: 1,
          barMaxWidth: 16,
          large: false,
          itemStyle: { color: C.up, color0: C.down, borderColor: C.up, borderColor0: C.down, borderWidth: 1 },
          markLine,
        },
        ...(showVol ? [{
          name: '成交量',
          type: 'bar',
          xAxisIndex: 1,
          yAxisIndex: 1,
          data: bars.map((b) => ({ value: b.volume, itemStyle: { color: b.close >= b.open ? 'rgba(255,92,92,0.62)' : 'rgba(47,208,140,0.62)', opacity: 1 } })),
          barMaxWidth: 14,
          large: false,
        }] : []),
        {
          name: '合并K线',
          type: 'custom',
          data: showMerged ? mergedData : [],
          renderItem: (_p: unknown, api: { coord: (v: number[]) => number[]; size: (v: number[]) => number[]; value: (i: number) => unknown }) => {
            const start = api.value(0) as number;
            const end = api.value(1) as number;
            const low = api.value(2) as number;
            const high = api.value(3) as number;
            const pH = api.coord([start, high]);
            const pL = api.coord([end, low]);
            const bw = api.size([1, 0])[0]!;
            // 合并-only 视图留 1px 间隙，使相邻合并段彼此可分离。
            const gap = solidMerge ? 1 : 0;
            return clipped(_p, {
              type: 'rect',
              shape: { x: pH[0]! - bw / 2 + gap, y: pH[1]!, width: Math.max(1, (end - start) * bw + bw - gap * 2), height: Math.max(1, pL[1]! - pH[1]!), r: solidMerge ? 2 : 0 },
              style: solidMerge
                ? { fill: C.merged, stroke: '#9bc0ff', lineWidth: 1.1 }
                : { fill: 'rgba(76,141,255,0.10)', stroke: 'rgba(76,141,255,0.55)', lineWidth: 1 },
            });
          },
          encode: { x: [0, 1], y: [2, 3] },
          // 合并-only 视图：按合并段（item）悬停提示，避免 axis 触发按起点下标错配跨段合并。
          tooltip: solidMerge
            ? {
                trigger: 'item',
                formatter: (p: { dataIndex: number }) => {
                  const mb = result.validBars[p.dataIndex];
                  if (!mb) return '';
                  const d0 = bars[mb.startRaw]?.date ?? '?';
                  const d1 = bars[mb.endRaw]?.date ?? '?';
                  const span = mb.endRaw - mb.startRaw + 1;
                  return `<b>合并段</b> ${d0}${span > 1 ? ` ~ ${d1}` : ''}<br/>高 ${mb.high.toFixed(2)}　低 ${mb.low.toFixed(2)}<br/>含原始K线 ${span} 根`;
                },
              }
            : undefined,
          z: 1,
        },
        {
          name: '中枢',
          type: 'custom',
          data: showCenter ? centerData : [],
          renderItem: (_p: unknown, api: { coord: (v: number[]) => number[]; size: (v: number[]) => number[]; value: (i: number) => unknown }) => {
            const x0 = api.value(0) as number;
            const x1 = api.value(1) as number;
            const zd = api.value(2) as number;
            const zg = api.value(3) as number;
            const dd = api.value(4) as number;
            const gg = api.value(5) as number;
            const isCand = (api.value(6) as number) === 1;
            const sel = (api.value(7) as number) === 1;
            const alpha = api.value(8) as number;
            const bw = api.size([1, 0])[0]!;
            const x = api.coord([x0, zg])[0]! - bw / 2;
            const w = (x1 - x0) * bw + bw;
            const yZG = api.coord([x0, zg])[1]!;
            const yZD = api.coord([x1, zd])[1]!;
            const yGG = api.coord([x0, gg])[1]!;
            const yDD = api.coord([x1, dd])[1]!;
            return clipped(_p, {
              type: 'group',
              children: [
                { type: 'rect', shape: { x, y: yGG, width: w, height: Math.max(1, yDD - yGG) }, style: { fill: `rgba(168,85,247,${sel ? 0.08 : 0.035 * alpha})` } },
                { type: 'rect', shape: { x, y: yZG, width: w, height: Math.max(1, yZD - yZG) }, style: { fill: `rgba(168,85,247,${sel ? 0.24 : 0.11 * alpha})`, stroke: sel ? '#d8b4fe' : `rgba(168,85,247,${0.58 * alpha})`, lineWidth: sel ? 2 : 1, lineDash: isCand ? [4, 3] : undefined } },
              ],
            });
          },
          encode: { x: [0, 1], y: [2, 3] },
          z: 2,
        },
        {
          name: '笔',
          type: 'custom',
          data: showBi ? biData : [],
          renderItem: (_p: unknown, api: { coord: (v: number[]) => number[]; value: (i: number) => unknown }) => {
            const p1 = api.coord([api.value(0) as number, api.value(1) as number]);
            const p2 = api.coord([api.value(2) as number, api.value(3) as number]);
            const isCand = (api.value(4) as number) === 1;
            const sel = (api.value(5) as number) === 1;
            const alpha = api.value(6) as number;
            return clipped(_p, {
              type: 'line',
              shape: { x1: p1[0]!, y1: p1[1]!, x2: p2[0]!, y2: p2[1]! },
              style: { stroke: sel ? '#fff3bf' : C.bi, lineWidth: sel ? 3 : 1.4, lineDash: isCand ? [5, 4] : undefined, opacity: alpha },
            });
          },
          encode: { x: [0, 2], y: [1, 3] },
          z: 3,
        },
        {
          name: '线段',
          type: 'custom',
          data: showSegment ? segData : [],
          renderItem: (_p: unknown, api: { coord: (v: number[]) => number[]; value: (i: number) => unknown }) => {
            const p1 = api.coord([api.value(0) as number, api.value(1) as number]);
            const p2 = api.coord([api.value(2) as number, api.value(3) as number]);
            const isCand = (api.value(4) as number) === 1;
            const sel = (api.value(5) as number) === 1;
            const alpha = api.value(6) as number;
            return clipped(_p, {
              type: 'line',
              shape: { x1: p1[0]!, y1: p1[1]!, x2: p2[0]!, y2: p2[1]! },
              style: { stroke: sel ? '#d3f9d8' : C.segment, lineWidth: sel ? 4 : 2.2, lineDash: isCand ? [6, 4] : undefined, opacity: alpha },
            });
          },
          encode: { x: [0, 2], y: [1, 3] },
          z: 3,
        },
        {
          name: '顶分型',
          type: 'scatter',
          data: fractalsFor('top'),
          symbol: 'arrow', symbolSize: 9, symbolRotate: 180,
          itemStyle: { color: C.top },
          z: 4,
        },
        {
          name: '底分型',
          type: 'scatter',
          data: fractalsFor('bottom'),
          symbol: 'arrow', symbolSize: 9,
          itemStyle: { color: C.bottom },
          z: 4,
        },
        {
          name: '候选分型',
          type: 'scatter',
          data: showFractal && layers.candidate ? fxData(candidate) : [],
          symbol: 'arrow', symbolSize: 10,
          symbolRotate: (_v: unknown, p: { data: { fx: Fractal } }) => (p.data.fx.type === 'top' ? 180 : 0),
          itemStyle: { color: 'rgba(255,176,32,0.5)', borderColor: C.candidate, borderWidth: 1, borderType: 'dashed' },
          z: 4,
        },
        {
          name: '我的标记',
          type: 'scatter',
          data: (userMarks ?? []).map((m) => {
            const mb = result.validBars[m.middle];
            return mb ? { value: [(mb.startRaw + mb.endRaw) / 2, m.type === 'top' ? mb.high : mb.low], t: m.type } : null;
          }).filter(Boolean),
          symbol: 'pin', symbolSize: 26,
          itemStyle: { color: C.mark },
          label: { show: true, formatter: (p: { data: { t: string } }) => (p.data.t === 'top' ? '顶' : '底'), color: '#fff', fontSize: 10 },
          z: 5,
        },
        {
          name: '背驰',
          type: 'scatter',
          data: showDivergence ? divData : [],
          symbol: 'diamond', symbolSize: 13,
          z: 4,
        },
        {
          name: '买卖点',
          type: 'scatter',
          data: showPoint ? pointData : [],
          symbol: 'pin', symbolSize: 23,
          symbolRotate: (_v: unknown, p: { data: { side: string } }) => (p.data.side === 'sell' ? 180 : 0),
          label: {
            show: true,
            formatter: (p: { data: { label: string; target: StructureRef } }) => p.data.label,
            color: '#fff', fontSize: 9,
          },
          z: 5,
        },
        // MACD 副图（仅 MACD 口径且有 close 时）：柱 + DIF/DEA 线，落在 grid 1。
        ...(showMacd && result.macd
          ? [
              { name: 'MACD柱', type: 'bar', xAxisIndex: gridCount - 1, yAxisIndex: gridCount - 1, data: result.macd.hist, itemStyle: { color: (p: { value: number | null }) => p.value == null ? 'transparent' : p.value >= 0 ? C.up : C.down },  barMaxWidth: 12, large: false },
              { name: 'DIF', type: 'line', xAxisIndex: gridCount - 1, yAxisIndex: gridCount - 1, data: result.macd.dif, showSymbol: false, symbol: 'none', lineStyle: { color: C.bi, width: 1 } },
              { name: 'DEA', type: 'line', xAxisIndex: gridCount - 1, yAxisIndex: gridCount - 1, data: result.macd.dea, showSymbol: false, symbol: 'none', lineStyle: { color: C.merged, width: 1 } },
            ]
          : []),
      ],
    };
    option.series = option.series.map((series: any) => ({ id: series.name, clip: true, ...series }));
    return option;
  }, [bars, result, layers, hideAnswers, userMarks, mergeStyle, defaultVisible, allowMacd, showSlider, showLastPrice, pricePrecision, priceUnit, volumeUnit, showVolume, compactContext, paneSizes]);

  const hiStart = highlight?.length ? Math.min(...highlight) : null;
  const hiEnd = highlight?.length ? Math.max(...highlight) : null;
  const decorations = useMemo(() => decorateSeries(structureOption, result, selected, highlight, contextBand, semantic, semantic ? semanticLevel : 2, solidMerge, layers),
    [structureOption, result, selected?.kind, selected?.id, hiStart, hiEnd, contextBand?.[0], contextBand?.[1], semantic, semanticLevel, solidMerge, layers]);
  const lastDecorationsRef = useRef(decorations);

  // 数据/角色布局更新才合并结构选项；保留实例及精确视窗，不 notMerge 重建整图。
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const patches = new Map(decorations.map((s: any) => [s.id, s]));
    const series = structureOption.series.map((s: any) => {
      const patch = patches.get(s.id) as any;
      return patch ? { ...s, ...patch, label: { ...s.label, ...patch.label } } : s;
    });
    chart.setOption({ ...structureOption, series }, { replaceMerge: ['series', 'xAxis', 'yAxis', 'grid', 'dataZoom'] });
    lastLenRef.current = bars.length;
    lastDecorationsRef.current = decorations;
    axisBoundsRef.current = { min: structureOption.yAxis[0].min, max: structureOption.yAxis[0].max };
    syncZoomRef.current();
  }, [structureOption]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || lastDecorationsRef.current === decorations) return;
    lastDecorationsRef.current = decorations;
    chart.setOption({ series: decorations });
  }, [decorations]);

  // 明确动作的一次性索引定位。紧凑/主图角色变化不在依赖中。
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !bars.length) return;
    if (!focus) lastFocusRef.current = null;
    const requestChanged = viewRequest != null && viewRequest.seq > lastRequestRef.current;
    const resetChanged = resetKey !== lastResetRef.current;
    const focusChanged = focus != null && focus.key !== lastFocusRef.current;
    if (!requestChanged && !resetChanged && !focusChanged) return;
    if (requestChanged) lastRequestRef.current = viewRequest!.seq;
    lastResetRef.current = resetKey;
    if (focus) lastFocusRef.current = focus.key;
    const target = requestChanged
      ? viewRequest!.start != null && viewRequest!.end != null ? { start: viewRequest!.start, end: viewRequest!.end } : defaultWindow(bars.length, defaultVisible)
      : focus ? { start: focus.start, end: focus.end } : defaultWindow(bars.length, defaultVisible);
    const last = bars.length - 1;
    let start = Math.max(0, Math.min(last, Math.floor(target.start)));
    let end = Math.max(start, Math.min(last, Math.ceil(target.end)));
    const minSpan = Math.min(11, last);
    if (end - start < minSpan) { end = Math.min(last, start + minSpan); start = Math.max(0, end - minSpan); }
    chart.dispatchAction({ type: 'dataZoom', startValue: start, endValue: end });
    syncZoomRef.current();
  }, [viewRequest?.seq, focus?.key, resetKey, bars, defaultVisible]);

  // 测距与结构/装饰独立；普通悬停不调用 setOption。
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    if (measurePoints.length) drawMeasure(chart, measurePoints, pricePrecision);
    else chart.setOption({ graphic: [{ id: 'measure-overlay', $action: 'remove' }] });
  }, [measurePoints, pricePrecision]);

  useEffect(() => {
    if (measureMode) return;
    setMeasurePoints((old) => (old.length ? [] : old));
  }, [measureMode]);

  // 跨图悬停：按真实时间找到本图对应 bar，仅显示同时间光标，不复制价格/下标。
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const idx = syncHoverTime == null ? -1 : findBarIndexAtTime(bars, syncHoverTime);
    setHoverIndex((old) => old === (idx < 0 ? null : idx) ? old : idx < 0 ? null : idx);
    if (idx < 0) {
      chart.dispatchAction({ type: 'hideTip' });
      chart.dispatchAction({ type: 'updateAxisPointer', currTrigger: 'leave' });
      return;
    }
    const bounds = axisBoundsRef.current;
    const point = chart.convertToPixel({ xAxisIndex: 0, yAxisIndex: 0 }, [idx, bounds ? (bounds.min + bounds.max) / 2 : bars[idx]!.close]) as number[];
    chart.dispatchAction({ type: 'updateAxisPointer', x: point[0], y: point[1] });
    if (!compactContext) chart.dispatchAction({ type: 'showTip', seriesIndex: 1, dataIndex: idx });
  }, [syncHoverTime, bars, compactContext]);

  // 重置缩放（非平移）：回到该周期的默认最近窗口。
  const resetZoom = () => {
    const chart = chartRef.current;
    if (!chart) return;
    zoomRef.current = null;
    const view = defaultWindow(bars.length, defaultVisible);
    chart.dispatchAction({ type: 'dataZoom', startValue: view.start, endValue: view.end });
  };

  const volumePane = showVolume && layers.volume !== false && bars.some((b) => b.volume > 0);
  const macdPane = allowMacd && layers.divergence !== false && !hideAnswers && !!result.macd && result.config.divMetric === 'MACD面积';
  const macdHasGaps = useMemo(() => result.macd?.hist.some((v) => v == null) ?? false, [result.macd]);
  const startPaneResize = (which: 1 | 2, e: ReactPointerEvent) => {
    if (!showSlider) return;
    e.preventDefault();
    const startY = e.clientY;
    const base = { ...paneSizes };
    const height = paneWrapRef.current?.clientHeight ?? 0;
    if (!height) return;
    const move = (ev: PointerEvent) => {
      const delta = (ev.clientY - startY) / height * 100;
      setPaneSizes(() => {
        if (which === 1) {
          const price = Math.max(24, Math.min(72, base.price + delta));
          const volume = Math.max(7, Math.min(34, base.volume - delta));
          return { ...base, price, volume };
        }
        const volume = Math.max(7, Math.min(34, base.volume + delta));
        const macd = Math.max(7, Math.min(34, base.macd - delta));
        return { ...base, volume, macd };
      });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up, { once: true });
  };

  const chips: Chip[] = [
    { color: C.up, label: '涨', show: !solidMerge },
    { color: C.down, label: '跌', show: !solidMerge },
    { color: C.merged, label: '合并K线', show: layers.merged, hollow: !solidMerge },
    { color: C.bi, label: '笔', show: layers.bi && !hideAnswers },
    { color: C.segment, label: '线段', show: layers.segment && !hideAnswers },
    { color: C.center, label: '中枢', show: layers.center && !hideAnswers },
    { color: C.divergence, label: '背驰', show: layers.divergence && !hideAnswers },
    { color: C.text, label: '买卖点', show: layers.point && !hideAnswers },
    { color: C.top, label: '顶分型', show: layers.fractal && !hideAnswers },
    { color: C.bottom, label: '底分型', show: layers.fractal && !hideAnswers },
    { color: C.candidate, label: '候选', dashed: true, show: layers.candidate && !hideAnswers },
    { color: C.mark, label: '我的标记', show: !!userMarks },
  ];

  const dataIndex = hoverIndex == null ? bars.length - 1 : Math.max(0, Math.min(bars.length - 1, hoverIndex));
  const dataBar = bars[dataIndex];
  const dataChg = dataBar?.pct_chg ?? (dataBar && dataIndex > 0 ? (dataBar.close / bars[dataIndex - 1]!.close - 1) * 100 : null);
  const measureInfo = (() => {
    if (measurePoints.length < 2) return null;
    const [a, b] = measurePoints;
    const barA = bars[Math.max(0, Math.min(bars.length - 1, a!.index))];
    const barB = bars[Math.max(0, Math.min(bars.length - 1, b!.index))];
    if (!barA || !barB) return null;
    const t0 = parseChinaMs(barA.date);
    const t1 = parseChinaMs(barB.date);
    const diff = b!.price - a!.price;
    const pct = a!.price === 0 ? 0 : diff / a!.price * 100;
    const span = Math.abs(b!.index - a!.index) + 1;
    const days = t0 != null && t1 != null ? Math.abs(t1 - t0) / 86_400_000 : null;
    return { diff, pct, span, dateA: barA.date, dateB: barB.date, days };
  })();

  return (
    <div className="chart-root">
      {showDataWindow && dataBar && (
        <div className="chart-data-window" aria-live="polite">
          <div className="data-main">
            <b>{dataBar.date}</b>
            <span className={dataChg == null ? '' : dataChg >= 0 ? 'is-up' : 'is-down'}>
              {dataChg == null ? '—' : `${dataChg >= 0 ? '+' : ''}${dataChg.toFixed(2)}%`}
            </span>
          </div>
          <div className="data-ohlc">
            <span>开 <b>{pricePrecision >= 0 ? dataBar.open.toFixed(pricePrecision) : dataBar.open}</b></span>
            <span>高 <b>{dataBar.high.toFixed(pricePrecision)}</b></span>
            <span>低 <b>{dataBar.low.toFixed(pricePrecision)}</b></span>
            <span>收 <b>{dataBar.close.toFixed(pricePrecision)}</b></span>
            <span>量 <b>{(dataBar.volume / 1e4).toFixed(0)}万{volumeUnit}</b></span>
            <span>额 <b>{(dataBar.amount / 1e8).toFixed(2)}亿元</b></span>
          </div>
          <div className="data-meta">
            价格 {priceUnit} · 时间=柱结束 · {dataBar.time ? `${dataBar.time.quality === 'unknown' ? '来源未知' : dataBar.time.complete ? '完整' : '不完整'} ${dataBar.time.sourceCount}/${dataBar.time.expectedSourceCount}` : '旧数据无覆盖元信息'}
            {macdHasGaps && ' · MACD按可信连续段重启，断点留空'}
          </div>
        </div>
      )}
      {measureMode && <div className="chart-measure-hint">{measurePoints.length === 0 ? '测距：在价格主图点击起点' : measurePoints.length === 1 ? '测距：点击终点（再点可重新开始）' : '测距完成；关闭测距可清除'}</div>}
      {measureInfo && (
        <div className="chart-measure-box">
          <div><b>测距</b><span className={measureInfo.diff >= 0 ? 'is-up' : 'is-down'}>{measureInfo.diff >= 0 ? '+' : ''}{measureInfo.diff.toFixed(pricePrecision)} {priceUnit} · {measureInfo.pct >= 0 ? '+' : ''}{measureInfo.pct.toFixed(2)}%</span></div>
          <div>{measureInfo.dateA} → {measureInfo.dateB}</div>
          <div>含端点 {measureInfo.span} 根 · 自然间隔 {measureInfo.days == null ? '—' : `${measureInfo.days.toFixed(measureInfo.days < 2 ? 2 : 1)}天`}</div>
        </div>
      )}
      {showChrome && <div className="chart-legend">
        {label && <span className="legend-title">{label}</span>}
        {chips.filter((c) => c.show).map((c) => (
          <span key={c.label} className="legend-chip">
            <i style={{ background: c.hollow ? 'transparent' : c.color, borderColor: c.hollow ? c.color : 'transparent', borderStyle: c.dashed ? 'dashed' : 'solid' }} />
            {c.label}
          </span>
        ))}
        <span className="legend-tools">
          <Tooltip title="切换视角：原始＝原始K线实体+合并外框；合并＝隐藏原始K线、仅看合并实体">
            <span className="seg-wrap">
              <span className="seg-cap">实体</span>
              <Segmented
                size="small"
                value={mergeStyle}
                onChange={(v) => setMergeStyle(v as 'outline' | 'solid')}
                options={[{ label: '原始', value: 'outline' }, { label: '合并', value: 'solid' }]}
              />
            </span>
          </Tooltip>
          <Tooltip title={`重置缩放（回到最近${defaultVisible}根）`}>
            <Button size="small" onClick={resetZoom}>⤾</Button>
          </Tooltip>
        </span>
        <span className="legend-hint">拖拽 / 滚轮 / 横滑 = 平移 · Ctrl+滚轮 / 双指 = 缩放</span>
        <span className="legend-unit">价格 · {priceUnit} · 横向等距一根K线，不代表自然时间</span>
      </div>}
      <div className="chart-canvas-wrap" ref={paneWrapRef}>
        <div ref={ref} className="chart-canvas" />
        {!compactContext && showSlider && volumePane && (
          <div className="pane-handle" style={{ top: `calc(16px + ${paneSizes.price}%)` }} title="拖动调整成交量高度" onPointerDown={(e) => startPaneResize(1, e)} />
        )}
        {!compactContext && showSlider && volumePane && macdPane && (
          <div className="pane-handle" style={{ top: `calc(16px + ${paneSizes.price + paneSizes.volume + 8}%)` }} title="拖动调整MACD高度" onPointerDown={(e) => startPaneResize(2, e)} />
        )}
      </div>
    </div>
  );
}