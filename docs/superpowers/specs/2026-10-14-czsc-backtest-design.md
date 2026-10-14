# czsc 买卖点历史回测（quant-lab）设计文档

日期：2026-10-14
状态：已批准（用户口头确认设计 5 节内容）

## 背景与目标

用户在学缠论（本仓库为教材《教你炒股票108课》），想知道 czsc（waditu/czsc，Apache-2.0）
的买卖点规则在 A 股真实历史上到底盈不盈利。第一版 = **单票、日线、多头方向的
事件驱动历史回测**，输出交易明细 + 盈亏统计 + 带标注的K线图。

与 MISSION.md 的关系：MISSION 把"量化编程/自动化交易"列为 out of scope，本任务是用户
2026-10-14 明确要求新增的 side project，属对 MISSION 范围的扩展（验证交易系统有效性
本就是 MISSION 的 Success 标准之一）。本目录不复用教学站代码（assets/charts.js 为
硬编码坐标，无计算逻辑）。

## 方案选择

- 采用**方案B：直接跑官方 Python czsc**（用户选定），放弃 Node 移植（方案A）与
  完整信号体系移植（方案C）。
- 数据源：同花顺 `hithink-finance` CLI（已认证可用，`market.history` 支持
  `--adjust none|forward|backward`，窗口十年）。

## 标的与数据

- 标的：贵州茅台 `600519.SH`，窗口 2016-10 ~ 2026-10（覆盖 2019–21 主升、
  2021–24 下跌震荡、2024 后修复的完整牛熊）。
- 链路：`hithink-finance market history --thscode 600519.SH --adjust forward`
  → JSON 落盘 `quant-lab/data/600519.SH.daily.json` → pandas →
  `czsc.format_standard_kline` → `RawBar` 列表。
- 复权方式：**前复权（forward）**，接受其未来函数口子（见"已知风险"）。

## 环境

- 目录：`quant-lab/`（本仓库内新建）
  - `quant-lab/.venv/` 虚拟环境（Python 3.13，不动系统环境）
  - `quant-lab/data/` 行情数据 JSON
  - `quant-lab/fetch_data.sh` 数据拉取脚本（封装 hithink-finance 调用）
  - `quant-lab/backtest.py` 回测主脚本
  - `quant-lab/out/` 回测输出（交易明细 CSV、HTML 图）
- 依赖：`czsc`（PyPI 预编译 wheel）、`pandas`。

## 信号与交易规则（日线单级别）

- 分析对象：`czsc.CZSC`（Freq.D），**逐 bar 流式推进**（不允许一次性全量算信号）。
- 开仓事件（任一命中，下一规则见执行）：
  - 一买 `cxt_first_buy_V221126`
  - 二买 `cxt_second_bs_V230320`
  - 三买 `cxt_third_bs_V230318`
- 平仓事件：
  - 对应卖侧信号（一卖/二卖/三卖，具体信号名以 czsc 1.0.x 实际注册名为准，
    实施时先列出 `signals.cxt` 可用信号再定）
  - 固定止损：-500 BP（约 -5%，相对开仓价）
  - 超时：持仓满 250 根日K强制平仓
- 方向：仅多头；仓位：全仓进出（单笔盈亏按百分比计，不含手续费；手续费留
  `FEE_RATE` 常量默认 0，后续可开）。

## 执行与成交规则（防未来函数）

- 每根K线收盘后 `update` CZSC → 计算信号 → 信号确认**当根收盘**即为成交价，
  严禁回填到分型所在K线成交。
- 前复权数据自带的复权因子未来信息为已知口子，报告注明。

## 输出

1. `out/trades.csv`：每笔交易的开平仓时间/价格/盈亏%/触发信号/持仓K线数
2. 控制台统计：交易笔数、胜率、总收益、盈亏比、最大回撤
3. `out/trades.html`：czsc `plot_czsc_trader` 产出的带买卖点标注K线图

## 验证标准

- 脚本能一次性跑完 10 年数据，无异常退出
- 交易明细每笔都有明确的触发信号名；抽查 3 笔，成交价 = 信号确认K线收盘价
- 统计数字与 trades.csv 自洽（胜率、总收益可由明细复算）

## 已知风险与边界

1. 前复权 = 用未来分红送股回改历史价 → 价格绝对值类规则有轻微未来信息；形态类不受影响
2. 信号为"回看 ≤50 笔"的局部形态识别，回测结果偏乐观，仅作系统有效性初筛，
   不构成实盘依据
3. 不含仓位管理、手续费、滑点；卖出信号集以 czsc 实际提供的为准
4. 若 `pip install czsc` 无 cp313 wheel 导致构建失败，降级为方案A（Node 移植核心规则），
   需重新与用户确认

## 不做的事（YAGNI）

- 多级别联立、周线/分钟线
- 批量扫描自选股
- 机器学习因子、信号优化
- 自动交易/实盘接入
