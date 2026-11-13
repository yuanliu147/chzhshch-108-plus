// 只读数据访问层：node 内置 node:sqlite，零第三方依赖。
// 强制 code(+adjustflag) 谓词走 PK 索引，禁全表扫；停牌占位行在此过滤。
import { DatabaseSync } from 'node:sqlite';
import {
  coverageIntersects, dailyCloseMs, dailyCoverage, describeCoverage, formatChinaDate,
  mergeRanges, parseChinaTime, sessionAt,
  type CoverageCalendar, type CoverageSummary, type SourceQuality, type TimeRange,
} from './marketTime.js';

const DB_PATH = process.env.CHAN_DB_PATH ?? '/Users/admin/WorkSpace/baostock_data/data/baostock.db';

let db: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
  if (!db) {
    db = new DatabaseSync(DB_PATH, { readOnly: true });
    db.exec('PRAGMA busy_timeout = 5000;'); // 与同步写者共存（WAL）
  }
  return db;
}

export interface SymbolRow {
  code: string;
  code_name: string | null;
  kind: 'stock' | 'index';
  status: number;
  ipo_date: string | null;
  out_date: string | null;
}

/** 标的搜索：股票(type=1) + 有行情数据的指数。 */
export function searchSymbols(q: string, kind: string, includeDelisted: boolean): SymbolRow[] {
  const d = getDb();
  const like = `%${q}%`;
  const out: SymbolRow[] = [];
  if (kind !== 'index') {
    const statusClause = includeDelisted ? '' : 'AND status = 1';
    const rows = d
      .prepare(
        `SELECT code, code_name, status, ipo_date, out_date FROM stock_basic
         WHERE type = 1 ${statusClause} AND (code LIKE ? OR code_name LIKE ?)
         ORDER BY code LIMIT 50`,
      )
      .all(like, like) as { code: string; code_name: string | null; status: number; ipo_date: string | null; out_date: string | null }[];
    for (const r of rows) out.push({ ...r, kind: 'stock' });
  }
  if (kind !== 'stock') {
    const rows = d
      .prepare(
        `SELECT b.code, b.code_name, b.status, b.ipo_date, b.out_date FROM stock_basic b
         WHERE b.type = 2 AND b.code IN (SELECT DISTINCT code FROM index_kline_d)
           AND (b.code LIKE ? OR b.code_name LIKE ?)
         ORDER BY b.code LIMIT 50`,
      )
      .all(like, like) as { code: string; code_name: string | null; status: number; ipo_date: string | null; out_date: string | null }[];
    for (const r of rows) out.push({ ...r, kind: 'index' });
  }
  return out.slice(0, 50);
}

export interface SymbolMeta {
  code: string;
  code_name: string | null;
  kind: 'stock' | 'index';
  status: number;
}

export function lookupSymbol(code: string): SymbolMeta | null {
  const d = getDb();
  const b = d.prepare('SELECT code, code_name, type, status FROM stock_basic WHERE code = ?').get(code) as
    | { code: string; code_name: string | null; type: number; status: number }
    | undefined;
  if (b) return { code: b.code, code_name: b.code_name, kind: b.type === 2 ? 'index' : 'stock', status: b.status };
  const ix = d.prepare('SELECT DISTINCT code FROM index_kline_d WHERE code = ?').get(code) as { code: string } | undefined;
  if (ix) return { code: ix.code, code_name: null, kind: 'index', status: 1 };
  return null;
}

/** 统一时间覆盖摘要：timeRange 为 (startMs,endMs] 的交易时段片段。 */
export interface BarTimeMeta {
  endMs: number;
  coverage: TimeRange[];
  sourceCount: number;
  expectedSourceCount: number;
  complete: boolean;
  quality: SourceQuality;
  continuityId: string;
}

export interface RawKBar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  amount: number;
  pct_chg: number | null;
  is_st: number | null;
  time: BarTimeMeta;
}

