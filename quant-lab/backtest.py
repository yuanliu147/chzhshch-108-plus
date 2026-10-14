"""全量历史回测：逐 bar 推进 CzscTrader，输出交易明细与统计。

用法: .venv/bin/python backtest.py
口径: 成交价 = 信号确认当根收盘价（CzscTrader 逐 bar 语义保证）；
      收益按 平仓价格/开仓价格-1 复算，不依赖 czsc BP 单位；手续费 FEE_RATE 预留。
止损语义: czsc 1.0.1 的 stop_loss 为移动止损——自持仓期间最高价回撤 stop_loss BP 触发，
      非相对开仓价的固定止损，故止损出场笔可能仍盈利。
已知口子: 前复权数据的复权因子含未来信息（spec 已知风险 1）。
"""
import json
import sys
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
from datafeed import load_bars
from strategy import SYMBOL, build_positions, build_trader

FEE_RATE = 0.0  # 单边手续费率，预留
DATA = Path(__file__).resolve().parent / "data" / f"{SYMBOL}.daily.json"
OUT = Path(__file__).resolve().parent / "out"

def max_drawdown(returns: list[float]) -> float:
    equity, peak, mdd = 1.0, 1.0, 0.0
    for r in returns:
        equity *= 1 + r
        peak = max(peak, equity)
        mdd = min(mdd, equity / peak - 1)
    return mdd

def main() -> None:
    _, bars = load_bars(str(DATA))
    assert len(bars) > 2000, f"K线不足: {len(bars)}"
    ct = build_trader(build_positions())
    for bar in bars:  # 逐根推进，禁止任何形式的回看/回填
        ct.update(bar)

    pos = ct.positions[0]  # 注意：CzscTrader 克隆 positions，必须从 ct.positions 取结果
    dfp = pd.DataFrame(pos.pairs)
    if len(dfp) == 0:
        raise SystemExit("10 年回测 0 笔交易——信号配置串与事件串可能静默不匹配，停止并报告，勿静默通过")
    need = {"开仓时间", "平仓时间", "开仓价格", "平仓价格", "事件序列"}
    missing = need - set(dfp.columns)
    assert not missing, f"pairs 缺列: {missing}; 实际列: {list(dfp.columns)}"
    OUT.mkdir(exist_ok=True)
    # 事件序列为 "开多_一买#hash@... -> 平多@500BP止损\"" 形式；剥离 #hash 后缀，
    # 并去掉 czsc 止损事件名内嵌的引号字符
    dfp["开仓信号"] = (dfp["事件序列"].str.split(" -> ").str[0].str.split("#").str[0]
                   .str.replace('"', '', regex=False))
    dfp["平仓原因"] = (dfp["事件序列"].str.split(" -> ").str[-1].str.split("#").str[0]
                   .str.replace('"', '', regex=False))
    dfp.to_csv(OUT / "trades.csv", index=False, encoding="utf-8-sig")

    rets = (dfp["平仓价格"] / dfp["开仓价格"] - 1 - 2 * FEE_RATE).tolist()
    wins = [r for r in rets if r > 0]
    losses = [r for r in rets if r <= 0]
    stop_mask = dfp["事件序列"].str.contains("止损")
    summary = {
        "标的": SYMBOL,
        "区间": f"{bars[0].dt:%Y-%m-%d}~{bars[-1].dt:%Y-%m-%d}",
        "K线数": len(bars),
        "交易笔数": len(rets),
        "胜率": round(len(wins) / len(rets), 4) if rets else None,
        "平均盈利": round(sum(wins) / len(wins), 4) if wins else None,
        "平均亏损": round(sum(losses) / len(losses), 4) if losses else None,
        "累计收益(复利)": round(float(__import__("math").prod([1 + r for r in rets]) - 1), 4) if rets else None,
        "最大回撤": round(max_drawdown(rets), 4),
        "盈亏比": round((sum(wins) / len(wins)) / abs(sum(losses) / len(losses)), 2)
                  if wins and losses else None,
        "手续费率": FEE_RATE,
        "止损语义": "移动止损(峰值回撤500BP，非相对开仓价)",
        "止损出场笔数": int(stop_mask.sum()),
        "止损中盈利笔数": int((stop_mask & (dfp["平仓价格"] > dfp["开仓价格"])).sum()),
        "平仓原因分布": dfp["平仓原因"].value_counts().to_dict()
                      if len(dfp) else {},
    }
    (OUT / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    print(f"\ntrades.csv: {OUT / 'trades.csv'}")

    try:
        from czsc.utils.plotting.lightweight import plot_czsc_trader
        plot_czsc_trader(ct, output="html", path=str(OUT / "trader.html"))
        print(f"trader.html: {OUT / 'trader.html'}")
    except Exception as e:  # 绘图是展示层，失败不阻断回测结果
        print(f"[warn] plot_czsc_trader 失败（不影响回测数据）: {e}")

if __name__ == "__main__":
    main()
