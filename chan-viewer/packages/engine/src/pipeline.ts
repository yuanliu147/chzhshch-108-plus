// 缠论引擎核心：单一增量状态机。
// createReplay(cfg).push(bar)→Event[]；compute(bars,cfg) 只是 fold 包装。
// 批/增量同源，「遮右重放不回填」由构造保证（见 设计说明.md 引擎操作规格）。
import type {
  Bi,
  ChanConfig,
  ChanEvent,
  Center,
  ComputeResult,
  Divergence,
  EventKind,
  Fractal,
  FractalType,
  KInput,
  MacdSeries,
  MergedBar,
  Segment,
  Trend,
  BuySellPoint,
} from './types.ts';
import { bot3, either, merge, roundPrice, top3 } from './merge.ts';
import { checkBi, moreExtreme } from './bi.ts';
import { detectSegments } from './segment.ts';
import { detectCenters, type Unit } from './center.ts';
import { detectTrends } from './trend.ts';
import { detectDivergences } from './divergence.ts';
import { macd } from './macd.ts';
import { detectPoints } from './point.ts';
import { configId, validateConfig } from './caliberRegistry.ts';

export class Replay {
  readonly config: ChanConfig;
  readonly configId: string;

  private valid: MergedBar[] = [];
  private confirmed: Fractal[] = [];
  private candidate: Fractal | null = null;
  private kept: Fractal[] = [];
  private bis: Bi[] = [];
  private segs: Segment[] = [];
  private segCandidate: Segment | null = null;
  private centers: Center[] = [];
  private centerCandidate: Center | null = null;
  private trends: Trend[] = [];
  private trendCandidate: Trend | null = null;
  private divergences: Divergence[] = [];
  private divCandidate: Divergence | null = null;
  private points: BuySellPoint[] = [];
  private pointIdByKey = new Map<string, number>();
  private nextPointId = 1;
  private confirmedPointKeys = new Set<string>();
  private rawBars: KInput[] = [];
  private events: ChanEvent[] = [];
  private rawCount = 0;
  private curAt = 0;
  private nextFxId = 1;
  private nextBiId = 1;
  private startDirLogged = false;

  constructor(cfg: ChanConfig) {
    validateConfig(cfg);
    this.config = cfg;
    this.configId = configId(cfg);
  }

  /** 喂入一根已走完的原始K线，返回本根触发的事件。 */
  push(bar: KInput): ChanEvent[] {
    const start = this.events.length;
    this.curAt = this.rawCount++;
    this.rawBars.push(bar);
    const high = roundPrice(bar.high, this.config.precision.digits);
    const low = roundPrice(bar.low, this.config.precision.digits);
    this.ingest(this.curAt, high, low);
    return this.events.slice(start);
  }

  result(): ComputeResult {
    const fractals = this.candidate ? [...this.confirmed, this.candidate] : [...this.confirmed];
    const segments = this.segCandidate ? [...this.segs, this.segCandidate] : [...this.segs];
    const centers = this.centerCandidate ? [...this.centers, this.centerCandidate] : [...this.centers];
    const trends = this.trendCandidate ? [...this.trends, this.trendCandidate] : [...this.trends];
    const divergences = this.divCandidate ? [...this.divergences, this.divCandidate] : [...this.divergences];
    const macdSeries = this.macdFull();
    return {
      configId: this.configId,
      config: this.config,
      validBars: [...this.valid],
      fractals,
      bis: [...this.bis],
      segments,
      centers,
      trends,
      divergences,
      points: [...this.points],
      macd: macdSeries ?? undefined,
      events: [...this.events],
    };
  }

  private emit(kind: EventKind, reason: string, cite: string[], refs: number[], id?: number): void {
    this.events.push({ at: this.curAt, kind, reason, cite, refs, id });
  }

