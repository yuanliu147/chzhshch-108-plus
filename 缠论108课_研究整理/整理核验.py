#!/usr/bin/env python3
"""本地缠论文献登记与逐字引用检查；不联网、不改原始资料。"""
import argparse
import csv
import hashlib
import json
import re
from pathlib import Path

OUT = Path(__file__).resolve().parent
ROOT = OUT.parent / '108'
NOTES = OUT / '工作笔记'


def dump(path, data):
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding='utf-8')


def corpus():
    records = []
    for path in sorted(ROOT.glob('*.md')):
        text = path.read_text(encoding='utf-8')
        title = re.sub(r'^#\s*\d+\s*-\s*', '', text.splitlines()[0]).strip()
        match = re.search(r'教你炒股票\s*(\d+)\s*[:：]', title)
        lesson = f'{int(match.group(1)):03}' if match else '附-' + path.name[:4]
        date = re.search(r'日期：\(([^)]+)\)', text)
        cut = text.find('**本文评论获取')
        body, comments = (text[:cut], text[cut:]) if cut >= 0 else (text, '')
        blocks = re.findall(r'```\s*\n(.*?)\n```', comments, re.S)
        declared = re.search(r'回复数量：\[(\d+)\]', comments)
        images = re.findall(r'!\[[^\]]*\]\(([^)]+)\)', body)
        records.append({
            'source_id': '博文-' + path.name[:4], '课号': lesson,
            '博文序号': path.name[:4], '日期': date.group(1) if date else '',
            '标题': title, '原文路径': str(path), '文件名': path.name,
            '正文': body, '评论': comments,
            '正文非空白字符数': len(re.sub(r'\s', '', body)),
            '评论块数': len(blocks),
            '署名作者评论块数': sum(bool(re.search(r'UID:\[1215172700\]\s*昵称：缠中说禅\s*日期：', block)) for block in blocks),
            '导出标注疑似回复数': int(declared.group(1)) if declared else None,
            '配图': images, 'sha256': hashlib.sha256(path.read_bytes()).hexdigest(),
        })
    return records


def note_sections():
    result = []
    for path in sorted(NOTES.glob('批次*.md')):
        text = path.read_text(encoding='utf-8')
        for m in re.finditer(r'^## (?:第(\d+)课|附篇·博文(\d+))[^\n]*\n(.*?)(?=^## |\Z)', text, re.M | re.S):
            key = f'{int(m.group(1)):03}' if m.group(1) else '附-' + m.group(2)
            result.append({'课号': key, '笔记文件': str(path),
                           '笔记行号': text.count('\n', 0, m.start()) + 1,
                           '文本': m.group(0),
                           '完整小节数': len(re.findall(r'^###\s+[1-8](?:\.|\s)', m.group(0), re.M))})
    return result


def quote_match(quote, source):
    # ……代表省略，分片必须按顺序在同一源文本中逐字存在；不做标点归一。
    parts = [part for part in re.split(r'……|\.\.\.', quote) if part]
    if not parts:
        return None
    end = 0
    starts = []
    for part in parts:
        start = source.find(part, end)
        if start < 0:
            return None
        starts.append(start)
        end = start + len(part)
    return starts


def comment_layer(source, pos, body_length):
    if pos < body_length:
        return '正文'
    headers = list(re.finditer(r'UID:\[(\d+)\]\s*昵称：([^\n]+?)\s*日期：', source[:pos]))
    if headers and '缠中说禅' == headers[-1].group(2).strip():
        return '评论区·署名缠中说禅（按本地导出）'
    return '评论区·其他署名或匿名（不认定为作者）'


