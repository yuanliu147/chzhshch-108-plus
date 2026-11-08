# -*- coding: utf-8 -*-
"""组装《缠论新手学习实践手册》单文件 HTML，并做引文与配图核验。"""
import html
import json
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
OUT = HERE.parent
sys.path.insert(0, str(OUT))
from 整理核验 import corpus, quote_match, comment_layer  # noqa: E402

FIGS = json.loads((HERE / '配图.json').read_text(encoding='utf-8'))
RECORDS = {r['课号']: r for r in corpus()}


def esc(s):
    return html.escape(str(s), quote=True)


def render_figures(content):
    used = []

    def sub(m):
        attrs = dict(re.findall(r'(data-[\w-]+)="([^"]*)"', m.group(1)))
        key = attrs.get('data-fig', '')
        if key not in FIGS:
            raise SystemExit('未知配图key：' + key)
        used.append(key)
        fig = FIGS[key]
        cap = attrs.get('data-cap') or fig['title']
        return ('<figure><p class="hint">图：' + esc(fig['title']) + '　·　手机上可左右滑动看全图</p>'
                '<div class="figscroll">' + fig['svg'] + '</div>'
                '<figcaption>' + esc(cap) + '</figcaption></figure>')

    content = re.sub(r'<figure\b([^>]*)>\s*</figure>', sub, content)
    return content, used


def build_nav(content):
    # 约定：正文里每个章节写成 <section id="xxx" data-nav="显示名">
    nav = re.findall(r'<section[^>]*\bid="([^"]+)"[^>]*\bdata-nav="([^"]+)"', content)
    ids = re.findall(r'<section[^>]*\bid="([^"]+)"', content)
    if len(nav) != len(ids):
        raise SystemExit('有章节缺 data-nav 或 id/data-nav 顺序不符：%d / %d' % (len(nav), len(ids)))
    return ''.join('<a href="#%s">%s</a>' % (esc(i), esc(t)) for i, t in nav), len(nav)


def check_quotes(content):
    evidence, problems = [], []
    for m in re.finditer(r'<q\b([^>]*)>(.*?)</q>', content, re.S):
        attrs = dict(re.findall(r'(data-[\w-]+)="([^"]*)"', m.group(1)))
        quote = re.sub(r'<[^>]+>', '', m.group(2))
        quote = html.unescape(quote).strip()
        src = attrs.get('data-src', '')
        layer = attrs.get('data-layer', 'body')
        rec = RECORDS.get(src)
        if not rec:
            problems.append({'引文': quote, '问题': '课号不存在：' + src})
            continue
        full = rec['正文'] + rec['评论']
        hay = rec['正文'] if layer == 'body' else full
        pos = quote_match(quote, hay)
        if pos is None and layer == 'body':
            pos = quote_match(quote, full)
        if pos is None:
            problems.append({'引文': quote, '课号': src, '问题': '逐字不匹配'})
            continue
        where = comment_layer(full, pos[0], len(rec['正文']))
        if layer == 'comment' and '署名缠中说禅' not in where:
            problems.append({'引文': quote, '课号': src, '问题': '标注为署名评论但实际层级为：' + where})
        evidence.append({'课号': src, '引文': quote, '层级': where,
                         '原文路径': rec['原文路径'], '位置': pos[0]})
    return evidence, problems


def main():
    tpl = (HERE / '手册模板.html').read_text(encoding='utf-8')
    content = (HERE / '手册正文.html').read_text(encoding='utf-8')
    content, used = render_figures(content)
    nav, nsec = build_nav(content)
    gates = re.findall(r'data-gate="([^"]+)"', content)
    badges = ''.join('<span class="badge">%s</span>' % esc(b) for b in [
        '8 个关卡', '%d 张教学配图' % len(FIGS), '每关含判定步骤与确认时点',
        '原文课号可回查', '离线单文件', '收益未检验',
    ])
    page = tpl.replace('__CONTENT__', content).replace('__NAV__', nav).replace('__BADGES__', badges)
    left = re.findall(r'__[A-Z][A-Z_]+__', page)
    if left:
        raise SystemExit('占位符残留：' + str(set(left)))
    evidence, problems = check_quotes(content)
    unused = sorted(set(FIGS) - set(used))
    dup = sorted({k for k in used if used.count(k) > 1})
    missing_sec = re.findall(r'<section\b(?![^>]*\bid=)[^>]*>', content)
    report = {
        '输出文件': str(OUT / '缠论新手学习实践手册.html'),
        '字节数': len(page.encode('utf-8')),
        '章节数': nsec, '关卡勾选数': len(gates),
        '配图总数': len(FIGS), '配图使用数': len(used), '未使用配图': unused, '重复使用配图': dup,
        '引文数': len(evidence), '引文问题': problems, '无id章节': len(missing_sec),
    }
    if problems or unused or dup or missing_sec:
        (HERE / '手册核验.json').write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding='utf-8')
        raise SystemExit('核验未通过：' + json.dumps({k: report[k] for k in ('引文问题', '未使用配图', '重复使用配图', '无id章节')}, ensure_ascii=False))
    (OUT / '缠论新手学习实践手册.html').write_text(page, encoding='utf-8')
    (HERE / '手册核验.json').write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding='utf-8')
    (HERE / '手册引文证据.jsonl').write_text(
        ''.join(json.dumps(e, ensure_ascii=False) + '\n' for e in evidence), encoding='utf-8')
    print('组装完成：%d 字节，%d 章节，%d 图，%d 处引文全部逐字匹配' %
          (report['字节数'], nsec, len(used), len(evidence)))


if __name__ == '__main__':
    main()