export interface KlineQuery {
  code: string;
  kind: 'stock' | 'index';
  adjust: string; // '1'后 '2'前 '3'不复权（指数忽略）
  start?: string;
  end?: string;
  limit: number;
}

export interface KlineData {
  bars: RawKBar[]; // 升序
  filteredSuspended: number;
  firstDate: string | null;
  lastDate: string | null;
}

/** 取K线：停牌过滤(trade_status=1)，升序返回。 */
export function queryKline(q: KlineQuery): KlineData {
  const d = getDb();
  const isIndex = q.kind === 'index';
  const table = isIndex ? 'index_kline_d' : 'stock_kline_d';
  const stFilter = isIndex ? '' : 'AND trade_status = 1';
  const adjFilter = isIndex ? '' : 'AND adjustflag = ?';
  const params: (string | number)[] = [q.code];
  if (!isIndex) params.push(Number(q.adjust));

  let where = `code = ? ${adjFilter} ${stFilter}`;
  if (q.start) {
    where += ' AND date >= ?';
    params.push(q.start);
  }
  if (q.end) {
    where += ' AND date <= ?';
    params.push(q.end);
  }

  const cols = isIndex
    ? 'date, open, high, low, close, volume, amount, pct_chg'
    : 'date, open, high, low, close, volume, amount, pct_chg, is_st';
  const sql = `SELECT ${cols} FROM ${table} WHERE ${where} ORDER BY date DESC LIMIT ?`;
  params.push(q.limit <= 0 ? -1 : q.limit); // SQLite LIMIT -1 = 不限行数
  const desc = d.prepare(sql).all(...params) as Record<string, number | string | null>[];
  const bars: RawKBar[] = desc
    .map((r) => ({
      date: r.date as string,
      open: r.open as number,
      high: r.high as number,
      low: r.low as number,
      close: r.close as number,
      volume: r.volume as number,
      amount: r.amount as number,
      pct_chg: (r.pct_chg as number | null) ?? null,
      is_st: isIndex ? null : ((r.is_st as number | null) ?? null),
      time: {
        endMs: dailyCloseMs(r.date as string),
        coverage: dailyCoverage(r.date as string),
        sourceCount: 1,
        expectedSourceCount: 1,
        complete: true,
        quality: 'verified' as const,
        continuityId: `daily:${q.code}:${isIndex ? 'index' : q.adjust}`,
      },
    }))
    .reverse();

  // 停牌占位行计数（同一日期窗口内 trade_status=0）。
  let filteredSuspended = 0;
  if (!isIndex && bars.length > 0) {
    const first = bars[0]!.date;
    const last = bars[bars.length - 1]!.date;
    const c = d
      .prepare(`SELECT COUNT(*) c FROM stock_kline_d WHERE code = ? AND adjustflag = ? AND trade_status = 0 AND date >= ? AND date <= ?`)
      .get(q.code, Number(q.adjust), first, last) as { c: number };
    filteredSuspended = c.c;
  }

  return {
    bars,
    filteredSuspended,
    firstDate: bars[0]?.date ?? null,
    lastDate: bars[bars.length - 1]?.date ?? null,
  };
}

// ---- 分钟线（独立 baostock_min.db，仅 5m、仅不复权、仅股票）----

const MIN_DB_PATH = process.env.CHAN_MIN_DB_PATH ?? '/Users/admin/WorkSpace/baostock_data/data/baostock_min.db';
let minDb: DatabaseSync | null = null;

export function getMinDb(): DatabaseSync {
  if (!minDb) {
    minDb = new DatabaseSync(MIN_DB_PATH, { readOnly: true });
    minDb.exec('PRAGMA busy_timeout = 5000;');
  }
  return minDb;
}

export interface MinBar {
  time: string; // bar 实际结束时间 YYYY-MM-DD HH:MM:SS
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  amount: number;
  /** 真实来源覆盖、名义桶边界和完整性；部分股票/日期缺根时 complete=false。 */
  timeMeta: BarTimeMeta & {
    bucketStartMs: number;
    bucketEndMs: number;
  };
}

