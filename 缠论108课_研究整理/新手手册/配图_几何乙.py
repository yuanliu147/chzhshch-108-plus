# -*- coding: utf-8 -*-
"""笔的配图：成笔条件、价格区间条件、同类分型剔除。人工合成示意。"""
from 配图基础 import Figure


def fig_bi():
    g = Figure('fig-bi', '成笔的三种情况：独立K线是关键',
               '左：顶分型用第1至3根、底分型用第3至5根，第3根被两个分型共用，违反结合律，不算一笔。'
               '中：顶分型第1至3根、底分型第4至6根，顶底之间没有不属于任一分型的K线，一般不算一笔。'
               '右：顶分型第1至3根、底分型第5至7根，第4根为独立K线，构成最基本的一笔。',
               760, 268)
    cases = [
        (8, '① 共用K线 → 不算一笔',
         [(10, 13), (12, 16), (11, 14), (6, 9), (7, 10)], (0, 2), (2, 4), 2,
         '第3根同时属于两个分型，违反结合律'),
        (262, '② 中间无独立K线 → 一般不算',
         [(10, 13), (12, 16), (11, 14), (8, 11), (6, 9), (7, 10)], (0, 2), (3, 5), None,
         '顶底之间0根独立K线，转折级别太小'),
        (516, '③ 有独立K线 → 一笔成立',
         [(10, 13), (12, 16), (11, 14), (9, 12), (8, 11), (6, 9), (7, 10)], (0, 2), (4, 6), 3,
         '第4根独立 → 顶16到底6为一笔'),
    ]
    for x0, title, sp, ta, tb, hi, note in cases:
        n = len(sp)
        g.ptitle(x0 + 2, 26, title)
        p = g.panel(x0, 40, 236, 200, 4.5, 17.5, n, pad_l=10, pad_r=10, pad_t=20, pad_b=24)
        p.axis(xlabels=[(i, str(i + 1)) for i in range(n)])
        p.zone(ta[0], ta[1], 4.5, 17.5, 'grpA')
        p.zone(tb[0], tb[1], 4.5, 17.5, 'grpB')
        p.bars(sp)
        if hi is not None:
            p.bar(hi, sp[hi][0], sp[hi][1], 'kbad' if x0 == 8 else 'khl')
        if x0 == 516:
            p.segline(1, 16, 5, 6, 'bi')
            p.dot(1, 16, 'toppoint', 4.5)
            p.dot(5, 6, 'botpoint', 4.5)
            p.tag(3, 12, '独立K线', 'tb', dy=-16)
        else:
            p.cross((ta[1] + tb[0]) / 2.0, 5.4, 'bad')
        g.text((p.X(ta[0]) + p.X(ta[1])) / 2, p.y + 13, '顶分型', 'ts', 'middle')
        g.text((p.X(tb[0]) + p.X(tb[1])) / 2, p.y + 13, '底分型', 'ts', 'middle')
        g.text(x0 + 2, 258, note, 'ts')
    g.caption('第62课：顶和底之间必须至少有一根K线。第77课：至少有一根K线不属于顶分型与底分型。')
    g.caption('先顶后底＝向下一笔；先底后顶＝向上一笔。相邻的顶和底才能连，隔了几个就不是。', 'ts')
    g.caption('蓝底＝顶分型范围，绿底＝底分型范围，红K＝被共用的K线，亮蓝K＝独立K线。人工示意。', 'ts')
    return g


