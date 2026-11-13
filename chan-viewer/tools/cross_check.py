# -*- coding: utf-8 -*-
"""只读真实 512 矩阵 + 显式 test fixtures；完整 Python↔TS diff 与独立黄金门禁。"""
import json
import math
import sqlite3
import subprocess
import sys
from copy import deepcopy
from datetime import datetime, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DB = '/Users/admin/WorkSpace/baostock_data/data/baostock.db'
MIN_DB = '/Users/admin/WorkSpace/baostock_data/data/baostock_min.db'
REPORT = ROOT / '报告'
sys.dont_write_bytecode = True
sys.path.insert(0, str(ROOT / 'tools'))
import reference_pipeline as ref  # noqa: E402

BASE = {'startDir': 'up', 'precision': {'digits': 'raw'}, 'biRule': '77课', 'mergeDir': '回找非包含',
        'touchOverlap': '相接算重叠', 'segMerge': '做包含处理',
        'centerUnit': '线段中枢', 'centerUpgrade': '9段升级', 'trendOverlap': '核心不重叠', 'divMetric': 'MACD面积',
        'bsp3Touch': '不跌破ZG', 'bsp2Filter': '允许二买低于一买'}
# 原矩阵逐项保留（含原先同值口径），不可以去重/缩短样本代替验证。
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
STRUCTURES = {'fractal': 'fractals', 'bi': 'bis', 'segment': 'segments', 'center': 'centers',
              'trend': 'trends', 'divergence': 'divergences', 'point': 'points'}


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
    assert len(samples) == 32 and len(CONFIGS) == 16
    return samples


def walk(seed, n):
    """engine prefixProperties.spec.ts 的 mulberry32 和价格生成规则；不使用 TS 输出。"""
    a = seed & 0xffffffff

    def rnd():
        nonlocal a
        a = (a + 0x6d2b79f5) & 0xffffffff
        t = ((a ^ (a >> 15)) * (1 | a)) & 0xffffffff
        t = ((t + (((t ^ (t >> 7)) * (61 | t)) & 0xffffffff)) ^ t) & 0xffffffff
        return ((t ^ (t >> 14)) & 0xffffffff) / 4294967296

    out, mid, drift = [], 100, 0
    for i in range(n):
        if i % 20 == 0:
            drift = (rnd() - 0.5) * 3
        mid += drift + (rnd() - 0.5) * 4
        width = 0.5 + rnd() * 4
        out.append({'date': str(i), 'low': mid - width / 2, 'high': mid + width / 2, 'close': mid})
    return out


def test_minutes(n=1450):
    # 人工时间/价格 fixture 明确标 test；不宣称是数据库真实来源。
    bars = walk(42, n)
    start = datetime(2026, 9, 1, 9, 35)
    for i, b in enumerate(bars):
        b['date'] = (start + timedelta(minutes=5 * i)).strftime('%Y-%m-%d %H:%M:%S')
        end = ref.bar_known_at(b)
        b['time'] = {'endMs': end, 'coverage': [{'startMs': end - 300000, 'endMs': end}],
                     'complete': True, 'quality': 'verified', 'continuityId': 'test-run'}
    return bars


def real_minutes():
    con = sqlite3.connect(f'file:{MIN_DB}?mode=ro', uri=True)
    con.row_factory = sqlite3.Row
    rows = con.execute('SELECT time, high, low, close FROM stock_kline_5m WHERE code=? AND adjustflag=3 ORDER BY time', ('sh.600000',)).fetchall()
    con.close()
    assert rows, '只读分钟库无浦发银行数据'
    dcon = sqlite3.connect(f'file:{DB}?mode=ro', uri=True)
    days = [r[0] for r in dcon.execute('SELECT date FROM stock_kline_d WHERE code=? AND adjustflag=3 AND trade_status=1 AND date BETWEEN ? AND ? ORDER BY date',
                                      ('sh.600000', rows[0]['time'][:10], rows[-1]['time'][:10]))]
    dcon.close()
    expected = []
    for day in days:
        for hour, minute in ((9, 30), (13, 0)):
            start = datetime.fromisoformat(day).replace(hour=hour, minute=minute)
            expected.extend((start + timedelta(minutes=5 * k)).strftime('%Y-%m-%d %H:%M:%S') for k in range(1, 25))
    positions = {date: i for i, date in enumerate(expected)}
    bars, previous, cont, gaps = [], None, 0, 0
    for r in rows:
        b = {'date': r['time'], 'high': r['high'], 'low': r['low'], 'close': r['close']}
        pos = positions.get(b['date'])
        if previous is not None and (pos is None or pos != previous + 1):
            cont += 1
            gaps += 1
        end = ref.bar_known_at(b)
        complete = pos is not None and all(ref.finite(b[k]) for k in ('high', 'low', 'close'))
        b['time'] = {'endMs': end, 'coverage': [{'startMs': end - 300000, 'endMs': end}],
                     'complete': complete, 'quality': 'verified' if complete else 'unknown',
                     'continuityId': f'db5m:{cont}'}
        bars.append(b)
        previous = pos
    return bars, {'数据库': MIN_DB, '原始根数': len(bars), '正常交易日证据数': len(days), '预期缺口边界数': gaps,
                  '可信源柱数': sum(b['time']['quality'] == 'verified' for b in bars),
                  '未知源柱数': sum(b['time']['quality'] == 'unknown' for b in bars),
                  '范围': [bars[0]['date'], bars[-1]['date']],
                  '覆盖声明': '按已入库5分钟源柱和股票正常交易日/session推导，不证明5分钟柱内部逐笔完整性'}


