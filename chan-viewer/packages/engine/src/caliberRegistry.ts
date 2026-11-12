// 口径注册表：每个口径取值的标签、来源、课号与逐字引文。
// 引文摘录自 新手手册/手册正文.html（只读参照），引擎保持无 IO。
// 来源徽标：原文 / 社区（非原文对照）/ 错误示范。
import type { ChanConfig } from './types.ts';

export type CaliberSource = '原文' | '社区' | '错误示范' | '实现假设';

export interface CaliberEntry {
  value: string;
  label: string;
  source: CaliberSource;
  lesson: string[];
  quote: string;
  note?: string;
}

export const 口径注册 = {
  startDir: {
    up: {
      value: 'up',
      label: '起点向上',
      source: '原文',
      lesson: ['065'],
      quote: '图最左端没有第n-1根时，起点方向要事先约定并写进日志。',
      note: '65课方向定义需借前一根；最左端无前根时按事先约定，本工具记入「起点方向」事件。',
    },
    down: {
      value: 'down',
      label: '起点向下',
      source: '原文',
      lesson: ['065'],
      quote: '图最左端没有第n-1根时，起点方向要事先约定并写进日志。',
      note: '同上，约定为向下。起点方向不同可能改变最左端若干合并，进而影响分型/笔。',
    },
  },
  precision: {
    raw: {
      value: 'raw',
      label: '原始精度（不舍入）',
      source: '原文',
      lesson: ['059', '081'],
      quote: '取个位还是取两位小数，会改变分型、笔和线段的划分（第59、81课）。',
      note: '使用数据源原始价格。形态分析用一套价，实际成交另记一套价。',
    },
    d0: { value: '0', label: '取个位', source: '原文', lesson: ['059', '081'], quote: '取个位还是取两位小数，会改变分型、笔和线段的划分（第59、81课）。' },
    d1: { value: '1', label: '取一位小数', source: '原文', lesson: ['059', '081'], quote: '取个位还是取两位小数，会改变分型、笔和线段的划分（第59、81课）。' },
    d2: { value: '2', label: '取两位小数', source: '原文', lesson: ['059', '081'], quote: '取个位还是取两位小数，会改变分型、笔和线段的划分（第59、81课）。' },
    d3: { value: '3', label: '取三位小数', source: '原文', lesson: ['059', '081'], quote: '取个位还是取两位小数，会改变分型、笔和线段的划分（第59、81课）。' },
    d4: { value: '4', label: '取四位小数', source: '原文', lesson: ['059', '081'], quote: '取个位还是取两位小数，会改变分型、笔和线段的划分（第59、81课）。' },
  },
  biRule: {
    '77课': {
      value: '77课',
      label: '77课原文口径',
      source: '原文',
      lesson: ['077'],
      quote: '顶和底之间至少有一个K线不属于顶分型与底分型',
      note: '价格条件为区间条件：「顶分型中最高那K线的区间至少要有一部分高于底分型中最低那K线的区间」。',
    },
    '社区老笔': {
      value: '社区老笔',
      label: '社区老笔（对照）',
      source: '社区',
      lesson: ['077'],
      quote: '用社区流传的「固定几根K线」当成笔标准（本地原文没有这个口径）',
      note: '非原文。独立K线同77课；价格条件放宽为比两个价（顶高于底即可），用于观察口径差异。',
    },
    '社区新笔': {
      value: '社区新笔',
      label: '社区新笔（对照）',
      source: '社区',
      lesson: ['077'],
      quote: '用社区流传的「固定几根K线」当成笔标准（本地原文没有这个口径）',
      note: '非原文。允许顶底分型共用1根K线（4根成笔）；价格条件同77课区间条件。',
    },
  },
  mergeDir: {
    '回找非包含': {
      value: '回找非包含',
      label: '回找非包含前根（原文）',
      source: '原文',
      lesson: ['065'],
      quote: '假设，第n根K线满足第n根与第n+1根的包含关系，而第n根与第n-1根不是包含关系，那么如果……，那么称第n-1、n、n+1根K线是向上的；如果……，那么称第n-1、n、n+1根K线是向下的。',
      note: 'gn≥gn-1→向上；dn≤dn-1→向下；两者不可能同时成立。',
    },
    '直接用前一根': {
      value: '直接用前一根',
      label: '直接用被合并两根（错误示范）',
      source: '错误示范',
      lesson: ['065'],
      quote: '包含关系本身没有方向',
      note: '错误示范：包含时方向无定义，用被合并两根自身判方向会抹掉新极值并可能重新引入包含（手册 fig-fangxiang 警示）。',
    },
  },
  touchOverlap: {
    '相接算重叠': {
      value: '相接算重叠',
      label: '端点相接算重叠（闭区间）',
      source: '原文',
      lesson: ['054', '067'],
      quote: '特征序列两相邻元素间没有重合区间，称为该序列的一个缺口。',
      note: '54课实例把单一价位重叠计为中枢；按闭区间 [lo,hi]，lo<=hi 即算有重合（端点相接不算缺口）。',
    },
    '须严格重叠': {
      value: '须严格重叠',
      label: '须严格重叠（开区间，实现假设）',
      source: '实现假设',
      lesson: ['067'],
      quote: '缺口定义是「没有重合区间」，若只有端点相接是否仍有重合，本课未明示单点边界。',
      note: '实现假设：要求 lo<hi 才算重合，端点相接(lo==hi)判为缺口/不重叠。原文未明示，列为可选口径以观察分歧。',
    },
  },
  segMerge: {
    '做包含处理': {
      value: '做包含处理',
      label: '特征序列做包含处理（原文）',
      source: '原文',
      lesson: ['067'],
      quote: '关于特征序列，把每一元素看成是一K线，那么，如同一般K线图中找分型的方法，也存在所谓的包含关系，也可以对此进行非包含处理。',
      note: '67课：特征序列先做非包含处理（标准化）再找分型，「以后没有特别说明，特征序列都是指标准特征序列」。',
    },
    '不做包含处理': {
      value: '不做包含处理',
      label: '特征序列不做包含处理（社区简化）',
      source: '社区',
      lesson: ['067'],
      quote: '经过非包含处理的特征序列，成为标准特征序列。',
      note: '非原文简化：直接用原始笔区间找特征序列分型，跳过标准化。许多实现如此，会与原文口径产生线段分歧。',
    },
  },
  centerUnit: {
    '线段中枢': {
      value: '线段中枢',
      label: '线段中枢（原文主方案）',
      source: '原文',
      lesson: ['053', '083'],
      quote: '当你用一个级别的显微镜时，就等于先把次级别的当成线段了。',
      note: '以线段为次级别构件构中枢。83课认为线段比笔更稳，是主方案。',
    },
    '笔中枢': {
      value: '笔中枢',
      label: '笔中枢（83课允许但稳定性差）',
      source: '社区',
      lesson: ['083'],
      quote: '我们是可以设计这样的程序，也就是用笔当成构成最小中枢的零件，但这样构造出来的系统，其稳定性极差。',
      note: '原文允许用笔当中枢零件但稳定性极差。社区常用笔中枢，与线段中枢产生中枢位置/数量分歧。',
    },
  },
  centerUpgrade: {
    '9段升级': {
      value: '9段升级',
      label: '延伸9段升级（33课）',
      source: '原文',
      lesson: ['033'],
      quote: '中枢的延伸不能超过5段，也就是一旦出现6段的延伸，加上形成中枢本身那三段，就构成更大级别的中枢了。',
      note: '初始3段+延伸，达9段即升级为更大级别中枢（本级中枢确认终结）。',
    },
    '不自动升级': {
      value: '不自动升级',
      label: '不自动升级（简化）',
      source: '社区',
      lesson: ['033'],
      quote: '中枢的延伸不能超过5段……就构成更大级别的中枢了。',
      note: '简化：中枢一直延伸不做9段升级计数。与原文在中枢终结时点/级别上产生分歧。',
    },
  },
  trendOverlap: {
    '核心不重叠': {
      value: '核心不重叠',
      label: '核心不重叠（ZG/ZD）',
      source: '原文',
      lesson: ['017'],
      quote: '在任何级别的任何走势中，某完成的走势类型至少包含两个以上依次同向的缠中说禅走势中枢，就称为该级别的缠中说禅趋势。',
      note: '以中枢核心区间 [ZD,ZG] 判定相邻中枢不重叠即构成趋势。',
    },
    '外围也不重叠': {
      value: '外围也不重叠',
      label: '外围也不重叠（20课更严）',
      source: '原文',
      lesson: ['020'],
      quote: '趋势中的缠中说禅中枢之间必须绝对不存在重叠。',
      note: '20课收紧：趋势里同级中枢连围绕波动（外围 GG/DD）都不能重叠。比核心口径更严格，会减少趋势判定。',
    },
  },
  divMetric: {
    'MACD面积': {
      value: 'MACD面积',
      label: 'MACD面积（24/25课）',
      source: '原文',
      lesson: ['024', '025'],
      quote: 'C段的走势类型完成时对应的MACD柱子面积（向上的看红柱子，向下看绿柱子）比A段对应的面积要小，这时候就构成标准的背弛。',
      note: '比较进入段(b)与离开段(c)的同向柱面积，c<b 则背驰。需 close 计算 MACD(12,26,9)。',
    },
    '中枢视角几何': {
      value: '中枢视角几何',
      label: '中枢视角几何（33课）',
      source: '原文',
      lesson: ['033'],
      quote: '对a+A+b+B+c，背驰的大概意思就是c段的力度比b的小了。',
      note: '纯几何：比较 c段与b段的价格幅度（段内 max(high)-min(low)），c<b 则背驰。无需 MACD/close。',
    },
  },
  bsp3Touch: {
    '不跌破ZG': {
      value: '不跌破ZG',
      label: '不跌破ZG（20课，>=）',
      source: '原文',
      lesson: ['020'],
      quote: '一个次级别走势类型向上离开缠中说禅走势中枢，然后以一个次级别走势类型回试，其低点不跌破ZG，则构成第三类买点。',
      note: '20课"不跌破"=回试低点>=ZG（允许等于，端点相接也算）。',
    },
    '不触及ZG': {
      value: '不触及ZG',
      label: '不触及ZG（21课，>）',
      source: '原文',
      lesson: ['021'],
      quote: '在其上产生一个次级别的回抽不触及该中枢。',
      note: '21课重合例写"不触及"=回试低点>ZG（等于ZG不算）。与20课"不跌破"在端点相接时分歧。',
    },
  },
  bsp2Filter: {
    '允许二买低于一买': {
      value: '允许二买低于一买',
      label: '允许二买低于一买（101课原文）',
      source: '原文',
      lesson: ['101'],
      quote: '第二类买点跌破第一类买点，也就是第二类买点比第一类买点低，这是完全可以的。',
      note: '101课明确允许二买低于一买（多构成盘整背驰）。不作额外过滤。',
    },
    '过滤二买须高于一买': {
      value: '过滤二买须高于一买',
      label: '过滤：二买须高于一买（研究过滤器）',
      source: '实现假设',
      lesson: ['101'],
      quote: '把"二买必须高于一买"当成原版硬条件会漏掉弱情况；若要排除，应标成你自己的过滤器并单独检验。',
      note: '实现假设/研究过滤器：只保留二买高于一买的较强形态。非原文硬条件，用于观察过滤效果。',
    },
  },
} as const;