def fig_bi_jiage():
    g = Figure('fig-bi-jiage', '第77课补充：顶K线区间要有一部分高于底K线区间',
               '合格例：顶分型中最高那根K线区间11至16，底分型中最低那根K线区间6至9，11至16全部高于9，条件满足。'
               '不合格例：顶K线区间10至12，底K线区间7至13，顶区间整个落在底区间内，虽然顶12高于底7，仍不可接受。',
               760, 232)
    for x0, title, top, bot, ok in (
        (10, '合格：顶区间高于底区间', (11, 16), (6, 9), True),
        (390, '不合格：顶都在底范围内', (10, 12), (7, 13), False),
    ):
        g.ptitle(x0 + 2, 26, title)
        p = g.panel(x0, 36, 350, 170, 5, 17, 2, pad_l=32, pad_r=92, pad_t=16, pad_b=28)
        p.axis(ticks=[6, 9, 12, 15], xlabels=[(0, '顶分型最高K线'), (1, '底分型最低K线')])
        p.hline(bot[1], 0, 1, 'aux', '底区间上沿%g' % bot[1])
        if ok:
            p.zone(0, 0, bot[1], top[1], 'ok')
        p.bar(0, top[0], top[1], 'kgood' if ok else 'kbad')
        p.bar(1, bot[0], bot[1], 'k')
        p.tag(0, top[1], '[%g,%g]' % top, 'tb', dy=-12)
        p.tag(1, bot[0], '[%g,%g]' % bot, 'tb', dy=20)
        if not ok:
            p.cross(0, 11, 'bad')
        g.text(x0 + 34, 222, '顶区间全部高于%g ✓' % bot[1] if ok else '顶12＞底7，但没有部分高于13 ✗', 'ts')
    g.caption('第77课原文：顶分型中最高那K线的区间至少要有一部分高于底分型中最低那K线的区间。', 'ts')
    g.caption('绿色＝满足条件的部分。此为价格区间示意，不是完整K线图。', 'ts')
    return g


def fig_bi_tichu():
    g = Figure('fig-bi-tichu', '划笔三步骤：同类分型先剔除',
               '分型序列为底8、顶14、顶16、底10、底9、顶15。顶14低于后面的顶16，剔除顶14；'
               '底10高于后面的底9，剔除底10。剩下底8、顶16、底9、顶15交替，连成三笔。',
               760, 278)
    pts = [(0, 8), (1, 14), (2, 16), (3, 10), (4, 9), (5, 15)]
    names = ['底1', '顶1', '顶2', '底2', '底3', '顶3']
    g.ptitle(12, 26, '步骤一：标出所有分型')
    p = g.panel(10, 36, 360, 200, 6, 18, 6, pad_l=30, pad_r=14, pad_t=20, pad_b=26)
    p.axis(ticks=[8, 11, 14, 17])
    p.path(pts, 'path')
    for (i, v), nm in zip(pts, names):
        top = nm.startswith('顶')
        p.dot(i, v, 'toppoint' if top else 'botpoint', 4.5)
        p.tag(i, v, '%s=%g' % (nm, v), 'ts', dy=-12 if top else 18)
    p.cross(1, 14, 'bad')
    p.cross(3, 10, 'bad')
    g.text(12, 250, '顶1=14 低于 顶2=16 → X掉顶1', 'ts')
    g.text(12, 268, '底2=10 高于 底3=9 → X掉底2', 'ts')
    g.arrow(378, 130, 396, 130)
    g.ptitle(400, 26, '步骤二三：余下相邻顶底连成笔')
    q = g.panel(398, 36, 352, 200, 6, 18, 6, pad_l=30, pad_r=14, pad_t=20, pad_b=26)
    q.axis(ticks=[8, 11, 14, 17])
    keep = [(0, 8), (2, 16), (4, 9), (5, 15)]
    q.path(keep, 'bi')
    for i, v in keep:
        top = v in (16, 15)
        q.dot(i, v, 'toppoint' if top else 'botpoint', 5)
        q.tag(i, v, '%g' % v, 'tb', dy=-12 if top else 18)
    q.tag(1, 12.4, '向上一笔', 'ts', dy=0)
    q.tag(3, 13.2, '向下一笔', 'ts', dy=0)
    q.tag(4.6, 12.6, '向上', 'ts', dy=0)
    g.text(400, 250, '相等的分型先保留，不急着X掉', 'ts')
    g.text(400, 268, '同类之间若还有别的顶底，那是好几笔', 'ts')
    g.caption('第77课步骤：① 确定所有符合标准的分型；② 同类比较，顶留更高、底留更低；')
    g.caption('③ 余下相邻顶底划为一笔；若仍相邻同性，取连续同类中最先一个与新出现的相反分型连笔，中间X掉。', 'ts')
    return g