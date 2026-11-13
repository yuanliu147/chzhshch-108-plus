// 跨周期时间覆盖映射：只回答“某段时间对应哪些 bar”，不判定缠论结构父子关系。
import type { RawBar, TimeRange } from '../api.ts';

export const CHINA_OFFSET_MS = 8 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

const DATETIME_RE = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** 数据源字符串按 Asia/Shanghai 解析为 UTC epoch；用于兼容未携带 time 元数据的旧响应。 */
export function parseChinaMs(value: string): number | null {
  const dt = DATETIME_RE.exec(value);
  if (dt) {
    const [, y, mo, d, h, mi, s = '0'] = dt;
    return Date.UTC(+y!, +mo! - 1, +d!, +h!, +mi!, +s!) - CHINA_OFFSET_MS;
  }
  const day = DATE_RE.exec(value);
  if (day) {
    const [, y, mo, d] = day;
    return Date.UTC(+y!, +mo! - 1, +d!) - CHINA_OFFSET_MS;
  }
  return null;
}

export function formatChinaDateTime(ms: number, withSeconds = false): string {
  const d = new Date(ms + CHINA_OFFSET_MS);
  const p = (v: number) => String(v).padStart(2, '0');
  const base = `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
  return withSeconds ? `${base}:${p(d.getUTCSeconds())}` : base;
}

function fallbackCoverage(bar: RawBar): TimeRange[] {
  const parsed = parseChinaMs(bar.date);
  if (parsed == null) return [];
  if (bar.date.length === 10) {
    // 日线 date 只有交易日，可知时刻按当日 15:00 收盘；覆盖拆上午/下午两段。
    const endMs = parsed + 15 * 60 * MINUTE_MS;
    const startMs = parsed + 9.5 * 60 * MINUTE_MS;
    return [
      { startMs, endMs: parsed + 11.5 * 60 * MINUTE_MS },
      { startMs: parsed + 13 * 60 * MINUTE_MS, endMs },
    ];
  }
  return [{ startMs: parsed - 5 * MINUTE_MS, endMs: parsed }];
}

/** 单根 bar 的绘图覆盖；fallback 不提供可信来源证据，核验须用 verifiedCoverageOf。 */
export function coverageOf(bar: RawBar): TimeRange[] {
  const coverage = bar.time?.coverage;
  return coverage?.length ? coverage : fallbackCoverage(bar);
}

export function endOf(bar: RawBar): number {
  if (bar.time?.endMs != null) return bar.time.endMs;
  const parsed = parseChinaMs(bar.date);
  if (parsed == null) return Number.NaN;
  return bar.date.length === 10 ? parsed + 15 * 60 * MINUTE_MS : parsed;
}

export function startOf(bar: RawBar): number {
  const coverage = coverageOf(bar);
  return coverage.length ? coverage[0]!.startMs : Number.NaN;
}

export function coverageContainsTime(coverage: readonly TimeRange[], timeMs: number): boolean {
  return coverage.some((r) => timeMs > r.startMs && timeMs <= r.endMs);
}

export function overlaps(a: readonly TimeRange[], b: readonly TimeRange[]): boolean {
  return a.some((x) => b.some((y) => Math.min(x.endMs, y.endMs) > Math.max(x.startMs, y.startMs)));
}

/** 来源集合运算，不使用绘图包络；去重后再计算交易时长。 */
export function mergeRanges(ranges: readonly TimeRange[]): TimeRange[] {
  const sorted = ranges.filter((r) => Number.isFinite(r.startMs) && Number.isFinite(r.endMs) && r.endMs > r.startMs)
    .map((r) => ({ ...r })).sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  const out: TimeRange[] = [];
  for (const range of sorted) {
    const last = out[out.length - 1];
    if (last && range.startMs <= last.endMs) last.endMs = Math.max(last.endMs, range.endMs);
    else out.push(range);
  }
  return out;
}

export function intersectRange(a: TimeRange, b: TimeRange): TimeRange | null {
  const startMs = Math.max(a.startMs, b.startMs);
  const endMs = Math.min(a.endMs, b.endMs);
  return endMs > startMs ? { startMs, endMs } : null;
}

export function intersectRanges(a: readonly TimeRange[], b: readonly TimeRange[]): TimeRange[] {
  const left = mergeRanges(a);
  const right = mergeRanges(b);
  const out: TimeRange[] = [];
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    const x = left[i]!;
    const y = right[j]!;
    const intersection = intersectRange(x, y);
    if (intersection) out.push(intersection);
    if (x.endMs <= y.endMs) i++;
    else j++;
  }
  return mergeRanges(out);
}

export function coveredMs(ranges: readonly TimeRange[]): number {
  return mergeRanges(ranges).reduce((sum, range) => sum + range.endMs - range.startMs, 0);
}

/** 仅显式可信且完整的真实来源可作为覆盖证据；fallbackCoverage 只供绘图。 */
export function verifiedCoverageOf(bar: RawBar): TimeRange[] {
  return bar.time?.quality === 'verified' && bar.time.complete && Number.isFinite(bar.time.endMs)
    ? mergeRanges(bar.time.coverage) : [];
}

/** 时间点所在 bar；时间等于 bar 结束时刻归属该 bar，严格使用 (start,end]。 */
export function findBarIndexAtTime(bars: readonly RawBar[], timeMs: number): number {
  let lo = 0;
  let hi = bars.length - 1;
  let candidate = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (endOf(bars[mid]!) >= timeMs) {
      candidate = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  if (candidate < 0) return -1;
  return coverageContainsTime(coverageOf(bars[candidate]!), timeMs) ? candidate : -1;
}

/** 与给定区间实际重叠的连续 bar 下标。 */
export function findBarIndices(bars: readonly RawBar[], range: TimeRange): number[] {
  const out: number[] = [];
  for (let i = 0; i < bars.length; i++) {
    if (overlaps(coverageOf(bars[i]!), [range])) out.push(i);
  }
  return out;
}

/** 一组 bar 的绘图包络，包含午休/缺根等空白，不能用来证明交易覆盖。 */
export function coverageSpan(bars: readonly RawBar[], indices: readonly number[]): TimeRange | null {
  if (!indices.length) return null;
  let startMs = Number.POSITIVE_INFINITY;
  let endMs = Number.NEGATIVE_INFINITY;
  for (const i of indices) {
    const b = bars[i];
    if (!b) continue;
    const coverage = coverageOf(b);
    for (const r of coverage) {
      startMs = Math.min(startMs, r.startMs);
      endMs = Math.max(endMs, r.endMs);
    }
  }
  return Number.isFinite(startMs) && endMs > startMs ? { startMs, endMs } : null;
}

/** 首末下标窗口对应的覆盖。 */
export function indexWindowCoverage(bars: readonly RawBar[], from: number, to: number): TimeRange | null {
  if (!bars.length) return null;
  const a = Math.max(0, Math.min(bars.length - 1, Math.min(from, to)));
  const b = Math.max(0, Math.min(bars.length - 1, Math.max(from, to)));
  return coverageSpan(bars, [a, b]);
}

/** 在目标周期查找与给定时间点对应的 bar，优先返回精确覆盖的 bar。 */
export function projectTimeToBars(sourceTimeMs: number, target: readonly RawBar[]): number {
  return findBarIndexAtTime(target, sourceTimeMs);
}
