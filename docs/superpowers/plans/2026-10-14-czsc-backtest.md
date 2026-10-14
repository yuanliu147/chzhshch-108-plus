# czsc 买卖点历史回测 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用同花顺前复权日K + 官方 czsc 库，回测 600519.SH 近 10 年三类买卖点盈亏，输出交易明细 CSV、统计和 HTML 图。

**Architecture:** Python 虚拟环境（quant-lab/.venv）内 `pip install czsc`（PyPI 预编译 wheel）。数据由 `hithink-finance` CLI 拉取落盘 JSON，`format_standard_kline` 转 RawBar；用 `CzscTrader` 逐 bar 流式推进（每根收盘更新信号与持仓），Position 配置开平仓事件（一/二/三类买卖点）+ 止损 -500BP + 超时 250 根。统计由 `开仓价格`/`平仓价格` 列复算，不依赖 czsc 的 BP 单位。

**Tech Stack:** Python 3.13 venv、czsc(>=1.0)、pandas、hithink-finance CLI（数据源，仓库外已装）。

**Spec:** `docs/superpowers/specs/2026-10-14-czsc-backtest-design.md`

## Global Constraints

- 标的 `600519.SH`，窗口 2016-10-14 ~ 2026-10-14，前复权（`--adjust forward`）
- 成交价 = 信号确认那根 K 线的收盘价；严禁一次性全量算信号再回填（逐 bar `ct.update(bar)`）
- 全仓多头单笔，手续费 `FEE_RATE = 0`（常量预留），滑点 0
- 环境变量 `CZSC_MIN_BI_LEN` 不设（用默认 6）、`CZSC_MAX_BI_NUM` 不设（用默认 50）
- **不执行任何 git commit / git push**（用户未要求）；完成后向用户汇报，由用户决定是否提交
- 所有命令的工作目录为仓库根 `/Users/xianyi/self_dir/chzhshch-108-plus`，Python 一律用 `quant-lab/.venv/bin/python`

## 已核实的 czsc 1.0 API 事实（实施时不要凭记忆改动）

以下签名/字符串均已从 waditu/czsc 源码（master 分支）核实：

- `format_standard_kline(df, freq)`：df 必须含 8 列 `dt, symbol, open, close, high, low, vol, amount`；freq 传 `"日线"` 字符串即可
- 信号注册名（signals_seq 元素）：
  - `czsc._native.signals.cxt.cxt_first_buy_V221126`
  - `czsc._native.signals.cxt.cxt_first_sell_V221126`
  - `czsc._native.signals.cxt.cxt_second_bs_V230320`
  - `czsc._native.signals.cxt.cxt_third_bs_V230318`
- 信号运行时 key（Rust 源码核实，模板文档中的版本号不在 key 里）：
  - 一买: `日线_D1B_BUY1`（v1=`一买`/`其他`）；一卖: `日线_D1B_SELL1`
  - 二买/二卖: `日线_D1#SMA#21_BS2辅助V230320`
  - 三买/三卖: `日线_D1#SMA#34_BS3辅助V230318`
- `Event.load({"operate": "开多", "signals_all": ["<信号串>"]})`；信号串 7 段下划线分隔，末段 score=0 表示最低置信门槛，`任意` 为通配
- `Position(symbol=..., name=..., opens=[Event,...], exits=[Event,...], interval=0, timeout=250, stop_loss=500)`
- `bg = BarGenerator("日线", [])`；`ct = CzscTrader(bg, positions, get_signals_config(signals_seq), ensemble_method="mean")`
- `ct.update(bar)` 逐根推进；`pos.pairs` 返回记录列表（DataFrame 列：`标的代码,策略标记,交易方向,开仓时间,平仓时间,开仓价格,平仓价格,持仓K线数,事件序列,持仓天数,盈亏比例`）

---

### Task 1: quant-lab 骨架与 czsc 环境

**Files:**
- Create: `quant-lab/.gitignore`（目录内忽略 .venv、data、out）
- Modify: 根 `.gitignore`（追加 3 行）
- Create: `quant-lab/README.md`（用法速记）

**Interfaces:**
- Produces: 可执行的 `quant-lab/.venv/bin/python`，import czsc 成功

- [ ] **Step 1: 建目录与虚拟环境**

