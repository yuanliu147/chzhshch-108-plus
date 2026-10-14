"""hithink-finance 日K JSON -> 标准 DataFrame / RawBar 列表"""
import json
import pandas as pd
from czsc import format_standard_kline

COLS = ["dt", "symbol", "open", "close", "high", "low", "vol", "amount"]
FIELDS = ["date_ms", "open_price", "close_price", "high_price", "low_price", "volume", "turnover"]

def load_bars(json_path: str, symbol: str = "600519.SH") -> tuple[pd.DataFrame, list]:
    with open(json_path, encoding="utf-8") as f:
        env = json.load(f)
    if not env.get("ok"):
        raise ValueError(f"hithink-finance 返回失败: {env.get('error')}")
    item = env["data"]["item"]
    for i, x in enumerate(item):
        missing = [k for k in FIELDS if k not in x]
        if missing:
            raise ValueError(f"第 {i} 根K线缺少字段: {missing}")
    df = pd.DataFrame({
        "dt": pd.to_datetime([x["date_ms"] for x in item], unit="ms", utc=True).tz_convert("Asia/Shanghai").tz_localize(None),
        "symbol": symbol,
        "open": [x["open_price"] for x in item],
        "close": [x["close_price"] for x in item],
        "high": [x["high_price"] for x in item],
        "low": [x["low_price"] for x in item],
        "vol": [x["volume"] for x in item],
        "amount": [x["turnover"] for x in item],
    })[COLS]
    if not df["dt"].is_monotonic_increasing or df["dt"].duplicated().any():
        raise ValueError("dt 非严格递增或有重复")
    return df, format_standard_kline(df, freq="日线")