interface WorkingBar extends MinBar {
  _sourceTimes: number[];
}

const FREQ_MINUTES = 5;

function rawMinBar(b: { time: string; open: number; high: number; low: number; close: number; volume: number; amount: number }): WorkingBar | null {
  const endMs = parseChinaTime(b.time);
  if (endMs == null) return null;
  const startMs = endMs - FREQ_MINUTES * 60_000;
  const session = sessionAt(endMs);
  const complete = session != null && startMs >= session.startMs && (endMs - session.startMs) % (FREQ_MINUTES * 60_000) === 0;
  return {
    ...b,
    timeMeta: {
      endMs,
      bucketStartMs: startMs,
      bucketEndMs: endMs,
      coverage: [{ startMs, endMs }],
      sourceCount: 1,
      expectedSourceCount: 1,
      complete,
      quality: 'unknown',
      continuityId: '',
    },
    _sourceTimes: [endMs],
  };
}

/**
 * 5m 聚合到 freq 分钟（15/30/60）。
 * 按交易时段 (09:30,11:30]、(13:00,15:00] 对齐，不跨午休/跨日。
 * 每个桶保存真实来源时间、覆盖片段与完整性；缺根不做补齐，也不伪造完整收盘。
 */
export function aggregate5m(
  bars: readonly { time: string; open: number; high: number; low: number; close: number; volume: number; amount: number }[],
  freq: number,
  calendar: CoverageCalendar = { declaredRange: null, days: [] },
): MinBar[] {
  if (freq <= FREQ_MINUTES) {
    const raw = bars.map(rawMinBar).filter((b): b is WorkingBar => !!b).map(({ _sourceTimes, ...b }) => b);
    return withContinuity(raw, freq, calendar);
  }

  const groups = new Map<string, WorkingBar>();
  for (const b of bars) {
    const endMs = parseChinaTime(b.time);
    if (endMs == null) continue;
    const session = sessionAt(endMs);
    if (!session) continue; // 非连续竞价记录（集合竞价等）不混入普通桶
    const bucket = Math.floor((endMs - session.startMs - 1) / (freq * 60_000));
    const key = `${session.date}|${session.startMs}|${bucket}`;
    let g = groups.get(key);
    if (!g) {
      const bucketStartMs = session.startMs + bucket * freq * 60_000;
      const bucketEndMs = Math.min(session.endMs, bucketStartMs + freq * 60_000);
      g = {
        time: b.time,
        open: b.open,
        high: Number.NEGATIVE_INFINITY,
        low: Number.POSITIVE_INFINITY,
        close: b.close,
        volume: 0,
        amount: 0,
        timeMeta: {
          endMs,
          bucketStartMs,
          bucketEndMs,
          coverage: [],
          sourceCount: 0,
          expectedSourceCount: Math.round((bucketEndMs - bucketStartMs) / (FREQ_MINUTES * 60_000)),
          complete: false,
          quality: 'unknown',
          continuityId: '',
        },
        _sourceTimes: [],
      };
      groups.set(key, g);
    }
    if (g._sourceTimes.includes(endMs)) continue; // 同一5m来源只计一次量额。
    // 升序来源：首开已定，末收/末时间更新，高取 max 低取 min，量额累加。
    g.high = Math.max(g.high, b.high);
    g.low = Math.min(g.low, b.low);
    g.close = b.close;
    g.volume += b.volume;
    g.amount += b.amount;
    if (endMs >= g.timeMeta.endMs) {
      g.timeMeta.endMs = endMs;
      g.time = b.time;
    }
    g._sourceTimes.push(endMs);
  }

  const aggregated = [...groups.values()].map((g) => {
    const unique = [...new Set(g._sourceTimes)].sort((a, b) => a - b);
    const coverage = mergeRanges(unique.map((endMs) => ({ startMs: endMs - FREQ_MINUTES * 60_000, endMs })));
    // 完整性：来源时间必须覆盖桶内每个名义 5m 结束点，且无越界记录。
    const expected = g.timeMeta.expectedSourceCount;
    let complete = unique.length === expected && expected > 0;
    if (complete) {
      for (let i = 0; i < expected; i++) {
        const want = g.timeMeta.bucketStartMs + (i + 1) * FREQ_MINUTES * 60_000;
        if (unique[i] !== want) { complete = false; break; }
      }
    }
    const { _sourceTimes, ...rest } = g;
    return {
      ...rest,
      timeMeta: {
        ...rest.timeMeta,
        coverage,
        sourceCount: unique.length,
        complete,
      },
    };
  }).sort((a, b) => a.timeMeta.endMs - b.timeMeta.endMs);
  return withContinuity(aggregated, freq, calendar);
}