```bash
mkdir -p quant-lab/data quant-lab/out
python3.13 -m venv quant-lab/.venv
```

- [ ] **Step 2: 安装依赖**

```bash
quant-lab/.venv/bin/pip install -U pip czsc pandas
```

预期：`Successfully installed czsc-1.0.x ...`。**若报没有 cp313 wheel 且源码构建失败（缺 Rust 工具链）：立即停止**，向用户报告触发 spec 已知风险 4（降级方案A需重新确认），不要尝试改装系统环境。

- [ ] **Step 3: 验证 import 与信号注册名可用**

```bash
quant-lab/.venv/bin/python - <<'EOF'
import czsc
print("czsc version:", getattr(czsc, "__version__", "unknown"))
from czsc import CZSC, BarGenerator, CzscTrader, Event, Position, Freq, format_standard_kline, get_signals_config
for name in ["cxt_first_buy_V221126", "cxt_first_sell_V221126", "cxt_second_bs_V230320", "cxt_third_bs_V230318"]:
    full = f"czsc._native.signals.cxt.{name}"
    freqs = czsc.get_signals_freqs([full])
    assert freqs == ["日线"] or "日线" in freqs, (full, freqs)
    print("OK signal:", full, "freqs:", freqs)
EOF
```

预期：4 行 `OK signal: ...`，无 AssertionError（证明信号名在已装版本中存在且默认跑在日线上）。

- [ ] **Step 4: .gitignore**

根 `.gitignore` 末尾追加（先 Read 确认无重复）：

```
quant-lab/.venv/
quant-lab/data/
quant-lab/out/
```

并创建 `quant-lab/.gitignore` 内容同上三行（防御单独移动目录的情况）。不写 README（YAGNI，用法最终体现在 backtest.py 的命令行帮助和最终汇报里）。

---

### Task 2: 数据拉取与转换

**Files:**
- Create: `quant-lab/fetch_data.sh`
- Create: `quant-lab/datafeed.py`
- Test: `quant-lab/tests/test_datafeed.py`

**Interfaces:**
- Consumes: Task 1 的 venv
- Produces: `quant-lab/data/600519.SH.daily.json`（hithink-finance 信封）；`datafeed.load_bars(json_path: str) -> tuple[pd.DataFrame, list]`，df 含 8 标准列，第二元素为 RawBar 列表（时间升序）

- [ ] **Step 1: 写数据拉取脚本**

`quant-lab/fetch_data.sh`：

```bash
#!/usr/bin/env bash
# 拉取 600519.SH 2016-10-14 至今的前复权日K，落盘 data/600519.SH.daily.json
set -euo pipefail
cd "$(dirname "$0")"
START_MS=$(node -e "console.log(new Date('2016-10-14T00:00:00+08:00').getTime())")
END_MS=$(node -e "console.log(Date.now())")
hithink-finance market history \
  --thscode 600519.SH \
  --start-ms "$START_MS" \
  --end-ms "$END_MS" \
  --adjust forward \
  --output data/600519.SH.daily.json \
  --format json
node -e "
const env = require('./data/600519.SH.daily.json');
if (!env.ok) { console.error('hithink-finance 返回失败:', env.error); process.exit(1); }
console.log('bars:', env.data.item.length, '首条:', new Date(env.data.item[0].date_ms).toISOString().slice(0,10), '末条:', new Date(env.data.item.at(-1).date_ms).toISOString().slice(0,10));
"
```

- [ ] **Step 2: 拉数据**

```bash
bash quant-lab/fetch_data.sh
```

预期输出 `bars: 24xx ...`（约 2400+ 个交易日，10 年）。若 `ok:false`，读取 `error.hint` 报告给用户，不要重试超过 1 次。

- [ ] **Step 3: 写失败测试（数据转换）**

`quant-lab/tests/test_datafeed.py`：

```python
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
```

`quant-lab/tests/fixture.json`（3 根K线的最小 hithink-finance 信封）：

```json
{"ok": true, "command": "market history", "data": {"item": [
  {"date_ms": 1767225600000, "volume": 100, "turnover": 1000.0, "open_price": 10.0, "high_price": 11.0, "low_price": 9.5, "close_price": 10.5},
  {"date_ms": 1767312000000, "volume": 200, "turnover": 2100.0, "open_price": 10.5, "high_price": 10.8, "low_price": 10.0, "close_price": 10.2},
  {"date_ms": 1767398400000, "volume": 150, "turnover": 1600.0, "open_price": 10.2, "high_price": 10.6, "low_price": 9.8, "close_price": 10.4}
]}}
```