const START_DIRS = ['up', 'down'] as const;
const DIGITS = [0, 1, 2, 3, 4, 'raw'] as const;
const BI_RULES = ['77课', '社区老笔', '社区新笔'] as const;
const MERGE_DIRS = ['回找非包含', '直接用前一根'] as const;
const TOUCH_OVERLAPS = ['相接算重叠', '须严格重叠'] as const;
const SEG_MERGES = ['做包含处理', '不做包含处理'] as const;
const CENTER_UNITS = ['线段中枢', '笔中枢'] as const;
const CENTER_UPGRADES = ['9段升级', '不自动升级'] as const;
const TREND_OVERLAPS = ['核心不重叠', '外围也不重叠'] as const;
const DIV_METRICS = ['MACD面积', '中枢视角几何'] as const;
const BSP3_TOUCHES = ['不跌破ZG', '不触及ZG'] as const;
const BSP2_FILTERS = ['允许二买低于一买', '过滤二买须高于一买'] as const;

/** 校验口径全必填且取值合法；拒绝隐式默认。 */
export function validateConfig(c: ChanConfig): void {
  if (!c || typeof c !== 'object') throw new Error('口径配置缺失：全必填，无隐式默认');
  if (!START_DIRS.includes(c.startDir)) throw new Error(`起点方向非法：${String(c.startDir)}`);
  if (!c.precision || !DIGITS.includes(c.precision.digits)) throw new Error(`精度口径非法：${String(c.precision?.digits)}`);
  if (!BI_RULES.includes(c.biRule)) throw new Error(`笔口径非法：${String(c.biRule)}`);
  if (!MERGE_DIRS.includes(c.mergeDir)) throw new Error(`包含方向口径非法：${String(c.mergeDir)}`);
  if (!TOUCH_OVERLAPS.includes(c.touchOverlap)) throw new Error(`端点相接重叠口径非法：${String(c.touchOverlap)}`);
  if (!SEG_MERGES.includes(c.segMerge)) throw new Error(`特征序列包含口径非法：${String(c.segMerge)}`);
  if (!CENTER_UNITS.includes(c.centerUnit)) throw new Error(`中枢构件口径非法：${String(c.centerUnit)}`);
  if (!CENTER_UPGRADES.includes(c.centerUpgrade)) throw new Error(`中枢升级口径非法：${String(c.centerUpgrade)}`);
  if (!TREND_OVERLAPS.includes(c.trendOverlap)) throw new Error(`趋势不重叠口径非法：${String(c.trendOverlap)}`);
  if (!DIV_METRICS.includes(c.divMetric)) throw new Error(`背驰度量口径非法：${String(c.divMetric)}`);
  if (!BSP3_TOUCHES.includes(c.bsp3Touch)) throw new Error(`三买边界口径非法：${String(c.bsp3Touch)}`);
  if (!BSP2_FILTERS.includes(c.bsp2Filter)) throw new Error(`二买过滤口径非法：${String(c.bsp2Filter)}`);
}

