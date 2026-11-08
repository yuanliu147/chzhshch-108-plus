# -*- coding: utf-8 -*-
"""汇总全部教学配图，输出 配图.json（key → svg/title/desc）。"""
import json
from pathlib import Path

import 配图_几何甲 as a
import 配图_几何乙 as b
import 配图_线段 as c
import 配图_中枢 as d
import 配图_背驰 as e
import 配图_买点 as f

OUT = Path(__file__).resolve().parent

BUILDERS = [
    a.fig_baohan, a.fig_shunxu, a.fig_fenxing, a.fig_fenxing_trap, a.fig_shidian,
    b.fig_bi, b.fig_bi_jiage, b.fig_bi_tichu,
    c.fig_seg_overlap, c.fig_seg_feature, c.fig_seg_case1, c.fig_seg_case2,
    d.fig_center_calc, d.fig_center_bounds, d.fig_center_three, d.fig_center_break,
    d.fig_level, d.fig_zoushi_type,
    e.fig_divergence, e.fig_panzheng_beichi, e.fig_qujiantao,
    f.fig_buy_panorama, f.fig_buy2_cases, f.fig_points_map,
]


def build():
    figs = {}
    for fn in BUILDERS:
        g = fn()
        if g.key in figs:
            raise SystemExit('配图key重复：' + g.key)
        figs[g.key] = {'title': g.title, 'desc': g.desc, 'svg': g.svg()}
    return figs


if __name__ == '__main__':
    figs = build()
    (OUT / '配图.json').write_text(json.dumps(figs, ensure_ascii=False, indent=1), encoding='utf-8')
    print('配图数量：', len(figs))
    for k, v in figs.items():
        print(' ', k, len(v['svg']), v['title'])