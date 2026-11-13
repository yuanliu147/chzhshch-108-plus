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
  SourceEvidence,
  LevelSnapshot,
  RefKind,
  StructureEvidence,
} from './types.ts';
import { bot3, either, merge, roundPrice, top3 } from './merge.ts';
import { checkBi, moreExtreme } from './bi.ts';
import { detectSegments } from './segment.ts';
import { detectCenters, type Unit } from './center.ts';
import { detectTrends } from './trend.ts';
import { detectDivergences } from './divergence.ts';
import { detectPoints } from './point.ts';
import { configId, validateConfig } from './caliberRegistry.ts';
import { barKnownAt } from './analysisTime.ts';
import { buildLevels } from './levels.ts';
import { sourceOf } from './sourceEvidence.ts';

type Registered = StructureEvidence & { id: number; key?: string; status: 'candidate' | 'confirmed'; confirmedAt: number | null };

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
  private ids = new Map<string, number>();
  private nextIds = new Map<RefKind, number>();
  private frozen = new Map<string, Registered>();
  private sources: SourceEvidence[] = [];
  private macdSeries: MacdSeries = { dif: [], dea: [], hist: [] };
  private macdContinuity: string | null = null;
  private macdHasClose = false;
  private ema12 = 0;
  private ema26 = 0;
  private dea = 0;
  private activeContinuity: string | null = null;
  private inputContinuity: string | null = null;
  private usedContinuities = new Set<string>();
  private activeValidStart = 0;
  private levels: LevelSnapshot[];
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
    this.levels = buildLevels([], [], cfg);
  }

  /** 喂入一根已走完的原始K线，返回本根触发的事件。 */
  push(bar: KInput): ChanEvent[] {
    const start = this.events.length;
    this.curAt = this.rawCount++;
    this.rawBars.push(bar);
    const source = sourceOf(bar);
    if (!source.complete || source.quality !== 'verified') {
      this.sources.push(source);
      this.appendMacd(bar, source);
      this.breakChain();
      return this.events.slice(start);
    }
    if (this.inputContinuity !== source.continuityId || this.activeContinuity == null) {
      this.breakChain();
      this.inputContinuity = source.continuityId;
      this.activeContinuity = this.usedContinuities.has(source.continuityId) ? `${source.continuityId}@${this.curAt}` : source.continuityId;
      this.usedContinuities.add(source.continuityId);
    }
    source.continuityId = this.activeContinuity!;
    this.sources.push(source);
    this.appendMacd(bar, source);
    const high = roundPrice(bar.high, this.config.precision.digits);
    const low = roundPrice(bar.low, this.config.precision.digits);
    this.ingest(this.curAt, high, low);
    return this.events.slice(start);
  }

  result(): ComputeResult {
    // 派生与身份注册只发生在 push；包括依赖/递归数组的完整快照。
    return structuredClone({
      configId: this.configId, config: this.config, inputCount: this.rawCount,
      sourceEvidence: this.sources,
      validBars: this.valid,
      fractals: this.candidate ? [...this.confirmed, this.candidate] : this.confirmed,
      bis: this.bis,
      segments: this.segCandidate ? [...this.segs, this.segCandidate] : this.segs,
      centers: this.centerCandidate ? [...this.centers, this.centerCandidate] : this.centers,
      trends: this.trendCandidate ? [...this.trends, this.trendCandidate] : this.trends,
      divergences: this.divCandidate ? [...this.divergences, this.divCandidate] : this.divergences,
      points: this.points, levels: this.levels, macd: this.macdHasClose ? this.macdSeries : undefined,
      events: this.events,
    });
  }

  private breakChain(): void {
    this.activeContinuity = null;
    this.inputContinuity = null;
    this.activeValidStart = this.valid.length;
    this.candidate = null;
    this.kept = [];
    this.bis = this.bis.filter((b) => b.status === 'confirmed');
    this.segCandidate = null;
    this.centerCandidate = null;
    this.trendCandidate = null;
    this.divCandidate = null;
    this.points = this.points.filter((p) => p.status === 'confirmed');
    this.startDirLogged = false;
    this.cacheLevels();
  }

  private register<T extends Registered>(kind: RefKind, item: T): T {
    const key = `${kind}:${item.key!}`;
    let id = this.ids.get(key);
    if (id == null) {
      id = kind === 'fractal' ? this.nextFxId++ : kind === 'bi' ? this.nextBiId++ : this.nextIds.get(kind) ?? 1;
      if (kind !== 'fractal' && kind !== 'bi') this.nextIds.set(kind, id + 1);
      this.ids.set(key, id);
    }
    item.id = id;
    const old = this.frozen.get(key);
    if (old) Object.assign(item, structuredClone(old));
    else if (item.status === 'confirmed') {
      if (item.quality !== 'verified' || item.confirmedAt == null) throw new Error(`确认依赖未闭合: ${item.key}`);
      this.frozen.set(key, structuredClone(item));
    }
    return item;
  }

  private retain<T extends Registered>(history: T[], all: T[]): T[] {
    const byKey = new Map(history.map((x) => [x.key, x]));
    for (const item of all) if (item.status === 'confirmed') byKey.set(item.key, item);
    return [...byKey.values()];
  }

  private cacheLevels(): void {
    const centers = this.centerCandidate ? [...this.centers, this.centerCandidate] : this.centers;
    const trends = this.trendCandidate ? [...this.trends, this.trendCandidate] : this.trends;
    this.levels = buildLevels(centers, trends, this.config, 12, (kind, _degree, items) => {
      for (const item of items) this.register(kind, item);
    });
  }

  private emit(kind: EventKind, reason: string, cite: string[], refs: number[], id?: number): void {
    this.events.push({ at: this.curAt, kind, reason, cite, refs, id });
  }

  // ---- 第1关 包含处理 ----
  private ingest(at: number, high: number, low: number): void {
    const bar = { high, low };
    let merged = false;
    if (this.valid.length === this.activeValidStart) {
      this.valid.push({ index: this.valid.length, high, low, startRaw: at, endRaw: at });
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
    for (let i = this.valid.length - 2; i >= this.activeValidStart; i--) {
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
    if (L - this.activeValidStart < 3) return;
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
        fx.dependencyKeys!.push(`raw:${this.activeContinuity}:${at}`);
        this.register('fractal', fx);
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
        old.dependencyKeys = Array.from({ length: c.endRaw - a.startRaw + 1 }, (_, i) => `raw:${this.activeContinuity}:${a.startRaw + i}`);
      }
    }

    if (type && !this.candidate) {
      const fx: Fractal = {
        id: 0,
        key: `fx:${this.activeContinuity}:${type}:${b.startRaw}:${b.endRaw}`,
        continuityId: this.activeContinuity!, quality: 'verified',
        dependencyKeys: Array.from({ length: c.endRaw - a.startRaw + 1 }, (_, i) => `raw:${this.activeContinuity}:${a.startRaw + i}`),
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
      this.candidate = this.register('fractal', fx);
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
        const startFx = this.confirmed.find((f) => f.id === lb.start)!;
        lb.key = `bi:${this.activeContinuity}:${startFx.key}:${fx.key}`;
        lb.dependencyKeys = [startFx.key!, fx.key!];
        this.register('bi', lb);
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
          lb.dependencyKeys!.push(fx.key!);
          this.register('bi', lb);
          this.emit('笔确认', '下一笔形成，上一笔终点冻结确认', ['077'], [e.startRaw, e.endRaw], lb.id);
          this.updateSegments(at);
        }
        const bi: Bi = {
          id: 0,
          key: `bi:${this.activeContinuity}:${e.key}:${fx.key}`,
          continuityId: this.activeContinuity!, quality: 'verified', dependencyKeys: [e.key!, fx.key!],
          start: e.id,
          end: fx.id,
          dir: fx.type === 'top' ? 'up' : 'down',
          status: 'candidate',
          confirmedAt: null,
        };
        this.bis.push(this.register('bi', bi));
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
    const confirmedBis = this.bis.filter((b) => b.status === 'confirmed' && b.continuityId === this.activeContinuity);
    const fxById = new Map(this.confirmed.map((f) => [f.id, f] as const));
    const all = detectSegments(confirmedBis, fxById, this.valid, this.config);
    for (const s of all) {
      const existed = this.frozen.has(`segment:${s.key}`);
      this.register('segment', s);
      if (s.status === 'confirmed' && !existed) this.emit('线段确认', '特征序列出现分型，线段破坏确认', ['067'], [s.startRaw, s.endRaw], s.id);
    }
    this.segs = this.retain(this.segs, all);
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
      units = this.bis.filter((b) => b.status === 'confirmed' && b.continuityId === this.activeContinuity).map((b) => {
        const s = fxById.get(b.start)!;
        const e = fxById.get(b.end)!;
        return { low: Math.min(s.price, e.price), high: Math.max(s.price, e.price), startRaw: fxRaw(s), endRaw: fxRaw(e), dir: b.dir,
          key: b.key, continuityId: b.continuityId, quality: b.quality, confirmedAt: b.confirmedAt };
      });
    } else {
      units = this.segs.filter((s) => s.continuityId === this.activeContinuity).map((s) => ({
        low: s.low, high: s.high, startRaw: s.startRaw, endRaw: s.endRaw, dir: s.dir,
        key: s.key, continuityId: s.continuityId, quality: s.quality, confirmedAt: s.confirmedAt,
      }));
    }
    const all = detectCenters(units, this.config);
    for (const c of all) {
      c.degree = 1;
      const existed = this.frozen.has(`center:${c.key}`);
      this.register('center', c);
      if (c.status === 'confirmed' && !existed) this.emit('中枢确认', '中枢终结确认（离开后回抽不回，或延伸9段升级）', ['018', '033'], [c.startRaw, c.endRaw], c.id);
    }
    this.centers = this.retain(this.centers, all);
    this.centerCandidate = all.find((c) => c.status === 'candidate') ?? null;
    this.updateTrends(at);
    this.cacheLevels();
  }

  // ---- 第6关 走势类型 ----
  private updateTrends(at: number): void {
    const all = detectTrends(this.centers.filter((c) => c.continuityId === this.activeContinuity), this.config);
    for (const t of all) {
      const existed = this.frozen.has(`trend:${t.key}`);
      this.register('trend', t);
      if (t.status === 'confirmed' && !existed) this.emit('走势类型', `走势类型：${t.kind}（含${t.centerIds.length}个中枢）`, ['017'], [t.startRaw, t.endRaw], t.id);
    }
    this.trends = this.retain(this.trends, all);
    this.trendCandidate = all.find((t) => t.status === 'candidate') ?? null;
    this.updateDivergences(at, all);
  }

  // ---- 第7关 背驰 ----
  private appendMacd(bar: KInput, source: SourceEvidence): void {
    const close = bar.close;
    if (typeof close === 'number') this.macdHasClose = true;
    if (!source.complete || source.quality !== 'verified' || close == null || !Number.isFinite(close)) {
      this.macdContinuity = null;
      this.macdSeries.dif.push(null);
      this.macdSeries.dea.push(null);
      this.macdSeries.hist.push(null);
      return;
    }
    if (this.macdContinuity !== source.continuityId) {
      this.ema12 = this.ema26 = close;
      this.dea = 0;
      this.macdContinuity = source.continuityId;
    } else {
      this.ema12 = close * (2 / 13) + this.ema12 * (1 - 2 / 13);
      this.ema26 = close * (2 / 27) + this.ema26 * (1 - 2 / 27);
    }
    const dif = this.ema12 - this.ema26;
    this.dea = dif * (2 / 10) + this.dea * (1 - 2 / 10);
    this.macdSeries.dif.push(dif);
    this.macdSeries.dea.push(this.dea);
    this.macdSeries.hist.push(2 * (dif - this.dea));
  }

  private updateDivergences(at: number, allTrends: Trend[]): void {
    const hist = this.macdHasClose ? this.macdSeries.hist : null;
    const all = detectDivergences(allTrends, this.centers.filter((c) => c.continuityId === this.activeContinuity), this.rawBars, hist, this.config,
      this.segs.filter((s) => s.continuityId === this.activeContinuity));
    for (const d of all) {
      const existed = this.frozen.has(`divergence:${d.key}`);
      this.register('divergence', d);
      if (d.status === 'confirmed' && !existed) this.emit('背驰确认', `${d.kind}：c段力度${d.cForce.toFixed(2)} < b段${d.bForce.toFixed(2)}（${d.metric}）`, ['024', '027'], [d.cStart, d.cEnd], d.id);
    }
    this.divergences = this.retain(this.divergences, all);
    this.divCandidate = all.find((d) => d.status === 'candidate') ?? null;
    this.updatePoints(at, all);
  }

  // ---- 第8关 买卖点 ----
  private updatePoints(at: number, allDivergences: Divergence[]): void {
    const divs = this.retain(this.divergences, allDivergences).filter((d) => d.continuityId === this.activeContinuity);
    if (this.divCandidate) divs.push(this.divCandidate);
    const all = detectPoints(divs, this.centers.filter((c) => c.continuityId === this.activeContinuity), this.confirmed, this.valid, this.rawBars, this.config,
      this.segs.filter((s) => s.continuityId === this.activeContinuity), 'completed-movements');
    // 一/三类先注册；二类通过一类 key 解析最终 id，永不引用临时 id=0。
    for (const p of all.filter((p) => p.klass !== 2)) this.register('point', p);
    const firstByKey = new Map([...this.points, ...all].filter((p) => p.klass === 1).map((p) => [p.key, p.id]));
    for (const p of all.filter((p) => p.klass === 2)) {
      p.refId = firstByKey.get(p.refKey);
      this.register('point', p);
    }
    const oldKeys = new Set(this.points.filter((p) => p.status === 'confirmed').map((p) => p.key));
    for (const p of all) if (p.status === 'confirmed' && !oldKeys.has(p.key)) {
      const label = `${p.side === 'buy' ? '买' : '卖'}点·${['一', '二', '三'][p.klass - 1]}类`;
      this.emit(p.side === 'buy' ? '买点确认' : '卖点确认', `${label}@价格${p.price.toFixed(2)}`, ['020'], [p.atRaw], p.id);
    }
    this.points = [...this.retain(this.points.filter((p) => p.status === 'confirmed'), all), ...all.filter((p) => p.status === 'candidate')];
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

/**
 * 只使用物理截止前已完成的 bar 计算。
 * 日线按当日15:00收盘可知；分钟按调用方提供的 endMs/时间戳。合成序号日期无法解析时用于纯测试，不伪装成真实时间。
 */
export function analyzeAsOf(bars: readonly KInput[], cfg: ChanConfig, asOfMs: number): ComputeResult {
  if (!Number.isFinite(asOfMs)) throw new Error('asOfMs 必须为有限物理时间');
  let previous = -Infinity;
  let count = 0;
  for (const b of bars) {
    const known = barKnownAt(b);
    if (known == null) throw new Error(`无法解析行情时间: ${b.date}`);
    if (known < previous) throw new Error(`行情时间逆序: ${b.date}`);
    previous = known;
    if (known <= asOfMs) count++;
  }
  return { ...compute(bars.slice(0, count), cfg), asOfMs };
}