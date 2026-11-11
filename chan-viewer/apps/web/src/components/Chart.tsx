// ECharts K线渲染：原始K线 + 合并K线/分型/笔 叠加图层。
// 坐标系按交易终端惯例精修：右侧价格轴、最新价标签、月界网格与智能日期刻度、
// 调色板十字光标、定制 dataZoom、图例直标（8 色可分离）。
import { useEffect, useRef } from 'react';
import { Button, Segmented, Tooltip } from 'antd';
import * as echarts from 'echarts/core';
import { CandlestickChart, CustomChart, ScatterChart } from 'echarts/charts';
import { GridComponent, TooltipComponent, DataZoomComponent, MarkAreaComponent, MarkLineComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import type { ComputeResult, Fractal } from '@chan/engine';
import type { RawBar } from '../api.ts';
import { useStore, type Layers } from '../store.ts';

echarts.use([CandlestickChart, CustomChart, ScatterChart, GridComponent, TooltipComponent, DataZoomComponent, MarkAreaComponent, MarkLineComponent, CanvasRenderer]);

// 主题色：涨跌红绿（A股惯例）+ 结构层各自独立色相，图例直标保证可分离。
const C = {
  up: '#ff5c5c',
  down: '#2fd08c',
  merged: '#4c8dff',
  bi: '#ffd43b',
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
  onBarClick?: (rawIndex: number) => void;
  hideAnswers?: boolean;
  userMarks?: { middle: number; type: 'top' | 'bottom' }[];
  /** 图例行首标题（对比模式的 口径A/B）。 */
  label?: string;
}

function fxPoint(f: Fractal, r: ComputeResult): { x: number; y: number } | null {
  const mb = r.validBars[f.middle];
  if (!mb) return null;
  return { x: (mb.startRaw + mb.endRaw) / 2, y: f.type === 'top' ? mb.high : mb.low };
}

interface Chip {
  color: string;
  label: string;
  dashed?: boolean;
  hollow?: boolean;
  show: boolean;
}

export function Chart({ bars, result, layers, highlight, onBarClick, hideAnswers, userMarks, label }: ChartProps) {
  const ref = useRef<HTMLDivElement>(null);
  const chartRef = useRef<echarts.ECharts | null>(null);
  const clickRef = useRef(onBarClick);
  clickRef.current = onBarClick;
  // 合并展示方式（全局显示偏好）：solid 时仅显示合并K线实体，隐藏原始K线。
  const mergeStyle = useStore((s) => s.mergeStyle);
  const setMergeStyle = useStore((s) => s.setMergeStyle);
  // 合并实体视角：仅当合并图层开启时生效；此时隐藏原始K线、只留合并实体。
  const solidMerge = mergeStyle === 'solid' && layers.merged;
  // 记住用户手动缩放；仅当K线数量变化（换标的/回放步进）时回到默认窗口。
  const zoomRef = useRef<{ start: number; end: number } | null>(null);
  const lastLenRef = useRef(-1);

  useEffect(() => {
    if (!ref.current) return;
    const chart = echarts.init(ref.current);
    chartRef.current = chart;
    chart.on('dataZoom', () => {
      const dz = (chart.getOption() as { dataZoom?: { start?: number; end?: number }[] }).dataZoom?.[0];
      if (dz && typeof dz.start === 'number' && typeof dz.end === 'number') zoomRef.current = { start: dz.start, end: dz.end };
    });
    chart.getZr().on('click', (e: { offsetX: number; offsetY: number }) => {
      const point = [e.offsetX, e.offsetY];
      if (!chart.containPixel({ gridIndex: 0 }, point)) return;
      const idx = Math.round(chart.convertFromPixel({ xAxisIndex: 0 }, e.offsetX) as number);
      if (Number.isFinite(idx) && idx >= 0) clickRef.current?.(idx);
    });
    const ro = new ResizeObserver(() => chart.resize());
    ro.observe(ref.current);
    // 滚轮/触摸板横滑 = 平移；Ctrl/⌘+滚轮 = 缩放（缩放的专属手势）；拖拽 = 平移。
    const dom = ref.current;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const dz = (chart.getOption() as { dataZoom?: { start?: number; end?: number }[] }).dataZoom?.[0];
      if (!dz || typeof dz.start !== 'number' || typeof dz.end !== 'number') return;
      const span = dz.end - dz.start;
      let start: number;
      let end: number;
      if (e.ctrlKey || e.metaKey) {
        const factor = e.deltaY > 0 ? 1.2 : 1 / 1.2;
        const ns = Math.min(100, Math.max(2, span * factor));
        const c = (dz.start + dz.end) / 2;
        start = c - ns / 2;
        end = c + ns / 2;
      } else {
        const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
        const shift = (delta / 400) * span;
        start = dz.start + shift;
        end = dz.end + shift;
      }
      if (start < 0) { end -= start; start = 0; }
      if (end > 100) { start -= end - 100; end = 100; }
      chart.dispatchAction({ type: 'dataZoom', start: Math.max(0, start), end: Math.min(100, end) });
    };
    dom.addEventListener('wheel', onWheel, { passive: false, capture: true });
    return () => {
      dom.removeEventListener('wheel', onWheel, { capture: true });
      ro.disconnect();
      chart.dispose();
      chartRef.current = null;
    };
  }, []);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const dates = bars.map((b) => b.date);
    // 默认窗口：最近约150根，保证蜡烛实体有足够像素宽度（不扁）。
    if (bars.length !== lastLenRef.current) {
      zoomRef.current = null;
      lastLenRef.current = bars.length;
    }
    const VISIBLE = 150;
    const defaultStart = bars.length ? Math.max(0, (1 - Math.min(bars.length, VISIBLE) / bars.length) * 100) : 0;
    const dz = zoomRef.current ?? { start: defaultStart, end: 100 };
    const showFractal = layers.fractal && !hideAnswers;
    const showBi = layers.bi && !hideAnswers;

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
    const dateLabel = (val: string, i: number) => (yearStart.has(i) ? val.slice(0, 4) : `${Number(val.slice(5, 7))}月`);

    const confirmed = result.fractals.filter((f) => f.status === 'confirmed');
    const candidate = result.fractals.filter((f) => f.status === 'candidate');
    const fxData = (fs: Fractal[]) =>
      fs.map((f) => {
        const p = fxPoint(f, result);
        return p ? { value: [p.x, p.y], fx: f } : null;
      }).filter(Boolean) as { value: [number, number]; fx: Fractal }[];

    const mergedData = result.validBars.map((b) => ({ value: [b.startRaw, b.endRaw, b.low, b.high] }));
    const biById = new Map(result.fractals.map((f) => [f.id, f]));
    const biData = result.bis.map((bi) => {
      const s = biById.get(bi.start);
      const e = biById.get(bi.end);
      const ps = s ? fxPoint(s, result) : null;
      const pe = e ? fxPoint(e, result) : null;
      return ps && pe ? { value: [ps.x, ps.y, pe.x, pe.y, bi.status === 'candidate' ? 1 : 0] } : null;
    }).filter(Boolean) as { value: number[] }[];

    const last = bars[bars.length - 1];
    const prev = bars[bars.length - 2];
    const lastUp = last ? (prev ? last.close >= prev.close : last.close >= last.open) : true;
    const lastColor = lastUp ? C.up : C.down;

    const markArea = highlight && highlight.length
      ? { silent: true, itemStyle: { color: 'rgba(255,212,59,0.12)' }, data: [[{ xAxis: Math.min(...highlight) }, { xAxis: Math.max(...highlight) }]] }
      : undefined;
    const markLine = last
      ? {
          silent: true,
          symbol: 'none',
          lineStyle: { color: lastColor, type: 'dashed', width: 1, opacity: 0.65 },
          label: {
            show: true, position: 'start', formatter: last.close.toFixed(2),
            backgroundColor: lastColor, color: '#0f1420', padding: [2, 5], borderRadius: 3, fontSize: 10, fontWeight: 700,
          },
          data: [{ yAxis: last.close }],
        }
      : undefined;

    const option: any = {
      animation: false,
      backgroundColor: 'transparent',
      grid: { left: 58, right: 14, top: 14, bottom: 46 },
      tooltip: {
        trigger: 'axis',
        axisPointer: {
          type: 'cross',
          crossStyle: { color: 'rgba(215,222,239,0.35)', type: 'dashed' },
          label: { backgroundColor: C.surface2, borderColor: C.accent, borderWidth: 1, color: C.text, fontSize: 10, precision: 2 },
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
          return `<b>${b.date}</b>${st}${chg}<br/>开 ${b.open.toFixed(2)}　高 ${b.high.toFixed(2)}<br/>低 ${b.low.toFixed(2)}　收 ${b.close.toFixed(2)}<br/>量 ${(b.volume / 1e4).toFixed(0)}万`;
        },
      },
      xAxis: {
        type: 'category',
        data: dates,
        boundaryGap: true,
        axisLine: { lineStyle: { color: C.axis } },
        axisTick: { show: false },
        axisLabel: { color: C.label, fontSize: 10, interval: isMonth, formatter: dateLabel, hideOverlap: true, margin: 10 },
        splitLine: { show: true, interval: isMonth, lineStyle: { color: C.gridV, type: 'dashed' } },
        axisPointer: { label: { backgroundColor: C.surface2, borderColor: C.accent, borderWidth: 1, color: C.text, fontSize: 10, formatter: (p: { value: string }) => p.value } },
        min: 'dataMin',
        max: 'dataMax',
      },
      yAxis: {
        scale: true,
        position: 'left',
        axisLine: { show: true, lineStyle: { color: C.axis } },
        axisTick: { show: true, lineStyle: { color: C.axis } },
        axisLabel: { color: C.label, fontSize: 10, margin: 8, formatter: (v: number) => v.toFixed(2) },
        splitLine: { lineStyle: { color: C.grid, type: 'dashed' } },
        axisPointer: { label: { backgroundColor: C.accent, color: '#0f1420', fontSize: 10, fontWeight: 600, precision: 2, formatter: (p: { value: number }) => p.value.toFixed(2) } },
      },
      dataZoom: [
        {
          type: 'inside', xAxisIndex: 0, start: dz.start, end: dz.end,
          zoomOnMouseWheel: false,
          moveOnMouseWheel: false,
          moveOnMouseMove: true,
          preventDefaultMouseMove: true,
        },
        {
          type: 'slider', xAxisIndex: 0, height: 22, bottom: 6,
          start: dz.start, end: dz.end,
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
        },
      ],
      series: [
        {
          name: 'K线',
          type: 'candlestick',
          // 合并实体视角下隐藏原始K线，仅保留合并结果。
          data: solidMerge ? [] : bars.map((b) => [b.open, b.close, b.low, b.high]),
          barWidth: '62%',
          barMinWidth: 1,
          barMaxWidth: 16,
          itemStyle: { color: C.up, color0: C.down, borderColor: C.up, borderColor0: C.down, borderWidth: 1 },
          markArea: solidMerge ? undefined : markArea,
          markLine: solidMerge ? undefined : markLine,
        },
        {
          name: '合并K线',
          type: 'custom',
          data: layers.merged ? mergedData : [],
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
            return {
              type: 'rect',
              shape: { x: pH[0]! - bw / 2 + gap, y: pH[1]!, width: Math.max(1, (end - start) * bw + bw - gap * 2), height: Math.max(1, pL[1]! - pH[1]!), r: solidMerge ? 2 : 0 },
              style: solidMerge
                ? {
                    fill: {
                      type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
                      colorStops: [
                        { offset: 0, color: '#6ca8ff' },
                        { offset: 1, color: '#3468d6' },
                      ],
                    },
                    stroke: 'rgba(150,192,255,0.95)', lineWidth: 1.2,
                  }
                : { fill: 'rgba(76,141,255,0.10)', stroke: 'rgba(76,141,255,0.55)', lineWidth: 1 },
            };
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
          markArea: solidMerge ? markArea : undefined,
          markLine: solidMerge ? markLine : undefined,
          z: 1,
        },
        {
          name: '笔',
          type: 'custom',
          data: showBi ? biData : [],
          renderItem: (_p: unknown, api: { coord: (v: number[]) => number[]; value: (i: number) => unknown }) => {
            const p1 = api.coord([api.value(0) as number, api.value(1) as number]);
            const p2 = api.coord([api.value(2) as number, api.value(3) as number]);
            const isCand = (api.value(4) as number) === 1;
            return {
              type: 'line',
              shape: { x1: p1[0]!, y1: p1[1]!, x2: p2[0]!, y2: p2[1]! },
              style: { stroke: C.bi, lineWidth: 1.6, lineDash: isCand ? [5, 4] : undefined },
            };
          },
          encode: { x: [0, 2], y: [1, 3] },
          z: 3,
        },
        {
          name: '顶分型',
          type: 'scatter',
          data: showFractal ? fxData(confirmed.filter((f) => f.type === 'top')) : [],
          symbol: 'arrow', symbolSize: 10, symbolRotate: 180,
          itemStyle: { color: C.top },
          z: 4,
        },
        {
          name: '底分型',
          type: 'scatter',
          data: showFractal ? fxData(confirmed.filter((f) => f.type === 'bottom')) : [],
          symbol: 'arrow', symbolSize: 10,
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
      ],
    };
    chart.setOption(option, { notMerge: true });
  }, [bars, result, layers, highlight, hideAnswers, userMarks, mergeStyle]);

  // 重置缩放（非平移）：回到默认最近150根窗口。
  const resetZoom = () => {
    const chart = chartRef.current;
    if (!chart) return;
    zoomRef.current = null;
    const start = bars.length ? Math.max(0, (1 - Math.min(bars.length, 150) / bars.length) * 100) : 0;
    chart.dispatchAction({ type: 'dataZoom', start, end: 100 });
  };

  const chips: Chip[] = [
    { color: C.up, label: '涨', show: !solidMerge },
    { color: C.down, label: '跌', show: !solidMerge },
    { color: C.merged, label: '合并K线', show: layers.merged, hollow: !solidMerge },
    { color: C.bi, label: '笔', show: layers.bi && !hideAnswers },
    { color: C.top, label: '顶分型', show: layers.fractal && !hideAnswers },
    { color: C.bottom, label: '底分型', show: layers.fractal && !hideAnswers },
    { color: C.candidate, label: '候选', dashed: true, show: layers.candidate && !hideAnswers },
    { color: C.mark, label: '我的标记', show: !!userMarks },
  ];

  return (
    <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column' }}>
      <div className="chart-legend">
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
          <Tooltip title="重置缩放（回到最近150根）">
            <Button size="small" onClick={resetZoom}>⤾</Button>
          </Tooltip>
        </span>
        <span className="legend-hint">拖拽 / 滚轮 / 横滑 = 平移 · Ctrl+滚轮 / 双指 = 缩放</span>
        <span className="legend-unit">价格 · 元</span>
      </div>
      <div ref={ref} className="chart-canvas" />
    </div>
  );
}