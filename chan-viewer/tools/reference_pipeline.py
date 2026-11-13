# -*- coding: utf-8 -*-
"""缠论参考管线（Python 独立实现）。

独立计算八关结构、来源证据、稳定身份与递归级别；不调用 TS、不读取 TS 期望。
同步引擎实际函数契约。只读、无第三方依赖。
"""
import math
import re
from copy import deepcopy
from datetime import datetime, timedelta, timezone


def finite(x):
    return isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x)


def js_num(x):
    return str(int(x)) if isinstance(x, (int, float)) and x == int(x) else str(x)


def coalesce(*xs):
    return next((x for x in xs if x is not None), None)


def parse_china_time(value):
    calendar = re.match(r'^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?', value)
    if not calendar:
        return None
    parts = [int(x or 0) for x in calendar.groups()]
    # Date.UTC 的 0..99 年会映射到 1900..1999，TS calendar 校验因此拒绝。
    if parts[0] < 100:
        return None
    try:
        datetime(*parts)
        if re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:?\d{2})', value):
            dt = datetime.fromisoformat(value.replace('Z', '+00:00'))
        elif re.fullmatch(r'\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2})?)?', value):
            dt = datetime(*parts, tzinfo=timezone(timedelta(hours=8)))
        else:
            return None
        return dt.timestamp() * 1000
    except ValueError:
        return None


def bar_known_at(bar):
    time = bar.get('time')
    if time is not None and bar.get('endMs') is not None and time.get('endMs') != bar['endMs']:
        raise ValueError(f"结束时间不一致: {bar['date']}")
    end = coalesce(time.get('endMs') if time is not None else None, bar.get('endMs'))
    if end is not None:
        return end if finite(end) else None
    parsed = parse_china_time(bar['date'])
    if parsed is None:
        return None
    return parsed + 15 * 3600000 if len(bar['date']) == 10 else parsed


def source_of(bar):
    time = bar.get('time')
    known = bar_known_at(bar)
    coverage = deepcopy(time['coverage']) if time is not None else []
    valid = bool(coverage) and all(finite(r['startMs']) and finite(r['endMs'])
        and r['endMs'] > r['startMs'] and known is not None and r['endMs'] <= known for r in coverage)
    t = time or {}
    quality = ('unknown' if t.get('quality') == 'unknown' else 'incomplete' if t.get('complete') is False
        else 'unknown' if time is not None and (not valid or known is None)
        else 'unknown' if bar.get('endMs') is not None and known is None else coalesce(t.get('quality'), 'verified'))
    return {'endMs': known, 'coverage': coverage, 'complete': coalesce(t.get('complete'), True),
            'quality': quality, 'continuityId': coalesce(t.get('continuityId'), 'legacy')}


def source_key(x, kind):
    return coalesce(x.get('key'), f"historical:{kind}:{x.get('id', 'undefined')}")


def same_continuity(a, b):
    return coalesce(a.get('continuityId'), 'legacy') == coalesce(b.get('continuityId'), 'legacy')


def evidence_of(xs, keys):
    cont = coalesce(xs[0].get('continuityId'), 'legacy') if xs else 'legacy'
    # 与 TS evidenceOf 一致：显式 incomplete 优先；历史 fixture 缺省可兼容。
    quality = ('incomplete' if any(x.get('quality') == 'incomplete' for x in xs)
        else 'unknown' if any(x.get('quality') == 'unknown' or coalesce(x.get('continuityId'), 'legacy') != cont for x in xs)
        else 'verified')
    return {'continuityId': cont, 'dependencyKeys': list(dict.fromkeys(keys)), 'quality': quality}


def continuous_groups(xs):
    groups = []
    for x in xs:
        if not groups or not same_continuity(groups[-1][-1], x):
            groups.append([])
        groups[-1].append(x)
    return groups

# ---- 纯函数内核（区间 [low, high]，与 配图自检.py 同构）----

def contains(a, b):
    return b[0] >= a[0] and b[1] <= a[1]


def either(a, b):
    return contains(a, b) or contains(b, a)


def merge(a, b, up):
    if up:
        return (max(a[0], b[0]), max(a[1], b[1]))
    return (min(a[0], b[0]), min(a[1], b[1]))


def top3(s):
    a, b, c = s
    return b[1] > a[1] and b[1] > c[1] and b[0] > a[0] and b[0] > c[0]


def bot3(s):
    a, b, c = s
    return b[0] < a[0] and b[0] < c[0] and b[1] < a[1] and b[1] < c[1]


def round_price(v, digits):
    if digits == 'raw':
        return v
    f = 10 ** digits
    return math.floor(v * f + 0.5) / f  # half-up，与 TS Math.round 一致（正价）


def more_extreme(f, e):
    return f['price'] > e['price'] if f['type'] == 'top' else f['price'] < e['price']


def min_middle_gap(rule):
    return 3 if rule == '社区新笔' else 4


def check_bi(e, f, rule):
    gap = f['middle'] - e['middle']
    need = min_middle_gap(rule)
    if gap < need:
        if rule == '社区新笔':
            return False, f'独立K线不足（社区新笔需顶底中间至少隔{need - 1}根，实际{gap - 1}根）'
        return False, f'独立K线不足（顶底之间需至少1根独立K线，实际{gap - 3}根）'
    top, bot = (e, f) if e['type'] == 'top' else (f, e)
    if rule == '社区老笔':
        if not top['price'] > bot['price']:
            return False, '价格条件不满足（社区老笔：顶须高于底）'
    else:
        if not top['midHigh'] > bot['midHigh']:
            return False, '价格区间条件不满足（顶区间须至少部分高于底区间）'
    return True, ''


# ---- 第4关 线段（特征序列分型法，65/67/78课），与 TS segment.ts 逻辑对齐 ----

def overlap(a, b, touch):
    lo, hi = max(a[0], b[0]), min(a[1], b[1])
    return lo <= hi if touch else lo < hi


def overlap_all(rs, touch):
    if not rs:
        return None
    lo = max(r[0] for r in rs)
    hi = min(r[1] for r in rs)
    ok = lo <= hi if touch else lo < hi
    return (lo, hi) if ok else None


def standardize(els, up):
    # els: list of dict {low, high, hiBi, loBi}；对齐 配图自检.standardize + 极值来源笔。
    out, direction = [], up
    for e in els:
        if out and either((out[-1]['low'], out[-1]['high']), (e['low'], e['high'])):
            last = out[-1]
            m = merge((last['low'], last['high']), (e['low'], e['high']), direction)
            out[-1] = {
                'low': m[0], 'high': m[1],
                # 极值来源跟随合并方向：向上时低点也取较高者，不能固定按更低溯源。
                'hiBi': last['hiBi'] if m[1] == last['high'] else e['hiBi'],
                'loBi': last['loBi'] if m[0] == last['low'] else e['loBi'],
            }
        else:
            if out:
                direction = e['high'] >= out[-1]['high']
            out.append(dict(e))
    return out


def fx_raw(fx, valid):
    mb = valid[fx['middle']]
    return (mb['startRaw'] + mb['endRaw']) / 2 if mb else fx['startRaw']


