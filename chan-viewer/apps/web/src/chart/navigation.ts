// 逐级看图导航状态：日线 → 30分钟 → 5分钟。纯函数，不依赖 React/ECharts。
import type { StructureRef } from '../nest.ts';

export type Level = 'd' | 'm30' | 'm5';
export const LEVELS: readonly Level[] = ['d', 'm30', 'm5'];

export interface ViewSnapshot {
  start: number;
  end: number;
  total: number;
}

/** null 端点表示恢复该周期默认窗口；seq 在一次导航会话内只增不减。 */
export interface ViewRequest {
  seq: number;
  start: number | null;
  end: number | null;
}

export interface NavStep {
  level: Level;
  ref: StructureRef | null;
  /** 父层带下来的完整覆盖，不随平移或定位改变。 */
  range: [number, number] | null;
  /** 当前实际 raw 索引视窗，返回时逐项恢复。 */
  view: ViewSnapshot | null;
  viewRequest: ViewRequest | null;
}

export interface NavState {
  path: NavStep[];
  locked: boolean;
  requestSeq: number;
}

export function initialNav(): NavState {
  return { path: [{ level: 'd', ref: null, range: null, view: null, viewRequest: null }], locked: false, requestSeq: 0 };
}

export function currentStep(nav: NavState): NavStep {
  return nav.path[nav.path.length - 1]!;
}

export function hasLevel(nav: NavState, level: Level): boolean {
  return nav.path.some((s) => s.level === level);
}

export function requestView(nav: NavState, level: Level, range: [number, number] | null): NavState {
  const idx = nav.path.findIndex((s) => s.level === level);
  if (idx < 0) return nav;
  const seq = nav.requestSeq + 1;
  const viewRequest = { seq, start: range?.[0] ?? null, end: range?.[1] ?? null };
  return { ...nav, requestSeq: seq, path: nav.path.map((s, i) => i === idx ? { ...s, viewRequest } : s) };
}

export function selectOnLevel(nav: NavState, level: Level, ref: StructureRef | null): NavState {
  const idx = nav.path.findIndex((s) => s.level === level);
  if (idx < 0) return nav;
  const path = nav.path.slice(0, idx + 1).map((s, i) => i === idx ? { ...s, ref } : s);
  return { ...nav, path, locked: false };
}

/** 初次进入用 range 定位；调用方可再请求带可读性 padding 的窗口。 */
export function drillDown(nav: NavState, range: [number, number] | null = null, view: ViewSnapshot | null = null): NavState {
  const i = LEVELS.indexOf(currentStep(nav).level);
  if (i < 0 || i >= LEVELS.length - 1) return nav;
  const next = LEVELS[i + 1]!;
  const state = { ...nav, path: [...nav.path, { level: next, ref: null, range, view, viewRequest: null }], locked: false };
  return requestView(state, next, view ? [view.start, view.end] : range);
}

export function goBack(nav: NavState): NavState {
  if (nav.path.length <= 1) return nav;
  return jumpTo(nav, nav.path[nav.path.length - 2]!.level);
}

export function jumpTo(nav: NavState, level: Level): NavState {
  const idx = nav.path.findIndex((s) => s.level === level);
  if (idx < 0 || idx === nav.path.length - 1) return nav;
  const step = nav.path[idx]!;
  const state = { ...nav, path: nav.path.slice(0, idx + 1), locked: false };
  return requestView(state, level, step.view ? [step.view.start, step.view.end] : step.range);
}

export function updateView(nav: NavState, level: Level, view: ViewSnapshot | null): NavState {
  const idx = nav.path.findIndex((s) => s.level === level);
  if (idx < 0) return nav;
  const old = nav.path[idx]!.view;
  if (old?.start === view?.start && old?.end === view?.end && old?.total === view?.total) return nav;
  return { ...nav, path: nav.path.map((s, i) => i === idx ? { ...s, view } : s) };
}

export function setRange(nav: NavState, level: Level, range: [number, number] | null): NavState {
  const idx = nav.path.findIndex((s) => s.level === level);
  if (idx < 0) return nav;
  return { ...nav, path: nav.path.map((s, i) => i === idx ? { ...s, range } : s), locked: false };
}

export function resetNav(nav: NavState = initialNav()): NavState {
  return requestView({ ...initialNav(), requestSeq: nav.requestSeq }, 'd', null);
}
