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


def canonical_config(c):
    import json
    obj = {'startDir': c['startDir'], 'digits': c['precision']['digits'],
           'biRule': c['biRule'], 'mergeDir': c['mergeDir']}
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
                bi = {'id': self.next_bi, 'start': e['id'], 'end': fx['id'],
                      'dir': 'up' if fx['type'] == 'top' else 'down',
                      'status': 'candidate', 'confirmedAt': None}
                self.next_bi += 1
                self.bis.append(bi)
                self.emit('笔候选', '相反分型满足独立K线与价格条件，连成候选笔', ['077'], [e['startRaw'], fx['endRaw']], bi['id'])
                K.append(fx)
            else:
                self.emit('剔除', reason, ['077'], [fx['startRaw'], fx['endRaw']], fx['id'])

    def result(self):
        fractals = self.confirmed + ([self.candidate] if self.candidate else [])
        return {
            'configId': self.config_id,
            'validBars': list(self.valid),
            'fractals': fractals,
            'bis': list(self.bis),
            'events': list(self.events),
        }


def compute(bars, cfg):
    r = Replay(cfg)
    for b in bars:
        r.push(b)
    return r.result()