def extra_samples():
    healthy = test_minutes()
    variants = {'full': healthy}
    bad = deepcopy(healthy)
    bad[120]['time']['complete'] = False
    # 故意保留 verified 标签，验证 false 不能被覆盖。
    variants['missing-root'] = bad
    unknown = deepcopy(healthy)
    unknown[120]['time']['quality'] = 'unknown'
    variants['reused-continuity'] = unknown
    bucket = deepcopy(healthy[:120] + healthy[126:])
    for b in bucket[120:]:
        b['time']['continuityId'] = 'test-after-bucket'
    variants['missing-bucket'] = bucket
    no_close = deepcopy(healthy)
    del no_close[120]['close']
    variants['missing-close'] = no_close
    for label, field, value in [('all-incomplete', 'complete', False), ('all-unknown', 'quality', 'unknown'), ('empty-coverage', 'coverage', [])]:
        bars = deepcopy(healthy[:600])
        for b in bars:
            b['time'][field] = value
        variants[label] = bars
    out = [{'code': f'test:minute:{label}', 'adjust': 'test', 'bars': bars} for label, bars in variants.items()]
    for seed, lengths in ((42, (370, 371, 1194, 1195, 1450)), (1, (370, 371, 1450))):
        bars = walk(seed, 1450)
        out.extend({'code': f'test:seed{seed}:{n}', 'adjust': 'test', 'bars': bars[:n], 'configIndices': [8, 12]} for n in lengths)
    minute_bars, metadata = real_minutes()
    out.append({'code': 'sh.600000', 'adjust': 'db5m-3', 'bars': minute_bars})
    cutoff = healthy[700]['time']['endMs']
    out.append({'code': 'test:minute:asOf', 'adjust': 'test', 'bars': healthy, 'configIndices': [8, 12], 'asOfMs': cutoff})
    return out, metadata


def deep_diff(a, b, path='$', out=None):
    if out is None:
        out = []
    if len(out) >= 50:
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
    elif ref.finite(a) and ref.finite(b):
        if abs(a - b) > 1e-9:
            out.append(f'{path}: Python={a} TS={b}')
    elif type(a) != type(b) or a != b:
        out.append(f'{path}: Python={a!r} TS={b!r}')
    return out


def covered_fields(x, path='$', out=None):
    if out is None:
        out = set()
    out.add(path)
    if isinstance(x, dict):
        for k, v in x.items():
            covered_fields(v, f'{path}.{k}', out)
    elif isinstance(x, list):
        for v in x:
            covered_fields(v, f'{path}[*]', out)
    return out


