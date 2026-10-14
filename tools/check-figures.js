#!/usr/bin/env node
/**
 * 课程图形/练习回归校验（开发工具，不参与教学展示）
 *
 * 用法：node tools/check-figures.js [可选的课程文件…]
 *   不带参数：校验全部课程
 *   带参数  ：只校验指定文件（用于负向测试）
 *
 * 原理：用桩对象替换 DOM 与 ChanCharts，执行每一课的内联脚本，捕获所有
 * 图形调用与练习数据，然后校验：
 *   1. 折线图 seg 标签不得落在第一个点（该段无处可画）
 *   2. 折线图标签方向：X 必须在向下段、S 必须在向上段、笔N 必须落在第 N 段
 *   3. 第1课练习：每题的分型必须唯一且等于设定答案
 *   4. 第2课：LEGIT 应为一笔、ILLEGIT 应因共用K线不算一笔
 *   5. 第3课练习A：三笔区间的交集是否为空，必须与设定答案一致
 *   6. 第3课特征序列：XBARS 必须等于 SEQ 中三条向下笔的区间，且顶分型在中间元素
 *   7. 第4课：示例图矩形、练习A选项、练习B判断、前置题math，必须与公式
 *      [max(低点), min(高点)] 算出的结果一致
 *   8. 第5课：教学图聚簇分类（盘整/上涨）、练习A分类与中枢簇、练习B
 *      （重叠→扩张判定＋原文语义）、全部选项等长、初始矩形序列
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DEFAULT_LESSONS = [
  '0001-fenxing-first-step.html',
  '0002-bi-strokes.html',
  '0003-duanxian-segments.html',
  '0004-zhongshu-pivot.html',
  '0005-trend-types.html',
  '0006-beichi-macd.html',
];
const DEFAULT_REFS = ['zhongshu-expansion.html'];
const INPUTS = process.argv.slice(2).length
  ? process.argv.slice(2).map(f => ({ file: f, base: '' }))
  : [...DEFAULT_LESSONS.map(f => ({ file: f, base: 'lessons' })),
     ...DEFAULT_REFS.map(f => ({ file: f, base: 'reference' }))];

let failures = 0;
let checks = 0;
const fail = msg => { failures++; console.log('  ✗ ' + msg); };
const ok = msg => { checks++; console.log('  ✓ ' + msg); };

/* ---------- DOM / 组件桩 ---------- */
function makeEl(id) {
  return {
    id: id || '',
    style: {}, dataset: {}, disabled: false,
    classList: { add() {}, remove() {}, contains() { return false; } },
    setAttribute() {}, addEventListener() {}, appendChild() {},
    querySelectorAll() { return []; }, querySelector(sel) { return makeEl(sel); },
    scrollIntoView() {}, innerHTML: '', textContent: '',
  };
}
const figures = [], charts = [], bars = [], zones = [];
function coords() {
  return { x: i => i * 10, y: v => v, overlay: makeEl(), centers: [], svg: makeEl(), data: [], points: [], bars: [] };
}
const ChanChartsStub = {
  renderZigzag(svg, points, opts) { figures.push({ id: svg && svg.id, points, opts }); return coords(); },
  renderCandles(svg, data, opts) { charts.push({ id: svg && svg.id, data, opts }); return coords(); },
  renderBars(svg, bs, opts) { bars.push({ id: svg && svg.id, bars: bs, opts }); return coords(); },
  zone(chart, x1, x2, lo, hi, opts) { zones.push({ lo, hi, label: opts && opts.label }); return {}; },
  stroke() {}, tag() {}, dot() {}, hasInclusion() { return false; },
};
const documentStub = {
  getElementById: id => makeEl(id),
  querySelector: sel => makeEl(sel),
  querySelectorAll: () => [],
  createElement: () => makeEl(),
  createElementNS: () => makeEl(),
  addEventListener() {},
};

/* ---------- 纯逻辑工具 ---------- */
function fractals(d) {
  const out = [];
  for (let i = 1; i < d.length - 1; i++) {
    const [a, b, c] = [d[i - 1], d[i], d[i + 1]];
    if (b.h > a.h && b.h > c.h && b.l > a.l && b.l > c.l) out.push({ i, type: '顶' });
    if (b.l < a.l && b.l < c.l && b.h < a.h && b.h < c.h) out.push({ i, type: '底' });
  }
  return out;
}
const inclusion = (a, b) => (a.h >= b.h && a.l <= b.l) || (b.h >= a.h && b.l <= a.l);