/** 在完整源序列上分段，再筛请求窗口；身份不依赖返回数组下标或limit。 */
function withContinuity(bars: MinBar[], freq: number, calendar: CoverageCalendar): MinBar[] {
  if (!bars.length) return bars;
  const summary = describeCoverage(bars.flatMap((b) => b.timeMeta.coverage), calendar, {
    startMs: bars[0]!.timeMeta.bucketStartMs,
    endMs: bars[bars.length - 1]!.timeMeta.bucketEndMs,
  });
  const days = new Map(calendar.days.map((day) => [day.date, day]));
  const declared = calendar.declaredRange;
  let anchor = bars[0]!.timeMeta.bucketStartMs;
  let previous: MinBar | undefined;
  for (const bar of bars) {
    const meta = bar.timeMeta;
    const date = formatChinaDate(meta.endMs);
    const trusted = declared != null && date >= declared.startDate && date <= declared.endDate && days.get(date)?.tradeStatus === 1;
    meta.quality = !trusted ? 'unknown' : meta.complete ? 'verified' : 'incomplete';
    const between = { startMs: previous?.timeMeta.bucketEndMs ?? meta.bucketStartMs, endMs: meta.bucketStartMs };
    if (!previous || meta.quality !== 'verified' || previous.timeMeta.quality !== 'verified'
      || coverageIntersects(summary.coverageGaps, between.startMs, between.endMs)
      || coverageIntersects(summary.unknownCoverage, between.startMs, between.endMs)) {
      anchor = meta.bucketStartMs;
    }
    meta.continuityId = `min:${freq}:${meta.quality}:${anchor}`;
    previous = bar;
  }
  return bars;
}

export interface MinQuery {
  code: string;
  freq: number; // 5/15/30/60
  start?: string;
  end?: string;
  limit: number;
}

export interface MinKlineData extends CoverageSummary {
  bars: MinBar[];
  declaredRange: CoverageCalendar['declaredRange'];
}

/** 日线状态只取不复权股票；正常日证明预期交易，停牌/已入库休市日证明无需来源。 */
function minuteCalendar(code: string, cap: MinCapability, endDay?: string): CoverageCalendar {
  const declaredRange = cap.firstTime && cap.lastTime
    ? { startDate: cap.firstTime.slice(0, 10), endDate: cap.lastTime.slice(0, 10) } : null;
  if (!declaredRange) return { declaredRange, days: [] };
  const first = declaredRange.startDate;
  const last = endDay ?? declaredRange.endDate;
  const d = getDb();
  const dates = d.prepare('SELECT calendar_date date, is_trading_day isTradingDay FROM trade_dates WHERE calendar_date >= ? AND calendar_date <= ?')
    .all(first, last) as { date: string; isTradingDay: number | null }[];
  const days = new Map<string, CoverageCalendar['days'][number]>(dates.map((day) => [day.date, { ...day, tradeStatus: null }]));
  const daily = d.prepare('SELECT date, trade_status tradeStatus FROM stock_kline_d WHERE code = ? AND adjustflag = 3 AND date >= ? AND date <= ?')
    .all(code, first, last) as { date: string; tradeStatus: number | null }[];
  for (const day of daily) days.set(day.date, { ...days.get(day.date), ...day });
  return { declaredRange, days: [...days.values()] };
}

