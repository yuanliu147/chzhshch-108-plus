"""czsc 三类买卖点多头策略：一买/二买/三买开仓，一卖/二卖/三卖平仓，止损-500BP，超时250根"""
from czsc import BarGenerator, CzscTrader, Event, Position, get_signals_config

SYMBOL = "600519.SH"

# 配置串（带版本号，喂给 get_signals_config）
SIGNAL_STRINGS = [
    "日线_D1B_BUY1V221126_一买_任意_任意_0",
    "日线_D1B_SELL1V221126_一卖_任意_任意_0",
    "日线_D1#SMA#21_BS2辅助V230320_二买_任意_任意_0",
    "日线_D1#SMA#34_BS3辅助V230318_三买_任意_任意_0",
]

def _event(operate: str, sig: str, label: str) -> Event:
    # name 仅影响展示（Event.name 返回 "label#hash"），sha8 不变，匹配逻辑不受影响
    return Event.load({"operate": operate, "signals_all": [sig], "name": label})

def build_positions() -> list[Position]:
    # 事件串 = 运行时 key 格式：BUY1/SELL1 不带版本号，BS2/BS3 带版本号
    opens = [
        _event("开多", "日线_D1B_BUY1_一买_任意_任意_0", "开多_一买"),
        _event("开多", "日线_D1#SMA#21_BS2辅助V230320_二买_任意_任意_0", "开多_二买"),
        _event("开多", "日线_D1#SMA#34_BS3辅助V230318_三买_任意_任意_0", "开多_三买"),
    ]
    exits = [
        _event("平多", "日线_D1B_SELL1_一卖_任意_任意_0", "平多_一卖"),
        _event("平多", "日线_D1#SMA#21_BS2辅助V230320_二卖_任意_任意_0", "平多_二卖"),
        _event("平多", "日线_D1#SMA#34_BS3辅助V230318_三卖_任意_任意_0", "平多_三卖"),
    ]
    return [Position(symbol=SYMBOL, name="缠论三类买卖点多头", opens=opens, exits=exits,
                     interval=0, timeout=250, stop_loss=500)]

def build_trader(positions: list[Position]) -> CzscTrader:
    bg = BarGenerator("日线", [])
    config = get_signals_config(SIGNAL_STRINGS)
    return CzscTrader(bg, positions, config, ensemble_method="mean")
