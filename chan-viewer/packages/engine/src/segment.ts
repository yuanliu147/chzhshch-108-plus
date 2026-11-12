// 第4关 线段：特征序列分型法（65/67/78课）。
// 纯函数：在「已确认笔」序列上做确定性划分，只追加确认、末尾留候选。
// 已确认笔不可变且只增 ⇒ 划分对前缀单调（已确认线段不被后续改写），天然满足遮右不回填。
// 区间一律 [low, high]，内核与 配图自检.py 同构。
import type { Bi, ChanConfig, Fractal, MergedBar, Segment } from './types.ts';

export interface Iv {
  low: number;
  high: number;
}

export function contains(a: Iv, b: Iv): boolean {
  return b.low >= a.low && b.high <= a.high;
}
export function either(a: Iv, b: Iv): boolean {
  return contains(a, b) || contains(b, a);
}
export function mergeIv(a: Iv, b: Iv, up: boolean): Iv {
  return up
    ? { low: Math.max(a.low, b.low), high: Math.max(a.high, b.high) }
    : { low: Math.min(a.low, b.low), high: Math.min(a.high, b.high) };
}
export function top3(s: readonly Iv[]): boolean {
  const [a, b, c] = s;
  return b!.high > a!.high && b!.high > c!.high && b!.low > a!.low && b!.low > c!.low;
}
export function bot3(s: readonly Iv[]): boolean {
  const [a, b, c] = s;
  return b!.low < a!.low && b!.low < c!.low && b!.high < a!.high && b!.high < c!.high;
}
/** 两区间是否重叠。touch=true（相接算重叠，闭区间 lo<=hi）；false=须严格重叠 lo<hi。 */
export function overlap(a: Iv, b: Iv, touch: boolean): boolean {
  const lo = Math.max(a.low, b.low);
  const hi = Math.min(a.high, b.high);
  return touch ? lo <= hi : lo < hi;
}

/** 多区间共同重叠（配图自检.overlap）：返回共同区间或 null。touch 控制端点相接是否算重叠。 */
export function overlapAll(rs: readonly Iv[], touch: boolean): Iv | null {
  if (rs.length === 0) return null;
  const lo = Math.max(...rs.map((r) => r.low));
  const hi = Math.min(...rs.map((r) => r.high));
  const ok = touch ? lo <= hi : lo < hi;
  return ok ? { low: lo, high: hi } : null;
}

/** 特征序列元素：一笔的价格区间 + 极值来源笔（provenance，用于定位线段端点）。 */
interface FeatEl {
  low: number;
  high: number;
  hiBi: number; // 高点来源笔下标
  loBi: number; // 低点来源笔下标
}

/** 标准化（非包含处理），逐字对齐 配图自检.standardize(seq, up)，并维护极值来源笔。 */
function standardize(els: readonly FeatEl[], up: boolean): FeatEl[] {
  const out: FeatEl[] = [];
  let direction = up;
  for (const e of els) {
    const last = out[out.length - 1];
    if (last && either(last, e)) {
      const m = mergeIv(last, e, direction);
      out[out.length - 1] = {
        low: m.low,
        high: m.high,
        hiBi: last.high >= e.high ? last.hiBi : e.hiBi,
        loBi: last.low <= e.low ? last.loBi : e.loBi,
      };
    } else {
      if (last) direction = e.high >= last.high;
      out.push({ ...e });
    }
  }
  return out;
}

interface BiInfo {
  iv: Iv;
  startFx: Fractal;
  endFx: Fractal;
  dir: 'up' | 'down';
}

/** 测试友好：对纯区间序列做标准化（配图自检.standardize 同构）。 */
export function standardizeSeq(ivs: readonly Iv[], up: boolean): Iv[] {
  const els = ivs.map((v, i) => ({ low: v.low, high: v.high, hiBi: i, loBi: i }));
  return standardize(els, up).map((e) => ({ low: e.low, high: e.high }));
}

function fxRaw(fx: Fractal, validBars: MergedBar[]): number {
  const mb = validBars[fx.middle];
  return mb ? (mb.startRaw + mb.endRaw) / 2 : fx.startRaw;
}

/**
 * 在已确认笔序列上划分线段。返回线段数组（末尾可能为候选）。
 * id 由位置+1 得（稳定），confirmedAt 由 Replay 填。
 */
export function detectSegments(
  bis: readonly Bi[],
  fxById: ReadonlyMap<number, Fractal>,
  validBars: MergedBar[],
  cfg: ChanConfig,
): Segment[] {
  const touch = cfg.touchOverlap === '相接算重叠';
  const doMerge = cfg.segMerge === '做包含处理';
  const n = bis.length;
  const info: BiInfo[] = [];
  for (const b of bis) {
    const s = fxById.get(b.start);
    const e = fxById.get(b.end);
    if (!s || !e) return [];
    info.push({
      iv: { low: Math.min(s.price, e.price), high: Math.max(s.price, e.price) },
      startFx: s,
      endFx: e,
      dir: b.dir,
    });
  }

  const segs: Segment[] = [];
  let i = 0;
  while (i < n) {
    const built = buildSegment(info, i, validBars, touch, doMerge);
    if (!built) break;
    segs.push(built.seg);
    if (built.seg.status === 'candidate') break;
    i = built.next;
  }
  segs.forEach((s, k) => {
    s.id = k + 1;
  });
  return segs;
}

