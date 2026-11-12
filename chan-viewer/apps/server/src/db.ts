// 只读数据访问层：node 内置 node:sqlite，零第三方依赖。
// 强制 code(+adjustflag) 谓词走 PK 索引，禁全表扫；停牌占位行在此过滤。
import { DatabaseSync } from 'node:sqlite';

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
  params.push(q.limit);
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
  time: string; // bar 结束时间 YYYY-MM-DD HH:MM:SS
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  amount: number;
}

/** 5m 聚合到 freq 分钟（15/30/60）。按交易时段（09:30–11:30、13:00–15:00）时间桶对齐，容忍缺根，不跨午休/跨日。 */
export function aggregate5m(bars: readonly MinBar[], freq: number): MinBar[] {
  if (freq <= 5) return [...bars];
  const groups = new Map<string, MinBar & { _t: number }>();
  for (const b of bars) {
    const date = b.time.slice(0, 10);
    const hh = Number(b.time.slice(11, 13));
    const mm = Number(b.time.slice(14, 16));
    const T = hh * 60 + mm; // bar 结束分钟
    // 时段与时段起点（09:30=570、13:00=780）。
    let sessionStart = -1;
    if (T >= 570 && T <= 690) sessionStart = 570;
    else if (T >= 780 && T <= 900) sessionStart = 780;
    else continue; // 非交易时段（集合竞价等）跳过
    const bucket = Math.floor((T - sessionStart - 1) / freq);
    const key = `${date}|${sessionStart}|${bucket}`;
    const g = groups.get(key);
    if (!g) {
      groups.set(key, { time: b.time, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume, amount: b.amount, _t: T });
    } else {
      // 升序遍历：首开已定，末收/末时间更新，高取 max 低取 min，量额累加。
      g.high = Math.max(g.high, b.high);
      g.low = Math.min(g.low, b.low);
      g.close = b.close;
      g.volume += b.volume;
      g.amount += b.amount;
      if (T >= g._t) {
        g._t = T;
        g.time = b.time;
      }
    }
  }
  return [...groups.values()].map(({ _t, ...rest }) => rest);
}

export interface MinQuery {
  code: string;
  freq: number; // 5/15/30/60
  start?: string;
  end?: string;
  limit: number;
}

/** 取分钟K线（仅不复权 adjustflag=3）。升序，聚合到 freq。 */
export function queryMinKline(q: MinQuery): MinBar[] {
  const d = getMinDb();
  const groupSize = Math.max(1, Math.round(q.freq / 5));
  const fetchLimit = Math.min(q.limit * groupSize, 200000);
  let where = 'code = ? AND adjustflag = 3';
  const params: (string | number)[] = [q.code];
  if (q.start) {
    where += ' AND time >= ?';
    params.push(q.start);
  }
  if (q.end) {
    where += ' AND time <= ?';
    params.push(q.end);
  }
  const sql = `SELECT time, open, high, low, close, volume, amount FROM stock_kline_5m WHERE ${where} ORDER BY time DESC LIMIT ?`;
  params.push(fetchLimit);
  const desc = d.prepare(sql).all(...params) as Record<string, number | string>[];
  const bars: MinBar[] = desc
    .map((r) => ({
      time: r.time as string,
      open: r.open as number,
      high: r.high as number,
      low: r.low as number,
      close: r.close as number,
      volume: r.volume as number,
      amount: r.amount as number,
    }))
    .reverse();
  return aggregate5m(bars, q.freq).slice(-q.limit);
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
  const r = d.prepare('SELECT COUNT(*) c, MIN(time) a, MAX(time) b FROM stock_kline_5m WHERE code = ?').get(code) as { c: number; a: string | null; b: string | null };
  return { hasMin: r.c > 0, count: r.c, firstTime: r.a, lastTime: r.b };
}