/** 保留旧数组签名；API另取同一次查询产生的来源摘要。 */
export function queryMinKline(q: MinQuery): MinBar[] {
  return queryMinKlineData(q).bars;
}

/** 取分钟K线（仅不复权 adjustflag=3）。start/end始终为覆盖相交窗口，不是as-of。 */
export function queryMinKlineData(q: MinQuery, cap = minCapability(q.code)): MinKlineData {
  const d = getMinDb();
  const all = q.limit <= 0;
  let where = 'code = ? AND adjustflag = 3';
  const params: (string | number)[] = [q.code];
  // 从库起点取得此前断点以稳定continuityId；结束向自然日取整，避免截断桶内部来源。
  const endDay = q.end?.slice(0, 10);
  if (endDay) {
    where += ' AND time <= ?';
    params.push(`${endDay} 23:59:59`);
  }
  const sql = `SELECT time, open, high, low, close, volume, amount FROM stock_kline_5m WHERE ${where} ORDER BY time ASC`;
  const source = d.prepare(sql).all(...params) as Record<string, number | string>[];
  const bars = source.map((r) => ({
    time: r.time as string,
    open: r.open as number,
    high: r.high as number,
    low: r.low as number,
    close: r.close as number,
    volume: r.volume as number,
    amount: r.amount as number,
  }));
  const calendar = minuteCalendar(q.code, cap, endDay);
  const aggregated = aggregate5m(bars, q.freq, calendar);
  for (const bar of aggregated) bar.timeMeta.continuityId = `${q.code}:${bar.timeMeta.continuityId}`;
  const reqStart = q.start ? parseChinaTime(q.start) : null;
  const reqEnd = q.end ? parseChinaTime(q.end) : null;
  const filtered = aggregated.filter((b) => {
    if (reqStart != null && reqEnd != null) {
      return coverageIntersects(b.timeMeta.coverage, reqStart, reqEnd);
    }
    if (reqStart != null && !coverageIntersects(b.timeMeta.coverage, reqStart, Number.POSITIVE_INFINITY)) return false;
    if (reqEnd != null && !coverageIntersects(b.timeMeta.coverage, Number.NEGATIVE_INFINITY, reqEnd)) return false;
    return true;
  });
  const selected = all ? filtered : filtered.slice(-q.limit);
  const declared = calendar.declaredRange;
  const startMs = reqStart ?? (!all && selected.length < filtered.length ? selected[0]?.timeMeta.bucketStartMs : null)
    ?? (declared ? parseChinaTime(`${declared.startDate} 00:00:00`) : null);
  const endMs = reqEnd ?? (declared ? parseChinaTime(`${declared.endDate} 23:59:59`) : null);
  const summary = startMs != null && endMs != null
    ? describeCoverage(aggregated.flatMap((bar) => bar.timeMeta.coverage), calendar, { startMs, endMs })
    : { expectedCoverage: [], coverageGaps: [], unknownCoverage: [], coverageStatus: 'unknown' as const };
  return { bars: selected, declaredRange: declared, ...summary };
}

export interface MinCapability {
  hasMin: boolean;
  count: number;
  firstTime: string | null;
  lastTime: string | null;
}

/** 探测标的是否有分钟线及可用范围。 */
export function minCapability(code: string): MinCapability {
  const d = getMinDb();
  const r = d.prepare('SELECT COUNT(*) c, MIN(time) a, MAX(time) b FROM stock_kline_5m WHERE code = ? AND adjustflag = 3').get(code) as { c: number; a: string | null; b: string | null };
  return { hasMin: r.c > 0, count: r.c, firstTime: r.a, lastTime: r.b };
}