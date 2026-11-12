// 第5关 中枢：连续三个次级别构件（笔或线段）重叠构成（17/18/20/33课）。
// 纯函数：在「已确认构件」序列上重算，只追加确认、末尾留候选（同线段的遮右策略）。
// 核心区间 = 前三连续构件共同重叠（20课简化式）；外围 GG/DD/G/D 按 20课在同向 Z 段上计算。
import type { Center, ChanConfig } from './types.ts';
import { overlap, overlapAll, type Iv } from './segment.ts';

/** 中枢构件（笔或线段）：价格区间 + 起止原始下标 + 方向。 */
export interface Unit extends Iv {
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

interface BuiltC {
  center: Center;
  next: number;
}

/** 在已确认构件序列上构造中枢序列（末尾可能为候选）。id 由位置+1。 */
export function detectCenters(units: readonly Unit[], cfg: ChanConfig): Center[] {
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
        if (upgrade && segCount >= 9) {
          // 9段升级：本级中枢确认终结。
          status = 'confirmed';
          next = j + 1;
          break;
        }
      } else if (pendingLeave < 0) {
        pendingLeave = j; // 首次离开核心
      } else {
        // 回抽也不重叠核心（连续两个不重叠构件 = 离开+回抽不回）→ 破坏确认（18课定理三）。
        status = 'confirmed';
        endUnit = pendingLeave - 1; // 中枢终结于离开前最后一个构件
        next = pendingLeave; // 新结构自离开构件起
        break;
      }
    }
    if (status === 'candidate') {
      endUnit = n - 1;
      next = n;
    }
    // 同向 Z 段 = i, i+2, …（与中枢方向一致的构件），用于外围边界。
    const zs: Iv[] = [];
    for (let k = i; k <= endUnit; k += 2) zs.push(units[k]!);
    const b = centerBounds(zs);
    centers.push({
      id: 0,
      unit: 'segment', // 由调用方覆盖为 bi/segment
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
      status,
      confirmedAt: null,
    });
    if (status === 'candidate') break;
    i = next;
  }
  centers.forEach((c, k) => {
    c.id = k + 1;
  });
  return centers;
}
