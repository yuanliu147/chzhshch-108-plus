// 引擎侧中国市场时间工具：零依赖、纯函数。时间语义与 apps/server/src/marketTime.ts 一致。
export const CHINA_OFFSET_MS = 8 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const DATETIME_RE = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function validCalendar(value: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(value);
  if (!m) return false;
  const [, y, mo, d, h = '0', mi = '0', s = '0'] = m;
  const day = new Date(Date.UTC(+y!, +mo! - 1, +d!));
  return day.getUTCFullYear() === +y! && day.getUTCMonth() === +mo! - 1 && day.getUTCDate() === +d!
    && +h <= 23 && +mi <= 59 && +s <= 59;
}

export function parseChinaTime(value: string): number | null {
  if (!validCalendar(value)) return null;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:?\d{2})$/.test(value)) {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : null;
  }
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

/** 一根已走完行情的可知时刻。日线是当日 15:00 收盘，分钟是数据源结束时间。 */
export function barKnownAt(bar: { date: string; endMs?: number; time?: { endMs: number } }): number | null {
  if (bar.time && bar.endMs != null && bar.time.endMs !== bar.endMs) {
    throw new Error(`结束时间不一致: ${bar.date}`);
  }
  const endMs = bar.time?.endMs ?? bar.endMs;
  if (endMs != null) return Number.isFinite(endMs) ? endMs : null;
  const parsed = parseChinaTime(bar.date);
  if (parsed == null) return null;
  return bar.date.length === 10 ? parsed + 15 * 60 * MINUTE_MS : parsed;
}

export function inSession(timeMs: number): boolean {
  const d = new Date(timeMs + CHINA_OFFSET_MS);
  const minutes = d.getUTCHours() * 60 + d.getUTCMinutes();
  return (minutes > 9 * 60 + 30 && minutes <= 11 * 60 + 30) || (minutes > 13 * 60 && minutes <= 15 * 60);
}
