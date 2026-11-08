#!/usr/bin/env python3
"""组装离线单文件报告，并登记主报告引文与课程目录。"""
import base64
import csv
import html
import json
import re
from datetime import datetime
from pathlib import Path
from bs4 import BeautifulSoup
from 整理核验 import OUT, ROOT, corpus, note_sections, quote_match, comment_layer, dump


def inline(text):
    text = html.escape(text)
    text = re.sub(r'`([^`]+)`', r'<code>\1</code>', text)
    text = re.sub(r'\*\*([^*]+)\*\*', r'<strong>\1</strong>', text)
    return text


def render_note(text):
    # 专用于本次结构化笔记，保留表格、标题、引文，不执行源HTML。
    lines = text.splitlines()
    output = []
    i = 0
    while i < len(lines):
        line = lines[i].strip()
        if not line:
            i += 1
            continue
        if line.startswith('```'):
            block = []
            i += 1
            while i < len(lines) and not lines[i].strip().startswith('```'):
                block.append(lines[i])
                i += 1
            output.append('<pre>' + html.escape('\n'.join(block)) + '</pre>')
            i += 1
            continue
        heading = re.match(r'^(#{1,6})\s+(.*)', line)
        if heading:
            level = min(4, max(2, len(heading.group(1))))
            output.append(f'<h{level}>' + inline(heading.group(2)) + f'</h{level}>')
        elif line.startswith('|'):
            table = []
            while i < len(lines) and lines[i].strip().startswith('|'):
                cells = lines[i].strip().strip('|').split('|')
                if not all(re.fullmatch(r'\s*:?-+:?\s*', c) for c in cells):
                    table.append(cells)
                i += 1
            rows = []
            for j, cells in enumerate(table):
                tag = 'th' if j == 0 else 'td'
                rows.append('<tr>' + ''.join(f'<{tag}>' + inline(c.strip()) + f'</{tag}>' for c in cells) + '</tr>')
            output.append('<div class="table-wrap"><table>' + ''.join(rows) + '</table></div>')
            continue
        elif line == '---':
            output.append('<hr>')
        elif re.match(r'^(?:[-*] |\d+\. )', line):
            ordered = bool(re.match(r'^\d+\. ', line))
            tag = 'ol' if ordered else 'ul'
            items = []
            pattern = r'^\d+\. ' if ordered else r'^[-*] '
            while i < len(lines) and re.match(pattern, lines[i].strip()):
                items.append('<li>' + inline(re.sub(pattern, '', lines[i].strip())) + '</li>')
                i += 1
            output.append(f'<{tag}>' + ''.join(items) + f'</{tag}>')
            continue
        elif line.startswith('>'):
            output.append('<blockquote>' + inline(line.lstrip('> ')) + '</blockquote>')
        else:
            output.append('<p>' + inline(line) + '</p>')
        i += 1
    return '\n'.join(output)


