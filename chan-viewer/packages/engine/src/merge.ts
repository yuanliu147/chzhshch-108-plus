// 第1关 包含处理纯函数。与 配图自检.py 内核同构（区间 [low, high]）。
import type { MergedBar } from './types.ts';

export interface Interval {
  low: number;
  high: number;
}

/** b 的区间全在 a 内。 */
export function contains(a: Interval, b: Interval): boolean {
  return b.low >= a.low && b.high <= a.high;
}

/** 互相包含（包含关系无方向）。 */
export function either(a: Interval, b: Interval): boolean {
  return contains(a, b) || contains(b, a);
}

/** 向上：两端取较高者；向下：两端取较低者（62课原文）。 */
export function merge(a: Interval, b: Interval, up: boolean): Interval {
  return up
    ? { low: Math.max(a.low, b.low), high: Math.max(a.high, b.high) }
    : { low: Math.min(a.low, b.low), high: Math.min(a.high, b.high) };
}

/** 顶分型：中间根高点与低点都严格最高（62课）。 */
export function top3(s: readonly Interval[]): boolean {
  const a = s[0]!, b = s[1]!, c = s[2]!;
  return b.high > a.high && b.high > c.high && b.low > a.low && b.low > c.low;
}

/** 底分型：中间根低点与高点都严格最低。 */
export function bot3(s: readonly Interval[]): boolean {
  const a = s[0]!, b = s[1]!, c = s[2]!;
  return b.low < a.low && b.low < c.low && b.high < a.high && b.high < c.high;
}

/** 价格精度：half-up 舍入到 digits 位；'raw' 不舍入（59/81课精度口径）。 */
export function roundPrice(v: number, digits: number | 'raw'): number {
  if (digits === 'raw') return v;
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

/** 收尾自检：有效K线两两无包含（62课「所有K线图都可以处理成没有包含关系的图形」）。 */
export function noInclusion(bars: readonly MergedBar[]): boolean {
  for (let i = 0; i + 1 < bars.length; i++) {
    if (either(bars[i]!, bars[i + 1]!)) return false;
  }
  return true;
}