/** 连续三笔（4 个价位）的区间交集是否存在；返回 null 表示无重叠 */
function tripleOverlapRange(prices) {
  const r = [];
  for (let i = 0; i < Math.min(3, prices.length - 1); i++) {
    const [a, b] = [prices[i], prices[i + 1]];
    r.push([Math.min(a, b), Math.max(a, b)]);
  }
  const lo = Math.max(...r.map(x => x[0])), hi = Math.min(...r.map(x => x[1]));
  return lo <= hi ? [lo, hi] : null;
}

/** 走势聚类（第5课）：连续三段的非空重叠聚成"中枢簇"，并给出类型判定 */
function zigClusters(ps) {
  const segs = [];
  for (let i = 0; i < ps.length - 1; i++) segs.push([Math.min(ps[i], ps[i + 1]), Math.max(ps[i], ps[i + 1])]);
  const tris = [];
  for (let i = 0; i + 2 < segs.length; i++) {
    const lo = Math.max(segs[i][0], segs[i + 1][0], segs[i + 2][0]);
    const hi = Math.min(segs[i][1], segs[i + 1][1], segs[i + 2][1]);
    if (lo <= hi) tris.push({ lo, hi });
  }
  const clusters = [];
  tris.forEach(t => {
    const hit = clusters.find(c => t.lo <= c.hi && t.hi >= c.lo);
    if (hit) { hit.lo = Math.min(hit.lo, t.lo); hit.hi = Math.max(hit.hi, t.hi); hit.members.push(t); }
    else clusters.push({ lo: t.lo, hi: t.hi, members: [t] });
  });
  for (let guard = 0; guard <= tris.length; guard++) {
    for (let i = 0; i < clusters.length; i++) {
      for (let j = i + 1; j < clusters.length; j++) {
        if (clusters[i].lo <= clusters[j].hi && clusters[j].lo <= clusters[i].hi) {
          clusters[i].lo = Math.min(clusters[i].lo, clusters[j].lo);
          clusters[i].hi = Math.max(clusters[i].hi, clusters[j].hi);
          clusters[i].members = clusters[i].members.concat(clusters[j].members);
          clusters.splice(j, 1);
        }
      }
    }
  }
  let kind;
  if (clusters.length === 1) {
    const span = clusters[0].hi - clusters[0].lo;
    const maxSpan = Math.max(...clusters[0].members.map(m => m.hi - m.lo));
    kind = span > maxSpan ? '扩张' : '盘整';
  } else {
    const asc = clusters.every((c, i) => i === 0 || clusters[i - 1].hi < c.lo);
    const desc = clusters.every((c, i) => i === 0 || c.hi < clusters[i - 1].lo);
    kind = asc ? '上涨' : (desc ? '下跌' : '扩张');
  }
  return { tris, clusters, kind };
}

