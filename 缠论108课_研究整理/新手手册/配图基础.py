# -*- coding: utf-8 -*-
"""缠论新手手册·教学配图基础构件。

所有 K 线、价格、MACD 数值都是人工合成的教学示意，不是任何真实标的的行情，
也不演示收益。图形只用来解释原文定义长什么样、按什么顺序判定。
"""


def esc(s):
    return str(s).replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')


def f(v):
    return ('%.2f' % float(v)).rstrip('0').rstrip('.')


class Figure:
    """一张完整配图，可含多个子面板。底部说明文字自动换行并自动撑高。"""

    def __init__(self, key, title, desc, w=760, h=300):
        self.key = key
        self.title = title
        self.desc = desc
        self.w = w
        self.h = h
        self.parts = []
        self.captions = []

    def caption(self, s, cls='t'):
        """图下方的说明句：不画进固定坐标，由 svg() 自动换行排版。"""
        self.captions.append((s, cls))

    def _wrapped(self):
        lines = []
        maxw = self.w - 30
        for s, cls in self.captions:
            size = 13.0 if cls == 't' else 11.5
            cur, cw = '', 0.0
            for ch in s:
                # 全角按字号估宽，半角按 0.55 倍，宁早换行不越界
                w = size if ord(ch) >= 0x2010 else size * 0.55
                if cw + w > maxw and cur:
                    lines.append((cur, cls))
                    cur, cw = ch, w
                else:
                    cur += ch
                    cw += w
            if cur:
                lines.append((cur, cls))
        return lines

    def add(self, s):
        self.parts.append(s)
        return s

    def text(self, x, y, s, cls='t', anchor='start'):
        return self.add('<text x="%s" y="%s" class="%s" text-anchor="%s">%s</text>'
                        % (f(x), f(y), cls, anchor, esc(s)))

    def rect(self, x, y, w, h, cls='frame'):
        return self.add('<rect x="%s" y="%s" width="%s" height="%s" class="%s"/>'
                        % (f(x), f(y), f(w), f(h), cls))

    def line(self, x1, y1, x2, y2, cls='aux'):
        return self.add('<line x1="%s" y1="%s" x2="%s" y2="%s" class="%s"/>'
                        % (f(x1), f(y1), f(x2), f(y2), cls))

    def arrow(self, x1, y1, x2, y2, cls='aux'):
        self.add('<line x1="%s" y1="%s" x2="%s" y2="%s" class="%s" marker-end="url(#arw)"/>'
                 % (f(x1), f(y1), f(x2), f(y2), cls))

    def raw(self, s):
        return self.add(s)

    def panel(self, x, y, w, h, pmin, pmax, n, pad_l=34, pad_r=12, pad_t=26, pad_b=22):
        return Panel(self, x, y, w, h, pmin, pmax, n, pad_l, pad_r, pad_t, pad_b)

    def ptitle(self, x, y, s, cls='pt'):
        return self.text(x, y, s, cls)

    def svg(self):
        defs = ('<defs><marker id="arw" viewBox="0 0 10 10" refX="9" refY="5"'
                ' markerWidth="7" markerHeight="7" orient="auto-start-reverse">'
                '<path d="M0 0L10 5L0 10z" fill="#868e96"/></marker></defs>')
        lines = self._wrapped()
        h = self.h
        tail = ''
        if lines:
            y = self.h + 16
            for s, cls in lines:
                tail += '<text x="12" y="%s" class="%s">%s</text>' % (f(y), cls, esc(s))
                y += 20 if cls == 't' else 18
            h = y - 20 + 14
        return ('<svg viewBox="0 0 %d %d" role="img" aria-labelledby="%s-t %s-d">'
                '<title id="%s-t">%s</title><desc id="%s-d">%s</desc>%s%s%s</svg>'
                % (self.w, h, self.key, self.key, self.key, esc(self.title),
                   self.key, esc(self.desc), defs, ''.join(self.parts), tail))