def build_segment(info, start, valid, touch, do_merge):
    n = len(info)
    dir_ = info[start]['dir']
    up = dir_ == 'up'
    startFx = info[start]['startFx']

    def mk_seg(endFx, status, boundary):
        a = fx_raw(startFx, valid)
        b = fx_raw(endFx, valid)
        consumed = info[start:boundary + 1]
        keys = [source_key(x['bi'], 'bi') for x in consumed]
        ev = evidence_of([x['bi'] for x in consumed], keys)
        if ev['quality'] != 'verified':
            status = 'candidate'
        tail = '|'.join(keys) if status == 'confirmed' else 'open'
        return {
            'id': 0, **ev,
            'key': f"seg:{ev['continuityId']}:{source_key(startFx, 'fx')}:{source_key(endFx, 'fx')}:{tail}",
            'dir': dir_, 'startFx': startFx['id'], 'endFx': endFx['id'],
            'startRaw': min(a, b), 'endRaw': max(a, b),
            'high': max(startFx['price'], endFx['price']),
            'low': min(startFx['price'], endFx['price']),
            'status': status, 'confirmedAt': max(coalesce(x['bi'].get('confirmedAt'), x['endFx'].get('confirmedAt'), x['endFx']['endRaw']) for x in consumed) if status == 'confirmed' else None,
        }

    feat = []
    extreme_price = info[start]['iv'][1] if up else info[start]['iv'][0]
    extreme_fx = info[start]['endFx']
    pending = None  # {breakFx, breakBi, secondFeat}

    for k in range(start + 1, n):
        bi = info[k]
        if bi['dir'] == dir_:
            p = bi['iv'][1] if up else bi['iv'][0]
            more = p > extreme_price if up else p < extreme_price
            if more:
                extreme_price = p
                extreme_fx = bi['endFx']
                pending = None
                continue
            if pending:
                # 第二特征序列取与原线段同向的笔；这些笔属于反转线段本体。
                el = {'low': bi['iv'][0], 'high': bi['iv'][1], 'hiBi': k, 'loBi': k}
                pending['secondFeat'].append(el)
                sf = standardize(pending['secondFeat'], not up) if do_merge else pending['secondFeat']
                if len(sf) >= 3:
                    tri = [(x['low'], x['high']) for x in sf[-3:]]
                    hit = bot3(tri) if up else top3(tri)
                    if hit:
                        return {'seg': mk_seg(pending['breakFx'], 'confirmed', k), 'next': pending['breakBi']}
            continue
        if pending:
            continue
        el = {'low': bi['iv'][0], 'high': bi['iv'][1], 'hiBi': k, 'loBi': k}
        feat.append(el)
        fs = standardize(feat, up) if do_merge else feat
        if len(fs) < 3:
            continue
        tri = [(x['low'], x['high']) for x in fs[-3:]]
        is_fx = top3(tri) if up else bot3(tri)
        if not is_fx:
            continue
        mid = fs[-2]
        breakBi = mid['hiBi'] if up else mid['loBi']
        breakFx = info[breakBi]['startFx']
        has_gap = not overlap(tri[0], tri[1], touch)
        if not has_gap:
            return {'seg': mk_seg(breakFx, 'confirmed', k), 'next': breakBi}
        second = []
        for q in range(breakBi + 1, k):
            prev = info[q]
            if prev['dir'] == dir_:
                second.append({'low': prev['iv'][0], 'high': prev['iv'][1], 'hiBi': q, 'loBi': q})
        pending = {'breakFx': breakFx, 'breakBi': breakBi, 'secondFeat': second}

    return {'seg': mk_seg(extreme_fx, 'candidate', n - 1), 'next': n}


def detect_segments(bis, fx_by_id, valid, cfg):
    out = [s for group in continuous_groups(bis) for s in detect_continuous_segments(group, fx_by_id, valid, cfg)]
    for i, s in enumerate(out):
        s['id'] = i + 1
    return out


def detect_continuous_segments(bis, fx_by_id, valid, cfg):
    touch = cfg['touchOverlap'] == '相接算重叠'
    do_merge = cfg['segMerge'] == '做包含处理'
    info = []
    for b in bis:
        s = fx_by_id.get(b['start'])
        e = fx_by_id.get(b['end'])
        if s is None or e is None:
            return []
        info.append({'bi': b, 'iv': (min(s['price'], e['price']), max(s['price'], e['price'])),
                     'startFx': s, 'endFx': e, 'dir': b['dir']})
    segs = []
    i = 0
    n = len(bis)
    while i < n:
        if i + 2 >= n:
            break
        if overlap_all([info[i]['iv'], info[i + 1]['iv'], info[i + 2]['iv']], touch) is None:
            i += 1
            continue
        built = build_segment(info, i, valid, touch, do_merge)
        if not built:
            break
        segs.append(built['seg'])
        if built['seg']['status'] == 'candidate':
            break
        i = built['next']
    for k, s in enumerate(segs):
        s['id'] = k + 1
    return segs


# ---- 第5关 中枢（17/18/20/33课），与 TS center.ts 对齐 ----

def center_bounds(zs):
    # zs: list of (low,high) 同向 Z 段。
    highs = [z[1] for z in zs]
    lows = [z[0] for z in zs]
    return {'ZG': min(highs[0], highs[1]), 'ZD': max(lows[0], lows[1]),
            'GG': max(highs), 'DD': min(lows), 'G': min(highs), 'D': max(lows)}


def unit_known_at(u):
    return coalesce(u.get('confirmedAt'), u['endRaw'])


def unit_key(u):
    return coalesce(u.get('key'), f"historical:unit:{js_num(u['startRaw'])}:{js_num(u['endRaw'])}")


def detect_centers(units, cfg):
    out = [c for group in continuous_groups(units) for c in detect_continuous_centers(group, cfg)]
    for i, c in enumerate(out):
        c['id'] = i + 1
    return out