def evidence_errors(r):
    """对两实现分别核验身份/引用/闭合，而不仅让两个相同错误互相匹配。"""
    out, by_key, by_kind = [], {}, {k: {} for k in STRUCTURES}
    id_by_key = {}
    for kind, field in STRUCTURES.items():
        lists = [r[field]]
        if kind in ('center', 'trend'):
            lists += [l[field] for l in r['levels']]
        for items in lists:
            if len({x['id'] for x in items}) != len(items) or len({x['key'] for x in items}) != len(items):
                out.append(f'{field}: 同一快照 id/key 不唯一')
            for x in items:
                old = by_kind[kind].get(x['id'])
                if old is not None and old['key'] != x['key']:
                    out.append(f"{kind}: id={x['id']} 对应多个key")
                old_id = id_by_key.get((kind, x['key']))
                if old_id is not None and old_id != x['id']:
                    out.append(f"{kind}: 同一key对应不同id")
                id_by_key[(kind, x['key'])] = x['id']
                by_kind[kind][x['id']] = x
                by_key[x['key']] = x
    for x in by_key.values():
        if any(k not in x for k in ('key', 'continuityId', 'dependencyKeys', 'quality')) or not x.get('dependencyKeys'):
            out.append(f"{x['key']}: 生产结构缺来源/依赖字段")
        confirmed = x['status'] == 'confirmed'
        if confirmed and (x.get('quality') != 'verified' or not ref.finite(x.get('confirmedAt'))):
            out.append(f"{x['key']}: confirmed缺首知时间/可信质量")
        elif confirmed and (int(x['confirmedAt']) != x['confirmedAt'] or not 0 <= x['confirmedAt'] < r['inputCount']):
            out.append(f"{x['key']}: confirmedAt不是有效全局raw下标")
        for key in x.get('dependencyKeys', []):
            if key.startswith('raw:'):
                cont, idx = key[4:].rsplit(':', 1)
                src = r['sourceEvidence'][int(idx)] if 0 <= int(idx) < r['inputCount'] else None
                if src is None or src['continuityId'] != cont or not src['complete'] or src['quality'] != 'verified':
                    out.append(f"{x['key']}: raw依赖不可信 {key}")
                if confirmed and int(idx) > x['confirmedAt']:
                    out.append(f"{x['key']}: raw依赖晚于确认 {key}")
            else:
                dep = by_key.get(key)
                if dep is None:
                    out.append(f"{x['key']}: 依赖不可解析 {key}")
                elif dep['continuityId'] != x['continuityId']:
                    out.append(f"{x['key']}: 跨连续段依赖 {key}")
                elif confirmed and (dep['status'] != 'confirmed' or dep['confirmedAt'] > x['confirmedAt']):
                    out.append(f"{x['key']}: 确认依赖未闭合 {key}")
    for b in r['bis']:
        for id_ in (b['start'], b['end']):
            if id_ not in by_kind['fractal']:
                out.append(f"bi:{b['id']}: 分型引用不存在")
    for s in r['segments']:
        for id_ in (s['startFx'], s['endFx']):
            if id_ not in by_kind['fractal']:
                out.append(f"segment:{s['id']}: 分型引用不存在")
    for t in by_kind['trend'].values():
        for id_ in t['centerIds']:
            if id_ not in by_kind['center']:
                out.append(f"trend:{t['id']}: 中枢引用不存在")
    for p in r['points']:
        target = by_kind.get(p['refKind'], {}).get(p.get('refId'))
        if target is None or target['key'] != p['refKey']:
            out.append(f"point:{p['id']}: typed ref不解析")
    if r['inputCount'] != len(r['sourceEvidence']):
        out.append('inputCount/sourceEvidence未对齐')
    for field in ('dif', 'dea', 'hist'):
        if 'macd' in r and len(r['macd'][field]) != r['inputCount']:
            out.append(f'macd.{field}: raw未对齐')
    return out[:50]