  // ---- 第1关 包含处理 ----
  private ingest(at: number, high: number, low: number): void {
    const bar = { high, low };
    let merged = false;
    if (this.valid.length === 0) {
      this.valid.push({ index: 0, high, low, startRaw: at, endRaw: at });
    } else {
      const tail = this.valid[this.valid.length - 1]!;
      if (either(tail, bar)) {
        const up = this.resolveDir(tail, bar);
        const m = merge(tail, bar, up);
        tail.low = m.low;
        tail.high = m.high;
        tail.endRaw = at;
        merged = true;
        this.emit(
          '合并',
          up ? '向上合并：高点取较高者、低点取较高者' : '向下合并：低点取较低者、高点取较低者',
          ['062', '065'],
          [tail.startRaw, at],
        );
      } else {
        this.valid.push({ index: this.valid.length, high, low, startRaw: at, endRaw: at });
      }
    }
    this.updateFractals(at, merged);
  }

  /** 方向判定。返回是否向上。 */
  private resolveDir(tail: MergedBar, bar: { high: number; low: number }): boolean {
    if (this.config.mergeDir === '直接用前一根') {
      // 错误示范：用被合并两根自身判方向（包含时方向无定义）。
      return bar.high >= tail.high;
    }
    // 回找非包含：往前找与尾根不构成包含的最近一根有效K线。
    for (let i = this.valid.length - 2; i >= 0; i--) {
      const p = this.valid[i]!;
      if (!either(p, tail)) {
        return tail.high >= p.high; // gn>=gn-1→向上；否则 dn<=dn-1→向下
      }
    }
    // 最左端：按事先约定的起点方向，写日志（仅首次）。
    if (!this.startDirLogged) {
      this.startDirLogged = true;
      this.emit(
        '起点方向',
        `最左端无已走完的非包含K线，按约定起点方向${this.config.startDir === 'up' ? '向上' : '向下'}`,
        ['065'],
        [tail.startRaw],
      );
    }
    return this.config.startDir === 'up';
  }

  // ---- 第2关 分型 ----
  private updateFractals(at: number, merged: boolean): void {
    const L = this.valid.length;
    if (L < 3) return;
    const a = this.valid[L - 3]!;
    const b = this.valid[L - 2]!;
    const c = this.valid[L - 1]!;
    const type: FractalType | null = top3([a, b, c]) ? 'top' : bot3([a, b, c]) ? 'bottom' : null;

    if (!merged) {
      // 新有效K线追加：原候选的第三根冻结 → 确认。
      if (this.candidate) {
        const fx = this.candidate;
        fx.status = 'confirmed';
        fx.confirmedAt = at;
        this.candidate = null;
        this.confirmed.push(fx);
        this.emit('分型确认', '第三根已冻结（不再是尾根），分型确认', ['062', '065'], [fx.startRaw, fx.endRaw], fx.id);
        this.onFractalConfirmed(fx, at);
      }
    } else if (this.candidate) {
      // 合并改写尾根：重估候选。
      const old = this.candidate;
      if (type === null || type !== old.type) {
        this.emit(
          '分型撤销',
          type === null ? '尾根被合并改写，三根结构不再满足分型定义' : '尾根被合并改写，分型类型改变',
          ['062', '065'],
          [old.startRaw, old.endRaw],
          old.id,
        );
        this.candidate = null;
      } else {
        old.endRaw = c.endRaw; // 候选延续（同类型同位置），更新溯源区间
      }
    }

    if (type && !this.candidate) {
      const fx: Fractal = {
        id: this.nextFxId++,
        type,
        middle: L - 2,
        price: type === 'top' ? b.high : b.low,
        midHigh: b.high,
        midLow: b.low,
        startRaw: a.startRaw,
        endRaw: c.endRaw,
        status: 'candidate',
        confirmedAt: null,
      };
      this.candidate = fx;
      this.emit('分型候选', '三根结构满足分型定义，第三根仍是尾根，列为候选', ['062'], [fx.startRaw, fx.endRaw], fx.id);
    }
  }

