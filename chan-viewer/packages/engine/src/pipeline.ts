// 缠论引擎核心：单一增量状态机。
// createReplay(cfg).push(bar)→Event[]；compute(bars,cfg) 只是 fold 包装。
// 批/增量同源，「遮右重放不回填」由构造保证（见 设计说明.md 引擎操作规格）。
import type {
  Bi,
  ChanConfig,
  ChanEvent,
  ComputeResult,
  EventKind,
  Fractal,
  FractalType,
  KInput,
  MergedBar,
} from './types.ts';
import { bot3, either, merge, roundPrice, top3 } from './merge.ts';
import { checkBi, moreExtreme } from './bi.ts';
import { configId, validateConfig } from './caliberRegistry.ts';

export class Replay {
  readonly config: ChanConfig;
  readonly configId: string;

  private valid: MergedBar[] = [];
  private confirmed: Fractal[] = [];
  private candidate: Fractal | null = null;
  private kept: Fractal[] = [];
  private bis: Bi[] = [];
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
    const high = roundPrice(bar.high, this.config.precision.digits);
    const low = roundPrice(bar.low, this.config.precision.digits);
    this.ingest(this.curAt, high, low);
    return this.events.slice(start);
  }

  result(): ComputeResult {
    const fractals = this.candidate ? [...this.confirmed, this.candidate] : [...this.confirmed];
    return {
      configId: this.configId,
      config: this.config,
      validBars: [...this.valid],
      fractals,
      bis: [...this.bis],
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