class Panel:
    """一个带价格纵轴的子图。i 为横轴槽位（可为小数），p 为价格。"""

    def __init__(self, fig, x, y, w, h, pmin, pmax, n, pad_l, pad_r, pad_t, pad_b):
        self.fig = fig
        self.x, self.y, self.w, self.h = x, y, w, h
        self.pmin, self.pmax = float(pmin), float(pmax)
        self.n = n
        self.ix = x + pad_l
        self.iy = y + pad_t
        self.iw = w - pad_l - pad_r
        self.ih = h - pad_t - pad_b
        self.dx = self.iw / float(n)

    def X(self, i):
        return self.ix + (float(i) + 0.5) * self.dx

    def Y(self, p):
        return self.iy + (self.pmax - float(p)) / (self.pmax - self.pmin) * self.ih

    def span_x(self, i0, i1):
        return self.X(i0) - self.dx / 2.0, self.X(i1) + self.dx / 2.0

    # ---- 坐标轴 -------------------------------------------------
    def axis(self, ticks=(), xlabels=()):
        g = self.fig
        g.line(self.ix - 6, self.iy, self.ix - 6, self.iy + self.ih, 'axis')
        g.line(self.ix - 6, self.iy + self.ih, self.ix + self.iw, self.iy + self.ih, 'axis')
        for p in ticks:
            y = self.Y(p)
            g.line(self.ix - 6, y, self.ix + self.iw, y, 'grid')
            g.text(self.ix - 10, y + 4, f(p), 'num', 'end')
        for i, s in xlabels:
            g.text(self.X(i), self.y + self.h - 5, s, 'ts', 'middle')

    # ---- K 线（只画高低区间，原文口径：不分阴阳） ------------------
    def bar(self, i, lo, hi, cls='k', cap=True):
        g = self.fig
        x = self.X(i)
        y1, y2 = self.Y(hi), self.Y(lo)
        g.line(x, y1, x, y2, cls)
        if cap:
            w = self.dx * 0.30
            g.line(x - w, y1, x + w, y1, cls + 'cap')
            g.line(x - w, y2, x + w, y2, cls + 'cap')

    def bars(self, specs, cls='k', start=0):
        for j, sp in enumerate(specs):
            self.bar(start + j, sp[0], sp[1], cls)

    # ---- 折线 / 笔 / 线段 ----------------------------------------
    def path(self, pts, cls='path'):
        d = 'M' + 'L'.join('%s %s' % (f(self.X(i)), f(self.Y(p))) for i, p in pts)
        self.fig.add('<path d="%s" class="%s"/>' % (d, cls))

    def segline(self, i0, p0, i1, p1, cls='seg'):
        self.fig.line(self.X(i0), self.Y(p0), self.X(i1), self.Y(p1), cls)

    # ---- 区间 ----------------------------------------------------
    def zone(self, i0, i1, plo, phi, cls='zone'):
        x0, x1 = self.span_x(i0, i1)
        y0, y1 = self.Y(phi), self.Y(plo)
        self.fig.rect(x0, y0, x1 - x0, y1 - y0, cls)

    def band(self, plo, phi, cls='zone', i0=0, i1=None):
        i1 = self.n - 1 if i1 is None else i1
        self.zone(i0, i1, plo, phi, cls)

    def hline(self, p, i0=0, i1=None, cls='aux', label=None, anchor='start'):
        i1 = self.n - 1 if i1 is None else i1
        x0, x1 = self.span_x(i0, i1)
        self.fig.line(x0, self.Y(p), x1, self.Y(p), cls)
        if label:
            self.fig.text(x1 + 4 if anchor == 'start' else x0 - 4, self.Y(p) + 4,
                          label, 'ts', anchor)

    def vline(self, i, cls='aux', p0=None, p1=None):
        p0 = self.pmin if p0 is None else p0
        p1 = self.pmax if p1 is None else p1
        self.fig.line(self.X(i), self.Y(p0), self.X(i), self.Y(p1), cls)

    # ---- 标记 ----------------------------------------------------
    def dot(self, i, p, cls='buypoint', r=5.5):
        self.fig.add('<circle cx="%s" cy="%s" r="%s" class="%s"/>'
                     % (f(self.X(i)), f(self.Y(p)), f(r), cls))

    def tag(self, i, p, s, cls='tb', dy=-12, dx=0, anchor='middle'):
        self.fig.text(self.X(i) + dx, self.Y(p) + dy, s, cls, anchor)

    def tri(self, i, p, up=True, cls='uptri'):
        x, y = self.X(i), self.Y(p)
        d = ('M%s %sL%s %sL%s %sz' % (f(x), f(y - 9), f(x - 6), f(y - 1), f(x + 6), f(y - 1))) if up else \
            ('M%s %sL%s %sL%s %sz' % (f(x), f(y + 9), f(x - 6), f(y + 1), f(x + 6), f(y + 1)))
        self.fig.add('<path d="%s" class="%s"/>' % (d, cls))

    def bracket(self, i0, i1, p, s, cls='ts', below=False, dy=6):
        x0, x1 = self.X(i0), self.X(i1)
        y = self.Y(p)
        o = dy if below else -dy
        self.fig.add('<path d="M%s %sL%s %sL%s %sL%s %s" class="brk"/>'
                     % (f(x0), f(y + o - (3 if below else -3)), f(x0), f(y + o),
                        f(x1), f(y + o), f(x1), f(y + o - (3 if below else -3))))
        self.fig.text((x0 + x1) / 2.0, y + o + (14 if below else -6), s, cls, 'middle')

    def note(self, x, y, s, cls='ts', anchor='start'):
        self.fig.text(self.x + x, self.y + y, s, cls, anchor)

    def cross(self, i, p, cls='bad'):
        x, y = self.X(i), self.Y(p)
        self.fig.line(x - 6, y - 6, x + 6, y + 6, cls)
        self.fig.line(x - 6, y + 6, x + 6, y - 6, cls)


def macd_panel(fig, x, y, w, h, values, vmax, n=None):
    """MACD 柱状子图：values 为柱高（正红负绿），vmax 为对称量程。"""
    n = len(values) if n is None else n
    p = fig.panel(x, y, w, h, -vmax, vmax, n, pad_l=34, pad_r=12, pad_t=18, pad_b=20)
    p.axis(ticks=(-vmax, 0, vmax))
    zero = p.Y(0)
    for i, v in enumerate(values):
        if abs(v) < 1e-9:
            continue
        x0 = p.X(i) - p.dx * 0.34
        y0 = p.Y(max(v, 0))
        hh = abs(p.Y(v) - zero)
        fig.rect(x0, y0, p.dx * 0.68, max(hh, 0.6), 'macdUp' if v > 0 else 'macdDn')
    fig.line(p.ix - 6, zero, p.ix + p.iw, zero, 'axis')
    return p