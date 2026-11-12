# -*- coding: utf-8 -*-
"""Python↔TS 交叉核验。

只读取 baostock 真实样本（10 股票×3 复权 + 2 指数，各 500 根，过滤停牌），
对同一口径矩阵分别跑 Python 参考管线与 TS 引擎，逐根事件/状态 diff，要求 0 diff。
产出 报告/交叉核验.json。用法：python3 tools/cross_check.py
"""
import json
import sqlite3
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DB = '/Users/admin/WorkSpace/baostock_data/data/baostock.db'
REPORT = ROOT / '报告'
sys.path.insert(0, str(ROOT / 'tools'))
from reference_pipeline import compute as py_compute  # noqa: E402

BASE = {'startDir': 'up', 'precision': {'digits': 'raw'}, 'biRule': '77课', 'mergeDir': '回找非包含',
        'touchOverlap': '相接算重叠', 'segMerge': '做包含处理',
        'centerUnit': '线段中枢', 'centerUpgrade': '9段升级', 'trendOverlap': '核心不重叠', 'divMetric': 'MACD面积',
        'bsp3Touch': '不跌破ZG', 'bsp2Filter': '允许二买低于一买'}
CONFIGS = [
    dict(BASE),
    {**BASE, 'startDir': 'down'},
    {**BASE, 'precision': {'digits': 0}},
    {**BASE, 'precision': {'digits': 2}, 'biRule': '社区老笔'},
    {**BASE, 'biRule': '社区新笔'},
    {**BASE, 'mergeDir': '直接用前一根'},
    {**BASE, 'touchOverlap': '须严格重叠'},
    {**BASE, 'segMerge': '不做包含处理'},
    {**BASE, 'centerUnit': '笔中枢'},
    {**BASE, 'centerUpgrade': '不自动升级'},
    {**BASE, 'trendOverlap': '外围也不重叠'},
    {**BASE, 'divMetric': '中枢视角几何'},
    {**BASE, 'centerUnit': '笔中枢', 'divMetric': '中枢视角几何'},
    {**BASE, 'centerUnit': '笔中枢', 'divMetric': 'MACD面积'},
    {**BASE, 'bsp3Touch': '不触及ZG'},
    {**BASE, 'bsp2Filter': '过滤二买须高于一买'},
]


def load_samples():
    con = sqlite3.connect(f'file:{DB}?mode=ro', uri=True)
    con.row_factory = sqlite3.Row
    samples = []
    active = [r['code'] for r in con.execute("SELECT code FROM stock_basic WHERE type=1 AND status=1 ORDER BY code LIMIT 8")]
    delisted = [r['code'] for r in con.execute("SELECT code FROM stock_basic WHERE type=1 AND status=0 ORDER BY code LIMIT 2")]
    for code in active + delisted:
        for adj in (1, 2, 3):
            rows = con.execute(
                "SELECT date, high, low, close FROM stock_kline_d WHERE code=? AND adjustflag=? AND trade_status=1 ORDER BY date DESC LIMIT 500",
                (code, adj)).fetchall()
            bars = [{'date': r['date'], 'high': r['high'], 'low': r['low'], 'close': r['close']} for r in reversed(rows)]
            samples.append({'code': code, 'adjust': str(adj), 'bars': bars})
    for code in ('sh.000001', 'sz.399006'):
        rows = con.execute("SELECT date, high, low, close FROM index_kline_d WHERE code=? ORDER BY date DESC LIMIT 500", (code,)).fetchall()
        bars = [{'date': r['date'], 'high': r['high'], 'low': r['low'], 'close': r['close']} for r in reversed(rows)]
        samples.append({'code': code, 'adjust': 'index', 'bars': bars})
    con.close()
    return samples


def deep_diff(a, b, path='$', out=None):
    if out is None:
        out = []
    if len(out) >= 20:
        return out
    if isinstance(a, dict) and isinstance(b, dict):
        for k in sorted(set(a) | set(b)):
            if k not in a:
                out.append(f'{path}.{k}: 仅TS有')
            elif k not in b:
                out.append(f'{path}.{k}: 仅Python有')
            else:
                deep_diff(a[k], b[k], f'{path}.{k}', out)
    elif isinstance(a, list) and isinstance(b, list):
        if len(a) != len(b):
            out.append(f'{path}: 长度 Python={len(a)} TS={len(b)}')
        for i in range(min(len(a), len(b))):
            deep_diff(a[i], b[i], f'{path}[{i}]', out)
    elif isinstance(a, (int, float)) and isinstance(b, (int, float)):
        if abs(a - b) > 1e-9:
            out.append(f'{path}: Python={a} TS={b}')
    else:
        if a != b:
            out.append(f'{path}: Python={a!r} TS={b!r}')
    return out


def main():
    REPORT.mkdir(exist_ok=True)
    samples = load_samples()
    in_path = REPORT / '交叉核验_输入.json'
    ts_path = REPORT / '交叉核验_TS输出.json'
    in_path.write_text(json.dumps({'samples': samples, 'configs': CONFIGS}, ensure_ascii=False), encoding='utf-8')

    print(f'样本 {len(samples)} 组 × 口径 {len(CONFIGS)} = {len(samples) * len(CONFIGS)} 组结果')
    print('运行 TS 引擎导出…')
    r = subprocess.run(['npx', 'tsx', 'packages/engine/scripts/exportResults.ts', str(in_path), str(ts_path)],
                       cwd=ROOT, capture_output=True, text=True)
    if r.returncode != 0:
        print('TS 导出失败：', r.stderr)
        sys.exit(1)
    print(r.stdout.strip())
    ts_results = json.loads(ts_path.read_text(encoding='utf-8'))['results']
    ts_index = {(x['code'], x['adjust'], x['configId']): x for x in ts_results}

    total = 0
    failed = 0
    details = []
    for s in samples:
        for cfg in CONFIGS:
            total += 1
            py = py_compute(s['bars'], cfg)
            key = (s['code'], s['adjust'], py['configId'])
            ts = ts_index.get(key)
            if ts is None:
                failed += 1
                details.append({'样本': key, '问题': 'TS 结果缺失'})
                continue
            diffs = []
            for field in ('validBars', 'fractals', 'bis', 'segments', 'centers', 'trends', 'divergences', 'points', 'events'):
                diffs += deep_diff(py[field], ts[field], field)
            if py['configId'] != ts['configId']:
                diffs.append(f'configId: Python={py["configId"]} TS={ts["configId"]}')
            if diffs:
                failed += 1
                details.append({'样本': list(key), '差异数': len(diffs), '差异': diffs})

    report = {
        '样本组数': len(samples),
        '口径数': len(CONFIGS),
        '核验组数': total,
        '通过': total - failed,
        '失败': failed,
        '全部通过': failed == 0,
        '明细': details,
    }
    (REPORT / '交叉核验.json').write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding='utf-8')
    print(f'交叉核验：{total - failed}/{total} 通过，{failed} 失败 → 报告/交叉核验.json')
    if failed:
        for d in details[:3]:
            print(json.dumps(d, ensure_ascii=False)[:500])
        sys.exit(1)


if __name__ == '__main__':
    main()