def detect_continuous_centers(units, cfg):
    touch = cfg['touchOverlap'] == '相接算重叠'
    upgrade = cfg['centerUpgrade'] == '9段升级'
    centers = []
    n = len(units)
    i = 0
    iv = lambda u: (u['low'], u['high'])
    while i + 2 < n:
        core = overlap_all([iv(u) for u in units[i:i + 3]], touch)
        if core is None:
            i += 1
            continue
        end_unit, seg_count = i + 2, 3
        status, evolution = 'candidate', 'forming'
        terminated_at = terminated_raw = None
        pending_leave, nxt = -1, n
        j = i + 3
        while j < n:
            u = units[j]
            if overlap(iv(u), core, touch):
                pending_leave = -1
                end_unit = j
                seg_count += 1
                evolution = 'extending'
                if upgrade and seg_count >= 9:
                    status, evolution = 'confirmed', 'upgraded'
                    terminated_raw = u['endRaw']
                    terminated_at = max(unit_known_at(x) for x in units[i:j + 1])
                    nxt = j + 1
                    break
            elif pending_leave < 0:
                pending_leave = j
            else:
                status, evolution = 'confirmed', 'terminated'
                end_unit = pending_leave - 1
                terminated_raw = u['endRaw']
                terminated_at = max(unit_known_at(x) for x in units[i:j + 1])
                nxt = pending_leave
                break
            j += 1
        if status == 'candidate':
            end_unit, nxt = n - 1, n
            if end_unit > i + 2:
                evolution = 'extending'
        b = center_bounds([iv(units[k]) for k in range(i, end_unit + 1, 2)])
        seed = units[i:i + 3]
        consumed = units[i:min(j + 1, n)]
        ev = evidence_of(consumed, [unit_key(u) for u in consumed])
        if any('confirmedAt' in u and u['confirmedAt'] is None for u in consumed):
            ev['quality'] = 'unknown'
        if ev['quality'] != 'verified':
            status = 'candidate'
        unit = 'bi' if cfg['centerUnit'] == '笔中枢' else 'segment'
        centers.append({
            'id': 0, **ev, 'key': f"ctr:{ev['continuityId']}:{unit}:{'|'.join(unit_key(u) for u in seed)}",
            'unit': unit, 'dir': units[i]['dir'],
            'startRaw': units[i]['startRaw'], 'endRaw': units[end_unit]['endRaw'],
            'ZG': core[1], 'ZD': core[0],
            'GG': b['GG'], 'DD': b['DD'], 'G': b['G'], 'D': b['D'],
            'segCount': seg_count, 'formedAt': max(unit_known_at(u) for u in seed),
            'formedRaw': units[i + 2]['endRaw'], 'terminatedRaw': terminated_raw,
            'terminatedAt': terminated_at, 'evolution': evolution,
            'status': status, 'confirmedAt': terminated_at if status == 'confirmed' else None,
        })
        if status == 'candidate':
            break
        i = nxt
    for k, c in enumerate(centers):
        c['id'] = k + 1
        if k == 0:
            c['relation'] = 'first'
        else:
            prev = centers[k - 1]
            c['relation'] = 'expanded' if overlap((prev['DD'], prev['GG']), (c['DD'], c['GG']), touch) else 'new'
    return centers


# ---- 第6关 走势类型（17/18/20课），与 TS trend.ts 对齐 ----

def trend_step(a, b, cfg):
    # 核心不重叠但外围重叠是中枢扩展，不是两个同级中枢构成趋势。
    if b.get('relation') == 'expanded':
        return None
    touch = cfg['touchOverlap'] == '相接算重叠'
    outer = cfg['trendOverlap'] == '外围也不重叠'
    ra = (a['DD'], a['GG']) if outer else (a['ZD'], a['ZG'])
    rb = (b['DD'], b['GG']) if outer else (b['ZD'], b['ZG'])
    if overlap_all([ra, rb], touch) is not None:
        return None
    if rb[0] > ra[1]:
        return 'up'
    if rb[1] < ra[0]:
        return 'down'
    return None


def detect_trends(centers, cfg):
    cs = [c for c in centers if c['status'] == 'confirmed']
    trends = []
    n, i = len(cs), 0
    while i < n:
        ids, dir_, j = [cs[i]['id']], None, i + 1
        while j < n:
            if not same_continuity(cs[j - 1], cs[j]) or cs[j - 1].get('degree', 1) != cs[j].get('degree', 1):
                break
            step = trend_step(cs[j - 1], cs[j], cfg)
            if not step or (dir_ is not None and step != dir_):
                break
            dir_ = step
            ids.append(cs[j]['id'])
            j += 1
        kind = ('上涨' if dir_ == 'up' else '下跌') if len(ids) >= 2 else '盘整'
        closed = j < n and same_continuity(cs[i], cs[j]) and cs[i].get('degree', 1) == cs[j].get('degree', 1)
        included = cs[i:j]
        consumed = cs[i:j + 1] if closed else included
        ev = evidence_of(consumed, [source_key(c, 'center') for c in consumed])
        status = 'confirmed' if closed and ev['quality'] == 'verified' else 'candidate'
        trends.append({'id': len(trends) + 1, **ev,
            'key': f"tr:{ev['continuityId']}:{kind}:{'|'.join(source_key(c, 'center') for c in included)}",
            'kind': kind, 'centerIds': ids, 'startRaw': cs[i]['startRaw'], 'endRaw': cs[i + len(ids) - 1]['endRaw'],
            'degree': cs[i].get('degree', 1), 'status': status,
            'confirmedAt': max(coalesce(c.get('confirmedAt'), c.get('terminatedAt'), c['endRaw']) for c in consumed) if status == 'confirmed' else None})
        i += len(ids)
    return trends


def enrich_trend_range(t, centers):
    included = [next((c for c in centers if c['id'] == id_), None) for id_ in t['centerIds']]
    included = [c for c in included if c is not None]
    if not included:
        return t
    return {**t, 'startPrice': min(c['DD'] for c in included), 'endPrice': max(c['GG'] for c in included)}


def build_levels(base_centers, base_trends, cfg, max_degree=12, register=None):
    basis = 'bi' if cfg['centerUnit'] == '笔中枢' else 'segment'
    name = '笔' if basis == 'bi' else '线段'
    levels = [{'degree': 0, 'basis': basis, 'centers': [], 'trends': [], 'completed': [],
               'note': f'基础构件层（已确认{name}）；中枢从 degree 1 开始。'}]
    centers = [{**c, 'degree': 1} for c in base_centers]
    trends = [enrich_trend_range({**t, 'degree': 1}, centers) for t in base_trends]
    levels.append({'degree': 1, 'basis': basis, 'centers': centers, 'trends': trends,
        'completed': [t for t in trends if t['status'] == 'confirmed'],
        'note': f'{name}级别中枢与本级走势；候选末段不向更高层提供构件。'})
    for degree in range(2, max_degree + 1):
        units = []
        for t in trends:
            if t['status'] != 'confirmed':
                continue
            a, b = t.get('startPrice', 0), t.get('endPrice', 0)
            units.append({'low': min(a, b), 'high': max(a, b), 'startRaw': t['startRaw'], 'endRaw': t['endRaw'],
                'dir': 'up' if t['kind'] == '上涨' else 'down', 'key': t.get('key'),
                'continuityId': t.get('continuityId'), 'quality': t.get('quality'),
                'dependencyKeys': [t['key']] if t.get('key') else [], 'confirmedAt': t['confirmedAt']})
        if len(units) < 3:
            break
        centers = [{**c, 'unit': 'trend', 'degree': degree, 'key': f"d{degree}:{c['key']}"} for c in detect_centers(units, cfg)]
        if register:
            for c in centers:
                register('center', c)
        trends = [enrich_trend_range({**t, 'degree': degree, 'key': f"d{degree}:{t['key']}"}, centers) for t in detect_trends(centers, cfg)]
        if register:
            for t in trends:
                register('trend', t)
        if not centers:
            break
        completed = [t for t in trends if t['status'] == 'confirmed']
        levels.append({'degree': degree, 'basis': 'completed-trend', 'centers': centers, 'trends': trends,
            'completed': completed, 'note': f'以 degree {degree - 1} 已完成走势为构件。'})
        if not completed:
            break
    return levels


# ---- MACD(12,26,9)（24/25课），与 TS macd.ts 一致（EMA 种子=首值）----

