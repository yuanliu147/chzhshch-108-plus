// 中国市场交易时间与柱覆盖的纯函数。所有时间点为 UTC epoch 毫秒，显示语义为 Asia/Shanghai。
// 覆盖区间一律 (startMs, endMs]；跨午休拆成多个区间，不把自然时间连续误当交易连续。

export const CHINA_OFFSET_MS = 8 * 60 * 60 * 1000;
export const MINUTE_MS = 60 * 1000;

export interface TimeRange {
  startMs: number;
  endMs: number;
}

export interface Session {
  date: string;
  startMs: number;
  endMs: number;
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATETIME_RE = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/;

/** 将不带时区的中国市场日期/时间解析为真实 UTC epoch，不经过浏览器本地时区。 */
export function parseChinaTime(value: string): number | null {
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

/** UTC epoch → 中国市场 YYYY-MM-DD HH:mm:ss。 */
export function formatChinaTime(ms: number): string {
  const d = new Date(ms + CHINA_OFFSET_MS);
  const p = (v: number, n = 2) => String(v).padStart(n, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

/** UTC epoch → 中国市场 YYYY-MM-DD。 */
export function formatChinaDate(ms: number): string {
  return formatChinaTime(ms).slice(0, 10);
}

/** 日线交易日收盘可知时刻（15:00，Asia/Shanghai）。 */
export function dailyCloseMs(date: string): number {
  const ms = parseChinaTime(`${date} 15:00:00`);
  if (ms == null) throw new Error(`非法交易日：${date}`);
  return ms;
}

/** 某交易日两个连续竞价时段；返回严格 (start,end] 区间。 */
export function sessionsOf(date: string): Session[] {
  const am = parseChinaTime(`${date} 09:30:00`);
  const amEnd = parseChinaTime(`${date} 11:30:00`);
  const pm = parseChinaTime(`${date} 13:00:00`);
  const pmEnd = parseChinaTime(`${date} 15:00:00`);
  if (am == null || amEnd == null || pm == null || pmEnd == null) return [];
  return [
    { date, startMs: am, endMs: amEnd },
    { date, startMs: pm, endMs: pmEnd },
  ];
}

/** 某时间所属的连续竞价时段；集合竞价或非交易时间返回 null。 */
export function sessionAt(ms: number): Session | null {
  for (const session of sessionsOf(formatChinaDate(ms))) {
    if (ms > session.startMs && ms <= session.endMs) return session;
  }
  return null;
}

/** 合并相邻/重叠覆盖；首尾相接按连续处理。 */
export function mergeRanges(ranges: readonly TimeRange[]): TimeRange[] {
  const sorted = [...ranges].filter((r) => r.endMs > r.startMs).sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  const out: TimeRange[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.startMs <= last.endMs) last.endMs = Math.max(last.endMs, r.endMs);
    else out.push({ ...r });
  }
  return out;
}

/** 覆盖交集。 */
export function intersectRange(a: TimeRange, b: TimeRange): TimeRange | null {
  const startMs = Math.max(a.startMs, b.startMs);
  const endMs = Math.min(a.endMs, b.endMs);
  return endMs > startMs ? { startMs, endMs } : null;
}

export function coverageIntersects(coverage: readonly TimeRange[], startMs: number, endMs: number): boolean {
  return coverage.some((r) => intersectRange(r, { startMs, endMs }) != null);
}

/** 覆盖总交易时长。 */
export function coveredMs(coverage: readonly TimeRange[]): number {
  return mergeRanges(coverage).reduce((sum, r) => sum + r.endMs - r.startMs, 0);
}

/** 5 分钟 bar 的自然覆盖：源时间戳是 bar 结束时间。 */
export function sourceBarRange(endTime: string): TimeRange | null {
  const endMs = parseChinaTime(endTime);
  return endMs == null ? null : { startMs: endMs - 5 * MINUTE_MS, endMs };
}

/** 一天完整日线覆盖（两段连续竞价时段）。 */
export function dailyCoverage(date: string): TimeRange[] {
  return sessionsOf(date).map((s) => ({ startMs: s.startMs, endMs: s.endMs }));
}

export type SourceQuality = 'verified' | 'incomplete' | 'unknown';

/** 日期范围仅声明库可核验的边界，不代表其中每个自然日都应有行情。 */
export interface CoverageCalendar {
  declaredRange: { startDate: string; endDate: string } | null;
  days: readonly { date: string; tradeStatus: number | null; isTradingDay?: number | null }[];
}

export interface CoverageSummary {
  expectedCoverage: TimeRange[];
  coverageGaps: TimeRange[];
  /** unknown 优先：已证明的缺口仍单独保留，但不能声称日历核验完整。 */
  coverageStatus: SourceQuality;
  unknownCoverage: TimeRange[];
}

/** 已声明的股票正常交易日才生成预期交易覆盖；其它未知日期不猜交易时段。 */
export function describeCoverage(
  observed: readonly TimeRange[],
  calendar: CoverageCalendar,
  window: TimeRange,
): CoverageSummary {
  const expected: TimeRange[] = [];
  const unknown: TimeRange[] = [];
  const days = new Map(calendar.days.map((day) => [day.date, day]));
  const range = calendar.declaredRange;
  const firstDay = parseChinaTime(formatChinaDate(window.startMs));
  if (firstDay == null || !Number.isFinite(window.endMs) || window.endMs <= window.startMs) {
    return { expectedCoverage: [], coverageGaps: [], coverageStatus: 'unknown', unknownCoverage: [] };
  }
  for (let startMs = firstDay; startMs < window.endMs; startMs += 24 * 60 * MINUTE_MS) {
    const date = formatChinaDate(startMs);
    const day = days.get(date);
    const declared = range != null && date >= range.startDate && date <= range.endDate;
    if (declared && day?.tradeStatus === 1) {
      for (const session of sessionsOf(date)) {
        const intersection = intersectRange(session, window);
        if (intersection) expected.push(intersection);
      }
    } else if (!(declared && (day?.tradeStatus === 0 || day?.isTradingDay === 0))) {
      const intersection = intersectRange({ startMs, endMs: startMs + 24 * 60 * MINUTE_MS }, window);
      if (intersection) unknown.push(intersection);
    }
  }
  const expectedCoverage = mergeRanges(expected);
  const coverageGaps: TimeRange[] = [];
  const actual = mergeRanges(observed);
  for (const want of expectedCoverage) {
    let cursor = want.startMs;
    for (const have of actual) {
      const intersection = intersectRange(want, have);
      if (!intersection) continue;
      if (intersection.startMs > cursor) coverageGaps.push({ startMs: cursor, endMs: intersection.startMs });
      cursor = Math.max(cursor, intersection.endMs);
    }
    if (cursor < want.endMs) coverageGaps.push({ startMs: cursor, endMs: want.endMs });
  }
  const unknownCoverage = mergeRanges(unknown);
  return {
    expectedCoverage,
    coverageGaps,
    coverageStatus: coveredMs(unknownCoverage) > 0 ? 'unknown' : coveredMs(coverageGaps) > 0 ? 'incomplete' : 'verified',
    unknownCoverage,
  };
}
