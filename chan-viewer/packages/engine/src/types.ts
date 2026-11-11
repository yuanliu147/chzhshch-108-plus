// 缠论引擎核心类型。区间一律表示为 [low, high]，与 配图自检.py 参考内核一致。

/** 引擎输入：已走完的原始K线，只用高低点（62课「这里不分阳线阴线，只看K线高低点」）。 */
export interface KInput {
  date: string;
  high: number;
  low: number;
}

export type StartDir = 'up' | 'down';
export type BiRule = '77课' | '社区老笔' | '社区新笔';
export type MergeDirRule = '回找非包含' | '直接用前一根';
export type PrecisionDigits = 0 | 1 | 2 | 3 | 4 | 'raw';

/** 口径四维全必填，compute 拒绝缺省（无隐式默认）。 */
export interface ChanConfig {
  startDir: StartDir;
  precision: { digits: PrecisionDigits };
  biRule: BiRule;
  mergeDir: MergeDirRule;
}

/** 有效K线（包含处理后）。refs 溯源到原始K线下标区间（含端点）。 */
export interface MergedBar {
  index: number;
  high: number;
  low: number;
  startRaw: number;
  endRaw: number;
}

export type FractalType = 'top' | 'bottom';

export interface Fractal {
  id: number;
  type: FractalType;
  /** 中间根在 validBars 中的下标。 */
  middle: number;
  /** 顶=中间根高点，底=中间根低点。 */
  price: number;
  /** 中间根完整区间（价格区间条件用）。 */
  midHigh: number;
  midLow: number;
  startRaw: number;
  endRaw: number;
  status: 'candidate' | 'confirmed';
  confirmedAt: number | null;
}

export interface Bi {
  id: number;
  start: number;
  end: number;
  /** 先底后顶=向上一笔。 */
  dir: 'up' | 'down';
  status: 'candidate' | 'confirmed';
  confirmedAt: number | null;
}

export type EventKind =
  | '起点方向'
  | '合并'
  | '分型候选'
  | '分型确认'
  | '分型撤销'
  | '笔候选'
  | '笔确认'
  | '改端点'
  | '剔除';

export interface ChanEvent {
  /** 触发事件的原始K线下标。 */
  at: number;
  kind: EventKind;
  reason: string;
  /** 课号引文键，如 ['062','065']。 */
  cite: string[];
  /** 涉及的原始K线下标。 */
  refs: number[];
  /** 分型或笔的 id。 */
  id?: number;
}

export interface ComputeResult {
  configId: string;
  config: ChanConfig;
  validBars: MergedBar[];
  /** 已确认分型 + 当前候选（候选在末尾）。 */
  fractals: Fractal[];
  bis: Bi[];
  events: ChanEvent[];
}