def ema_series(values, n):
    k = 2 / (n + 1)
    out = []
    prev = 0
    for i, v in enumerate(values):
        prev = v if i == 0 else v * k + prev * (1 - k)
        out.append(prev)
    return out


def macd(closes):
    e12 = ema_series(closes, 12)
    e26 = ema_series(closes, 26)
    dif = [a - b for a, b in zip(e12, e26)]
    dea = ema_series(dif, 9)
    hist = [2 * (d - e) for d, e in zip(dif, dea)]
    return {'dif': dif, 'dea': dea, 'hist': hist}


def area_between(hist, a, b, up):
    s = max(0, math.ceil(a))
    e = min(len(hist) - 1, math.floor(b))
    total = 0.0
    for i in range(s, e + 1):
        h = hist[i]
        if h is None:
            return None
        if (h > 0) if up else (h < 0):
            total += abs(h)
    return total


# ---- 第7关 背驰（24/25/27/33课），与 TS divergence.ts 对齐 ----

def price_at(bars, raw):
    i = max(0, min(len(bars) - 1, math.floor(raw + 0.5)))  # half-up，与 TS Math.round 一致
    b = bars[i]
    c = b.get('close')
    return c if c is not None else (b['high'] + b['low']) / 2


def extreme_raw(bars, a, b, dir_):
    s = max(0, math.ceil(a))
    e = min(len(bars) - 1, math.floor(b))
    best = s
    bv = float('-inf') if dir_ == 'up' else float('inf')
    for i in range(s, e + 1):
        v = bars[i]['high'] if dir_ == 'up' else bars[i]['low']
        if (v > bv) if dir_ == 'up' else (v < bv):
            bv = v
            best = i
    return best


def force_of(bars, hist, a, b, dir_, metric):
    s = max(0, math.ceil(a))
    e = min(len(bars) - 1, math.floor(b))
    if e < s:
        return 0.0
    if metric == 'MACD面积':
        return area_between(hist, a, b, dir_ == 'up') if hist is not None else None
    return abs(price_at(bars, b) - price_at(bars, a))  # 几何：段净位移


def detect_divergences(trends, centers, bars, hist, cfg, movements=None):
    metric = cfg['divMetric']
    if metric == 'MACD面积' and not hist:
        return []
    by_id = {c['id']: c for c in centers}
    completed = sorted([m for m in (movements or []) if m['status'] == 'confirmed'], key=lambda m: m['startRaw'])
    last_raw = len(bars) - 1
    out = []
    n = len(trends)

    def centers_of(t):
        return [by_id[i] for i in t['centerIds'] if i in by_id]

    for t in range(n):
        T = trends[t]
        cs = centers_of(T)
        if not cs:
            continue
        B = cs[-1]
        ordered = sorted([c for c in centers if same_continuity(c, B) and c.get('degree', 1) == B.get('degree', 1)], key=lambda c: c['startRaw'])
        pos = next(i for i, c in enumerate(ordered) if c['id'] == B['id'])
        A = ordered[pos - 1] if pos > 0 else None
        is_trend = T['kind'] != '盘整'
        local = [m for m in completed if same_continuity(m, T)]
        entry = None if A else next((m for m in reversed(local) if m['endRaw'] <= cs[0]['startRaw'] + 0.6), None)
        if A is None and entry is None:
            continue
        b_start = A['startRaw'] if A else entry['startRaw']
        b_end = B['startRaw'] if A else cs[0]['startRaw']
        next_trend = next((x for x in trends[t + 1:] if same_continuity(x, T)), None)
        closed_end = next_trend['startRaw'] if T['status'] == 'confirmed' and next_trend else None
        leave = next((m for m in local if m['startRaw'] >= B['endRaw'] - 0.6 and (closed_end is None or m['endRaw'] <= closed_end + 0.6)), None)
        c_start = leave['startRaw'] if leave else B['startRaw']
        window_end = leave['endRaw'] if leave else coalesce(closed_end, last_raw)
        if is_trend:
            dir_ = 'up' if T['kind'] == '上涨' else 'down'
        else:
            dir_ = 'up' if price_at(bars, window_end) >= price_at(bars, c_start) else 'down'
        c_end = extreme_raw(bars, c_start, window_end, dir_)
        b_force = force_of(bars, hist, b_start, b_end, dir_, metric)
        c_force = force_of(bars, hist, c_start, c_end, dir_, metric)
        if not finite(b_force) or not finite(c_force):
            continue
        entry_key = source_key(A or entry, 'center' if A else 'segment')
        leave_key = source_key(leave, 'segment') if leave else 'open'
        sources = [T, B, A or entry] + ([leave] if leave else [])
        ev = evidence_of(sources, [source_key(T, 'trend'), source_key(B, 'center'), entry_key] + ([leave_key] if leave else []))
        est = T['status'] != 'confirmed' or closed_end is None or leave is None or ev['quality'] != 'verified'
        if est and metric == 'MACD面积':
            c_force *= 2
        if not (c_force < b_force):
            continue
        out.append({'id': 0, **ev, 'key': f"div:{ev['continuityId']}:{source_key(T, 'trend')}:{entry_key}:{leave_key}",
                    'kind': '趋势背驰' if is_trend else '盘整背驰', 'metric': metric,
                    'dir': dir_, 'bStart': b_start, 'bEnd': b_end, 'cStart': c_start, 'cEnd': c_end,
                    'bForce': b_force, 'cForce': c_force, 'est': est,
                    'status': 'candidate' if est else 'confirmed',
                    'confirmedAt': None if est else max(coalesce(T.get('confirmedAt'), T['endRaw']), coalesce(B.get('confirmedAt'), B['endRaw']), coalesce(A.get('confirmedAt') if A else None, entry.get('confirmedAt') if entry else None, b_end), coalesce(leave.get('confirmedAt'), leave['endRaw']))})
    for k, d in enumerate(out):
        d['id'] = k + 1
    return out


# ---- 第8关 买卖点（20/21/101课），与 TS point.ts 对齐 ----

