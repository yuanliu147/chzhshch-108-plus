import json
import pandas as pd
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from datafeed import load_bars

FIXTURE = Path(__file__).parent / "fixture.json"

def test_load_bars_columns_and_order():
    df, bars = load_bars(str(FIXTURE))
    assert list(df.columns) == ["dt", "symbol", "open", "close", "high", "low", "vol", "amount"]
    assert len(df) == 3 and len(bars) == 3
    assert df["dt"].is_monotonic_increasing
    assert bars[0].symbol == "600519.SH"
    assert bars[2].close == df.iloc[2]["close"]
