#!/usr/bin/env python3
"""独立读取SQLite核验探索结果；不调用TypeScript指标实现。"""
import csv
import json
import math
import sqlite3
from collections import defaultdict
from datetime import date, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "报告" / "缠论策略探索_20261115"
BASE = ROOT / "报告" / "缠论策略回测_20261115"
DB = Path("/Users/admin/WorkSpace/baostock_data/data/baostock.db")
TOL = 1e-8

checks = []
def check(name, errors, count, examples=None):
    checks.append({"检查项": name, "检查数量": count, "错误数": len(errors), "示例": (examples or errors)[:5]})

def different(a, b, tol=TOL):
    if a is None or b is None:
        return a != b
    return not math.isclose(float(a), float(b), rel_tol=tol, abs_tol=tol)

def mean(values):
    return sum(values) / len(values)

def trend(closes, window):
    if len(closes) < window + 1:
        return None
    current = mean(closes[-window:])
    previous = mean(closes[-window-1:-1])
    return closes[-1] > current and current > previous

def lookback(closes, window):
    return closes[-1] / closes[-1-window] - 1 if len(closes) > window else None

def week_key(value):
    day = date.fromisoformat(value)
    return (day - timedelta(days=day.weekday())).isoformat()

def main():
    result = json.loads((OUT / "探索账户结果.json").read_text())
    features = json.loads((OUT / "探索特征汇总.json").read_text())
    records = features["records"]
    summaries = result["summaries"]
    audit = result["audit"]
    conn = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    conn.execute("PRAGMA busy_timeout=5000")

    errors = []
    if len(records) != audit["candidateCount"]:
        errors.append(f"特征{len(records)} != 候选{audit['candidateCount']}")
    if len(summaries) != audit["accountScenarioCount"]:
        errors.append(f"场景{len(summaries)} != 审计{audit['accountScenarioCount']}")
    check("结果数量与审计一致", errors, 2)

    errors = []
    timing_count = 0
    for r in records:
        for level in ("weeklyPoint", "monthlyPoint"):
            end = r[level]["periodEndDate"]
            if end is not None and end > r["signalDate"]:
                errors.append(f"{r['code']} {r['signalDate']} {level}={end}")
        for key, plan in r["exitPlans"].items():
            timing_count += 1
            signal = plan["signalDate"]
            exit_date = plan["date"]
            if signal is not None and signal < r["entryDate"]:
                errors.append(f"{r['code']} {key}触发早于入场")
            if exit_date is not None and (signal is None or exit_date <= signal or exit_date > audit["config"]["endDate"]):
                errors.append(f"{r['code']} {key}离场时间错误")
        for field in ("volumePrimary", "volumeSecondary"):
            value = r[field]
            if value is not None and (not math.isfinite(value) or value <= 0):
                errors.append(f"{r['code']} {field}={value}")
    check("周月截止、离场时序与量能有限性", errors, timing_count + len(records) * 2)

    errors = []
    for r in records:
        raw = conn.execute("SELECT close FROM stock_kline_d WHERE code=? AND adjustflag=3 AND date=?", (r["code"], r["signalDate"])).fetchone()
        hfq = conn.execute("SELECT close FROM stock_kline_d WHERE code=? AND adjustflag=1 AND date=?", (r["code"], r["signalDate"])).fetchone()
        if r["structureLevelRaw"] is None:
            continue
        if not raw or not hfq or not raw[0] or not hfq[0]:
            errors.append(f"{r['code']} {r['signalDate']}缺复权来源")
            continue
        expected = r["structureLevelRaw"] * hfq[0] / raw[0]
        if different(expected, r["structureLevel"], 1e-9):
            errors.append(f"{r['code']} 结构位{expected}!={r['structureLevel']}")
    check("全部结构位按信号日复权因子换算", errors, len(records))

    step = max(1, len(records) // 160)
    sample = records[::step][:160]
    index_rows = conn.execute("SELECT date,close FROM index_kline_d WHERE code='sh.000001' ORDER BY date").fetchall()
    index_position = {row[0]: i for i, row in enumerate(index_rows)}
    index_all_closes = [row[1] for row in index_rows]
    errors = []
    indicator_checks = 0
    for r in sample:
        rows = conn.execute("SELECT date,close FROM stock_kline_d WHERE code=? AND adjustflag=1 AND trade_status=1 AND high>0 AND low>0 AND close>0 AND date<=? ORDER BY date DESC LIMIT 260", (r["code"], r["signalDate"])).fetchall()[::-1]
        closes = [row[1] for row in rows]
        for window in (20, 60, 120, 250):
            expected = trend(closes, window)
            actual = r["dailyTrend"].get(str(window))
            indicator_checks += 1
            if expected != actual:
                errors.append(f"{r['code']} {r['signalDate']} MA{window}:{expected}!={actual}")
        index_closes = index_all_closes[:index_position[r["signalDate"]] + 1] if r["signalDate"] in index_position else []
        for window in (20, 60, 120):
            expected_stock = lookback(closes, window)
            expected_index = lookback(index_closes, window)
            actual = r["stockReturn"].get(str(window))
            indicator_checks += 1
            if different(expected_stock, actual):
                errors.append(f"{r['code']} {r['signalDate']} 个股收益{window}:{expected_stock}!={actual}")
            if expected_index is None and actual is not None:
                errors.append("指数历史不足但个股特征异常")
    check("独立重算抽样日线趋势与个股收益", errors, indicator_checks)

    calendar_rows = conn.execute("SELECT calendar_date FROM trade_dates WHERE is_trading_day=1 AND calendar_date>='1990-01-01' ORDER BY calendar_date").fetchall()
    period_ends = {"week": defaultdict(str), "month": defaultdict(str)}
    for (day,) in calendar_rows:
        period_ends["week"][week_key(day)] = day
        period_ends["month"][day[:7]] = day
    errors = []
    period_checks = 0
    for r in sample[::4]:
        rows = conn.execute("SELECT r.date,h.close FROM stock_kline_d r JOIN stock_kline_d h ON h.code=r.code AND h.date=r.date AND h.adjustflag=1 WHERE r.code=? AND r.adjustflag=3 AND r.trade_status=1 AND r.high>0 AND r.low>0 AND r.close>0 AND r.date<=? ORDER BY r.date", (r["code"], r["signalDate"])).fetchall()
        for unit, windows, field in (("week", (5, 10, 20, 60), "weeklyTrend"), ("month", (3, 6, 12, 24), "monthlyTrend")):
            groups = defaultdict(list)
            for day, close in rows:
                key = week_key(day) if unit == "week" else day[:7]
                groups[key].append(close)
            last_key = week_key(calendar_rows[-1][0]) if unit == "week" else calendar_rows[-1][0][:7]
            periods = sorted((period_ends[unit][key], values[-1]) for key, values in groups.items() if key != last_key and period_ends[unit].get(key, "") <= r["signalDate"] and period_ends[unit].get(key))
            closes = [value for _, value in periods]
            for window in windows:
                expected = trend(closes, window)
                actual = r[field].get(str(window))
                period_checks += 1
                if expected != actual:
                    errors.append(f"{r['code']} {r['signalDate']} {unit}{window}:{expected}!={actual}")
    check("独立聚合抽样已完成周线月线趋势", errors, period_checks)

    errors = []
    for row in summaries:
        expected = row["初始资金"] + row["已实现盈亏"] + row["未实现盈亏"]
        if different(expected, row["期末权益"], 1e-6):
            errors.append(f"{row['实验ID']} {row['买点类别']} {row['离场规则']}:{expected}!={row['期末权益']}")
    check("全部账户期末权益与已实现未实现独立相加", errors, len(summaries))

    exit_names = {"any-sell": "任一确认卖点", "same-class-sell": "同类确认卖点", "hold-20": "持有20个市场交易日", "hold-60": "持有60个市场交易日"}
    with (BASE / "账户场景汇总.csv").open(encoding="utf-8-sig") as handle:
        original = {(int(row["买点类别"][0]), row["离场规则"]): row for row in csv.DictReader(handle) if row["样本"] == "2010—2026纯日线" and row["共振过滤"] == "无共振过滤"}
    errors = []
    baseline = [row for row in summaries if row["实验ID"] == "baseline"]
    for row in baseline:
        other = original.get((row["买点类别"], exit_names[row["离场规则"]]))
        if not other:
            errors.append(f"缺原基线{row['实验ID']}")
        elif different(row["期末权益"], other["期末权益(元)"], 1.1e-4):
            errors.append(f"{row['买点类别']}{row['离场规则']}:{row['期末权益']}!={other['期末权益(元)']}")
    check("探索基线与原回测十二账户一致", errors, len(baseline))

    errors = []
    path_count = 0
    with (OUT / "信号路径诊断.csv").open(encoding="utf-8-sig") as handle:
        for row in csv.DictReader(handle):
            path_count += 1
            for horizon in (20, 60):
                ret = row[f"后复权{horizon}日收益_未扣费"]
                mfe = row[f"{horizon}日最大有利变动"]
                mae = row[f"{horizon}日最大不利变动"]
                if not ret:
                    continue
                ret, mfe, mae = float(ret), float(mfe), float(mae)
                if ret <= -1 or mfe + 1e-10 < ret or mae - 1e-10 > ret or mae <= -1:
                    errors.append(f"{row['股票代码']} {row['信号日期']} {horizon}路径关系错误")
    check("全部路径收益与MFE/MAE关系及价格下界", errors, path_count * 2)

    payload = {
        "核验时间": date.today().isoformat(),
        "数据源": str(DB),
        "候选数": len(records),
        "账户场景数": len(summaries),
        "日线指标抽样数": len(sample),
        "周月指标抽样数": len(sample[::4]),
        "检查": checks,
        "总错误数": sum(item["错误数"] for item in checks),
        "限制": "高周期缠论点由同一引擎产生，本次独立脚本核验其时点但不重实现结构识别；路径诊断未扣费且不代表可成交收益。",
    }
    (OUT / "探索独立核验.json").write_text(json.dumps(payload, ensure_ascii=False, indent=2))
    print(json.dumps({"总错误数": payload["总错误数"], "检查": [{"检查项": x["检查项"], "错误数": x["错误数"]} for x in checks]}, ensure_ascii=False, indent=2))
    conn.close()
    raise SystemExit(1 if payload["总错误数"] else 0)

if __name__ == "__main__":
    main()
