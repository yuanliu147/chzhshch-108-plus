// 第8关 买卖点（20/21/51/53/101课）。
// 一买/一卖=下跌趋势/上涨趋势的趋势背驰转折点；三买/三卖=离开中枢后首次回试分型不破边界；
// 二买/二卖=一买/一卖后回抽再探底的分型。均溯源到已确认结构，候选随结构进行。
import type { BuySellPoint, Center, ChanConfig, Divergence, Fractal, KInput, MergedBar, Segment } from './types.ts';
import { evidenceOf, sameContinuity, sourceKey } from './sourceEvidence.ts';

function fxRaw(fx: Fractal, validBars: MergedBar[]): number {
  const mb = validBars[fx.middle];
  return mb ? (mb.startRaw + mb.endRaw) / 2 : fx.startRaw;
}

/** 买卖点检测。id 由位置+1；confirmedAt 由 Replay 填。 */
export function detectPoints(
  divergences: readonly Divergence[],
  centers: readonly Center[],
  fractals: readonly Fractal[],
  validBars: MergedBar[],
  bars: readonly KInput[],
  cfg: ChanConfig,
  /** 已完成次级别走势（默认基础构件为已确认线段）。生产路径必须传入。 */
  subMovements: readonly Segment[] = [],
  mode: 'completed-movements' | 'historical-fractals' = 'completed-movements',
): BuySellPoint[] {
  const out: BuySellPoint[] = [];
  const historical = mode === 'historical-fractals';
  const add = (p: BuySellPoint, ref: Divergence | Center | BuySellPoint, extra: (Segment | Fractal)[]): void => {
    p.refKind = p.klass === 1 ? 'divergence' : p.klass === 3 ? 'center' : 'point';
    p.refKey = sourceKey(ref, p.refKind);
    const extraKeys = extra.map((x) => sourceKey(x, 'movement'));
    Object.assign(p, evidenceOf([ref, ...extra], [p.refKey, ...extraKeys]));
    p.key = `point:${p.continuityId}:${p.side}:${p.klass}:${p.refKey}:${extraKeys.join('|') || (historical ? `historical:${p.atRaw}` : 'open')}`;
    if (p.quality !== 'verified') p.status = 'candidate';
    if (p.status === 'confirmed') p.confirmedAt = Math.max(ref.confirmedAt ?? ('cEnd' in ref ? ref.cEnd : 'endRaw' in ref ? ref.endRaw : ref.atRaw), ...extra.map((x) => x.confirmedAt ?? x.endRaw));
    out.push(p);
  };
  const confirmedFx = fractals.filter((f) => f.status === 'confirmed');
  const fxRawOf = (f: Fractal) => fxRaw(f, validBars);

  const movements = subMovements.filter((m) => m.status === 'confirmed').sort((a, b) => a.startRaw - b.startRaw);

  // ---- 一买/一卖：趋势背驰转折点；有次级别数据时必须出现反向完成走势才确认 ----
  for (const d of divergences) {
    if (d.kind !== '趋势背驰') continue;
    const i = Math.max(0, Math.min(bars.length - 1, Math.round(d.cEnd)));
    const b = bars[i]!;
    const turn = movements.find((m) => sameContinuity(m, d) && m.dir === (d.dir === 'down' ? 'up' : 'down') && m.startRaw >= d.cEnd - 0.6);
    const status: BuySellPoint['status'] = d.status === 'confirmed' && (historical || !!turn) ? 'confirmed' : 'candidate';
    if (d.dir === 'down') {
      add({ id: 0, side: 'buy', klass: 1, atRaw: d.cEnd, price: b.low, refId: d.id, status, confirmedAt: null }, d, turn ? [turn] : []);
    } else {
      add({ id: 0, side: 'sell', klass: 1, atRaw: d.cEnd, price: b.high, refId: d.id, status, confirmedAt: null }, d, turn ? [turn] : []);
    }
  }

  if (!historical) {
    // ---- 原文路径：三买/三卖 = 完成的次级别离开 + 首次完成的次级别回试 ----
    for (const c of centers) {
      if (c.status !== 'confirmed') continue;
      const local = movements.filter((m) => sameContinuity(m, c));
      const after = local.filter((m) => m.startRaw >= c.endRaw - 0.6);
      const upLeave = after.find((m) => m.dir === 'up' && m.high > c.ZG);
      if (upLeave) {
        const retest = local.find((m) => m.dir === 'down' && m.startRaw >= upLeave.endRaw - 0.6);
        if (retest) {
          const ok = cfg.bsp3Touch === '不跌破ZG' ? retest.low >= c.ZG : retest.low > c.ZG;
          if (ok) add({ id: 0, side: 'buy', klass: 3, atRaw: retest.endRaw, price: retest.low, refId: c.id, status: 'confirmed', confirmedAt: null }, c, [upLeave, retest]);
        }
      }
      const downLeave = after.find((m) => m.dir === 'down' && m.low < c.ZD);
      if (downLeave) {
        const retest = local.find((m) => m.dir === 'up' && m.startRaw >= downLeave.endRaw - 0.6);
        if (retest) {
          const ok = cfg.bsp3Touch === '不跌破ZG' ? retest.high <= c.ZD : retest.high < c.ZD;
          if (ok) add({ id: 0, side: 'sell', klass: 3, atRaw: retest.endRaw, price: retest.high, refId: c.id, status: 'confirmed', confirmedAt: null }, c, [downLeave, retest]);
        }
      }
    }

    // ---- 原文路径：二类点 = 一类点后两个完成的次级别走势（反弹、回试） ----
    const firstBuys2 = out.filter((p) => p.klass === 1 && p.side === 'buy' && p.status === 'confirmed');
    const firstSells2 = out.filter((p) => p.klass === 1 && p.side === 'sell' && p.status === 'confirmed');
    for (const b1 of firstBuys2) {
      const rebound = movements.find((m) => sameContinuity(m, b1) && m.dir === 'up' && m.startRaw >= b1.atRaw - 0.6 && m.endRaw > b1.atRaw);
      if (!rebound) continue;
      const retest = movements.find((m) => sameContinuity(m, b1) && m.dir === 'down' && m.startRaw >= rebound.endRaw - 0.6);
      if (!retest) continue;
      if (cfg.bsp2Filter === '过滤二买须高于一买' && !(retest.low > b1.price)) continue;
      add({ id: 0, side: 'buy', klass: 2, atRaw: retest.endRaw, price: retest.low, refId: b1.id, status: 'confirmed', confirmedAt: null }, b1, [rebound, retest]);
    }
    for (const s1 of firstSells2) {
      const decline = movements.find((m) => sameContinuity(m, s1) && m.dir === 'down' && m.startRaw >= s1.atRaw - 0.6 && m.endRaw > s1.atRaw);
      if (!decline) continue;
      const retest = movements.find((m) => sameContinuity(m, s1) && m.dir === 'up' && m.startRaw >= decline.endRaw - 0.6);
      if (!retest) continue;
      if (cfg.bsp2Filter === '过滤二买须高于一买' && !(retest.high < s1.price)) continue;
      add({ id: 0, side: 'sell', klass: 2, atRaw: retest.endRaw, price: retest.high, refId: s1.id, status: 'confirmed', confirmedAt: null }, s1, [decline, retest]);
    }
  } else {
    // 兼容旧的纯分型调用（仅用于历史对照/单测）：生产 Replay 必须传已完成次级别走势。
    for (const c of centers) {
      if (c.status !== 'confirmed') continue;
      let upLeave = -1;
      let downLeave = -1;
      for (let i = Math.ceil(c.endRaw); i < bars.length; i++) {
        if (upLeave < 0 && bars[i]!.high > c.ZG) upLeave = i;
        if (downLeave < 0 && bars[i]!.low < c.ZD) downLeave = i;
        if (upLeave >= 0 && downLeave >= 0) break;
      }
      if (upLeave >= 0) {
        const retest = confirmedFx.find((f) => f.type === 'bottom' && fxRawOf(f) > upLeave);
        if (retest) {
          const ok = cfg.bsp3Touch === '不跌破ZG' ? retest.price >= c.ZG : retest.price > c.ZG;
          if (ok) add({ id: 0, side: 'buy', klass: 3, atRaw: fxRawOf(retest), price: retest.price, refId: c.id, status: 'confirmed', confirmedAt: null }, c, [retest]);
        }
      }
      if (downLeave >= 0) {
        const retest = confirmedFx.find((f) => f.type === 'top' && fxRawOf(f) > downLeave);
        if (retest) {
          const ok = cfg.bsp3Touch === '不跌破ZG' ? retest.price <= c.ZD : retest.price < c.ZD;
          if (ok) add({ id: 0, side: 'sell', klass: 3, atRaw: fxRawOf(retest), price: retest.price, refId: c.id, status: 'confirmed', confirmedAt: null }, c, [retest]);
        }
      }
    }
    const firstBuys = out.filter((p) => p.klass === 1 && p.side === 'buy' && p.status === 'confirmed');
    const firstSells = out.filter((p) => p.klass === 1 && p.side === 'sell' && p.status === 'confirmed');
    for (const b1 of firstBuys) {
      const up = confirmedFx.find((f) => f.type === 'top' && fxRawOf(f) > b1.atRaw);
      if (!up) continue;
      const b2 = confirmedFx.find((f) => f.type === 'bottom' && fxRawOf(f) > fxRawOf(up));
      if (!b2) continue;
      if (cfg.bsp2Filter === '过滤二买须高于一买' && !(b2.price > b1.price)) continue;
      add({ id: 0, side: 'buy', klass: 2, atRaw: fxRawOf(b2), price: b2.price, refId: b1.id, status: 'confirmed', confirmedAt: null }, b1, [up, b2]);
    }
    for (const s1 of firstSells) {
      const down = confirmedFx.find((f) => f.type === 'bottom' && fxRawOf(f) > s1.atRaw);
      if (!down) continue;
      const s2 = confirmedFx.find((f) => f.type === 'top' && fxRawOf(f) > fxRawOf(down));
      if (!s2) continue;
      if (cfg.bsp2Filter === '过滤二买须高于一买' && !(s2.price < s1.price)) continue;
      add({ id: 0, side: 'sell', klass: 2, atRaw: fxRawOf(s2), price: s2.price, refId: s1.id, status: 'confirmed', confirmedAt: null }, s1, [down, s2]);
    }
  }

  // 按结构位置排序后赋 id（保证时间序、单调）。
  out.sort((a, b) => a.atRaw - b.atRaw || a.klass - b.klass || (a.side === b.side ? 0 : a.side === 'buy' ? -1 : 1));
  out.forEach((p, k) => {
    p.id = k + 1;
  });
  const byKey = new Map(out.map((p) => [p.key, p.id]));
  for (const p of out) if (p.refKind === 'point') p.refId = byKey.get(p.refKey);
  return out;
}