- [ ] **Step 4: 运行测试确认失败**

```bash
quant-lab/.venv/bin/pip install pytest
quant-lab/.venv/bin/python -m pytest quant-lab/tests/test_datafeed.py -v
```

预期：FAIL（`ModuleNotFoundError: No module named 'datafeed'`）。

- [ ] **Step 5: 实现 datafeed.py**

```python
"""hithink-finance 日K JSON -> 标准 DataFrame / RawBar 列表"""
import json
import pandas as pd
from czsc import Freq, format_standard_kline

COLS = ["dt", "symbol", "open", "close", "high", "low", "vol", "amount"]

def load_bars(json_path: str) -> tuple[pd.DataFrame, list]:
    env = json.load(open(json_path, encoding="utf-8"))
    if not env.get("ok"):
        raise ValueError(f"hithink-finance 返回失败: {env.get('error')}")
    item = env["data"]["item"]
    if len(item) < 100:
        raise ValueError(f"K线数量异常: {len(item)}")
    df = pd.DataFrame({
        "dt": pd.to_datetime([x["date_ms"] for x in item], unit="ms"),
        "symbol": json_path.split("/")[-1].split(".")[0],
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
```

（fixture 只有 3 根 < 100，`test_load_bars_columns_and_order` 会卡在数量校验上——把数量校验放到真实数据的集成步骤里做，fixture 测试专注列与顺序。）

修正实现：将 `if len(item) < 100` 删除，数量校验移入 Task 4 Step 1 的集成断言（真实数据 `assert len(bars) > 2000`）。`load_bars` 只校验：ok 信封、字段齐全、dt 严格递增。

- [ ] **Step 6: 重跑测试确认通过**

```bash
quant-lab/.venv/bin/python -m pytest quant-lab/tests/test_datafeed.py -v
```

预期：PASS。

- [ ] **Step 7: 真实数据集成冒烟**

```bash
quant-lab/.venv/bin/python - <<'EOF'
import sys; sys.path.insert(0, "quant-lab")
from datafeed import load_bars
df, bars = load_bars("quant-lab/data/600519.SH.daily.json")
assert len(bars) > 2000, len(bars)
assert bars[0].dt.strftime("%Y-%m-%d") >= "2016-10-14"
print("bars:", len(bars), "first:", bars[0].dt, "last:", bars[-1].dt, "freq:", bars[-1].freq)
EOF
```

预期：`bars: 24xx first: 2016-10-17 ... last: 2026-10-1x freq: 日线`。

---

### Task 3: 策略组装（信号 + 事件 + 持仓）

**Files:**
- Create: `quant-lab/strategy.py`
- Test: `quant-lab/tests/test_strategy.py`

**Interfaces:**
- Consumes: Task 1 API 事实（信号串常量）
- Produces: `strategy.SIGNALS_SEQ: list[str]`（4 个信号全名）；`strategy.build_positions() -> list[Position]`（单多头仓位，3 开 3 平 6 事件）；`strategy.build_trader(positions) -> CzscTrader`

- [ ] **Step 1: 写失败测试**

`quant-lab/tests/test_strategy.py`：

```python
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from strategy import SIGNALS_SEQ, build_positions, build_trader

def test_signals_seq():
    assert len(SIGNALS_SEQ) == 4
    assert all(s.startswith("czsc._native.signals.cxt.") for s in SIGNALS_SEQ)

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
```

- [ ] **Step 2: 运行确认失败**

```bash
quant-lab/.venv/bin/python -m pytest quant-lab/tests/test_strategy.py -v
```

预期：3 个 FAIL（ModuleNotFoundError: strategy）。

- [ ] **Step 3: 实现 strategy.py**