def golden_fixtures():
    fixtures, checks = [], []

    def add(name, kind, args, predicate):
        fixtures.append({'name': f'test:{name}', 'kind': kind, 'args': args})
        checks.append((f'test:{name}', predicate))

    ev = {'continuityId': 'golden', 'quality': 'verified'}
    units = [{**ev, 'key': f'unit:{i}', 'low': low, 'high': high, 'startRaw': i * 5 + 11,
              'endRaw': i * 5 + 16, 'dir': 'up' if i % 2 == 0 else 'down', 'confirmedAt': at}
             for i, (low, high, at) in enumerate([(10, 14, 22), (11, 15, 28), (12, 16, 36), (30, 36, 45), (40, 46, 52)])]
    add('formed-time', 'centers', [units, BASE], lambda x: len(x) == 1 and
        [x[0]['formedRaw'], x[0]['formedAt'], x[0]['terminatedRaw'], x[0]['terminatedAt'], x[0]['confirmedAt']] == [26, 36, 36, 52, 52]
        and x[0]['dependencyKeys'] == [u['key'] for u in units])
    add('formed-seed-key', 'centers', [units[:3], BASE], lambda x: x[0]['key'] == 'ctr:golden:segment:unit:0|unit:1|unit:2' and x[0]['formedAt'] == 36)
    split = [{**u, 'continuityId': 'a' if i < 2 else 'b'} for i, u in enumerate(units[:4])]
    add('no-cross-cont-center', 'centers', [split, BASE], lambda x: x == [])
    add('unfinished-center', 'centers', [units[:-1] + [{**units[-1], 'confirmedAt': None}], BASE],
        lambda x: x[0]['status'] == 'candidate' and x[0]['quality'] == 'unknown')

    def center(id_, start, end):
        return {**ev, 'id': id_, 'key': f'center:{id_}', 'unit': 'segment', 'dir': 'up', 'startRaw': start, 'endRaw': end,
                'ZG': 14, 'ZD': 10, 'GG': 15, 'DD': 9, 'G': 14, 'D': 10, 'segCount': 3, 'degree': 1,
                'formedAt': end + 5, 'formedRaw': end, 'terminatedAt': end + 15, 'terminatedRaw': end + 10,
                'evolution': 'terminated', 'status': 'confirmed', 'confirmedAt': end + 15, 'dependencyKeys': [f'unit:{id_}:1']}

    def movement(id_, dir_, start, end, low, high, at):
        return {**ev, 'id': id_, 'key': f'movement:{id_}', 'dir': dir_, 'startFx': id_, 'endFx': id_ + 1,
                'startRaw': start, 'endRaw': end, 'low': low, 'high': high, 'status': 'confirmed', 'confirmedAt': at,
                'dependencyKeys': [f'bi:{id_}']}

    c = {**center(1, 0, 5), 'ZG': 13, 'confirmedAt': 22}
    movs = [movement(1, 'up', 6, 8, 10, 14, 19), movement(2, 'down', 8, 10, 13, 13.5, 25)]
    bars = [{'date': str(i), 'low': 9 + i * 0.1, 'high': 10 + i * 0.1, 'close': 9.5 + i * 0.1} for i in range(30)]
    add('completed-third-buy', 'points', [[], [c], [], [], bars, BASE, movs], lambda x: len(x) == 1 and
        (x[0]['klass'], x[0]['side'], x[0]['atRaw'], x[0]['price'], x[0]['confirmedAt'], x[0]['refKind']) == (3, 'buy', 10, 13, 25, 'center')
        and x[0]['dependencyKeys'] == ['center:1', 'movement:1', 'movement:2'])
    add('empty-production-no-fallback', 'points', [[], [c], [], [], bars, BASE, []], lambda x: x == [])
    add('third-buy-first-retest', 'points', [[], [c], [], [], bars, BASE,
        [movs[0], {**movs[1], 'low': 12}, movement(3, 'down', 11, 13, 14, 15, 26)]], lambda x: x == [])
    add('unknown-center-no-confirm', 'points', [[], [{**c, 'quality': 'unknown'}], [], [], bars, BASE, movs],
        lambda x: len(x) == 1 and x[0]['status'] == 'candidate')
    add('other-cont-no-point', 'points', [[], [c], [], [], bars, BASE, [{**m, 'continuityId': 'other'} for m in movs]], lambda x: x == [])
    d = {**ev, 'id': 1, 'key': 'div:gold', 'kind': '趋势背驰', 'metric': 'MACD面积', 'dir': 'down',
         'bStart': 0, 'bEnd': 2, 'cStart': 2, 'cEnd': 3, 'bForce': 3, 'cForce': 1, 'est': False,
         'status': 'confirmed', 'confirmedAt': 12, 'dependencyKeys': ['trend:gold']}
    second_movs = [movement(1, 'up', 4, 6, 9, 11, 20), movement(2, 'down', 6, 8, 8.8, 9.5, 28)]

    def second_check(x):
        first = next((p for p in x if p['klass'] == 1), None)
        second = next((p for p in x if p['klass'] == 2), None)
        return first is not None and second is not None and second['refKind'] == 'point' and second['refId'] == first['id'] != 0 and second['refKey'] == first['key'] and second['confirmedAt'] == 28

    add('second-buy-ref-key-id', 'points', [[d], [], [], [], bars, BASE, second_movs], second_check)
    add('first-needs-completed-turn', 'points', [[d], [], [], [], bars, BASE, []], lambda x: len(x) == 1 and x[0]['status'] == 'candidate')
    add('candidate-first-no-second', 'points', [[{**d, 'status': 'candidate', 'confirmedAt': None}], [], [], [], bars, BASE, second_movs],
        lambda x: all(p['status'] == 'candidate' and p['klass'] == 1 for p in x) and bool(x))

    prices = [10, 20, 10, 27, 21, 25, 15, 20, 18, 23]
    fxs = [{**ev, 'id': i + 1, 'key': f'fx:{i}', 'type': 'bottom' if i % 2 == 0 else 'top', 'middle': i,
            'price': p, 'midHigh': p, 'midLow': p, 'startRaw': i, 'endRaw': i, 'status': 'confirmed', 'confirmedAt': i,
            'dependencyKeys': [f'raw:golden:{i}']} for i, p in enumerate(prices)]
    bis = [{**ev, 'id': i + 1, 'key': f'bi:{i}', 'start': i + 1, 'end': i + 2, 'dir': 'up' if i % 2 == 0 else 'down',
            'status': 'confirmed', 'confirmedAt': 100 + i, 'dependencyKeys': [f'fx:{i}', f'fx:{i + 1}']} for i in range(9)]
    valid = [{'index': i, 'low': p, 'high': p, 'startRaw': i, 'endRaw': i} for i, p in enumerate(prices)]
    add('segment-second-sequence-close', 'segments', [bis, fxs, valid, BASE], lambda x: x[0]['status'] == 'confirmed' and x[0]['endRaw'] == 3 and x[0]['confirmedAt'] == 108 and x[0]['dependencyKeys'] == [b['key'] for b in bis])

    centers = [center(10, 20, 30), center(40, 60, 70)]
    trends = ref.detect_trends(centers, BASE)
    add('trend-close-successor', 'trends', [centers, BASE], lambda x: x[0]['confirmedAt'] == 85 and x[0]['dependencyKeys'] == ['center:10', 'center:40'])
    dbars = []
    for i in range(150):
        close = 100 + i if i < 20 else 120 if i < 30 else 120 + (i - 30) / 3 if i <= 45 else 110
        dbars.append({'date': str(i), 'low': close - 0.1, 'high': close + 0.1, 'close': close})
    entry = movement(1, 'up', 0, 20, 100, 130, 31)
    leave = movement(2, 'up', 30, 45, 100, 130, 95)
    geo = {**BASE, 'divMetric': '中枢视角几何'}
    add('divergence-closed-window', 'divergences', [trends, centers, dbars, None, geo, [entry, leave]], lambda x: sum(d['status'] == 'confirmed' for d in x) == 1 and x[0]['status'] == 'confirmed' and
        [x[0][k] for k in ('bStart', 'bEnd', 'cStart', 'cEnd', 'confirmedAt')] == [0, 20, 30, 45, 95])
    outside = {**leave, 'endRaw': 100, 'confirmedAt': 130}
    add('divergence-outside-window', 'divergences', [trends, centers, dbars, None, geo, [entry, outside]], lambda x: all(d['status'] == 'candidate' for d in x))
    spaced_centers = [center(10, 10, 20), center(40, 30, 40), center(90, 60, 70)]
    spaced_trends = [{**ev, 'id': 1, 'key': 'trend:up', 'kind': '上涨', 'centerIds': [10, 40],
                      'startRaw': 10, 'endRaw': 40, 'status': 'confirmed', 'confirmedAt': 85,
                      'dependencyKeys': ['center:10', 'center:40', 'center:90']},
                     {**ev, 'id': 2, 'key': 'trend:next', 'kind': '盘整', 'centerIds': [90],
                      'startRaw': 60, 'endRaw': 70, 'status': 'candidate', 'confirmedAt': None,
                      'dependencyKeys': ['center:90']}]
    spaced_bars = []
    for i in range(100):
        close = 100 + i if i < 30 else 130 + (i - 40) / 5 if i <= 55 else 100
        spaced_bars.append({'date': str(i), 'low': close - 0.1, 'high': close + 0.1, 'close': close})
    add('predecessor-not-id-minus-one', 'divergences', [spaced_trends, spaced_centers, spaced_bars, None, geo,
        [movement(1, 'up', 40, 55, 100, 130, 95)]], lambda x: any(d['kind'] == '趋势背驰' and d['status'] == 'confirmed'
        and d['bStart'] == 10 and d['bEnd'] == 30 and d['confirmedAt'] == 95 and 'center:10' in d['dependencyKeys'] for d in x))
    hist = [1 if i <= 20 else 0.1 if 30 <= i <= 45 else 0 for i in range(150)]
    add('macd-area-closed', 'divergences', [trends, centers, dbars, hist, BASE, [entry, leave]], lambda x: sum(d['status'] == 'confirmed' for d in x) == 1 and x[0]['bForce'] == 21 and abs(x[0]['cForce'] - 1.6) < 1e-9 and x[0]['confirmedAt'] == 95)
    broken_hist = list(hist)
    broken_hist[10] = None
    add('macd-area-null-not-zero', 'divergences', [trends, centers, dbars, broken_hist, BASE, [entry, leave]], lambda x: not any(d['status'] == 'confirmed' for d in x))
    deep_centers = [center(i + 1, i * 10, i * 10 + 5) for i in range(92)]
    deep_trends = ref.detect_trends(deep_centers, BASE)

    def deep_check(x):
        c2 = next(l for l in x if l['degree'] == 2)['centers'][0]
        c3 = next(l for l in x if l['degree'] == 3)['centers'][0]
        return c2['unit'] == c3['unit'] == 'trend' and c2['formedRaw'] == 25 and c2['formedAt'] == 50 and c2['confirmedAt'] == 110 and c3['status'] == 'confirmed' and c3['confirmedAt'] == 920 and all(l['basis'] == 'completed-trend' for l in x[2:])

    add('degree2-and-degree3-closed', 'levels', [deep_centers, deep_trends, BASE], deep_check)
    add('pen-level-basis', 'levels', [[], [], {**BASE, 'centerUnit': '笔中枢'}], lambda x: all(l['basis'] == 'bi' and '笔' in l['note'] for l in x))
    add('split-levels-no-upgrade', 'levels', [deep_centers[:10], [{**t, 'continuityId': 'left' if i < 4 else 'right'} for i, t in enumerate(ref.detect_trends(deep_centers[:10], BASE))], BASE],
        lambda x: all(c['status'] == 'candidate' for l in x[2:] for c in l['centers']) and len(x) == 3)

    minute = test_minutes(600)
    add('healthy-minute-nonempty', 'compute', [test_minutes(), CONFIGS[8]], lambda x: bool(x['bis']) and bool(x['centers']) and any(p['status'] == 'confirmed' for p in x['points']))
    bad = deepcopy(minute)
    for b in bad:
        b['time']['complete'] = False
    add('missing-roots-no-confirm', 'compute', [bad, CONFIGS[8]], lambda x: all(not x[field] for field in STRUCTURES.values()) and all(h is None for h in x['macd']['hist']) and x['inputCount'] == 600)
    gap = deepcopy(minute)
    gap[120]['time']['complete'] = False
    add('gap-restart-retains-raw', 'compute', [gap, CONFIGS[8]], lambda x: x['inputCount'] == 600 and len(x['sourceEvidence']) == 600 and x['macd']['hist'][120] is None and x['macd']['hist'][121] == 0
        and x['sourceEvidence'][121]['continuityId'] == 'test-run@121' and any(b['status'] == 'confirmed' and b['continuityId'] == 'test-run@121' for b in x['bis']) and not evidence_errors(x))
    source = deepcopy(minute[0])
    add('explicit-unknown-preserved', 'source', [{**source, 'time': {**source['time'], 'quality': 'unknown'}}], lambda x: x['quality'] == 'unknown')
    add('false-not-verified', 'source', [{**source, 'time': {**source['time'], 'complete': False}}], lambda x: x['quality'] == 'incomplete')
    add('empty-coverage-not-verified', 'source', [{**source, 'time': {**source['time'], 'coverage': []}}], lambda x: x['quality'] == 'unknown')
    add('invalid-coverage-not-verified', 'source', [{**source, 'time': {**source['time'], 'coverage': [{'startMs': 10, 'endMs': 5}]}}], lambda x: x['quality'] == 'unknown')
    add('future-coverage-not-verified', 'source', [{**source, 'time': {**source['time'], 'coverage': [{'startMs': source['time']['endMs'], 'endMs': source['time']['endMs'] + 1}]}}], lambda x: x['quality'] == 'unknown')
    add('unknown-end-json-null', 'source', [{'date': 'test:unknown', 'low': 1, 'high': 2, 'endMs': 'invalid',
        'time': {'endMs': 'invalid', 'coverage': [{'startMs': 0, 'endMs': 1}], 'complete': True}}], lambda x: x['endMs'] is None and x['quality'] == 'unknown')
    add('legacy-no-time-algorithm', 'source', [{'date': 'test:ordinal', 'low': 1, 'high': 2}], lambda x: x['endMs'] is None and x['quality'] == 'verified' and x['complete'])
    iso = [{'date': '2026-09-01T01:35:00Z', 'high': 2, 'low': 1}, {'date': '2026-09-01T09:40:00+08:00', 'high': 3, 'low': 2}, {'date': '2026-09-01T09:45:00+0800', 'high': 4, 'low': 3}]
    cutoff = ref.bar_known_at(iso[1])
    add('iso-offset-asOf-prefix', 'asOf', [iso, BASE, cutoff], lambda x: x['inputCount'] == 2 and x['asOfMs'] == cutoff and [s['endMs'] for s in x['sourceEvidence']] == [cutoff - 300000, cutoff])
    as_of_gap = deepcopy(minute)
    as_of_gap[120]['time']['complete'] = False
    as_of_cutoff = as_of_gap[200]['time']['endMs']
    add('asOf-gap-keeps-index', 'asOf', [as_of_gap, CONFIGS[8], as_of_cutoff], lambda x: x['inputCount'] == 201
        and len(x['sourceEvidence']) == 201 and x['sourceEvidence'][120]['quality'] == 'incomplete'
        and x['sourceEvidence'][121]['continuityId'] == 'test-run@121'
        and x['macd']['hist'][120] is None and x['macd']['hist'][121] == 0)
    add('calendar-invalid-rejected', 'asOf', [[{'date': '2026-02-30', 'low': 1, 'high': 2}], BASE, cutoff],
        lambda x: x == {'error': '无法解析行情时间: 2026-02-30'})
    add('dual-end-consistent', 'source', [{**source, 'endMs': source['time']['endMs']}], lambda x: x['endMs'] == source['time']['endMs'] and x['quality'] == 'verified')
    add('asOf-unknown-rejected', 'asOf', [[{'date': 'test:unknown', 'low': 1, 'high': 2}], BASE, cutoff], lambda x: x == {'error': '无法解析行情时间: test:unknown'})
    add('asOf-reverse-rejected', 'asOf', [[iso[1], iso[0]], BASE, cutoff], lambda x: x == {'error': '行情时间逆序: 2026-09-01T01:35:00Z'})
    add('asOf-cutoff-finite', 'asOf', [iso, BASE, None], lambda x: x == {'error': 'asOfMs 必须为有限物理时间'})
    add('dual-end-consistency', 'source', [{**source, 'endMs': source['time']['endMs'] + 1}], lambda x: x == {'error': f"结束时间不一致: {source['date']}"})
    long = walk(42, 1450)
    add('seed42-long-nonempty', 'compute', [long, CONFIGS[8]], lambda x: bool(x['centers']) and any(p['status'] == 'confirmed' for p in x['points']) and not evidence_errors(x))
    add('result-cadence-id-pure', 'replay', [long, CONFIGS[8]], lambda x: not deep_diff(x, ref.compute(long, CONFIGS[8])))
    return fixtures, checks


