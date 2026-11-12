// 缠论引擎核心类型。区间一律表示为 [low, high]，与 配图自检.py 参考内核一致。

/** 引擎输入：已走完的原始K线。high/low 用于结构；可选 close 用于 MACD/背驰（缺省时 MACD 口径不可用）。 */
export interface KInput {
  date: string;
  high: number;
  low: number;
  close?: number;
}

export type StartDir = 'up' | 'down';
export type BiRule = '77课' | '社区老笔' | '社区新笔';
export type MergeDirRule = '回找非包含' | '直接用前一根';
export type PrecisionDigits = 0 | 1 | 2 | 3 | 4 | 'raw';
/** 端点相接是否算重叠（54课单价位可计重叠=闭区间 lo<=hi；严格=lo<hi）。统一用于线段缺口与中枢重叠。 */
export type TouchOverlapRule = '相接算重叠' | '须严格重叠';
/** 特征序列是否做非包含处理（67课「可以对此进行非包含处理」vs 直接用原始笔区间找分型的社区简化）。 */
export type SegMergeRule = '做包含处理' | '不做包含处理';
/** 中枢构件：线段中枢（原文主方案，稳定性好）vs 笔中枢（83课允许但稳定性极差）。 */
export type CenterUnitRule = '线段中枢' | '笔中枢';
/** 中枢延伸升级：9段升级（33课延伸5段+初始3段）vs 不自动升级（简化）。 */
export type CenterUpgradeRule = '9段升级' | '不自动升级';
/** 趋势中同级中枢不重叠的判定口径：核心不重叠（ZG/ZD）vs 外围也不重叠（GG/DD，20课更严格）。 */
export type TrendOverlapRule = '核心不重叠' | '外围也不重叠';
/** 背驰力度度量：MACD面积（24/25课，需 close）vs 中枢视角几何（33课 c段 vs b段价格幅度，纯 high/low）。 */
export type DivMetricRule = 'MACD面积' | '中枢视角几何';
/** 三买/三卖边界：不跌破ZG（20课，>=）vs 不触及ZG（21课，>）。 */
export type Bsp3TouchRule = '不跌破ZG' | '不触及ZG';
/** 二买是否允许低于一买：允许（101课原文）vs 过滤须高于一买（研究过滤器，标非原文）。 */
export type Bsp2FilterRule = '允许二买低于一买' | '过滤二买须高于一买';

/** 口径全必填，compute 拒绝缺省（无隐式默认）。canonicalConfig 键序固定，新增维度追加在末。 */
export interface ChanConfig {
  startDir: StartDir;
  precision: { digits: PrecisionDigits };
  biRule: BiRule;
  mergeDir: MergeDirRule;
  touchOverlap: TouchOverlapRule;
  segMerge: SegMergeRule;
  centerUnit: CenterUnitRule;
  centerUpgrade: CenterUpgradeRule;
  trendOverlap: TrendOverlapRule;
  divMetric: DivMetricRule;
  bsp3Touch: Bsp3TouchRule;
  bsp2Filter: Bsp2FilterRule;
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

/** 线段：由连续笔构成（≥3笔且前三笔有重叠），端点为一顶一底分型。 */
export interface Segment {
  id: number;
  /** 线段方向＝其首笔方向；向上线段止于顶、向下线段止于底。 */
  dir: 'up' | 'down';
  /** 起止分型 id（溯源到笔/分型）。 */
  startFx: number;
  endFx: number;
  /** 线段在原始K线下的起止下标（端点分型中间根位置）。 */
  startRaw: number;
  endRaw: number;
  high: number;
  low: number;
  status: 'candidate' | 'confirmed';
  confirmedAt: number | null;
}

/** 中枢：连续三个次级别构件（笔或线段）重叠构成。核心 [ZD,ZG] 与外围 GG/DD/G/D 都存。 */
export interface Center {
  id: number;
  unit: 'bi' | 'segment';
  /** 中枢方向＝首个构件（Z走势段）方向；回升形成=up，回调形成=down。 */
  dir: 'up' | 'down';
  startRaw: number;
  endRaw: number;
  ZG: number; // 中枢上沿 = min(各构件高点)（前三个）
  ZD: number; // 中枢下沿 = max(各构件低点)（前三个）
  GG: number; // 外围最高 = max(所有构件高点)
  DD: number; // 外围最低 = min(所有构件低点)
  G: number;  // min(各构件高点)
  D: number;  // max(各构件低点)
  /** 构件段数（含延伸），9段升级判据用。 */
  segCount: number;
  status: 'candidate' | 'confirmed';
  confirmedAt: number | null;
}

/** 走势类型：盘整=单中枢；趋势=≥2个同向且依次不重叠的中枢（上涨/下跌）。 */
export interface Trend {
  id: number;
  kind: '盘整' | '上涨' | '下跌';
  /** 组成的中枢 id（按时间顺序）。 */
  centerIds: number[];
  startRaw: number;
  endRaw: number;
  status: 'candidate' | 'confirmed';
  confirmedAt: number | null;
}

/** MACD 副图序列（对齐原始K线下标）。 */
export interface MacdSeries {
  dif: number[];
  dea: number[];
  hist: number[];
}

/** 背驰：比较进入段(b)与离开段(c)力度，c<b 则背驰。趋势背驰=趋势末中枢后；盘整背驰=盘整中枢。 */
export interface Divergence {
  id: number;
  kind: '趋势背驰' | '盘整背驰';
  metric: DivMetricRule;
  /** 背驰方向：上涨背驰（顶）/下跌背驰（底）。 */
  dir: 'up' | 'down';
  /** b段（进入）与 c段（离开）的原始K线区间。 */
  bStart: number;
  bEnd: number;
  cStart: number;
  cEnd: number;
  /** 力度值：MACD=同向柱面积；几何=段价格跨度。 */
  bForce: number;
  cForce: number;
  /** cForce 是否为候选估算（c段进行中 ×2 估算）。 */
  est: boolean;
  status: 'candidate' | 'confirmed';
  confirmedAt: number | null;
}

/** 买卖点。atRaw=结构位置（原始K线下标），confirmedAt=首次可知时间（事后性）。 */
export interface BuySellPoint {
  id: number;
  side: 'buy' | 'sell';
  /** 1=背驰转折点；2=一买后回抽再探底；3=离开中枢后首次回试不破边界。 */
  klass: 1 | 2 | 3;
  atRaw: number;
  price: number;
  /** 关联的中枢或背驰 id（溯源）。 */
  refId?: number;
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
  | '剔除'
  | '线段候选'
  | '线段确认'
  | '线段破坏'
  | '中枢候选'
  | '中枢确认'
  | '中枢延伸'
  | '中枢新生'
  | '中枢升级'
  | '走势类型'
  | '背驰候选'
  | '背驰确认'
  | '买点确认'
  | '卖点确认';

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
  /** 已确认线段 + 当前候选（候选在末尾）。 */
  segments: Segment[];
  /** 已确认中枢 + 当前候选（候选在末尾）。 */
  centers: Center[];
  /** 走势类型分解（末段为候选）。 */
  trends: Trend[];
  /** 背驰（趋势/盘整），末段进行中为候选（含 ×2 估算）。 */
  divergences: Divergence[];
  /** 买卖点（一/二/三类，买/卖）。 */
  points: BuySellPoint[];
  /** MACD 副图序列（仅当输入含 close 时存在）。 */
  macd?: MacdSeries;
  events: ChanEvent[];
}