# -*- coding: utf-8 -*-
"""缠论参考管线（Python 独立实现）。

依 chan-viewer/设计说明.md「引擎操作规格」独立实现第 1–3 关增量管线，
作为 TS 引擎的交叉核验基准（非转译）。只读、无第三方依赖。
事件字符串与结构为规格定义的常量，两实现必须逐根一致。
"""
import math

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
                'hiBi': last['hiBi'] if last['high'] >= e['high'] else e['hiBi'],
                'loBi': last['loBi'] if last['low'] <= e['low'] else e['loBi'],
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

    def mk_seg(endFx, status):
        a = fx_raw(startFx, valid)
        b = fx_raw(endFx, valid)
        return {
            'id': 0, 'dir': dir_, 'startFx': startFx['id'], 'endFx': endFx['id'],
            'startRaw': min(a, b), 'endRaw': max(a, b),
            'high': max(startFx['price'], endFx['price']),
            'low': min(startFx['price'], endFx['price']),
            'status': status, 'confirmedAt': None,
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
                if pending:
                    pending = None
            continue
        el = {'low': bi['iv'][0], 'high': bi['iv'][1], 'hiBi': k, 'loBi': k}
        if pending:
            pending['secondFeat'].append(el)
            sf = standardize(pending['secondFeat'], not up) if do_merge else pending['secondFeat']
            if len(sf) >= 3:
                tri = [(x['low'], x['high']) for x in sf[-3:]]
                hit = bot3(tri) if up else top3(tri)
                if hit:
                    return {'seg': mk_seg(pending['breakFx'], 'confirmed'), 'next': pending['breakBi']}
            continue
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
            return {'seg': mk_seg(breakFx, 'confirmed'), 'next': breakBi}
        pending = {'breakFx': breakFx, 'breakBi': breakBi, 'secondFeat': []}

    return {'seg': mk_seg(extreme_fx, 'candidate'), 'next': n}


def detect_segments(bis, fx_by_id, valid, cfg):
    touch = cfg['touchOverlap'] == '相接算重叠'
    do_merge = cfg['segMerge'] == '做包含处理'
    info = []
    for b in bis:
        s = fx_by_id.get(b['start'])
        e = fx_by_id.get(b['end'])
        if s is None or e is None:
            return []
        info.append({'iv': (min(s['price'], e['price']), max(s['price'], e['price'])),
                     'startFx': s, 'endFx': e, 'dir': b['dir']})
    segs = []
    i = 0
    n = len(bis)
    while i < n:
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


def detect_centers(units, cfg):
    # units: list of dict {low, high, startRaw, endRaw, dir}。
    touch = cfg['touchOverlap'] == '相接算重叠'
    upgrade = cfg['centerUpgrade'] == '9段升级'
    centers = []
    n = len(units)
    i = 0
    iv = lambda u: (u['low'], u['high'])
    while i + 2 < n:
        core = overlap_all([iv(units[i]), iv(units[i + 1]), iv(units[i + 2])], touch)
        if core is None:
            i += 1
            continue
        end_unit = i + 2
        seg_count = 3
        status = 'candidate'
        pending_leave = -1
        nxt = n
        for j in range(i + 3, n):
            u = units[j]
            if overlap(iv(u), core, touch):
                pending_leave = -1
                end_unit = j
                seg_count += 1
                if upgrade and seg_count >= 9:
                    status = 'confirmed'
                    nxt = j + 1
                    break
            elif pending_leave < 0:
                pending_leave = j
            else:
                status = 'confirmed'
                end_unit = pending_leave - 1
                nxt = pending_leave
                break
        if status == 'candidate':
            end_unit = n - 1
            nxt = n
        zs = [iv(units[k]) for k in range(i, end_unit + 1, 2)]
        b = center_bounds(zs)
        centers.append({
            'id': 0, 'unit': 'segment', 'dir': units[i]['dir'],
            'startRaw': units[i]['startRaw'], 'endRaw': units[end_unit]['endRaw'],
            'ZG': core[1], 'ZD': core[0],
            'GG': b['GG'], 'DD': b['DD'], 'G': b['G'], 'D': b['D'],
            'segCount': seg_count, 'status': status, 'confirmedAt': None,
        })
        if status == 'candidate':
            break
        i = nxt
    for k, c in enumerate(centers):
        c['id'] = k + 1
    return centers


# ---- 第6关 走势类型（17/18/20课），与 TS trend.ts 对齐 ----

def trend_step(a, b, cfg):
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
    n = len(cs)
    i = 0
    while i < n:
        ids = [cs[i]['id']]
        dir_ = None
        j = i + 1
        while j < n:
            step = trend_step(cs[j - 1], cs[j], cfg)
            if step and (dir_ is None or step == dir_):
                dir_ = step
                ids.append(cs[j]['id'])
                j += 1
            else:
                break
        kind = ('上涨' if dir_ == 'up' else '下跌') if len(ids) >= 2 else '盘整'
        trends.append({'id': 0, 'kind': kind, 'centerIds': ids,
                       'startRaw': cs[i]['startRaw'], 'endRaw': cs[i + len(ids) - 1]['endRaw'],
                       'status': 'candidate', 'confirmedAt': None})
        i += len(ids)
    for k, t in enumerate(trends):
        t['id'] = k + 1
        t['status'] = 'confirmed' if k < len(trends) - 1 else 'candidate'
    return trends


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
        return area_between(hist, a, b, dir_ == 'up') if hist else 0.0
    return abs(price_at(bars, b) - price_at(bars, a))  # 几何：段净位移


def detect_divergences(trends, centers, bars, hist, cfg):
    metric = cfg['divMetric']
    if metric == 'MACD面积' and not hist:
        return []
    by_id = {c['id']: c for c in centers}
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
        A = by_id.get(B['id'] - 1)  # 前一同级中枢
        if A is None:
            continue
        is_trend = T['kind'] != '盘整'
        b_start = A['startRaw']
        b_end = B['startRaw']
        is_last = t == n - 1
        c_start = B['startRaw']
        window_end = last_raw if is_last else trends[t + 1]['startRaw']
        if is_trend:
            dir_ = 'up' if T['kind'] == '上涨' else 'down'
        else:
            dir_ = 'up' if price_at(bars, window_end) >= price_at(bars, c_start) else 'down'
        c_end = extreme_raw(bars, c_start, window_end, dir_)
        b_force = force_of(bars, hist, b_start, b_end, dir_, metric)
        c_force = force_of(bars, hist, c_start, c_end, dir_, metric)
        est = T['status'] == 'candidate'
        if est and metric == 'MACD面积':
            c_force *= 2
        if not (c_force < b_force):
            continue
        out.append({'id': 0, 'kind': '趋势背驰' if is_trend else '盘整背驰', 'metric': metric,
                    'dir': dir_, 'bStart': b_start, 'bEnd': b_end, 'cStart': c_start, 'cEnd': c_end,
                    'bForce': b_force, 'cForce': c_force, 'est': est,
                    'status': 'candidate' if est else 'confirmed', 'confirmedAt': None})
    for k, d in enumerate(out):
        d['id'] = k + 1
    return out


# ---- 第8关 买卖点（20/21/101课），与 TS point.ts 对齐 ----

def detect_points(divergences, centers, fractals, valid, bars, cfg):
    out = []
    confirmed_fx = [f for f in fractals if f['status'] == 'confirmed']

    def fxraw(f):
        mb = valid[f['middle']]
        return (mb['startRaw'] + mb['endRaw']) / 2 if mb else f['startRaw']

    for d in divergences:
        if d['kind'] != '趋势背驰':
            continue
        i = max(0, min(len(bars) - 1, math.floor(d['cEnd'] + 0.5)))
        b = bars[i]
        if d['dir'] == 'down':
            out.append({'id': 0, 'side': 'buy', 'klass': 1, 'atRaw': d['cEnd'], 'price': b['low'], 'refId': d['id'], 'status': d['status'], 'confirmedAt': None})
        else:
            out.append({'id': 0, 'side': 'sell', 'klass': 1, 'atRaw': d['cEnd'], 'price': b['high'], 'refId': d['id'], 'status': d['status'], 'confirmedAt': None})

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
                    out.append({'id': 0, 'side': 'buy', 'klass': 3, 'atRaw': fxraw(retest), 'price': retest['price'], 'refId': c['id'], 'status': 'confirmed', 'confirmedAt': None})
        if down_leave >= 0:
            retest = next((f for f in confirmed_fx if f['type'] == 'top' and fxraw(f) > down_leave), None)
            if retest:
                ok = retest['price'] <= c['ZD'] if cfg['bsp3Touch'] == '不跌破ZG' else retest['price'] < c['ZD']
                if ok:
                    out.append({'id': 0, 'side': 'sell', 'klass': 3, 'atRaw': fxraw(retest), 'price': retest['price'], 'refId': c['id'], 'status': 'confirmed', 'confirmedAt': None})

    for b1 in [p for p in out if p['klass'] == 1 and p['side'] == 'buy']:
        up = next((f for f in confirmed_fx if f['type'] == 'top' and fxraw(f) > b1['atRaw']), None)
        if not up:
            continue
        b2 = next((f for f in confirmed_fx if f['type'] == 'bottom' and fxraw(f) > fxraw(up)), None)
        if not b2:
            continue
        if cfg['bsp2Filter'] == '过滤二买须高于一买' and not (b2['price'] > b1['price']):
            continue
        out.append({'id': 0, 'side': 'buy', 'klass': 2, 'atRaw': fxraw(b2), 'price': b2['price'], 'refId': b1['id'], 'status': 'confirmed', 'confirmedAt': None})
    for s1 in [p for p in out if p['klass'] == 1 and p['side'] == 'sell']:
        down = next((f for f in confirmed_fx if f['type'] == 'bottom' and fxraw(f) > s1['atRaw']), None)
        if not down:
            continue
        s2 = next((f for f in confirmed_fx if f['type'] == 'top' and fxraw(f) > fxraw(down)), None)
        if not s2:
            continue
        if cfg['bsp2Filter'] == '过滤二买须高于一买' and not (s2['price'] < s1['price']):
            continue
        out.append({'id': 0, 'side': 'sell', 'klass': 2, 'atRaw': fxraw(s2), 'price': s2['price'], 'refId': s1['id'], 'status': 'confirmed', 'confirmedAt': None})

    out.sort(key=lambda p: (p['atRaw'], p['klass'], 0 if p['side'] == 'buy' else 1))
    for k, p in enumerate(out):
        p['id'] = k + 1
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
        self.point_id_by_key = {}
        self.next_point_id = 1
        self.confirmed_point_keys = set()
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
        d = self.cfg['precision']['digits']
        high = round_price(bar['high'], d)
        low = round_price(bar['low'], d)
        self._ingest(self.cur_at, high, low)
        return self.events[start:]

    def _resolve_dir(self, tail, bar):
        if self.cfg['mergeDir'] == '直接用前一根':
            return bar['high'] >= tail['high']
        for i in range(len(self.valid) - 2, -1, -1):
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
        if not self.valid:
            self.valid.append({'index': 0, 'high': high, 'low': low, 'startRaw': at, 'endRaw': at})
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
        if L < 3:
            return
        a, b, c = self.valid[L - 3], self.valid[L - 2], self.valid[L - 1]
        tri = [(a['low'], a['high']), (b['low'], b['high']), (c['low'], c['high'])]
        typ = 'top' if top3(tri) else ('bottom' if bot3(tri) else None)

        if not merged:
            if self.candidate:
                fx = self.candidate
                fx['status'] = 'confirmed'
                fx['confirmedAt'] = at
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

        if typ and not self.candidate:
            fx = {
                'id': self.next_fx, 'type': typ, 'middle': L - 2,
                'price': b['high'] if typ == 'top' else b['low'],
                'midHigh': b['high'], 'midLow': b['low'],
                'startRaw': a['startRaw'], 'endRaw': c['endRaw'],
                'status': 'candidate', 'confirmedAt': None,
            }
            self.next_fx += 1
            self.candidate = fx
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
                    self.emit('笔确认', '下一笔形成，上一笔终点冻结确认', ['077'], [e['startRaw'], e['endRaw']], lb['id'])
                    self._update_segments(at)
                bi = {'id': self.next_bi, 'start': e['id'], 'end': fx['id'],
                      'dir': 'up' if fx['type'] == 'top' else 'down',
                      'status': 'candidate', 'confirmedAt': None}
                self.next_bi += 1
                self.bis.append(bi)
                self.emit('笔候选', '相反分型满足独立K线与价格条件，连成候选笔', ['077'], [e['startRaw'], fx['endRaw']], bi['id'])
                K.append(fx)
            else:
                self.emit('剔除', reason, ['077'], [fx['startRaw'], fx['endRaw']], fx['id'])

    def _update_segments(self, at):
        confirmed_bis = [b for b in self.bis if b['status'] == 'confirmed']
        fx_by_id = {f['id']: f for f in self.confirmed}
        all_segs = detect_segments(confirmed_bis, fx_by_id, self.valid, self.cfg)
        confirmed = [s for s in all_segs if s['status'] == 'confirmed']
        for k in range(len(self.segs), len(confirmed)):
            s = confirmed[k]
            s['confirmedAt'] = at
            self.emit('线段确认', '特征序列出现分型，线段破坏确认', ['067'], [s['startRaw'], s['endRaw']], s['id'])
        self.segs = confirmed
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
                if b['status'] != 'confirmed':
                    continue
                s = fx_by_id[b['start']]
                e = fx_by_id[b['end']]
                units.append({'low': min(s['price'], e['price']), 'high': max(s['price'], e['price']),
                              'startRaw': fxraw(s), 'endRaw': fxraw(e), 'dir': b['dir']})
        else:
            units = [{'low': s['low'], 'high': s['high'], 'startRaw': s['startRaw'],
                      'endRaw': s['endRaw'], 'dir': s['dir']} for s in self.segs]
        all_c = detect_centers(units, self.cfg)
        for c in all_c:
            c['unit'] = 'bi' if use_bi else 'segment'
        confirmed = [c for c in all_c if c['status'] == 'confirmed']
        for k in range(len(self.centers), len(confirmed)):
            c = confirmed[k]
            c['confirmedAt'] = at
            self.emit('中枢确认', '中枢终结确认（离开后回抽不回，或延伸9段升级）', ['018', '033'], [c['startRaw'], c['endRaw']], c['id'])
        self.centers = confirmed
        self.center_candidate = next((c for c in all_c if c['status'] == 'candidate'), None)
        self._update_trends(at)

    def _update_trends(self, at):
        all_t = detect_trends(self.centers, self.cfg)
        confirmed = [t for t in all_t if t['status'] == 'confirmed']
        for k in range(len(self.trends), len(confirmed)):
            t = confirmed[k]
            t['confirmedAt'] = at
            self.emit('走势类型', f"走势类型：{t['kind']}（含{len(t['centerIds'])}个中枢）", ['017'], [t['startRaw'], t['endRaw']], t['id'])
        self.trends = confirmed
        self.trend_candidate = next((t for t in all_t if t['status'] == 'candidate'), None)
        self._update_divergences(at, all_t)

    def _macd_full(self):
        if not self.raw_bars:
            return None
        closes = [b.get('close') for b in self.raw_bars]
        if any(c is None for c in closes):
            return None
        return macd(closes)

    def _update_divergences(self, at, all_trends):
        m = self._macd_full()
        hist = m['hist'] if m else None
        all_d = detect_divergences(all_trends, self.centers, self.raw_bars, hist, self.cfg)
        confirmed = [d for d in all_d if d['status'] == 'confirmed']
        for k in range(len(self.divergences), len(confirmed)):
            d = confirmed[k]
            d['confirmedAt'] = at
            reason = f"{d['kind']}（{'上涨' if d['dir']=='up' else '下跌'}）：c段力度{d['cForce']:.2f} < b段{d['bForce']:.2f}（{d['metric']}）"
            self.emit('背驰确认', reason, ['024', '027'], [d['cStart'], d['cEnd']], d['id'])
        self.divergences = confirmed
        self.div_candidate = next((d for d in all_d if d['status'] == 'candidate'), None)
        self._update_points(at, all_d)

    def _update_points(self, at, all_divergences):
        all_p = detect_points(all_divergences, self.centers, self.confirmed, self.valid, self.raw_bars, self.cfg)
        for p in all_p:
            key = f"{p['side']}{p['klass']}@{p['atRaw']:.2f}#{p.get('refId') if p.get('refId') is not None else ''}"
            if key not in self.point_id_by_key:
                self.point_id_by_key[key] = self.next_point_id
                self.next_point_id += 1
            p['id'] = self.point_id_by_key[key]
            if p['status'] == 'confirmed' and key not in self.confirmed_point_keys:
                self.confirmed_point_keys.add(key)
                label = f"{'买' if p['side']=='buy' else '卖'}点·{['一','二','三'][p['klass']-1]}类"
                self.emit('买点确认' if p['side'] == 'buy' else '卖点确认', f"{label}@价格{p['price']:.2f}", ['020'], [p['atRaw']], p['id'])
        self.points = all_p

    def result(self):
        fractals = self.confirmed + ([self.candidate] if self.candidate else [])
        segments = self.segs + ([self.seg_candidate] if self.seg_candidate else [])
        centers = self.centers + ([self.center_candidate] if self.center_candidate else [])
        trends = self.trends + ([self.trend_candidate] if self.trend_candidate else [])
        divergences = self.divergences + ([self.div_candidate] if self.div_candidate else [])
        m = self._macd_full()
        return {
            'configId': self.config_id,
            'validBars': list(self.valid),
            'fractals': fractals,
            'bis': list(self.bis),
            'segments': segments,
            'centers': centers,
            'trends': trends,
            'divergences': divergences,
            'points': list(self.points),
            'macd': m,
            'events': list(self.events),
        }


def compute(bars, cfg):
    r = Replay(cfg)
    for b in bars:
        r.push(b)
    return r.result()