def run_python_fixture(f):
    args, kind = f['args'], f['kind']
    functions = {'source': ref.source_of, 'centers': ref.detect_centers, 'trends': ref.detect_trends,
                 'divergences': ref.detect_divergences, 'points': ref.detect_points, 'levels': ref.build_levels,
                 'compute': ref.compute, 'asOf': ref.analyze_as_of}
    try:
        if kind == 'segments':
            bis, fractals, valid, cfg = args
            return ref.detect_segments(bis, {f['id']: f for f in fractals}, valid, cfg)
        if kind == 'replay':
            bars, cfg = args
            r = ref.Replay(cfg)
            for b in bars:
                r.push(b)
                r.result()
                r.result()
            return r.result()
        return functions[kind](*args)
    except ValueError as e:
        return {'error': str(e)}


def prefix_errors(results):
    errors = []
    for seed, lengths in ((42, (370, 371, 1194, 1195, 1450)), (1, (370, 371, 1450))):
        for cfg in (CONFIGS[8], CONFIGS[12]):
            cid = ref.config_id(cfg)
            full = results[(f'test:seed{seed}:1450', 'test', cid)]
            for n in lengths[:-1]:
                pre = results[(f'test:seed{seed}:{n}', 'test', cid)]
                for field in STRUCTURES.values():
                    by_key = {x['key']: x for x in full[field]}
                    for x in pre[field]:
                        if x['status'] == 'confirmed' and deep_diff(x, by_key.get(x['key'])):
                            errors.append(f'seed{seed}:{n} {field} confirmed变更: {x["key"]}')
                if deep_diff(pre['events'], [e for e in full['events'] if e['at'] < n]):
                    errors.append(f'seed{seed}:{n} events不满足前缀')
    return errors


