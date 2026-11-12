// 全局状态（zustand 单 store）。缠论计算结果由组件 useMemo 派生，避免第二状态源。
import { create } from 'zustand';
import { 预设, type ChanConfig } from '@chan/engine';
import { fetchKline, fetchSymbols, type KlineMeta, type RawBar, type SymbolItem } from './api.ts';

export type Mode = 'learn' | 'compare' | 'practice' | 'multi';
export interface Layers {
  merged: boolean;
  fractal: boolean;
  bi: boolean;
  candidate: boolean;
  segment: boolean;
  center: boolean;
  divergence: boolean;
  point: boolean;
}

/** 口径对比预设对（千人千缠素材，均带出处）。 */
export const 对比预设对: { name: string; a: ChanConfig; b: ChanConfig; note: string }[] = [
  {
    name: '77课 vs 社区老笔',
    a: { ...预设.原文默认 },
    b: { ...预设.原文默认, biRule: '社区老笔' },
    note: '价格条件：区间条件（原文）vs 比两个价（社区）。顶区间全落在底区间内时分歧。',
  },
  {
    name: '两位小数 vs 取个位',
    a: { ...预设.原文默认, precision: { digits: 2 } },
    b: { ...预设.原文默认, precision: { digits: 0 } },
    note: '59/81课：价格精度改变包含判定，进而改变分型/笔。',
  },
  {
    name: '起点向上 vs 向下',
    a: { ...预设.原文默认, startDir: 'up' },
    b: { ...预设.原文默认, startDir: 'down' },
    note: '65课：最左端方向须事先约定；约定不同可能改变左端合并。',
  },
  {
    name: '回找非包含 vs 直接用前一根',
    a: { ...预设.原文默认 },
    b: { ...预设.原文默认, mergeDir: '直接用前一根' },
    note: '错误示范：包含时方向无定义，直接用被合并两根会抹掉新极值。',
  },
  {
    name: '特征序列 做包含 vs 不做',
    a: { ...预设.原文默认 },
    b: { ...预设.原文默认, segMerge: '不做包含处理' },
    note: '67课：特征序列先做非包含处理（标准化）再找分型 vs 直接用原始笔区间。影响线段端点与数量。',
  },
  {
    name: '端点相接 算重叠 vs 须严格',
    a: { ...预设.原文默认 },
    b: { ...预设.原文默认, touchOverlap: '须严格重叠' },
    note: '54课单价位可计重叠（闭区间）vs 严格重叠（开区间）。影响缺口判定，进而影响第一/二种情况分流。',
  },
  {
    name: '笔中枢 vs 线段中枢',
    a: { ...预设.原文默认, centerUnit: '笔中枢' },
    b: { ...预设.原文默认, centerUnit: '线段中枢' },
    note: '83课：笔中枢稳定性极差但灵敏，线段中枢更稳更粗。同一数据，中枢数量与位置差异巨大。',
  },
  {
    name: '背驰 MACD面积 vs 几何',
    a: { ...预设.原文默认, centerUnit: '笔中枢', divMetric: 'MACD面积' },
    b: { ...预设.原文默认, centerUnit: '笔中枢', divMetric: '中枢视角几何' },
    note: '24/25课 MACD柱面积 vs 33课 c段净位移。力度度量不同，背驰点不同。（笔中枢下结构更丰富，便于观察）',
  },
  {
    name: '三买 不跌破ZG vs 不触及ZG',
    a: { ...预设.原文默认, bsp3Touch: '不跌破ZG' },
    b: { ...预设.原文默认, bsp3Touch: '不触及ZG' },
    note: '20课"不跌破"(>=) vs 21课"不触及"(>)。回试低点恰好等于 ZG 时分歧。',
  },
];

interface Store {
  symbols: SymbolItem[];
  code: string;
  adjust: string;
  bars: RawBar[];
  meta: KlineMeta | null;
  loading: boolean;
  error: string | null;
  configA: ChanConfig;
  configB: ChanConfig;
  mode: Mode;
  cursor: number;
  playing: boolean;
  /** 自动回放间隔（毫秒/根）。默认放慢，便于逐根观察包含/分型/笔转换。 */
  playMs: number;
  layers: Layers;
  /** 合并展示方式：outline=原始K线实体+合并外框；solid=仅合并K线实体（隐藏原始K线）。 */
  mergeStyle: 'outline' | 'solid';
  highlight: number[] | null;
  searchSymbols: (q: string) => Promise<void>;
  load: (code: string, adjust: string) => Promise<void>;
  setAdjust: (a: string) => void;
  setConfigA: (c: ChanConfig) => void;
  setConfigB: (c: ChanConfig) => void;
  setMode: (m: Mode) => void;
  setCursor: (n: number) => void;
  step: (d: number) => void;
  setPlaying: (p: boolean) => void;
  setPlayMs: (n: number) => void;
  toggleLayer: (k: keyof Layers) => void;
  setMergeStyle: (s: 'outline' | 'solid') => void;
  setHighlight: (refs: number[] | null) => void;
}

export const useStore = create<Store>((set, get) => ({
  symbols: [],
  code: 'sh.600000',
  adjust: '1',
  bars: [],
  meta: null,
  loading: false,
  error: null,
  configA: { ...预设.原文默认 },
  configB: { ...预设.原文默认, biRule: '社区老笔' },
  mode: 'learn',
  cursor: 0,
  playing: false,
  playMs: 600,
  layers: { merged: true, fractal: true, bi: true, candidate: true, segment: true, center: true, divergence: true, point: true },
  mergeStyle: 'outline',
  highlight: null,

  searchSymbols: async (q) => {
    try {
      set({ symbols: await fetchSymbols(q) });
    } catch (e) {
      set({ error: String(e instanceof Error ? e.message : e) });
    }
  },

  load: async (code, adjust) => {
    set({ loading: true, error: null, code, adjust, playing: false });
    try {
      const { bars, meta } = await fetchKline(code, adjust, 500);
      set({ bars, meta, cursor: Math.max(0, bars.length - 1), loading: false, highlight: null });
    } catch (e) {
      set({ loading: false, error: String(e instanceof Error ? e.message : e), bars: [], meta: null });
    }
  },

  setAdjust: (a) => {
    const { code, load } = get();
    void load(code, a);
  },
  setConfigA: (c) => set({ configA: c }),
  setConfigB: (c) => set({ configB: c }),
  setMode: (m) => set({ mode: m, playing: false }),
  setCursor: (n) => {
    const max = Math.max(0, get().bars.length - 1);
    set({ cursor: Math.max(0, Math.min(n, max)) });
  },
  step: (d) => {
    const { cursor, setCursor } = get();
    setCursor(cursor + d);
  },
  setPlaying: (p) => set({ playing: p }),
  setPlayMs: (n) => set({ playMs: n }),
  toggleLayer: (k) => set({ layers: { ...get().layers, [k]: !get().layers[k] } }),
  setMergeStyle: (s) => {
    // 切到「合并实体」时确保合并图层开启，否则无实体可侧重。
    const layers = s === 'solid' ? { ...get().layers, merged: true } : get().layers;
    set({ mergeStyle: s, layers });
  },
  setHighlight: (refs) => set({ highlight: refs }),
}));