def detect_points(divergences, centers, fractals, valid, bars, cfg, sub_movements=None, mode='completed-movements'):
    out = []
    historical = mode == 'historical-fractals'

    def add(p, ref, extra):
        kind = {1: 'divergence', 2: 'point', 3: 'center'}[p['klass']]
        p['refKind'], p['refKey'] = kind, source_key(ref, kind)
        keys = [source_key(x, 'movement') for x in extra]
        p.update(evidence_of([ref] + extra, [p['refKey']] + keys))
        tail = '|'.join(keys) or (f"historical:{js_num(p['atRaw'])}" if historical else 'open')
        p['key'] = f"point:{p['continuityId']}:{p['side']}:{p['klass']}:{p['refKey']}:{tail}"
        if p['quality'] != 'verified':
            p['status'] = 'candidate'
        if p['status'] == 'confirmed':
            p['confirmedAt'] = max([coalesce(ref.get('confirmedAt'), ref.get('cEnd'), ref.get('endRaw'), ref.get('atRaw'))] + [coalesce(x.get('confirmedAt'), x['endRaw']) for x in extra])
        out.append(p)

    confirmed_fx = [f for f in fractals if f['status'] == 'confirmed']

    def fxraw(f):
        mb = valid[f['middle']]
        return (mb['startRaw'] + mb['endRaw']) / 2 if mb else f['startRaw']

    movements = sorted([m for m in (sub_movements or []) if m['status'] == 'confirmed'], key=lambda m: m['startRaw'])
    for d in divergences:
        if d['kind'] != '趋势背驰':
            continue
        i = max(0, min(len(bars) - 1, math.floor(d['cEnd'] + 0.5)))
        b = bars[i]
        turn = next((m for m in movements if same_continuity(m, d) and m['dir'] == ('up' if d['dir'] == 'down' else 'down') and m['startRaw'] >= d['cEnd'] - 0.6), None)
        status = 'confirmed' if d['status'] == 'confirmed' and (historical or turn is not None) else 'candidate'
        if d['dir'] == 'down':
            add({'id': 0, 'side': 'buy', 'klass': 1, 'atRaw': d['cEnd'], 'price': b['low'], 'refId': d['id'], 'status': status, 'confirmedAt': None}, d, [turn] if turn else [])
        else:
            add({'id': 0, 'side': 'sell', 'klass': 1, 'atRaw': d['cEnd'], 'price': b['high'], 'refId': d['id'], 'status': status, 'confirmedAt': None}, d, [turn] if turn else [])
    if not historical:
        # 原文路径：完成的次级别离开 + 首次完成的次级别回试。
        for c in centers:
            if c['status'] != 'confirmed':
                continue
            local = [m for m in movements if same_continuity(m, c)]
            after = [m for m in local if m['startRaw'] >= c['endRaw'] - 0.6]
            up_leave = next((m for m in after if m['dir'] == 'up' and m['high'] > c['ZG']), None)
            if up_leave:
                retest = next((m for m in local if m['dir'] == 'down' and m['startRaw'] >= up_leave['endRaw'] - 0.6), None)
                if retest:
                    ok = retest['low'] >= c['ZG'] if cfg['bsp3Touch'] == '不跌破ZG' else retest['low'] > c['ZG']
                    if ok:
                        add({'id': 0, 'side': 'buy', 'klass': 3, 'atRaw': retest['endRaw'], 'price': retest['low'], 'refId': c['id'], 'status': 'confirmed', 'confirmedAt': None}, c, [up_leave, retest])
            down_leave = next((m for m in after if m['dir'] == 'down' and m['low'] < c['ZD']), None)
            if down_leave:
                retest = next((m for m in local if m['dir'] == 'up' and m['startRaw'] >= down_leave['endRaw'] - 0.6), None)
                if retest:
                    ok = retest['high'] <= c['ZD'] if cfg['bsp3Touch'] == '不跌破ZG' else retest['high'] < c['ZD']
                    if ok:
                        add({'id': 0, 'side': 'sell', 'klass': 3, 'atRaw': retest['endRaw'], 'price': retest['high'], 'refId': c['id'], 'status': 'confirmed', 'confirmedAt': None}, c, [down_leave, retest])

        for b1 in [p for p in out if p['klass'] == 1 and p['side'] == 'buy' and p['status'] == 'confirmed']:
            rebound = next((m for m in movements if same_continuity(m, b1) and m['dir'] == 'up' and m['startRaw'] >= b1['atRaw'] - 0.6 and m['endRaw'] > b1['atRaw']), None)
            if not rebound:
                continue
            retest = next((m for m in movements if same_continuity(m, b1) and m['dir'] == 'down' and m['startRaw'] >= rebound['endRaw'] - 0.6), None)
            if not retest:
                continue
            if cfg['bsp2Filter'] == '过滤二买须高于一买' and not (retest['low'] > b1['price']):
                continue
            add({'id': 0, 'side': 'buy', 'klass': 2, 'atRaw': retest['endRaw'], 'price': retest['low'], 'refId': b1['id'], 'status': 'confirmed', 'confirmedAt': None}, b1, [rebound, retest])
        for s1 in [p for p in out if p['klass'] == 1 and p['side'] == 'sell' and p['status'] == 'confirmed']:
            decline = next((m for m in movements if same_continuity(m, s1) and m['dir'] == 'down' and m['startRaw'] >= s1['atRaw'] - 0.6 and m['endRaw'] > s1['atRaw']), None)
            if not decline:
                continue
            retest = next((m for m in movements if same_continuity(m, s1) and m['dir'] == 'up' and m['startRaw'] >= decline['endRaw'] - 0.6), None)
            if not retest:
                continue
            if cfg['bsp2Filter'] == '过滤二买须高于一买' and not (retest['high'] < s1['price']):
                continue
            add({'id': 0, 'side': 'sell', 'klass': 2, 'atRaw': retest['endRaw'], 'price': retest['high'], 'refId': s1['id'], 'status': 'confirmed', 'confirmedAt': None}, s1, [decline, retest])
    else:
        # 兼容旧的纯分型调用（仅历史对照/单测）；生产管线必须传已完成次级别走势。
        for c in centers:
            if c['status'] != 'confirmed':
                continue
            up_leave = -1
            down_leave = -1
            for i in range(math.ceil(c['endRaw']), len(bars)):
                if up_leave < 0 and bars[i]['high'] > c['ZG']:
                    up_leave = i
                if down_leave < 0 and bars[i]['low'] < c['ZD']:
                    down_leave = i
                if up_leave >= 0 and down_leave >= 0:
                    break
            if up_leave >= 0:
                retest = next((f for f in confirmed_fx if f['type'] == 'bottom' and fxraw(f) > up_leave), None)
                if retest:
                    ok = retest['price'] >= c['ZG'] if cfg['bsp3Touch'] == '不跌破ZG' else retest['price'] > c['ZG']
                    if ok:
                        add({'id': 0, 'side': 'buy', 'klass': 3, 'atRaw': fxraw(retest), 'price': retest['price'], 'refId': c['id'], 'status': 'confirmed', 'confirmedAt': None}, c, [retest])
            if down_leave >= 0:
                retest = next((f for f in confirmed_fx if f['type'] == 'top' and fxraw(f) > down_leave), None)
                if retest:
                    ok = retest['price'] <= c['ZD'] if cfg['bsp3Touch'] == '不跌破ZG' else retest['price'] < c['ZD']
                    if ok:
                        add({'id': 0, 'side': 'sell', 'klass': 3, 'atRaw': fxraw(retest), 'price': retest['price'], 'refId': c['id'], 'status': 'confirmed', 'confirmedAt': None}, c, [retest])
        for b1 in [p for p in out if p['klass'] == 1 and p['side'] == 'buy' and p['status'] == 'confirmed']:
            up = next((f for f in confirmed_fx if f['type'] == 'top' and fxraw(f) > b1['atRaw']), None)
            if not up:
                continue
            b2 = next((f for f in confirmed_fx if f['type'] == 'bottom' and fxraw(f) > fxraw(up)), None)
            if not b2:
                continue
            if cfg['bsp2Filter'] == '过滤二买须高于一买' and not (b2['price'] > b1['price']):
                continue
            add({'id': 0, 'side': 'buy', 'klass': 2, 'atRaw': fxraw(b2), 'price': b2['price'], 'refId': b1['id'], 'status': 'confirmed', 'confirmedAt': None}, b1, [up, b2])
        for s1 in [p for p in out if p['klass'] == 1 and p['side'] == 'sell' and p['status'] == 'confirmed']:
            down = next((f for f in confirmed_fx if f['type'] == 'bottom' and fxraw(f) > s1['atRaw']), None)
            if not down:
                continue
            s2 = next((f for f in confirmed_fx if f['type'] == 'top' and fxraw(f) > fxraw(down)), None)
            if not s2:
                continue
            if cfg['bsp2Filter'] == '过滤二买须高于一买' and not (s2['price'] < s1['price']):
                continue
            add({'id': 0, 'side': 'sell', 'klass': 2, 'atRaw': fxraw(s2), 'price': s2['price'], 'refId': s1['id'], 'status': 'confirmed', 'confirmedAt': None}, s1, [down, s2])

    out.sort(key=lambda p: (p['atRaw'], p['klass'], 0 if p['side'] == 'buy' else 1))
    for k, p in enumerate(out):
        p['id'] = k + 1
    by_key = {p['key']: p['id'] for p in out}
    for p in out:
        if p['refKind'] == 'point':
            p['refId'] = by_key.get(p['refKey'])
    return out


