# -*- coding: utf-8 -*-
"""生成配图预览页，用于目视检查排版（不是交付物）。"""
import json
import re
from pathlib import Path

HERE = Path(__file__).resolve().parent
figs = json.loads((HERE / '配图.json').read_text(encoding='utf-8'))
tpl = (HERE / '手册模板.html').read_text(encoding='utf-8')
css = re.search(r'<style>(.*?)</style>', tpl, re.S).group(1)
body = []
for k, v in figs.items():
    body.append('<section id="%s"><h2>%s</h2><p class="sub">%s</p>'
                '<div class="figscroll">%s</div></section>' % (k, v['title'], v['desc'], v['svg']))
page = ('<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width,initial-scale=1">'
        '<title>配图预览</title><style>%s</style></head><body><div class="wrap">%s</div></body></html>'
        % (css, ''.join(body)))
(HERE / '配图预览.html').write_text(page, encoding='utf-8')
print('配图预览.html 已生成，%d 张' % len(figs))