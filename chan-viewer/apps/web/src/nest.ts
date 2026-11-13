// 多周期结构定位与窗口筛选。只读既有 ComputeResult，不重算缠论结构。
import type { ComputeResult, Fractal } from '@chan/engine';
import type { RawBar } from './api.ts';

export type StructureKind = 'bi' | 'segment' | 'center' | 'fractal' | 'divergence' | 'point';
export interface StructureRef { kind: StructureKind; id: number }
export interface StructureItem extends StructureRef {
  label: string;
  startRaw: number;
  endRaw: number;
  status: 'candidate' | 'confirmed';
  description: string;
}

export const STRUCTURE_LABEL: Record<StructureKind, string> = {
  bi: '笔', segment: '线段', center: '中枢', fractal: '分型', divergence: '背驰', point: '买卖点',
};

function dateAt(bars: RawBar[], raw: number): string {
  const i = Math.max(0, Math.min(bars.length - 1, Math.round(raw)));
  return bars[i]?.date ?? '';
}

function fractalRaw(f: Fractal, result: ComputeResult): number | null {
  const mb = result.validBars[f.middle];
  return mb ? (mb.startRaw + mb.endRaw) / 2 : null;
}

/** 结构的原始K线范围，供图表高亮、dataZoom 与反向定位共用。 */
export function rawRangeOf(result: ComputeResult, ref: StructureRef): [number, number] | null {
  if (ref.kind === 'bi') {
    const bi = result.bis.find((x) => x.id === ref.id);
    const sf = bi && result.fractals.find((f) => f.id === bi.start);
    const ef = bi && result.fractals.find((f) => f.id === bi.end);
    const a = sf ? fractalRaw(sf, result) : null;
    const b = ef ? fractalRaw(ef, result) : null;
    return a == null || b == null ? null : [Math.min(a, b), Math.max(a, b)];
  }
  if (ref.kind === 'segment') {
    const x = result.segments.find((s) => s.id === ref.id);
    return x ? [x.startRaw, x.endRaw] : null;
  }
  if (ref.kind === 'center') {
    const x = result.centers.find((c) => c.id === ref.id);
    return x ? [x.startRaw, x.endRaw] : null;
  }
  if (ref.kind === 'fractal') {
    const x = result.fractals.find((f) => f.id === ref.id);
    return x ? [x.startRaw, x.endRaw] : null;
  }
  if (ref.kind === 'divergence') {
    const x = result.divergences.find((d) => d.id === ref.id);
    return x ? [x.cStart, x.cEnd] : null;
  }
  const x = result.points.find((p) => p.id === ref.id);
  return x ? [x.atRaw, x.atRaw] : null;
}

export function structureItem(result: ComputeResult, ref: StructureRef): StructureItem | null {
  const range = rawRangeOf(result, ref);
  if (!range) return null;
  const base = { kind: ref.kind, id: ref.id, startRaw: range[0], endRaw: range[1] };
  if (ref.kind === 'bi') {
    const x = result.bis.find((b) => b.id === ref.id)!;
    return { ...base, label: `笔 ${String(x.id).padStart(2, '0')}`, status: x.status, description: x.dir === 'up' ? '向上笔' : '向下笔' };
  }
  if (ref.kind === 'segment') {
    const x = result.segments.find((s) => s.id === ref.id)!;
    return { ...base, label: `线段 ${String(x.id).padStart(2, '0')}`, status: x.status, description: `${x.dir === 'up' ? '向上' : '向下'} · ${x.low.toFixed(2)}–${x.high.toFixed(2)}` };
  }
  if (ref.kind === 'center') {
    const x = result.centers.find((c) => c.id === ref.id)!;
    const rel = x.relation === 'expanded' ? '扩展' : x.relation === 'new' ? '新生' : '首中枢';
    return { ...base, label: `中枢 ${String(x.id).padStart(2, '0')}`, status: x.status, description: `ZD ${x.ZD.toFixed(2)} · ZG ${x.ZG.toFixed(2)} · ${x.segCount}构件 · ${rel}` };
  }
  if (ref.kind === 'fractal') {
    const x = result.fractals.find((f) => f.id === ref.id)!;
    return { ...base, label: `${x.type === 'top' ? '顶' : '底'}分型 ${x.id}`, status: x.status, description: `价格 ${x.price.toFixed(2)}` };
  }
  if (ref.kind === 'divergence') {
    const x = result.divergences.find((d) => d.id === ref.id)!;
    return { ...base, label: `${x.kind} ${x.id}`, status: x.status, description: `${x.dir === 'up' ? '顶' : '底'}背驰 · 力度 ${x.bForce.toFixed(3)} → ${x.cForce.toFixed(3)}` };
  }
  const x = result.points.find((p) => p.id === ref.id)!;
  return { ...base, label: `${x.side === 'buy' ? '买' : '卖'}${['一', '二', '三'][x.klass - 1]}类 ${x.id}`, status: x.status, description: `价格 ${x.price.toFixed(2)}` };
}

/** 全部可定位结构。详情列表与图外反向定位共用这一事实源。 */
export function structureItems(result: ComputeResult): StructureItem[] {
  const refs: StructureRef[] = [
    ...result.bis.map((x) => ({ kind: 'bi' as const, id: x.id })),
    ...result.segments.map((x) => ({ kind: 'segment' as const, id: x.id })),
    ...result.centers.map((x) => ({ kind: 'center' as const, id: x.id })),
    ...result.fractals.map((x) => ({ kind: 'fractal' as const, id: x.id })),
    ...result.divergences.map((x) => ({ kind: 'divergence' as const, id: x.id })),
    ...result.points.map((x) => ({ kind: 'point' as const, id: x.id })),
  ];
  return refs.map((ref) => structureItem(result, ref)).filter((x): x is StructureItem => !!x)
    .sort((a, b) => a.startRaw - b.startRaw || a.endRaw - b.endRaw);
}

/** 图上点击空白处时选择包含该根K线的最具体结构。系列自身的点击会精确覆盖此结果。 */
export function structureAt(result: ComputeResult, raw: number): StructureRef | null {
  const hits = structureItems(result).filter((x) => raw >= x.startRaw - 0.6 && raw <= x.endRaw + 0.6);
  hits.sort((a, b) => (a.endRaw - a.startRaw) - (b.endRaw - b.startRaw));
  return hits[0] ? { kind: hits[0].kind, id: hits[0].id } : null;
}

export function windowFor(result: ComputeResult, bars: RawBar[], ref: StructureRef): [string, string] | null {
  const range = rawRangeOf(result, ref);
  return range ? [dateAt(bars, range[0]), dateAt(bars, range[1])] : null;
}

/** 次级别中落在 [t0,t1] 的 raw 下标。日线结束日期扩展至当日尾盘，避免丢掉最后一天。 */
export function rawIndicesWithin(lowerBars: RawBar[], t0: string, t1: string): number[] {
  const end = t1.length === 10 ? `${t1} 23:59:59` : t1;
  const out: number[] = [];
  lowerBars.forEach((b, i) => { if (b.date >= t0 && b.date <= end) out.push(i); });
  return out;
}

export function structuresWithin(result: ComputeResult, bars: RawBar[], t0: string, t1: string): StructureItem[] {
  const end = t1.length === 10 ? `${t1} 23:59:59` : t1;
  return structureItems(result).filter((x) => dateAt(bars, x.endRaw) >= t0 && dateAt(bars, x.startRaw) <= end);
}
