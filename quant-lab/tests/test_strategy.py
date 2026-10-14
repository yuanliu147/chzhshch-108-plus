import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from strategy import SIGNAL_STRINGS, build_positions, build_trader

def test_signal_strings():
    assert len(SIGNAL_STRINGS) == 4
    assert all(s.count("_") == 6 for s in SIGNAL_STRINGS)  # 7 段下划线分隔
    assert "BUY1V221126" in SIGNAL_STRINGS[0]

def test_build_positions():
    positions = build_positions()
    assert len(positions) == 1
    pos = positions[0]
    assert pos.symbol == "600519.SH"
    assert len(pos.opens) == 3 and len(pos.exits) == 3
    assert pos.stop_loss == 500 and pos.timeout == 250

def test_build_trader():
    ct = build_trader(build_positions())
    assert ct.base_freq == "日线"