  // ---- 第3关 笔 ----
  private onFractalConfirmed(fx: Fractal, at: number): void {
    const K = this.kept;
    if (K.length === 0) {
      K.push(fx);
      return;
    }
    const last = K[K.length - 1]!;
    if (fx.type === last.type) {
      // 同类：级联单向剔除（前顶低于后顶/前底高于后底）。
      const lb = this.bis[this.bis.length - 1];
      let changedEnd = false;
      while (K.length > 0 && K[K.length - 1]!.type === fx.type && moreExtreme(fx, K[K.length - 1]!)) {
        const e = K.pop()!;
        this.emit(
          '剔除',
          fx.type === 'top' ? '前顶低于后顶，单向剔除前顶' : '前底高于后底，单向剔除前底',
          ['077'],
          [e.startRaw, e.endRaw],
          e.id,
        );
        if (lb && lb.end === e.id) changedEnd = true;
      }
      if (changedEnd && lb) {
        lb.end = fx.id;
        lb.dir = fx.type === 'top' ? 'up' : 'down';
        this.emit('改端点', '出现更极端的同类分型，候选笔端点改为新分型', ['077'], [fx.startRaw, fx.endRaw], lb.id);
      }
      K.push(fx);
    } else {
      // 异类：先解析尾部同类串（取最先一个＝最极端）。
      while (K.length >= 2 && K[K.length - 2]!.type === K[K.length - 1]!.type) {
        const e = K.pop()!;
        this.emit('剔除', '同串取首：保留连续同类中最先一个（最极端），其余剔除', ['077'], [e.startRaw, e.endRaw], e.id);
      }
      const e = K[K.length - 1]!;
      const chk = checkBi(e, fx, this.config.biRule);
      if (chk.ok) {
        const lb = this.bis[this.bis.length - 1];
        if (lb && lb.end === e.id) {
          lb.status = 'confirmed';
          lb.confirmedAt = at;
          this.emit('笔确认', '下一笔形成，上一笔终点冻结确认', ['077'], [e.startRaw, e.endRaw], lb.id);
          this.updateSegments(at);
        }
        const bi: Bi = {
          id: this.nextBiId++,
          start: e.id,
          end: fx.id,
          dir: fx.type === 'top' ? 'up' : 'down',
          status: 'candidate',
          confirmedAt: null,
        };
        this.bis.push(bi);
        this.emit('笔候选', '相反分型满足独立K线与价格条件，连成候选笔', ['077'], [e.startRaw, fx.endRaw], bi.id);
        K.push(fx);
      } else {
        this.emit('剔除', chk.reason, ['077'], [fx.startRaw, fx.endRaw], fx.id);
      }
    }
  }

  // ---- 第4关 线段 ----
  /** 笔确认后重算线段：纯函数 detectSegments 在已确认笔序列上划分，只追加确认、末尾留候选。 */
  private updateSegments(at: number): void {
    const confirmedBis = this.bis.filter((b) => b.status === 'confirmed');
    const fxById = new Map(this.confirmed.map((f) => [f.id, f] as const));
    const all = detectSegments(confirmedBis, fxById, this.valid, this.config);
    const confirmed = all.filter((s) => s.status === 'confirmed');
    for (let k = this.segs.length; k < confirmed.length; k++) {
      const s = confirmed[k]!;
      s.confirmedAt = at;
      this.emit('线段确认', '特征序列出现分型，线段破坏确认', ['067'], [s.startRaw, s.endRaw], s.id);
    }
    this.segs = confirmed;
    this.segCandidate = all.find((s) => s.status === 'candidate') ?? null;
    this.updateCenters(at);
  }

  // ---- 第5关 中枢 ----
  /** 线段/笔确认后重算中枢：centerUnit 选构件（线段或笔），detectCenters 纯函数重算。 */
  private updateCenters(at: number): void {
    const useBi = this.config.centerUnit === '笔中枢';
    const fxRaw = (fx: Fractal): number => {
      const mb = this.valid[fx.middle];
      return mb ? (mb.startRaw + mb.endRaw) / 2 : fx.startRaw;
    };
    let units: Unit[];
    if (useBi) {
      const fxById = new Map(this.confirmed.map((f) => [f.id, f] as const));
      units = this.bis.filter((b) => b.status === 'confirmed').map((b) => {
        const s = fxById.get(b.start)!;
        const e = fxById.get(b.end)!;
        return { low: Math.min(s.price, e.price), high: Math.max(s.price, e.price), startRaw: fxRaw(s), endRaw: fxRaw(e), dir: b.dir };
      });
    } else {
      units = this.segs.map((s) => ({ low: s.low, high: s.high, startRaw: s.startRaw, endRaw: s.endRaw, dir: s.dir }));
    }
    const all = detectCenters(units, this.config);
    all.forEach((c) => {
      c.unit = useBi ? 'bi' : 'segment';
    });
    const confirmed = all.filter((c) => c.status === 'confirmed');
    for (let k = this.centers.length; k < confirmed.length; k++) {
      const c = confirmed[k]!;
      c.confirmedAt = at;
      this.emit('中枢确认', '中枢终结确认（离开后回抽不回，或延伸9段升级）', ['018', '033'], [c.startRaw, c.endRaw], c.id);
    }
    this.centers = confirmed;
    this.centerCandidate = all.find((c) => c.status === 'candidate') ?? null;
    this.updateTrends(at);
  }