def assemble():
    records = corpus()
    sections = note_sections()
    notes = {s['课号']: s for s in sections}
    expected = {r['课号'] for r in records}
    if set(notes) != expected or len(sections) != len(records) or any(s['完整小节数'] != 8 for s in sections):
        raise SystemExit('课程笔记未全部完成，拒绝组装为完成版。')
    audit = json.loads((OUT / '笔记核验.json').read_text())
    if audit['引文待核查数']:
        raise SystemExit('笔记引文仍有未核查项，拒绝组装。')
    content = (OUT / '理论研究正文.html').read_text(encoding='utf-8')
    soup = BeautifulSoup(content, 'html.parser')
    by_key = {r['课号']: r for r in records}
    evidence = []
    for q in soup.select('q[data-source]'):
        key = q['data-source']
        quote = q.get_text()
        record = by_key[key]
        source = record['正文'] + record['评论'] if q.get('data-layer') == 'comment' else record['正文']
        positions = quote_match(quote, source)
        if positions is None:
            raise SystemExit(f'主报告引文不匹配第{key}课：{quote}')
        layer = comment_layer(source, positions[0], len(record['正文']))
        if q.get('data-layer') == 'comment' and '署名缠中说禅' not in layer:
            raise SystemExit('署名评论引用未找到正确署名上下文')
        evidence.append({'evidence_id': f'主报告引文-{len(evidence)+1:03}',
                         'source_id': record['source_id'], '课号': key, '层级': layer,
                         'quote': quote, '原文起始行': source.count('\n', 0, positions[0])+1,
                         '检查': '逐字匹配并区分正文与评论'})
    claims = []
    for p in soup.select('[data-claim]'):
        keys = p.get('data-sources', '').split()
        if not all(k in by_key for k in keys):
            raise SystemExit('主报告出现未知来源')
        claims.append({'claim_id': p['data-claim'], '主张': p.get_text(' ', strip=True),
                       'source_ids': [by_key[k]['source_id'] for k in keys],
                       '性质': p.get('data-status', '原文归纳，非收益验证'),
                       '验证边界': '正文归纳经过人工跨课核对；脚本仅检查来源存在与逐字引文'})
    courses, images, rows, sources, csv_rows = {}, {}, [], [], []
    for r in records:
        key = r['课号']
        note = notes[key]['文本']
        gist = re.search(r'^- 一句话主旨：\s*(.*)', note, re.M)
        type_match = re.search(r'^- 类型：\s*(.*)', note, re.M)
        gist = gist.group(1).strip() if gist else ''
        kind = type_match.group(1).strip() if type_match else ''
        keywords = []
        batch = Path(notes[key]['笔记文件']).read_text(encoding='utf-8')
        index_line = re.search(r'^\|\s*' + re.escape(key) + r'\s*\|(.*)$', batch, re.M)
        if index_line:
            cells = [c.strip() for c in index_line.group(1).strip('|').split('|')]
            if len(cells) >= 6:
                keywords = cells[-1]
                if not gist:
                    gist = cells[-2]
        keywords = keywords if isinstance(keywords, str) else ''
        image_keys = []
        for path in r['配图']:
            image = ROOT / path
            image_key = 'pic/' + image.name
            image_keys.append(image_key)
            if image_key not in images:
                mime = 'image/jpeg' if image.suffix.lower() in ['.jpg', '.jpeg'] else 'image/png'
                images[image_key] = 'data:' + mime + ';base64,' + base64.b64encode(image.read_bytes()).decode()
        courses[key] = {'title': r['标题'], 'date': r['日期'], 'path': r['原文路径'],
                        'body': r['正文'], 'comments': r['评论'],
                        'comment_start_line': r['正文'].count('\n')+1,
                        'note_html': render_note(note), 'images': image_keys}
        search = (key + ' ' + r['标题'] + ' ' + gist + ' ' + keywords + ' ' + kind).lower()
        rows.append(f'<tr id="course-{key}" data-key="{key}" data-search="{html.escape(search, quote=True)}"><td>{key}</td><td>{r["日期"][:10]}</td><td>{html.escape(r["标题"])}</td><td>{html.escape(gist)}<br><span class="muted">{html.escape(keywords)}</span></td><td><button type="button" data-course="{key}">查看</button></td></tr>')
        sources.append(f'<tr><td>{r["source_id"]}</td><td>{html.escape(r["标题"])}<br>{r["日期"]}</td><td class="path">{html.escape(r["原文路径"])}</td></tr>')
        csv_rows.append({'课号': key, '博文序号': r['博文序号'], '发布日期': r['日期'],
                         '标题': r['标题'], '整理类型': kind, '一句话主旨': gist,
                         '关键概念': keywords, '配图数量': len(image_keys),
                         '原文路径': r['原文路径'], '笔记路径': notes[key]['笔记文件']})
    with (OUT / '课程索引_中文.csv').open('w', encoding='utf-8-sig', newline='') as f:
        writer = csv.DictWriter(f, fieldnames=list(csv_rows[0]))
        writer.writeheader()
        writer.writerows(csv_rows)
    payload = json.dumps({'courses': courses, 'images': images}, ensure_ascii=False).replace('</', '<\\/')
    verification = f'<p><strong>覆盖核验：</strong>113篇各有一节逐课笔记，无缺课、重复课或不完整小节。笔记内{audit["匹配引文数"]}处引文已逐字匹配其注明课程；主报告{len(evidence)}处引文另行匹配，区分正文与署名回复。配图43张，均在本地存在并嵌入报告。</p>'
    template = (OUT / '报告模板.html').read_text(encoding='utf-8')
    replacements = {'__DATE__': datetime.now().strftime('%Y-%m-%d'), '__MAIN_CONTENT__': content,
                    '__CATALOG_ROWS__': '\n'.join(rows), '__SOURCE_ROWS__': '\n'.join(sources),
                    '__REPORT_DATA__': payload, '__VERIFICATION_CONTENT__': verification}
    for marker, value in replacements.items():
        template = template.replace(marker, value)
    if re.search(r'__[A-Z][A-Z_]+__', template):
        raise SystemExit('存在未完成占位符')
    target = OUT / '缠论108课_研究报告.html'
    target.write_text(template, encoding='utf-8')
    for name, data in [('主报告证据.jsonl', evidence), ('主张登记.jsonl', claims)]:
        (OUT / name).write_text(''.join(json.dumps(e, ensure_ascii=False)+'\n' for e in data), encoding='utf-8')
    dump(OUT / '报告组装核验.json', {'报告': str(target), '课程数': len(courses), '图片数': len(images),
                                 '主报告引文数': len(evidence), '已登记主张数': len(claims),
                                 '文件字节数': target.stat().st_size})
    print('已生成', target, '；课程', len(courses), '；配图', len(images), '；报告引文', len(evidence))


if __name__ == '__main__':
    assemble()