def canonical_config(c):
    import json
    obj = {'startDir': c['startDir'], 'digits': c['precision']['digits'],
           'biRule': c['biRule'], 'mergeDir': c['mergeDir'],
           'touchOverlap': c['touchOverlap'], 'segMerge': c['segMerge'],
           'centerUnit': c['centerUnit'], 'centerUpgrade': c['centerUpgrade'],
           'trendOverlap': c['trendOverlap'], 'divMetric': c['divMetric'],
           'bsp3Touch': c['bsp3Touch'], 'bsp2Filter': c['bsp2Filter']}
    return json.dumps(obj, ensure_ascii=False, separators=(',', ':'))


def config_id(c):
    s = canonical_config(c)
    h = 0x811c9dc5
    for ch in s:
        h ^= ord(ch)
        h = (h * 0x01000193) & 0xffffffff
    return format(h, '08x')


class Replay:
    def __init__(self, cfg):
        self.cfg = cfg
        self.config_id = config_id(cfg)
        self.valid = []        # {index, high, low, startRaw, endRaw}
        self.confirmed = []    # fractal dict
        self.candidate = None
        self.kept = []
        self.bis = []
        self.segs = []
        self.seg_candidate = None
        self.centers = []
        self.center_candidate = None
        self.trends = []
        self.trend_candidate = None
        self.divergences = []
        self.div_candidate = None
        self.points = []
        self.ids = {}
        self.next_ids = {}
        self.frozen = {}
        self.sources = []
        self.macd_series = {'dif': [], 'dea': [], 'hist': []}
        self.macd_continuity = None
        self.macd_has_close = False
        self.ema12 = self.ema26 = self.dea = 0
        self.active_continuity = self.input_continuity = None
        self.used_continuities = set()
        self.active_valid_start = 0
        self.levels = build_levels([], [], cfg)
        self.raw_bars = []
        self.events = []
        self.raw_count = 0
        self.cur_at = 0
        self.next_fx = 1
        self.next_bi = 1
        self.start_logged = False

    def emit(self, kind, reason, cite, refs, fid=None):
        ev = {'at': self.cur_at, 'kind': kind, 'reason': reason, 'cite': cite, 'refs': refs}
        if fid is not None:
            ev['id'] = fid
        self.events.append(ev)

    def push(self, bar):
        start = len(self.events)
        self.cur_at = self.raw_count
        self.raw_count += 1
        self.raw_bars.append(bar)
        source = source_of(bar)
        if not source['complete'] or source['quality'] != 'verified':
            self.sources.append(source)
            self._append_macd(bar, source)
            self._break_chain()
            return self.events[start:]
        if self.input_continuity != source['continuityId'] or self.active_continuity is None:
            self._break_chain()
            cont = source['continuityId']
            self.input_continuity = cont
            self.active_continuity = f'{cont}@{self.cur_at}' if cont in self.used_continuities else cont
            self.used_continuities.add(cont)
        source['continuityId'] = self.active_continuity
        self.sources.append(source)
        self._append_macd(bar, source)
        d = self.cfg['precision']['digits']
        high = round_price(bar['high'], d)
        low = round_price(bar['low'], d)
        self._ingest(self.cur_at, high, low)
        return self.events[start:]

    def _break_chain(self):
        self.active_continuity = self.input_continuity = None
        self.active_valid_start = len(self.valid)
        self.candidate = None
        self.kept = []
        self.bis = [b for b in self.bis if b['status'] == 'confirmed']
        self.seg_candidate = self.center_candidate = self.trend_candidate = self.div_candidate = None
        self.points = [p for p in self.points if p['status'] == 'confirmed']
        self.start_logged = False
        self._cache_levels()

    def _register(self, kind, item):
        key = f"{kind}:{item['key']}"
        if key not in self.ids:
            if kind == 'fractal':
                id_ = self.next_fx
                self.next_fx += 1
            elif kind == 'bi':
                id_ = self.next_bi
                self.next_bi += 1
            else:
                id_ = self.next_ids.get(kind, 1)
                self.next_ids[kind] = id_ + 1
            self.ids[key] = id_
        item['id'] = self.ids[key]
        if key in self.frozen:
            item.update(deepcopy(self.frozen[key]))
        elif item['status'] == 'confirmed':
            if item['quality'] != 'verified' or item['confirmedAt'] is None:
                raise ValueError(f"确认依赖未闭合: {item['key']}")
            self.frozen[key] = deepcopy(item)
        return item

    @staticmethod
    def _retain(history, all_):
        by_key = {x['key']: x for x in history}
        for x in all_:
            if x['status'] == 'confirmed':
                by_key[x['key']] = x
        return list(by_key.values())

    def _cache_levels(self):
        cs = self.centers + ([self.center_candidate] if self.center_candidate else [])
        ts = self.trends + ([self.trend_candidate] if self.trend_candidate else [])
        self.levels = build_levels(cs, ts, self.cfg, register=self._register)

    def _append_macd(self, bar, source):
        close = bar.get('close')
        if isinstance(close, (int, float)) and not isinstance(close, bool):
            self.macd_has_close = True
        if not source['complete'] or source['quality'] != 'verified' or not finite(close):
            self.macd_continuity = None
            for series in self.macd_series.values():
                series.append(None)
            return
        if self.macd_continuity != source['continuityId']:
            self.ema12 = self.ema26 = close
            self.dea = 0
            self.macd_continuity = source['continuityId']
        else:
            self.ema12 = close * (2 / 13) + self.ema12 * (1 - 2 / 13)
            self.ema26 = close * (2 / 27) + self.ema26 * (1 - 2 / 27)
        dif = self.ema12 - self.ema26
        self.dea = dif * (2 / 10) + self.dea * (1 - 2 / 10)
        self.macd_series['dif'].append(dif)
        self.macd_series['dea'].append(self.dea)
        self.macd_series['hist'].append(2 * (dif - self.dea))

    def _resolve_dir(self, tail, bar):
        if self.cfg['mergeDir'] == '直接用前一根':
            return bar['high'] >= tail['high']
        for i in range(len(self.valid) - 2, self.active_valid_start - 1, -1):
            p = self.valid[i]
            if not either((p['low'], p['high']), (tail['low'], tail['high'])):
                return tail['high'] >= p['high']
        if not self.start_logged:
            self.start_logged = True
            d = '向上' if self.cfg['startDir'] == 'up' else '向下'
            self.emit('起点方向', f'最左端无已走完的非包含K线，按约定起点方向{d}', ['065'], [tail['startRaw']])
        return self.cfg['startDir'] == 'up'

    def _ingest(self, at, high, low):
        bar = {'high': high, 'low': low}
        merged = False
        if len(self.valid) == self.active_valid_start:
            self.valid.append({'index': len(self.valid), 'high': high, 'low': low, 'startRaw': at, 'endRaw': at})
        else:
            tail = self.valid[-1]
            if either((tail['low'], tail['high']), (low, high)):
                up = self._resolve_dir(tail, bar)
                lo, hi = merge((tail['low'], tail['high']), (low, high), up)
                tail['low'], tail['high'], tail['endRaw'] = lo, hi, at
                merged = True
                reason = '向上合并：高点取较高者、低点取较高者' if up else '向下合并：低点取较低者、高点取较低者'
                self.emit('合并', reason, ['062', '065'], [tail['startRaw'], at])
            else:
                self.valid.append({'index': len(self.valid), 'high': high, 'low': low, 'startRaw': at, 'endRaw': at})
        self._update_fractals(at, merged)

    def _update_fractals(self, at, merged):
        L = len(self.valid)
        if L - self.active_valid_start < 3:
            return
        a, b, c = self.valid[L - 3], self.valid[L - 2], self.valid[L - 1]
        tri = [(a['low'], a['high']), (b['low'], b['high']), (c['low'], c['high'])]
        typ = 'top' if top3(tri) else ('bottom' if bot3(tri) else None)

        if not merged:
            if self.candidate:
                fx = self.candidate
                fx['status'] = 'confirmed'
                fx['confirmedAt'] = at
                fx['dependencyKeys'].append(f'raw:{self.active_continuity}:{at}')
                self._register('fractal', fx)
                self.candidate = None
                self.confirmed.append(fx)
                self.emit('分型确认', '第三根已冻结（不再是尾根），分型确认', ['062', '065'], [fx['startRaw'], fx['endRaw']], fx['id'])
                self._on_confirmed(fx, at)
        elif self.candidate:
            old = self.candidate
            if typ is None or typ != old['type']:
                reason = '尾根被合并改写，三根结构不再满足分型定义' if typ is None else '尾根被合并改写，分型类型改变'
                self.emit('分型撤销', reason, ['062', '065'], [old['startRaw'], old['endRaw']], old['id'])
                self.candidate = None
            else:
                old['endRaw'] = c['endRaw']
                old['dependencyKeys'] = [f'raw:{self.active_continuity}:{i}' for i in range(a['startRaw'], c['endRaw'] + 1)]

        if typ and not self.candidate:
            fx = {
                'id': 0, 'key': f"fx:{self.active_continuity}:{typ}:{b['startRaw']}:{b['endRaw']}",
                'continuityId': self.active_continuity, 'quality': 'verified',
                'dependencyKeys': [f'raw:{self.active_continuity}:{i}' for i in range(a['startRaw'], c['endRaw'] + 1)],
                'type': typ, 'middle': L - 2,
                'price': b['high'] if typ == 'top' else b['low'],
                'midHigh': b['high'], 'midLow': b['low'],
                'startRaw': a['startRaw'], 'endRaw': c['endRaw'],
                'status': 'candidate', 'confirmedAt': None,
            }
            self.candidate = self._register('fractal', fx)
            self.emit('分型候选', '三根结构满足分型定义，第三根仍是尾根，列为候选', ['062'], [fx['startRaw'], fx['endRaw']], fx['id'])

    def _on_confirmed(self, fx, at):
        K = self.kept
        if not K:
            K.append(fx)
            return
        last = K[-1]
        if fx['type'] == last['type']:
            lb = self.bis[-1] if self.bis else None
            changed = False
            while K and K[-1]['type'] == fx['type'] and more_extreme(fx, K[-1]):
                e = K.pop()
                reason = '前顶低于后顶，单向剔除前顶' if fx['type'] == 'top' else '前底高于后底，单向剔除前底'
                self.emit('剔除', reason, ['077'], [e['startRaw'], e['endRaw']], e['id'])
                if lb and lb['end'] == e['id']:
                    changed = True
            if changed and lb:
                lb['end'] = fx['id']
                lb['dir'] = 'up' if fx['type'] == 'top' else 'down'
                start_fx = next(f for f in self.confirmed if f['id'] == lb['start'])
                lb['key'] = f"bi:{self.active_continuity}:{start_fx['key']}:{fx['key']}"
                lb['dependencyKeys'] = [start_fx['key'], fx['key']]
                self._register('bi', lb)
                self.emit('改端点', '出现更极端的同类分型，候选笔端点改为新分型', ['077'], [fx['startRaw'], fx['endRaw']], lb['id'])
            K.append(fx)
        else:
            while len(K) >= 2 and K[-2]['type'] == K[-1]['type']:
                e = K.pop()
                self.emit('剔除', '同串取首：保留连续同类中最先一个（最极端），其余剔除', ['077'], [e['startRaw'], e['endRaw']], e['id'])
            e = K[-1]
            ok, reason = check_bi(e, fx, self.cfg['biRule'])
            if ok:
                lb = self.bis[-1] if self.bis else None
                if lb and lb['end'] == e['id']:
                    lb['status'] = 'confirmed'
                    lb['confirmedAt'] = at
                    lb['dependencyKeys'].append(fx['key'])
                    self._register('bi', lb)
                    self.emit('笔确认', '下一笔形成，上一笔终点冻结确认', ['077'], [e['startRaw'], e['endRaw']], lb['id'])
                    self._update_segments(at)
                bi = {'id': 0, 'key': f"bi:{self.active_continuity}:{e['key']}:{fx['key']}",
                      'continuityId': self.active_continuity, 'quality': 'verified', 'dependencyKeys': [e['key'], fx['key']],
                      'start': e['id'], 'end': fx['id'], 'dir': 'up' if fx['type'] == 'top' else 'down',
                      'status': 'candidate', 'confirmedAt': None}
                self.bis.append(self._register('bi', bi))
                self.emit('笔候选', '相反分型满足独立K线与价格条件，连成候选笔', ['077'], [e['startRaw'], fx['endRaw']], bi['id'])
                K.append(fx)
            else:
                self.emit('剔除', reason, ['077'], [fx['startRaw'], fx['endRaw']], fx['id'])

    def _update_segments(self, at):
        confirmed_bis = [b for b in self.bis if b['status'] == 'confirmed' and b['continuityId'] == self.active_continuity]
        fx_by_id = {f['id']: f for f in self.confirmed}
        all_segs = detect_segments(confirmed_bis, fx_by_id, self.valid, self.cfg)
        for s in all_segs:
            existed = f"segment:{s['key']}" in self.frozen
            self._register('segment', s)
            if s['status'] == 'confirmed' and not existed:
                self.emit('线段确认', '特征序列出现分型，线段破坏确认', ['067'], [s['startRaw'], s['endRaw']], s['id'])
        self.segs = self._retain(self.segs, all_segs)
        self.seg_candidate = next((s for s in all_segs if s['status'] == 'candidate'), None)
        self._update_centers(at)

    def _update_centers(self, at):
        use_bi = self.cfg['centerUnit'] == '笔中枢'

        def fxraw(fx):
            mb = self.valid[fx['middle']]
            return (mb['startRaw'] + mb['endRaw']) / 2 if mb else fx['startRaw']

        if use_bi:
            fx_by_id = {f['id']: f for f in self.confirmed}
            units = []
            for b in self.bis:
                if b['status'] != 'confirmed' or b['continuityId'] != self.active_continuity:
                    continue
                s = fx_by_id[b['start']]
                e = fx_by_id[b['end']]
                units.append({'low': min(s['price'], e['price']), 'high': max(s['price'], e['price']),
                              'startRaw': fxraw(s), 'endRaw': fxraw(e), 'dir': b['dir'],
                              **{k: b[k] for k in ('key', 'continuityId', 'quality', 'confirmedAt')}})
        else:
            units = [{k: s[k] for k in ('low', 'high', 'startRaw', 'endRaw', 'dir', 'key', 'continuityId', 'quality', 'confirmedAt')}
                     for s in self.segs if s['continuityId'] == self.active_continuity]
        all_c = detect_centers(units, self.cfg)
        for c in all_c:
            c['degree'] = 1
            existed = f"center:{c['key']}" in self.frozen
            self._register('center', c)
            if c['status'] == 'confirmed' and not existed:
                self.emit('中枢确认', '中枢终结确认（离开后回抽不回，或延伸9段升级）', ['018', '033'], [c['startRaw'], c['endRaw']], c['id'])
        self.centers = self._retain(self.centers, all_c)
        self.center_candidate = next((c for c in all_c if c['status'] == 'candidate'), None)
        self._update_trends(at)
        self._cache_levels()

    def _update_trends(self, at):
        all_t = detect_trends([c for c in self.centers if c['continuityId'] == self.active_continuity], self.cfg)
        for t in all_t:
            existed = f"trend:{t['key']}" in self.frozen
            self._register('trend', t)
            if t['status'] == 'confirmed' and not existed:
                self.emit('走势类型', f"走势类型：{t['kind']}（含{len(t['centerIds'])}个中枢）", ['017'], [t['startRaw'], t['endRaw']], t['id'])
        self.trends = self._retain(self.trends, all_t)
        self.trend_candidate = next((t for t in all_t if t['status'] == 'candidate'), None)
        self._update_divergences(at, all_t)

    def _update_divergences(self, at, all_trends):
        hist = self.macd_series['hist'] if self.macd_has_close else None
        centers = [c for c in self.centers if c['continuityId'] == self.active_continuity]
        segs = [s for s in self.segs if s['continuityId'] == self.active_continuity]
        all_d = detect_divergences(all_trends, centers, self.raw_bars, hist, self.cfg, segs)
        for d in all_d:
            existed = f"divergence:{d['key']}" in self.frozen
            self._register('divergence', d)
            if d['status'] == 'confirmed' and not existed:
                reason = f"{d['kind']}：c段力度{d['cForce']:.2f} < b段{d['bForce']:.2f}（{d['metric']}）"
                self.emit('背驰确认', reason, ['024', '027'], [d['cStart'], d['cEnd']], d['id'])
        self.divergences = self._retain(self.divergences, all_d)
        self.div_candidate = next((d for d in all_d if d['status'] == 'candidate'), None)
        self._update_points(at, all_d)

    def _update_points(self, at, all_divergences):
        divs = [d for d in self._retain(self.divergences, all_divergences) if d['continuityId'] == self.active_continuity]
        if self.div_candidate:
            divs.append(self.div_candidate)
        centers = [c for c in self.centers if c['continuityId'] == self.active_continuity]
        segs = [s for s in self.segs if s['continuityId'] == self.active_continuity]
        all_p = detect_points(divs, centers, self.confirmed, self.valid, self.raw_bars, self.cfg, segs, 'completed-movements')
        for p in all_p:
            if p['klass'] != 2:
                self._register('point', p)
        first_by_key = {p['key']: p['id'] for p in self.points + all_p if p['klass'] == 1}
        for p in all_p:
            if p['klass'] == 2:
                p['refId'] = first_by_key.get(p['refKey'])
                self._register('point', p)
        old_keys = {p['key'] for p in self.points if p['status'] == 'confirmed'}
        for p in all_p:
            if p['status'] == 'confirmed' and p['key'] not in old_keys:
                label = f"{'买' if p['side']=='buy' else '卖'}点·{['一','二','三'][p['klass']-1]}类"
                self.emit('买点确认' if p['side'] == 'buy' else '卖点确认', f"{label}@价格{p['price']:.2f}", ['020'], [p['atRaw']], p['id'])
        self.points = self._retain([p for p in self.points if p['status'] == 'confirmed'], all_p) + [p for p in all_p if p['status'] == 'candidate']

    def result(self):
        fractals = self.confirmed + ([self.candidate] if self.candidate else [])
        segments = self.segs + ([self.seg_candidate] if self.seg_candidate else [])
        centers = self.centers + ([self.center_candidate] if self.center_candidate else [])
        trends = self.trends + ([self.trend_candidate] if self.trend_candidate else [])
        divergences = self.divergences + ([self.div_candidate] if self.div_candidate else [])
        result = {
            'configId': self.config_id, 'config': self.cfg,
            'inputCount': self.raw_count, 'sourceEvidence': self.sources, 'levels': self.levels,
            'validBars': list(self.valid),
            'fractals': fractals,
            'bis': list(self.bis),
            'segments': segments,
            'centers': centers,
            'trends': trends,
            'divergences': divergences,
            'points': list(self.points),
            'events': list(self.events),
        }
        if self.macd_has_close:
            result['macd'] = self.macd_series
        return deepcopy(result)


def compute(bars, cfg):
    r = Replay(cfg)
    for b in bars:
        r.push(b)
    return r.result()


def analyze_as_of(bars, cfg, as_of_ms):
    if not finite(as_of_ms):
        raise ValueError('asOfMs 必须为有限物理时间')
    previous, count = -math.inf, 0
    for b in bars:
        known = bar_known_at(b)
        if known is None:
            raise ValueError(f"无法解析行情时间: {b['date']}")
        if known < previous:
            raise ValueError(f"行情时间逆序: {b['date']}")
        previous = known
        if known <= as_of_ms:
            count += 1
    return {**compute(bars[:count], cfg), 'asOfMs': as_of_ms}
