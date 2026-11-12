// 第8关 买卖点（20/21/51/53/101课）。
// 一买/一卖=下跌趋势/上涨趋势的趋势背驰转折点；三买/三卖=离开中枢后首次回试分型不破边界；
// 二买/二卖=一买/一卖后回抽再探底的分型。均溯源到已确认结构，候选随结构进行。
import type { BuySellPoint, Center, ChanConfig, Divergence, Fractal, KInput, MergedBar } from './types.ts';

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
): BuySellPoint[] {
  const out: BuySellPoint[] = [];
  const confirmedFx = fractals.filter((f) => f.status === 'confirmed');
  const fxRawOf = (f: Fractal) => fxRaw(f, validBars);

  // ---- 一买/一卖：趋势背驰转折点（一买肯定是趋势背驰）----
  for (const d of divergences) {
    if (d.kind !== '趋势背驰') continue;
    const i = Math.max(0, Math.min(bars.length - 1, Math.round(d.cEnd)));
    const b = bars[i]!;
    if (d.dir === 'down') {
      // 下跌趋势背驰 → 一买（底）。
      out.push({ id: 0, side: 'buy', klass: 1, atRaw: d.cEnd, price: b.low, refId: d.id, status: d.status, confirmedAt: null });
    } else {
      out.push({ id: 0, side: 'sell', klass: 1, atRaw: d.cEnd, price: b.high, refId: d.id, status: d.status, confirmedAt: null });
    }
  }

  // ---- 三买/三卖：离开中枢 + 首次回试分型不破边界 ----
  for (const c of centers) {
    if (c.status !== 'confirmed') continue;
    // 向上离开：中枢后首根 high>ZG 的K线。
    let upLeave = -1;
    let downLeave = -1;
    for (let i = Math.ceil(c.endRaw); i < bars.length; i++) {
      if (upLeave < 0 && bars[i]!.high > c.ZG) upLeave = i;
      if (downLeave < 0 && bars[i]!.low < c.ZD) downLeave = i;
      if (upLeave >= 0 && downLeave >= 0) break;
    }
    // 三买：向上离开后首个底分型，低点不破 ZG（不跌破>=/不触及>）。
    if (upLeave >= 0) {
      const retest = confirmedFx.find((f) => f.type === 'bottom' && fxRawOf(f) > upLeave);
      if (retest) {
        const ok = cfg.bsp3Touch === '不跌破ZG' ? retest.price >= c.ZG : retest.price > c.ZG;
        if (ok) out.push({ id: 0, side: 'buy', klass: 3, atRaw: fxRawOf(retest), price: retest.price, refId: c.id, status: 'confirmed', confirmedAt: null });
      }
    }
    // 三卖：向下离开后首个顶分型，高点不升破 ZD。
    if (downLeave >= 0) {
      const retest = confirmedFx.find((f) => f.type === 'top' && fxRawOf(f) > downLeave);
      if (retest) {
        const ok = cfg.bsp3Touch === '不跌破ZG' ? retest.price <= c.ZD : retest.price < c.ZD;
        if (ok) out.push({ id: 0, side: 'sell', klass: 3, atRaw: fxRawOf(retest), price: retest.price, refId: c.id, status: 'confirmed', confirmedAt: null });
      }
    }
  }

  // ---- 二买/二卖：一买/一卖后回抽再探底 ----
  const firstBuys = out.filter((p) => p.klass === 1 && p.side === 'buy');
  const firstSells = out.filter((p) => p.klass === 1 && p.side === 'sell');
  for (const b1 of firstBuys) {
    // 一买后先一个顶分型（次级别向上回抽），再一个底分型（探底）= 二买。
    const up = confirmedFx.find((f) => f.type === 'top' && fxRawOf(f) > b1.atRaw);
    if (!up) continue;
    const b2 = confirmedFx.find((f) => f.type === 'bottom' && fxRawOf(f) > fxRawOf(up));
    if (!b2) continue;
    // bsp2Filter：过滤口径要求二买高于一买。
    if (cfg.bsp2Filter === '过滤二买须高于一买' && !(b2.price > b1.price)) continue;
    out.push({ id: 0, side: 'buy', klass: 2, atRaw: fxRawOf(b2), price: b2.price, refId: b1.id, status: 'confirmed', confirmedAt: null });
  }
  for (const s1 of firstSells) {
    const down = confirmedFx.find((f) => f.type === 'bottom' && fxRawOf(f) > s1.atRaw);
    if (!down) continue;
    const s2 = confirmedFx.find((f) => f.type === 'top' && fxRawOf(f) > fxRawOf(down));
    if (!s2) continue;
    if (cfg.bsp2Filter === '过滤二买须高于一买' && !(s2.price < s1.price)) continue;
    out.push({ id: 0, side: 'sell', klass: 2, atRaw: fxRawOf(s2), price: s2.price, refId: s1.id, status: 'confirmed', confirmedAt: null });
  }

  // 按结构位置排序后赋 id（保证时间序、单调）。
  out.sort((a, b) => a.atRaw - b.atRaw || a.klass - b.klass || (a.side === b.side ? 0 : a.side === 'buy' ? -1 : 1));
  out.forEach((p, k) => {
    p.id = k + 1;
  });
  return out;
}