def audit(records, sections):
    by_key = {r['课号']: r for r in records}
    problems, evidence, coverage = [], [], []
    for section in sections:
        key = section['课号']
        r = by_key.get(key)
        coverage.append({k: section[k] for k in ['课号', '笔记文件', '笔记行号', '完整小节数']})
        if not r:
            problems.append({'类型': '未知课号', '课号': key})
            continue
        source = r['正文'] + r['评论']
        for m in re.finditer(r'「([^「」]+)」', section['文本']):
            quote = m.group(1)
            source = r['正文'] + r['评论']
            positions = quote_match(quote, source)
            line = section['笔记行号'] + section['文本'].count('\n', 0, m.start())
            matched = r
            cross_reference = False
            if positions is None:
                alternatives = [s for s in records if quote_match(quote, s['正文'] + s['评论']) is not None]
                line_start = section['文本'].rfind('\n', 0, m.start()) + 1
                line_end = section['文本'].find('\n', m.end())
                context = section['文本'][line_start:line_end if line_end >= 0 else len(section['文本'])]
                explicit = [s for s in alternatives if s['文件名'] in context or
                            (s['课号'].isdigit() and re.search(r'第\s*0*'+str(int(s['课号']))+r'课', context))]
                if explicit:
                    matched = explicit[0]
                    source = matched['正文'] + matched['评论']
                    positions = quote_match(quote, source)
                    cross_reference = True
                else:
                    problems.append({'类型': '引文不匹配所注明来源', '课号': key, '笔记文件': section['笔记文件'],
                                     '笔记行号': line, '引文': quote,
                                     '匹配其他课': [s['课号'] for s in alternatives]})
            if positions is not None:
                evidence.append({'evidence_id': f'引文-{len(evidence)+1:05}',
                                 'source_id': matched['source_id'], '课号': matched['课号'],
                                 '笔记所在课号': key, 'quote': quote,
                                 '原文起始行': source.count('\n', 0, positions[0]) + 1,
                                 '层级': comment_layer(source, positions[0], len(matched['正文'])),
                                 '笔记文件': section['笔记文件'], '笔记行号': line,
                                 '检查': '明确跨课引用逐字匹配' if cross_reference else '逐字匹配'})
    for path in sorted({s['笔记文件'] for s in sections}):
        text = Path(path).read_text(encoding='utf-8')
        start = text.find('## 本批汇总')
        if start < 0:
            continue
        summary = text[start:]
        batch_keys = {s['课号'] for s in sections if s['笔记文件'] == path}
        for m in re.finditer(r'「([^「」]+)」', summary):
            quote = m.group(1)
            matches = [(r, quote_match(quote, r['正文'] + r['评论'])) for r in records if r['课号'] in batch_keys]
            matches = [(r, pos) for r, pos in matches if pos is not None]
            line = text.count('\n', 0, start+m.start())+1
            if not matches:
                problems.append({'类型': '汇总引文不匹配本批', '课号': '汇总', '笔记文件': path,
                                 '笔记行号': line, '引文': quote})
            else:
                r, positions = matches[0]
                source = r['正文'] + r['评论']
                evidence.append({'evidence_id': f'引文-{len(evidence)+1:05}', 'source_id': r['source_id'],
                                 '课号': r['课号'], 'quote': quote,
                                 '原文起始行': source.count('\n', 0, positions[0])+1,
                                 '层级': comment_layer(source, positions[0], len(r['正文'])),
                                 '笔记文件': path, '笔记行号': line, '检查': '汇总逐字匹配本批来源'})
    expected = set(by_key)
    seen = [s['课号'] for s in sections]
    counts = {key: seen.count(key) for key in set(seen)}
    report = {
        '源文件数': len(records), '笔记章节数': len(sections),
        '未覆盖课号': sorted(expected - set(seen)),
        '重复课号': {key: count for key, count in counts.items() if count > 1},
        '小节不完整': [s for s in coverage if s['完整小节数'] != 8],
        '匹配引文数': len(evidence), '引文待核查数': len(problems),
        '问题': problems, '覆盖明细': coverage,
    }
    return report, evidence


def register(records):
    registry = [{k: r[k] for k in ['source_id', '课号', '博文序号', '日期', '标题', '原文路径', 'sha256']} for r in records]
    (OUT / '来源登记.jsonl').write_text(''.join(json.dumps(r, ensure_ascii=False) + '\n' for r in registry), encoding='utf-8')
    dump(OUT / '本地资料.json', records)
    images = sorted((ROOT / 'pic').iterdir())
    numbered = [int(r['课号']) for r in records if r['课号'].isdigit()]
    missing_images = [str(ROOT / image) for r in records for image in r['配图'] if not (ROOT / image).exists()]
    dump(OUT / '研究清单.json', {
        '范围': '用户提供的本地108课与5篇附文；不联网、不回测、不修改原文',
        '资料性质': '同一作者博客的本地导出；不是113个独立实证来源',
        '评论边界': '正文、按导出署名缠中说禅的评论、其他署名或匿名评论分开；不确认匿名者为作者',
        '源文件数': len(records), '编号课数': len(numbered),
        '缺失编号课': sorted(set(range(1, 109)) - set(numbered)),
        '配图数': len(images), '缺失配图': missing_images,
        '正文非空白字符总数': sum(r['正文非空白字符数'] for r in records),
        '实际评论块总数': sum(r['评论块数'] for r in records),
        '署名缠中说禅评论块总数': sum(r['署名作者评论块数'] for r in records),
        '导出标注总数': sum(r['导出标注疑似回复数'] or 0 for r in records),
        '原始资料哈希': {str(p.relative_to(ROOT)): hashlib.sha256(p.read_bytes()).hexdigest()
                       for p in list(ROOT.glob('*.md')) + images},
    })
    fields = ['课号', '博文序号', '日期', '标题', '正文非空白字符数', '评论块数', '导出标注疑似回复数', '配图数量', '原文路径']
    with (OUT / '原文目录_中文.csv').open('w', encoding='utf-8-sig', newline='') as f:
        writer = csv.DictWriter(f, fieldnames=fields)
        writer.writeheader()
        for r in records:
            writer.writerow({**{k: r[k] for k in fields if k != '配图数量'}, '配图数量': len(r['配图'])})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--登记', action='store_true')
    parser.add_argument('--核验', action='store_true')
    args = parser.parse_args()
    records = corpus()
    if args.登记:
        register(records)
        print('完成来源登记：', len(records), '篇；原文只读。')
    if args.核验:
        report, evidence = audit(records, note_sections())
        dump(OUT / '笔记核验.json', report)
        (OUT / '引用证据.jsonl').write_text(''.join(json.dumps(e, ensure_ascii=False) + '\n' for e in evidence), encoding='utf-8')
        print(json.dumps({k: v for k, v in report.items() if k not in ['问题', '覆盖明细']}, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