/* ---------- 逐课执行 ---------- */
for (const { file, base } of INPUTS) {
  console.log('\n=== ' + file + ' ===');
  figures.length = 0; charts.length = 0; bars.length = 0; zones.length = 0;
  const src = path.isAbsolute(file) ? file : path.join(ROOT, base, file);
  const html = fs.readFileSync(src, 'utf8');
  const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]).join('\n');
  let dumped = {};
  const dumpNames = ['EXERCISES', 'QUIZ', 'QA', 'MAIN', 'ENDS', 'SEQ', 'A1', 'A2', 'XBARS', 'LEGIT', 'ILLEGIT',
    'GATE', 'CA', 'CB', 'ZS_EX', 'FIG_PAN', 'FIG_TREND', 'TA', 'TB', 'SCENES', 'RECIPE', 'FIG_MACD', 'BA', 'BB'];
  const dumper = ';__dump({' + dumpNames.map(n => `${n}: (typeof ${n} !== 'undefined' ? ${n} : null)`).join(',') + '});';
  try {
    new Function('ChanCharts', 'document', '__dump', script + dumper)(
      ChanChartsStub, documentStub, o => { dumped = o; });
    ok('内联脚本可执行（无语法错误）');
  } catch (e) {
    fail('内联脚本执行失败: ' + e.message);
    continue;
  }

  // 1 & 2：折线图标签规则
  const beforeFigures = failures;
  figures.forEach(f => {
    const ps = f.points, tag = `${f.id || 'svg'}`;
    if (ps[0] && ps[0].seg) fail(`[${tag}] 第一个点带 seg "${ps[0].seg}"，永远不会绘制（疑为标签错位）`);
    for (let i = 1; i < ps.length; i++) {
      const a = ps[i - 1], b = ps[i], up = b.price >= a.price;
      if (!b.seg) continue;
      if (/^X/i.test(b.seg) && up) fail(`[${tag}] "${b.seg}" 落在第 ${i} 段（向上）上——X 应为向下笔`);
      if (/^S/i.test(b.seg) && !up) fail(`[${tag}] "${b.seg}" 落在第 ${i} 段（向下）上——S 应为向上笔`);
      const m = /^笔(\d+)$/.exec(b.seg);
      if (m && Number(m[1]) !== i) fail(`[${tag}] "${b.seg}" 落在第 ${i} 段上——编号与段序不符`);
    }
    const unlabeled = ps.slice(1).filter(p => !p.seg).length;
    if (unlabeled) console.log(`  · [${tag}] 提示：有 ${unlabeled} 段未标注（若有意则忽略）`);
    checks++;
  });
  if (figures.length && failures === beforeFigures) ok(`折线图 ${figures.length} 张，标签方向/编号规则通过`);

  // 3：第1课练习
  if (dumped.EXERCISES) {
    dumped.EXERCISES.forEach((ex, k) => {
      const fr = fractals(ex.candles);
      if (ex.noneBtn) {
        fr.length === 0 && ex.answer === null
          ? ok(`第1课练习${k + 1}：确认"无分型"且答案设为空`)
          : fail(`第1课练习${k + 1}：设定为无分型，但检出 ${JSON.stringify(fr)}`);
      } else {
        fr.length === 1 && fr[0].i === ex.answer
          ? ok(`第1课练习${k + 1}：分型唯一且在第 ${ex.answer + 1} 根（=答案）`)
          : fail(`第1课练习${k + 1}：检出 ${JSON.stringify(fr)}，答案设为 ${ex.answer}`);
      }
    });
  }

  // 4：第2课
  if (dumped.LEGIT && dumped.ILLEGIT) {
    const fl = fractals(dumped.LEGIT), fi = fractals(dumped.ILLEGIT);
    const incL = dumped.LEGIT.some((c, i, arr) => i && inclusion(arr[i - 1], c));
    const incI = dumped.ILLEGIT.some((c, i, arr) => i && inclusion(arr[i - 1], c));
    (fl.length === 2 && !incL && fl[1].i - fl[0].i >= 3)
      ? ok('第2课 LEGIT：一顶一底、无包含、间距足够 → 确为一笔')
      : fail(`第2课 LEGIT 数据可疑：分型 ${JSON.stringify(fl)}，包含=${incL}`);
    (fi.length === 2 && !incI && fi[1].i - fi[0].i === 2)
      ? ok('第2课 ILLEGIT：两个分型相距 2 → 共用中间K线 → 不算一笔')
      : fail(`第2课 ILLEGIT 数据可疑：分型 ${JSON.stringify(fi)}`);
  }
  if (dumped.QUIZ) {
    const zig = dumped.QUIZ[2];
    const fz = fractals(zig.candles);
    (fz.map(x => x.i).join(',') === '1,4,7,10' && zig.answer === false)
      ? ok('第2课 陷阱题：四个分型依次为 1/4/7/10，①与④之间隔着分型 → 不能连成一笔')
      : fail(`第2课 陷阱题数据可疑：${JSON.stringify(fz)}`);
  }

  // 5：第3课练习A
  if (dumped.QA) {
    dumped.QA.forEach((q, k) => {
      const prices = q.points.map(p => p.price);
      const ov = !!tripleOverlapRange(prices);
      ov === q.answer
        ? ok(`第3课练习A${k + 1}：三笔${ov ? '有' : '无'}重叠，与答案（${q.answer ? '能构成' : '不能构成'}）一致`)
        : fail(`第3课练习A${k + 1}：算出重叠=${ov}，答案设为 ${q.answer}`);
    });
  }

  // 6：第3课特征序列
  if (dumped.SEQ && dumped.XBARS) {
    const ps = dumped.SEQ.map(p => p.price);
    const downs = [];
    for (let i = 1; i < ps.length; i++) {
      if (ps[i] < ps[i - 1]) downs.push([Math.min(ps[i], ps[i - 1]), Math.max(ps[i], ps[i - 1])]);
    }
    const match = downs.length === dumped.XBARS.length && downs.every((d, i) =>
      d[0] === dumped.XBARS[i].lo && d[1] === dumped.XBARS[i].hi);
    match ? ok('第3课 XBARS 与走势图中三条向下笔的区间完全对应')
      : fail(`第3课 XBARS 与向下笔不符：向下笔=${JSON.stringify(downs)}，XBARS=${JSON.stringify(dumped.XBARS.map(b => [b.lo, b.hi]))}`);
    const X = dumped.XBARS.map(b => ({ lo: b.lo, hi: b.hi }));
    const midTop = X[1].hi > X[0].hi && X[1].hi > X[2].hi && X[1].lo > X[0].lo && X[1].lo > X[2].lo;
    const noGap = Math.min(X[0].hi, X[1].hi) >= Math.max(X[0].lo, X[1].lo);
    (midTop && noGap)
      ? ok(`第3课 特征序列：中间元素构成顶分型，且 X1–X2 无缺口 → 第一种情况，线段终点 ${X[1].hi}`)
      : fail('第3课 特征序列：顶分型或无缺口条件不成立');
  }

  // 7：第4课 中枢
  if (dumped.ZS_EX) {
    const zs = tripleOverlapRange(dumped.ZS_EX);
    const z = zones[0];
    (zs && z && z.lo === zs[0] && z.hi === zs[1])
      ? ok(`第4课 示例图：画出的矩形 [${z.lo}, ${z.hi}] 与公式算出的中枢区间一致`)
      : fail(`第4课 示例图矩形与公式不符：公式=${JSON.stringify(zs)}，矩形=${JSON.stringify(z && [z.lo, z.hi])}`);
  }
  if (dumped.GATE) {
    const no = Number(file.slice(0, 4));
    const gl = no >= 5 && no <= 9 ? `第${no}课` : '第4课';
    dumped.GATE.forEach((q, k) => {
      const valid = Array.isArray(q.opts) && q.correct >= 0 && q.correct < q.opts.length;
      if (!valid) { fail(`${gl}前置题${k + 1}：correct 下标越界`); return; }
      if (q.expectKind) {
        const c = zigClusters(q.points);
        const txt = q.opts[q.correct];
        (c.kind === q.expectKind && txt.includes(q.expectKind))
          ? ok(`${gl}前置题${k + 1}：独立分类＝${c.kind}，与答案选项"${txt}"一致`)
          : fail(`${gl}前置题${k + 1}：分类=${c.kind}（应 ${q.expectKind}），选项"${txt}"`);
      } else if (q.points) {
        const zs = tripleOverlapRange(q.points);
        const saysNo = /不能|不构成|无/.test(q.opts[q.correct]);
        (!!zs) !== saysNo
          ? ok(`${gl}前置题${k + 1}：三段${zs ? '有' : '无'}重叠，与答案选项"${q.opts[q.correct]}"一致`)
          : fail(`${gl}前置题${k + 1}：公式得 ${JSON.stringify(zs)}，答案选出"${q.opts[q.correct]}"`);
      } else if (q.ranges) {
        const lo = Math.max(...q.ranges.map(r => r[0])), hi = Math.min(...q.ranges.map(r => r[1]));
        const t = q.opts[q.correct], m = /(\d+)~(\d+)/.exec(t);
        (lo === q.expect[0] && hi === q.expect[1] && m && Number(m[1]) === lo && Number(m[2]) === hi)
          ? ok(`${gl}前置题${k + 1}：公式 [${lo}, ${hi}]＝expect，正确选项"${t}"`)
          : fail(`${gl}前置题${k + 1}：公式 [${lo}, ${hi}]、expect [${q.expect}]、选项"${t}" 不一致`);
      } else {
        ok(`${gl}前置题${k + 1}：答案下标 ${q.correct}（"${q.opts[q.correct]}"），选项结构完整`);
      }
    });
  }
  if (dumped.CA) {
    dumped.CA.forEach((q, k) => {
      const zs = tripleOverlapRange(q.points);
      const exp = q.expect;
      const matchExpect = (zs === null && exp === null) ||
        (zs && exp && zs[0] === exp[0] && zs[1] === exp[1]);
      const txt = q.opts[q.correct];
      const matchText = zs ? txt.includes(`${zs[0]}~${zs[1]}`) : /无重叠|不构成/.test(txt);
      (matchExpect && matchText)
        ? ok(`第4课练习A${k + 1}：公式 ${zs ? '[' + zs + ']' : '无重叠'}＝expect，正确选项为"${txt}"`)
        : fail(`第4课练习A${k + 1}：公式=${JSON.stringify(zs)}，expect=${JSON.stringify(exp)}，正确选项="${txt}"`);
    });
  }
  if (dumped.CB) {
    dumped.CB.forEach((q, k) => {
      const zs = tripleOverlapRange(q.points);
      (!!zs) === q.answer
        ? ok(`第4课练习B${k + 1}：${zs ? '中枢 [' + zs + ']' : '无中枢'}，与设定答案一致`)
        : fail(`第4课练习B${k + 1}：公式=${JSON.stringify(zs)}，答案设为 ${q.answer}`);
    });
  }

  // 8：第5课 走势类型
  if (dumped.FIG_PAN && dumped.FIG_TREND && dumped.TA && dumped.TB) {
    const pan = zigClusters(dumped.FIG_PAN);
    pan.kind === '盘整'
      ? ok(`第5课 教学图（盘整）：线段重叠聚成一簇 [${pan.clusters[0].lo}, ${pan.clusters[0].hi}]，不扩张`)
      : fail(`第5课 教学图（盘整）应为盘整，实为 ${pan.kind}：${JSON.stringify(pan.clusters.map(c => [c.lo, c.hi]))}`);
    const tr = zigClusters(dumped.FIG_TREND);
    (tr.kind === '上涨' && tr.clusters.length === 2)
      ? ok(`第5课 教学图（趋势）：两簇 [${tr.clusters[0].lo}, ${tr.clusters[0].hi}] / [${tr.clusters[1].lo}, ${tr.clusters[1].hi}] 依次抬高、不重叠`)
      : fail(`第5课 教学图（趋势）应为两簇上涨，实为 ${tr.kind}：${JSON.stringify(tr.clusters.map(c => [c.lo, c.hi]))}`);
    const zw = zones.map(z => [z.lo, z.hi]);
    const zwExpect = [[70, 80], [92, 100], [70, 80], [80, 90], [86, 96]];
    JSON.stringify(zw) === JSON.stringify(zwExpect)
      ? ok('第5课 初始绘制的 5 个中枢矩形与设计值一致（含练习B的两块）')
      : fail(`第5课 矩形序列 ${JSON.stringify(zw)} ≠ 预期 ${JSON.stringify(zwExpect)}`);

    dumped.TA.forEach((q, k) => {
      const c = zigClusters(q.points);
      const want = q.answer.replace('走势', '');
      const zs = (q.zones || []).map(z => [z.lo, z.hi]);
      (c.kind === want && JSON.stringify(zs) === JSON.stringify(c.clusters.map(cl => [cl.lo, cl.hi])) && q.opts[q.correct] === q.answer)
        ? ok(`第5课 练习A${k + 1}：独立分类＝${c.kind}，中枢簇与设定一致，正确选项"${q.answer}"`)
        : fail(`第5课 练习A${k + 1}：分类=${c.kind}（应 ${want}），簇=${JSON.stringify(c.clusters.map(cl => [cl.lo, cl.hi]))}，zones=${JSON.stringify(zs)}`);
    });
    dumped.TB.forEach((q, k) => {
      const valid = Array.isArray(q.opts) && q.correct >= 0 && q.correct < q.opts.length;
      if (!valid) { fail(`第5课 练习B${k + 1}：correct 下标越界`); return; }
      if (q.points && q.zones) {
        const c = zigClusters(q.points);
        const zs = q.zones.map(z => [z.lo, z.hi]);
        const overlap = zs[0][0] <= zs[1][1] && zs[1][0] <= zs[0][1];
        const noTrend = /^不算/.test(q.opts[q.correct]);
        (c.kind === '扩张' && overlap && noTrend && zs.every(z => c.tris.some(t => t.lo === z[0] && t.hi === z[1])))
          ? ok(`第5课 练习B${k + 1}：两中枢区间重叠（${zs[1][0]} ≤ ${zs[0][1]}），独立判定＝扩张，与答案一致`)
          : fail(`第5课 练习B${k + 1}：分类=${c.kind}，重叠=${overlap}，答案="${q.opts[q.correct]}"，zones=${JSON.stringify(zs)}`);
      } else {
        const doubt = q.opts.filter(o => o.includes('不必然')).length;
        (doubt === 1 && q.opts[q.correct].includes('不必然'))
          ? ok(`第5课 练习B${k + 1}：唯一含"不必然"的选项即正确答案（第20课原文语义）`)
          : fail(`第5课 练习B${k + 1}：含"不必然"的选项数=${doubt}，correct=${q.correct}`);
      }
    });

    [['前置题', dumped.GATE], ['练习A', dumped.TA], ['练习B', dumped.TB]].forEach(([tag, arr]) => {
      arr.forEach((q, k) => {
        const lens = q.opts.map(o => [...o].length);
        lens.every(l => l === lens[0])
          ? ok(`第5课 ${tag}${k + 1}：选项等长（${lens[0]} 字 × ${lens.length}）`)
          : fail(`第5课 ${tag}${k + 1}：选项长度 ${JSON.stringify(lens)} 不等`);
      });
    });
  }

  // 9：reference/zhongshu-expansion.html 中枢升级判定卡
  if (dumped.SCENES && dumped.RECIPE) {
    const envOf = sc => sc.zones.filter(z => z.cls === 'env').map(z => [z.lo, z.hi]);
    const intOf = sc => sc.zones.filter(z => z.cls !== 'env').map(z => [z.lo, z.hi]);
    dumped.SCENES.forEach(sc => {
      const env = envOf(sc), itv = intOf(sc);
      const envApart = env.length === 2 && env[0][1] < env[1][0];
      const envTouch = env.length === 2 && env[0][1] >= env[1][0];
      const intApart = itv.length === 2 && itv[0][1] < itv[1][0];
      const intTouch = itv.length === 2 && itv[0][1] >= itv[1][0];
      const okScene = sc.verdict === '趋势' ? (envApart && intApart)
        : sc.verdict === '升级' ? (envTouch && intApart)
        : (sc.verdict === '别拆' && intTouch);
      const why = `震荡范围分离=${envApart}/重叠=${envTouch}，区间分离=${intApart}/重叠=${intTouch}`;
      okScene
        ? ok(`速查页 情形${sc.id}（${sc.verdict}）：数据关系与判定一致（${why}）`)
        : fail(`速查页 情形${sc.id}（${sc.verdict}）关系不符：${why}`);
    });

    const expectZones = [];
    dumped.SCENES.forEach(sc => sc.zones.forEach(z => expectZones.push([z.lo, z.hi])));
    expectZones.push([dumped.RECIPE.zone.lo, dumped.RECIPE.zone.hi]);
    const drawnZones = zones.map(z => [z.lo, z.hi]);
    JSON.stringify(drawnZones) === JSON.stringify(expectZones)
      ? ok(`速查页 绘制的 ${drawnZones.length} 个矩形与数据声明一致（顺序、数值）`)
      : fail(`速查页 矩形序列 ${JSON.stringify(drawnZones)} ≠ 声明 ${JSON.stringify(expectZones)}`);

    const bars = dumped.RECIPE.bars;
    const lo = Math.max(...bars.map(b => b.lo)), hi = Math.min(...bars.map(b => b.hi));
    (lo === dumped.RECIPE.expect[0] && hi === dumped.RECIPE.expect[1] &&
     lo === dumped.RECIPE.zone.lo && hi === dumped.RECIPE.zone.hi)
      ? ok(`速查页 新中枢公式：三段公共部分 [${lo}, ${hi}]＝示例值＝绘制值`)
      : fail(`速查页 新中枢公式：[${lo}, ${hi}]、expect ${JSON.stringify(dumped.RECIPE.expect)}、zone ${JSON.stringify(dumped.RECIPE.zone)} 不一致`);
  }

  // 10：第6课 背驰
  if (dumped.FIG_MACD && dumped.BA && dumped.BB) {
    const area = bs => bs.reduce((s, b) => s + Math.abs(b.v), 0);
    const fA = area(dumped.FIG_MACD.filter(b => b.seg === 'A'));
    const fC = area(dumped.FIG_MACD.filter(b => b.seg === 'C'));
    (fC < fA)
      ? ok(`第6课 教学图：A段面积 ${fA.toFixed(2)} ＞ C段 ${fC.toFixed(2)}（C柱子多反而面积小）→ 标准背驰`)
      : fail(`第6课 教学图面积比较异常：A=${fA}，C=${fC}`);

    const zwExpect6 = [[122, 130], [124, 132]];
    const zw6 = zones.slice(0, 2).map(z => [z.lo, z.hi]);
    JSON.stringify(zw6) === JSON.stringify(zwExpect6)
      ? ok('第6课 初始绘制的中枢矩形（教学图 B 段 + 第1题 B 段）与设计值一致')
      : fail(`第6课 矩形 ${JSON.stringify(zw6)} ≠ 预期 ${JSON.stringify(zwExpect6)}`);

    dumped.BA.forEach((q, k) => {
      const aSeg = area(q.bars.filter(b => b.seg === 'A'));
      const cSeg = area(q.bars.filter(b => b.seg === 'C'));
      const beichi = cSeg < aSeg;
      const bz = tripleOverlapRange(q.points.slice(1, 5));
      const zsOk = bz && q.bZone && q.bZone[0] === bz[0] && q.bZone[1] === bz[1];
      const ansOk = (q.answer === '有背驰') === beichi && q.opts[q.correct] === q.answer;
      (ansOk && zsOk)
        ? ok(`第6课 练习A${k + 1}：A段面积 ${aSeg.toFixed(2)} vs C段 ${cSeg.toFixed(2)} → ${beichi ? '背驰' : '不背驰'}，与答案一致；B中枢 [${q.bZone}] 与公式相符`)
        : fail(`第6课 练习A${k + 1}：A=${aSeg}，C=${cSeg}，答案="${q.answer}"，B中枢=${JSON.stringify(q.bZone)} vs 公式 ${JSON.stringify(bz)}`);
    });

    dumped.BB.forEach((q, k) => {
      const valid = Array.isArray(q.opts) && q.correct >= 0 && q.correct < q.opts.length;
      if (!valid) { fail(`第6课 练习B${k + 1}：correct 下标越界`); return; }
      const key = k === 0 ? '盘整背驰' : '先出来';
      const hit = q.opts.filter(o => o.includes(key));
      (hit.length === 1 && q.opts[q.correct].includes(key))
        ? ok(`第6课 练习B${k + 1}：唯一含"${key}"的选项即正确答案（原文语义）`)
        : fail(`第6课 练习B${k + 1}：含"${key}"的选项数=${hit.length}，correct=${q.correct}`);
    });

    [['前置题', dumped.GATE], ['练习A', dumped.BA], ['练习B', dumped.BB]].forEach(([tag, arr]) => {
      arr.forEach((q, k) => {
        const lens = q.opts.map(o => [...o].length);
        lens.every(l => l === lens[0])
          ? ok(`第6课 ${tag}${k + 1}：选项等长（${lens[0]} 字 × ${lens.length}）`)
          : fail(`第6课 ${tag}${k + 1}：选项长度 ${JSON.stringify(lens)} 不等`);
      });
    });
  }
}

console.log(`\n共 ${checks} 项通过，${failures} 项失败`);
process.exit(failures ? 1 : 0);