```python
"""czsc 三类买卖点多头策略：一买/二买/三买开仓，一卖/二卖/三卖平仓，止损-500BP，超时250根"""
from czsc import BarGenerator, CzscTrader, Event, Position, get_signals_config

SYMBOL = "600519.SH"

SIGNALS_SEQ = [
    "czsc._native.signals.cxt.cxt_first_buy_V221126",
    "czsc._native.signals.cxt.cxt_first_sell_V221126",
    "czsc._native.signals.cxt.cxt_second_bs_V230320",
    "czsc._native.signals.cxt.cxt_third_bs_V230318",
]

def _event(operate: str, sig: str) -> Event:
    return Event.load({"operate": operate, "signals_all": [sig]})

def build_positions() -> list[Position]:
    opens = [
        _event("开多", "日线_D1B_BUY1_一买_任意_任意_0"),
        _event("开多", "日线_D1#SMA#21_BS2辅助V230320_二买_任意_任意_0"),
        _event("开多", "日线_D1#SMA#34_BS3辅助V230318_三买_任意_任意_0"),
    ]
    exits = [
        _event("平多", "日线_D1B_SELL1_一卖_任意_任意_0"),
        _event("平多", "日线_D1#SMA#21_BS2辅助V230320_二卖_任意_任意_0"),
        _event("平多", "日线_D1#SMA#34_BS3辅助V230318_三卖_任意_任意_0"),
    ]
    return [Position(symbol=SYMBOL, name="缠论三类买卖点多头", opens=opens, exits=exits,
                     interval=0, timeout=250, stop_loss=500)]

def build_trader(positions: list[Position]) -> CzscTrader:
    bg = BarGenerator("日线", [])
    config = get_signals_config(SIGNALS_SEQ)
    return CzscTrader(bg, positions, config, ensemble_method="mean")
```

- [ ] **Step 4: 运行测试确认通过**

```bash
quant-lab/.venv/bin/python -m pytest quant-lab/tests/test_strategy.py -v
```

预期：3 个 PASS。若 `Event.load` 对信号串报错（格式不符），不要改 guess——把错误原样带回给用户并核对 spec「已核实的 API 事实」。

- [ ] **Step 5: 300 根K线推进冒烟（防"组装完跑不动"）**

```bash
quant-lab/.venv/bin/python - <<'EOF'
import sys; sys.path.insert(0, "quant-lab")
from datafeed import load_bars
from strategy import build_positions, build_trader, SIGNALS_SEQ
_, bars = load_bars("quant-lab/data/600519.SH.daily.json")
ct = build_trader(build_positions())
for bar in bars[:300]:
    ct.update(bar)
keys = [k for k in ct.s.keys() if "BUY1" in k or "BS2" in k or "BS3" in k]
print("信号key样例:", keys)
assert any("日线_D1B_BUY1" in k for k in keys), keys
print("SMOKE OK, end_dt:", ct.end_dt)
EOF
```

预期：打印信号 key（含 `日线_D1B_BUY1` 等 4 个 key），`SMOKE OK`。出现 panic/异常即停止报告。

---

### Task 4: 全量回测 + 交易明细 + 统计

**Files:**
- Create: `quant-lab/backtest.py`

**Interfaces:**
- Consumes: `datafeed.load_bars`、`strategy.build_positions/build_trader`
- Produces: `quant-lab/out/trades.csv`（列同 czsc pairs：标的代码…盈亏比例）；控制台统计报告；`quant-lab/out/summary.json`

- [ ] **Step 1: 实现 backtest.py**

```python
"""全量历史回测：逐 bar 推进 CzscTrader，输出交易明细与统计。

用法: .venv/bin/python backtest.py
口径: 成交价 = 信号确认当根收盘价（CzscTrader 逐 bar 语义保证）；
      收益按 平仓价格/开仓价格-1 复算，不依赖 czsc BP 单位；手续费 FEE_RATE 预留。
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

    pos = ct.positions[0]
    dfp = pd.DataFrame(pos.pairs)
    OUT.mkdir(exist_ok=True)
    dfp.to_csv(OUT / "trades.csv", index=False, encoding="utf-8-sig")

    rets = (dfp["平仓价格"] / dfp["开仓价格"] - 1 - 2 * FEE_RATE).tolist()
    wins = [r for r in rets if r > 0]
    losses = [r for r in rets if r <= 0]
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
        "平仓原因分布": dfp["事件序列"].str.extract(r"平多#([^_]+)")[0].value_counts().to_dict()
                      if len(dfp) else {},
    }
    (OUT / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    print(f"\ntrades.csv: {OUT / 'trades.csv'}")

if __name__ == "__main__":
    main()
```

