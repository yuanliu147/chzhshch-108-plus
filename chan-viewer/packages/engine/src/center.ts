// 第5关 中枢：连续三个次级别构件（笔或线段）重叠构成（17/18/20/33课）。
// 纯函数：在「已确认构件」序列上重算，只追加确认、末尾留候选（同线段的遮右策略）。
// 核心区间 = 前三连续构件共同重叠（20课简化式）；外围 GG/DD/G/D 按 20课在同向 Z 段上计算。
import type { Center, ChanConfig, StructureEvidence } from './types.ts';
import { overlap, overlapAll, type Iv } from './segment.ts';
import { evidenceOf, sameContinuity } from './sourceEvidence.ts';

/** 中枢构件（笔或线段）：价格区间 + 起止原始下标 + 方向。 */
export interface Unit extends Iv, StructureEvidence {
  key?: string;
  confirmedAt?: number | null;
  startRaw: number;
  endRaw: number;
  dir: 'up' | 'down';
}

/** 中枢边界（20课）：ZG=min(g1,g2)、ZD=max(d1,d2)、GG/G/D/DD 遍历同向 Z 段。 */
export function centerBounds(zs: readonly Iv[]): { ZG: number; ZD: number; GG: number; DD: number; G: number; D: number } {
  const highs = zs.map((z) => z.high);
  const lows = zs.map((z) => z.low);
  return {
    ZG: Math.min(highs[0]!, highs[1]!),
    ZD: Math.max(lows[0]!, lows[1]!),
    GG: Math.max(...highs),
    DD: Math.min(...lows),
    G: Math.min(...highs),
    D: Math.max(...lows),
  };
}

/** 历史 fixture 缺省用几何端点；生产 Unit 必须传真实首知时间。 */
const knownAt = (u: Unit): number => u.confirmedAt ?? u.endRaw;
const unitKey = (u: Unit): string => u.key ?? `historical:unit:${u.startRaw}:${u.endRaw}`;

/** 按连续段构造，绝不把断点两侧的构件拼成初三段。 */
export function detectCenters(units: readonly Unit[], cfg: ChanConfig): Center[] {
  const out: Center[] = [];
  let start = 0;
  for (let end = 1; end <= units.length; end++) {
    if (end === units.length || !sameContinuity(units[end - 1]!, units[end]!)) {
      out.push(...detectContinuousCenters(units.slice(start, end), cfg));
      start = end;
    }
  }
  out.forEach((c, i) => { c.id = i + 1; });
  return out;
}

function detectContinuousCenters(units: readonly Unit[], cfg: ChanConfig): Center[] {
  const touch = cfg.touchOverlap === '相接算重叠';
  const upgrade = cfg.centerUpgrade === '9段升级';
  const centers: Center[] = [];
  const n = units.length;
  let i = 0;
  while (i + 2 < n) {
    const core = overlapAll([units[i]!, units[i + 1]!, units[i + 2]!], touch);
    if (!core) {
      i++;
      continue;
    }
    let endUnit = i + 2;
    let segCount = 3;
    let status: 'candidate' | 'confirmed' = 'candidate';
    let evolution: Center['evolution'] = 'forming';
    let terminatedAt: number | null = null;
    let terminatedRaw: number | null = null;
    let pendingLeave = -1; // 首个不重叠核心的构件（离开）
    let next = n;
    let j = i + 3;
    for (; j < n; j++) {
      const u = units[j]!;
      if (overlap(u, core, touch)) {
        // 重叠核心 → 延伸（若此前有离开，离开未成立，回到延伸）。
        pendingLeave = -1;
        endUnit = j;
        segCount++;
        evolution = 'extending';
        if (upgrade && segCount >= 9) {
          // 9段升级：本级中枢终结；父级对象由 levels 阶段保留来源后生成。
          status = 'confirmed';
          evolution = 'upgraded';
          terminatedRaw = u.endRaw;
          terminatedAt = Math.max(...units.slice(i, j + 1).map(knownAt));
          next = j + 1;
          break;
        }
      } else if (pendingLeave < 0) {
        pendingLeave = j; // 首次离开核心
      } else {
        // 回抽也不重叠核心（连续两个不重叠构件 = 离开+回抽不回）→ 破坏确认（18课定理三）。
        status = 'confirmed';
        evolution = 'terminated';
        endUnit = pendingLeave - 1; // 中枢终结于离开前最后一个构件
        terminatedRaw = u.endRaw;
        terminatedAt = Math.max(...units.slice(i, j + 1).map(knownAt));
        next = pendingLeave; // 新结构自离开构件起
        break;
      }
    }
    if (status === 'candidate') {
      endUnit = n - 1;
      next = n;
      if (endUnit > i + 2) evolution = 'extending';
    }
    // 同向 Z 段 = i, i+2, …（与中枢方向一致的构件），用于外围边界。
    const zs: Iv[] = [];
    for (let k = i; k <= endUnit; k += 2) zs.push(units[k]!);
    const b = centerBounds(zs);
    const seedUnits = units.slice(i, i + 3);
    const consumed = units.slice(i, Math.min(j + 1, n));
    const evidence = evidenceOf(consumed, consumed.map(unitKey));
    if (consumed.some((u) => u.confirmedAt === null)) evidence.quality = 'unknown';
    if (evidence.quality !== 'verified') status = 'candidate';
    const unit = cfg.centerUnit === '笔中枢' ? 'bi' : 'segment';
    centers.push({
      id: 0,
      ...evidence,
      key: `ctr:${evidence.continuityId}:${unit}:${seedUnits.map(unitKey).join('|')}`,
      unit,
      dir: units[i]!.dir,
      startRaw: units[i]!.startRaw,
      endRaw: units[endUnit]!.endRaw,
      ZG: core.high,
      ZD: core.low,
      GG: b.GG,
      DD: b.DD,
      G: b.G,
      D: b.D,
      segCount,
      formedAt: Math.max(...seedUnits.map(knownAt)),
      formedRaw: units[i + 2]!.endRaw,
      terminatedRaw,
      terminatedAt,
      evolution,
      status,
      confirmedAt: status === 'confirmed' ? terminatedAt : null,
    });
    if (status === 'candidate') break;
    i = next;
  }
  centers.forEach((c, k) => {
    c.id = k + 1;
    if (k === 0) { c.relation = 'first'; return; }
    const prev = centers[k - 1]!;
    const outerA = { low: prev.DD, high: prev.GG };
    const outerB = { low: c.DD, high: c.GG };
    c.relation = overlap(outerA, outerB, touch) ? 'expanded' : 'new';
  });
  return centers;
}