  // ---- 第6关 走势类型 ----
  private updateTrends(at: number): void {
    const all = detectTrends(this.centers, this.config);
    const confirmed = all.filter((t) => t.status === 'confirmed');
    for (let k = this.trends.length; k < confirmed.length; k++) {
      const t = confirmed[k]!;
      t.confirmedAt = at;
      this.emit('走势类型', `走势类型：${t.kind}（含${t.centerIds.length}个中枢）`, ['017'], [t.startRaw, t.endRaw], t.id);
    }
    this.trends = confirmed;
    this.trendCandidate = all.find((t) => t.status === 'candidate') ?? null;
    this.updateDivergences(at, all);
  }

  // ---- 第7关 背驰 ----
  private macdFull(): MacdSeries | null {
    if (this.rawBars.length === 0) return null;
    const closes = this.rawBars.map((b) => b.close);
    if (closes.some((c) => typeof c !== 'number')) return null;
    return macd(closes as number[]);
  }

  private updateDivergences(at: number, allTrends: Trend[]): void {
    const hist = this.macdFull()?.hist ?? null;
    const all = detectDivergences(allTrends, this.centers, this.rawBars, hist, this.config);
    const confirmed = all.filter((d) => d.status === 'confirmed');
    for (let k = this.divergences.length; k < confirmed.length; k++) {
      const d = confirmed[k]!;
      d.confirmedAt = at;
      this.emit(
        '背驰确认',
        `${d.kind}（${d.dir === 'up' ? '上涨' : '下跌'}）：c段力度${d.cForce.toFixed(2)} < b段${d.bForce.toFixed(2)}（${d.metric}）`,
        ['024', '027'],
        [d.cStart, d.cEnd],
        d.id,
      );
    }
    this.divergences = confirmed;
    this.divCandidate = all.find((d) => d.status === 'candidate') ?? null;
    this.updatePoints(at, all);
  }

  // ---- 第8关 买卖点 ----
  private updatePoints(at: number, allDivergences: Divergence[]): void {
    const all = detectPoints(allDivergences, this.centers, this.confirmed, this.valid, this.rawBars, this.config);
    for (const p of all) {
      // 稳定 id：按内在 key 在首次出现时赋（前缀/全量一致，满足 P1）。
      const key = `${p.side}${p.klass}@${p.atRaw.toFixed(2)}#${p.refId ?? ''}`;
      let id = this.pointIdByKey.get(key);
      if (id === undefined) {
        id = this.nextPointId++;
        this.pointIdByKey.set(key, id);
      }
      p.id = id;
      if (p.status === 'confirmed' && !this.confirmedPointKeys.has(key)) {
        this.confirmedPointKeys.add(key);
        const label = `${p.side === 'buy' ? '买' : '卖'}点·${['一', '二', '三'][p.klass - 1]}类`;
        this.emit(p.side === 'buy' ? '买点确认' : '卖点确认', `${label}@价格${p.price.toFixed(2)}`, ['020'], [p.atRaw], id);
      }
    }
    this.points = all;
  }
}

export function createReplay(cfg: ChanConfig): Replay {
  return new Replay(cfg);
}

/** 批计算＝增量 fold。与逐根 push 同源（性质 P2）。 */
export function compute(bars: readonly KInput[], cfg: ChanConfig): ComputeResult {
  const r = new Replay(cfg);
  for (const b of bars) r.push(b);
  return r.result();
}