def main():
    assert REPORT.is_dir(), f'核验报告目录不存在: {REPORT}'
    original = load_samples()
    extra, minute_metadata = extra_samples()
    samples = original + extra
    fixtures, checks = golden_fixtures()
    in_path, ts_path = REPORT / '交叉核验_输入.json', REPORT / '交叉核验_TS输出.json'
    in_path.write_text(json.dumps({'samples': samples, 'configs': CONFIGS, 'fixtures': fixtures}, ensure_ascii=False, allow_nan=False), encoding='utf-8')
    total = sum(len(s.get('configIndices', CONFIGS)) for s in samples)
    print(f'原矩阵 32×16=512；新增 {total - 512}；test黄金 {len(checks)}', flush=True)
    proc = subprocess.run(['npx', 'tsx', 'packages/engine/scripts/exportResults.ts', str(in_path), str(ts_path)], cwd=ROOT, capture_output=True, text=True)
    if proc.returncode:
        print('TS 导出失败:', proc.stderr)
        return 1
    print(proc.stdout.strip(), flush=True)
    output = json.loads(ts_path.read_text(encoding='utf-8'))
    ts_index = {(x['code'], x['adjust'], x['configId']): {k: v for k, v in x.items() if k not in ('code', 'adjust')} for x in output['results']}
    py_index, details, fields, failed, identities = {}, [], set(), 0, 0
    for s in samples:
        for i in s.get('configIndices', range(len(CONFIGS))):
            cfg = CONFIGS[i]
            py = ref.compute(s['bars'], cfg) if 'asOfMs' not in s else ref.analyze_as_of(s['bars'], cfg, s['asOfMs'])
            key = (s['code'], s['adjust'], py['configId'])
            py_index[key] = py
            ts = ts_index.get(key)
            diffs = deep_diff(py, ts)
            for label, r in (('Python', py), ('TS', ts)):
                if r is not None:
                    errs = evidence_errors(r)
                    identities += len(errs)
                    diffs += [f'{label}: {e}' for e in errs]
            if diffs:
                failed += 1
                details.append({'样本': key, '差异': diffs[:50]})
            else:
                fields.update(covered_fields(py))
    ts_fixtures = {f['name']: {'error': f['error']} if 'error' in f else f['result'] for f in output['fixtures']}
    golden_failures = []
    fixture_diffs = []
    for f, (name, check) in zip(fixtures, checks):
        py, ts = run_python_fixture(f), ts_fixtures[f['name']]
        diff = deep_diff(py, ts)
        if diff:
            fixture_diffs.append({'fixture': name, '差异': diff})
        else:
            fields.update(covered_fields(py, f'$fixture.{f["kind"]}'))
        for implementation, result in (('Python', py), ('TS', ts)):
            try:
                passed = check(result)
            except (KeyError, StopIteration, TypeError, IndexError) as e:
                passed = False
                golden_failures.append({'fixture': name, '实现': implementation, '异常': str(e)})
            if not passed:
                golden_failures.append({'fixture': name, '实现': implementation, '问题': '独立黄金断言失败'})
    prefixes = {label: prefix_errors(index) for label, index in (('Python', py_index), ('TS', ts_index))}
    ok = failed == 0 and not fixture_diffs and not golden_failures and not any(prefixes.values())
    report = {'原始矩阵组数': 512, '新增矩阵组数': total - 512, '核验组数': total,
              '通过': total - failed, '失败': failed, '全部通过': ok, '字段剥离': False,
              '数值绝对容差': 1e-9, '零差异字段路径': sorted(fields), '身份与引用错误数': identities,
              '独立黄金数量': len(checks), '黄金核验实现数': 2, '独立黄金名称': [name for name, _ in checks],
              '黄金失败': golden_failures, 'fixture差异': fixture_diffs, '前缀失败': prefixes,
              '分钟真实数据': minute_metadata, '明细': details,
              '限制': ['原512组日线无time按纯算法声明完整兼容，不能证明真实逐分钟完整性',
                       '人工分钟缺根/缺桶与深层构件明确标test；不补写数据库、不外推节假日交易',
                       '结构与引用精确比较，数值容差1e-9；每失败样本最多记录50条，不隐藏失败',
                       '仅执行独立交叉核验，不运行页面/服务器门禁；未提交Git']}
    (REPORT / '交叉核验.json').write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding='utf-8')
    print(f'矩阵 {total - failed}/{total}；fixture diff {len(fixture_diffs)}；独立黄金失败 {len(golden_failures)}；身份错误 {identities}；前缀失败 {sum(map(len, prefixes.values()))}', flush=True)
    for d in (details + fixture_diffs + golden_failures)[:5]:
        print(json.dumps(d, ensure_ascii=False)[:2000])
    print(f'完整报告: {REPORT / "交叉核验.json"}')
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
