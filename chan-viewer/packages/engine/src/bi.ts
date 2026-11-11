// 第3关 笔的纯判定函数（77课口径 + 社区对照口径）。
import type { BiRule, Fractal } from './types.ts';

/** f 是否比 e 严格更极端（顶更高/底更低）。相等不算。 */
export function moreExtreme(f: Fractal, e: Fractal): boolean {
  return f.type === 'top' ? f.price > e.price : f.price < e.price;
}

/** 独立K线所需的最小 middle 差：77课/老笔=4（中间≥1根独立K线），新笔=3（允许共用1根）。 */
export function minMiddleGap(rule: BiRule): number {
  return rule === '社区新笔' ? 3 : 4;
}

export interface BiCheck {
  ok: boolean;
  reason: string;
}

/** 成笔条件：独立K线 + 价格条件。e→f 须一顶一底。 */
export function checkBi(e: Fractal, f: Fractal, rule: BiRule): BiCheck {
  const gap = f.middle - e.middle;
  const need = minMiddleGap(rule);
  if (gap < need) {
    return {
      ok: false,
      reason:
        rule === '社区新笔'
          ? `独立K线不足（社区新笔需顶底中间至少隔${need - 1}根，实际${gap - 1}根）`
          : `独立K线不足（顶底之间需至少1根独立K线，实际${gap - 3}根）`,
    };
  }
  const top = e.type === 'top' ? e : f;
  const bot = e.type === 'top' ? f : e;
  if (rule === '社区老笔') {
    // 社区老笔：比两个价（顶高于底即可），非原文区间条件。
    if (!(top.price > bot.price)) {
      return { ok: false, reason: '价格条件不满足（社区老笔：顶须高于底）' };
    }
  } else {
    // 77课/新笔：顶分型中间根区间至少有一部分高于底分型中间根区间 ⇔ tHigh > bHigh。
    if (!(top.midHigh > bot.midHigh)) {
      return { ok: false, reason: '价格区间条件不满足（顶区间须至少部分高于底区间）' };
    }
  }
  return { ok: true, reason: '' };
}