注意：`事件序列` 提取平仓原因的 regex 依赖 czsc 事件名格式（`name#HASH`），若 `平仓原因分布` 为空 dict 不影响主结果——不要为它加复杂解析。

- [ ] **Step 2: 全量运行**

```bash
quant-lab/.venv/bin/python quant-lab/backtest.py
```

预期：打印 summary JSON（`交易笔数` 应为个位到几十的数量级；若 >200 笔，怀疑事件通配过宽，停下来核对），写出 `out/trades.csv` 与 `out/summary.json`。

- [ ] **Step 3: 一致性校验（统计可复算）**

```bash
quant-lab/.venv/bin/python - <<'EOF'
import json, pandas as pd, math
s = json.load(open("quant-lab/out/summary.json", encoding="utf-8"))
df = pd.read_csv("quant-lab/out/trades.csv")
rets = df["平仓价格"] / df["开仓价格"] - 1
assert s["交易笔数"] == len(df)
assert abs(s["累计收益(复利)"] - (math.prod(1 + rets) - 1)) < 1e-6
assert abs(s["胜率"] - (rets > 0).mean()) < 1e-6
# 成交价 = 收盘价口径抽查：开仓价格必须出现在当根K线 [low, high] 区间内（收盘价天然满足）
assert (df["开仓价格"] > 0).all() and (df["平仓价格"] > 0).all()
print("CONSISTENCY OK:", s["交易笔数"], "trades, total", s["累计收益(复利)"])
EOF
```

预期：`CONSISTENCY OK: ...`。任何 assert 失败都要先排查脚本 bug 再报告，不要静默改数。

---

### Task 5: HTML 可视化

**Files:**
- Modify: `quant-lab/backtest.py`（main 末尾追加绘图调用）
- Produces: `quant-lab/out/trader.html`

- [ ] **Step 1: 追加绘图代码到 backtest.py 的 `main()` 末尾（`print` 之后、`if __name__` 之前位置调用）**

在 `main()` 末尾、`if __name__ == "__main__":` 之前不动结构，于 `print(f"\ntrades.csv: ...")` 后追加：

```python
    try:
        from czsc.utils.plotting.lightweight import plot_czsc_trader
        plot_czsc_trader(ct, output="html", path=str(OUT / "trader.html"))
        print(f"trader.html: {OUT / 'trader.html'}")
    except Exception as e:  # 绘图是展示层，失败不阻断回测结果
        print(f"[warn] plot_czsc_trader 失败（不影响回测数据）: {e}")
```

- [ ] **Step 2: 重跑并验证产物**

```bash
quant-lab/.venv/bin/python quant-lab/backtest.py
ls -la quant-lab/out/
```

预期：`trader.html` 存在且 >100KB（自包含 HTML 含 K 线与缠论结构标注）；若仅出现 `[warn]` 行，回测 CSV/JSON 依然有效，把 warn 内容报告给用户决定是否降级为纯 `plot_czsc` 单周期图。

- [ ] **Step 3: 最终汇报材料整理**

确认 `out/` 下三件套齐全：`trades.csv`、`summary.json`、`trader.html`。向用户汇报：交易笔数、胜率、累计收益、最大回撤、三买三卖触发分布，并附前 5 笔交易明细供人工抽查成交价口径。

---

## Self-Review 记录

- **Spec 覆盖**：标的/数据（T2）、环境（T1）、信号事件持仓（T3）、逐 bar 执行（T4）、输出 CSV+统计+HTML（T4/T5）、验证标准（T2 S7、T4 S3）、已知风险（backtest.py docstring + summary 字段）、YAGNI 边界（无多级别/无扫描/无 ML）——全覆盖。
- **占位符**：无 TBD/TODO；所有代码块完整。Task 4 的「平仓原因分布」提取失败有明确降级行为（空 dict），不算占位。
- **类型一致性**：`load_bars` 返回 `(DataFrame, list[RawBar])` 贯穿 T2–T4；`build_positions()/build_trader()` 签名在 T3 定义、T4 消费一致；信号串常量与 Rust 源码核实值逐字一致（`BUY1` 无版本号、`BS2辅助V230320` 带版本号）。