/** 配置规范化 JSON（键序固定，新增维度追加在末）。 */
export function canonicalConfig(c: ChanConfig): string {
  return JSON.stringify({
    startDir: c.startDir,
    digits: c.precision.digits,
    biRule: c.biRule,
    mergeDir: c.mergeDir,
    touchOverlap: c.touchOverlap,
    segMerge: c.segMerge,
    centerUnit: c.centerUnit,
    centerUpgrade: c.centerUpgrade,
    trendOverlap: c.trendOverlap,
    divMetric: c.divMetric,
    bsp3Touch: c.bsp3Touch,
    bsp2Filter: c.bsp2Filter,
  });
}

/** FNV-1a 哈希 → configId，贯穿结果/练习记录/对比会话。 */
export function configId(c: ChanConfig): string {
  const s = canonicalConfig(c);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** 预设：完整显式配置（命名预设，非隐式默认）。 */
export const 预设 = {
  原文默认: {
    startDir: 'up',
    precision: { digits: 'raw' },
    biRule: '77课',
    mergeDir: '回找非包含',
    touchOverlap: '相接算重叠',
    segMerge: '做包含处理',
    centerUnit: '线段中枢',
    centerUpgrade: '9段升级',
    trendOverlap: '核心不重叠',
    divMetric: 'MACD面积',
    bsp3Touch: '不跌破ZG',
    bsp2Filter: '允许二买低于一买',
  } as ChanConfig,
};