interface Built {
  seg: Segment;
  next: number; // 下一线段起始笔下标（仅 confirmed 有意义）
}

/** 从笔下标 start 起构建一条线段；到数据末尾仍未确认结束则返回候选。 */
function buildSegment(
  info: BiInfo[],
  start: number,
  validBars: MergedBar[],
  touch: boolean,
  doMerge: boolean,
): Built | null {
  const n = info.length;
  const dir = info[start]!.dir;
  const up = dir === 'up';
  const startFx = info[start]!.startFx;

  // 特征序列元素 = 反向笔（up 线段取 down 笔），自 start+1 起每隔一根。
  let feat: FeatEl[] = [];
  // 候选线段当前极值分型（up=最高点所在顶分型；down=最低点所在底分型）。
  let extremePrice = up ? info[start]!.iv.high : info[start]!.iv.low;
  let extremeFx = info[start]!.endFx;

  // 第二种情况挂起：等第二特征序列出分型。
  let pending: null | {
    breakFx: Fractal;
    breakBi: number; // 假设分界点那根反向笔下标（下一线段由此起）
    secondFeat: FeatEl[]; // 第二特征序列（自分界点的反向序列）
  } = null;

  const mkSeg = (endFx: Fractal, status: 'candidate' | 'confirmed'): Segment => {
    const a = fxRaw(startFx, validBars);
    const b = fxRaw(endFx, validBars);
    return {
      id: 0,
      dir,
      startFx: startFx.id,
      endFx: endFx.id,
      startRaw: Math.min(a, b),
      endRaw: Math.max(a, b),
      high: Math.max(startFx.price, endFx.price),
      low: Math.min(startFx.price, endFx.price),
      status,
      confirmedAt: null,
    };
  };

  for (let k = start + 1; k < n; k++) {
    const bi = info[k]!;
    if (bi.dir === dir) {
      // 同向笔：延续线段，更新极值。第二种挂起中若同向创新高/低 → 破坏不成立，撤销挂起（78课）。
      const p = up ? bi.iv.high : bi.iv.low;
      const moreExtreme = up ? p > extremePrice : p < extremePrice;
      if (moreExtreme) {
        extremePrice = p;
        extremeFx = bi.endFx;
        if (pending) pending = null;
      }
      continue;
    }

    // 反向笔 → 特征元素。
    const el: FeatEl = { low: bi.iv.low, high: bi.iv.high, hiBi: k, loBi: k };

    if (pending) {
      // 第二特征序列（自分界点的反向序列）：78课须做包含处理（doMerge 控制）。
      pending.secondFeat.push(el);
      const sf = doMerge ? standardize(pending.secondFeat, !up) : pending.secondFeat;
      if (sf.length >= 3) {
        const tri = sf.slice(-3);
        const hit = up ? bot3(tri) : top3(tri); // 上起等第二序列底分型；下起等顶分型
        if (hit) {
          // 第二种情况成立：线段在假设分界点结束（确认）。
          return { seg: mkSeg(pending.breakFx, 'confirmed'), next: pending.breakBi };
        }
      }
      continue;
    }

    // 正常累计特征序列。
    feat.push(el);
    const fs = doMerge ? standardize(feat, up) : feat;
    if (fs.length < 3) continue;
    const tri = fs.slice(-3);
    const isFx = up ? top3(tri) : bot3(tri); // 上起看特征序列顶分型；下起看底分型
    if (!isFx) continue;

    // 出现特征序列分型 = 线段结束的前提。中间元素极值来源笔 → 假设分界点。
    const mid = tri[1]!;
    const breakBi = up ? mid.hiBi : mid.loBi; // 顶分型取高点来源笔；底分型取低点来源笔
    const breakFx = info[breakBi]!.startFx; // 该反向笔的起始分型即线段端点（顶/底）

    // 缺口判定：分型第一、二元素是否有缺口（无重叠）。
    const hasGap = !overlap(tri[0]!, tri[1]!, touch);
    if (!hasGap) {
      // 第一种情况：直接结束。
      return { seg: mkSeg(breakFx, 'confirmed'), next: breakBi };
    }
    // 第二种情况：挂起，等第二特征序列分型。
    pending = { breakFx, breakBi, secondFeat: [] };
  }

  // 数据末尾：线段未确认结束 → 候选，端点取当前极值分型。
  return { seg: mkSeg(extremeFx, 'candidate'), next: n };
}
