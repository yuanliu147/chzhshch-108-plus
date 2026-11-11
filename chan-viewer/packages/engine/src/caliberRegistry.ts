// 口径注册表：每个口径取值的标签、来源、课号与逐字引文。
// 引文摘录自 新手手册/手册正文.html（只读参照），引擎保持无 IO。
// 来源徽标：原文 / 社区（非原文对照）/ 错误示范。
import type { ChanConfig } from './types.ts';

export type CaliberSource = '原文' | '社区' | '错误示范';

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
} as const;

const START_DIRS = ['up', 'down'] as const;
const DIGITS = [0, 1, 2, 3, 4, 'raw'] as const;
const BI_RULES = ['77课', '社区老笔', '社区新笔'] as const;
const MERGE_DIRS = ['回找非包含', '直接用前一根'] as const;

/** 校验口径四维全必填且取值合法；拒绝隐式默认。 */
export function validateConfig(c: ChanConfig): void {
  if (!c || typeof c !== 'object') throw new Error('口径配置缺失：四维全必填，无隐式默认');
  if (!START_DIRS.includes(c.startDir)) throw new Error(`起点方向非法：${String(c.startDir)}`);
  if (!c.precision || !DIGITS.includes(c.precision.digits)) throw new Error(`精度口径非法：${String(c.precision?.digits)}`);
  if (!BI_RULES.includes(c.biRule)) throw new Error(`笔口径非法：${String(c.biRule)}`);
  if (!MERGE_DIRS.includes(c.mergeDir)) throw new Error(`包含方向口径非法：${String(c.mergeDir)}`);
}

/** 配置规范化 JSON（键序固定）。 */
export function canonicalConfig(c: ChanConfig): string {
  return JSON.stringify({
    startDir: c.startDir,
    digits: c.precision.digits,
    biRule: c.biRule,
    mergeDir: c.mergeDir,
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
  原文默认: { startDir: 'up', precision: { digits: 'raw' }, biRule: '77课', mergeDir: '回找非包含' } as ChanConfig,
};