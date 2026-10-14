/* ============================================================
   charts.js —— 缠论课程共享图表组件
   renderCandles(): 把 OHLC 数组渲染为可交互的 SVG K线图
                    返回坐标系 {x, y, overlay, centers}，供叠加笔/线段/中枢
   stroke() / tag() / dot(): 在坐标系上叠加结构（笔、线段、标记）
   所有课程共用：阳线红、阴线绿（A股配色），自动缩放，可点击
   ============================================================ */

const ChanCharts = (() => {
  const NS = 'http://www.w3.org/2000/svg';

  function el(tag, attrs = {}) {
    const node = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    return node;
  }

  /**
   * 渲染K线图
   * @param {SVGElement} svg 目标 SVG 元素
   * @param {Array<{o,h,l,c}>} data K线数据（时间顺序）
   * @param {Object} opts
   *   width, height : viewBox 尺寸（默认 640 x 300）
   *   onClick       : (index, groupEl) => void  点击某根K线时触发
   *   labels        : 是否显示底部序号（默认 true）
   *   grid          : 是否显示水平网格线与价格刻度（默认 true）
   * @returns {{x:function, y:function, overlay:SVGElement, centers:number[],
   *            svg:SVGElement, width:number, height:number, data:Array}}
   *   x(i) 返回第 i 根K线的中心横坐标；y(price) 返回价格对应的纵坐标
   */
  function renderCandles(svg, data, opts = {}) {
    const W = opts.width || 640, H = opts.height || 300;
    const pad = { l: 46, r: 18, t: 22, b: 34 };
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.innerHTML = '';

    const hi = Math.max(...data.map(d => d.h));
    const lo = Math.min(...data.map(d => d.l));
    const span = (hi - lo) || 1;
    const plotH = H - pad.t - pad.b;
    const plotW = W - pad.l - pad.r;
    const yOf = v => pad.t + (hi - v) / span * plotH;
    const step = plotW / data.length;
    const bw = Math.min(step * 0.58, 30);
    const xOf = i => pad.l + step * (i + 0.5);

    if (opts.grid !== false) {
      for (let i = 0; i <= 3; i++) {
        const v = lo + span * i / 3;
        const yy = yOf(v);
        svg.appendChild(el('line', { x1: pad.l, y1: yy, x2: W - pad.r, y2: yy, class: 'grid-line' }));
        const t = el('text', { x: pad.l - 6, y: yy + 3, 'text-anchor': 'end', class: 'price-label' });
        t.textContent = v.toFixed(1);
        svg.appendChild(t);
      }
    }

    const centers = data.map((d, i) => {
      const cx = xOf(i);
      const up = d.c >= d.o;
      const g = el('g', { class: `candle ${up ? 'up' : 'down'}` });
      g.dataset.index = i;

      g.appendChild(el('line', { x1: cx, y1: yOf(d.h), x2: cx, y2: yOf(d.l) }));
      const top = yOf(Math.max(d.o, d.c));
      const bot = yOf(Math.min(d.o, d.c));
      g.appendChild(el('rect', {
        x: cx - bw / 2, y: top, width: bw,
        height: Math.max(bot - top, 2), rx: 1,
      }));

      if (opts.labels !== false) {
        const t = el('text', { x: cx, y: H - 12, 'text-anchor': 'middle', class: 'axis-label' });
        t.textContent = i + 1;
        svg.appendChild(t);
      }

      if (opts.onClick) {
        g.style.cursor = 'pointer';
        g.addEventListener('click', () => opts.onClick(i, g));
      }
      svg.appendChild(g);
      return cx;
    });

    const overlay = el('g', { class: 'overlay' });
    svg.appendChild(overlay);

    return { x: xOf, y: yOf, overlay, centers, svg, width: W, height: H, data };
  }

  /** 在坐标系上画一条折线（用于笔、线段等结构） */
  function stroke(chart, points, opts = {}) {
    if (!points || points.length < 2) return null;
    const line = el('polyline', {
      points: points.map(p => `${p[0]},${p[1]}`).join(' '),
      class: `stroke ${opts.dir || ''}`.trim(),
      fill: 'none',
    });
    if (opts.dashed) line.setAttribute('stroke-dasharray', '5 4');
    if (opts.color) line.setAttribute('stroke', opts.color);
    chart.overlay.appendChild(line);
    return line;
  }

  /** 在坐标系上放一个文字标记（如"笔1"） */
  function tag(chart, x, y, text, opts = {}) {
    const t = el('text', {
      x, y, class: `stroke-label ${opts.cls || ''}`.trim(),
      'text-anchor': opts.anchor || 'middle',
    });
    t.textContent = text;
    chart.overlay.appendChild(t);
    return t;
  }

  /** 在坐标系上标记一个端点 */
  function dot(chart, x, y, opts = {}) {
    const c = el('circle', { cx: x, cy: y, r: opts.r || 4, class: `dot ${opts.cls || ''}`.trim() });
    chart.overlay.appendChild(c);
    return c;
  }

  /** 两根K线是否存在包含关系（一根的高低点范围完全包住另一根） */
  function hasInclusion(a, b) {
    return (a.h >= b.h && a.l <= b.l) || (b.h >= a.h && b.l <= a.l);
  }

  /**
   * 渲染折线走势图（笔、线段的示意图）
   * @param {Array<{price:number,label?:string,labelBelow?:boolean,seg?:string,hl?:boolean}>} points
   *        相邻两点连成一笔/一段；seg 是"以该点为终点"那一段的编号（画在段中点），hl 高亮该段
   * @param {Object} opts width, height, yPad
   * @returns {{x:function, y:function, overlay:SVGElement, svg:SVGElement, points:Array}}
   */
  function renderZigzag(svg, points, opts = {}) {
    const W = opts.width || 640, H = opts.height || 320;
    const pad = { l: 40, r: 24, t: 28, b: 42 };
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.innerHTML = '';

    const prices = points.map(p => p.price);
    const rawSpan = (Math.max(...prices) - Math.min(...prices)) || 1;
    const padP = opts.yPad !== undefined ? opts.yPad : rawSpan * 0.12;
    const hi = Math.max(...prices) + padP, lo = Math.min(...prices) - padP;
    const span = hi - lo;
    const plotH = H - pad.t - pad.b, plotW = W - pad.l - pad.r;
    const yOf = v => pad.t + (hi - v) / span * plotH;
    const xOf = i => pad.l + (points.length < 2 ? plotW / 2 : plotW * i / (points.length - 1));

    for (let i = 0; i <= 3; i++) {
      const v = lo + span * i / 3, yy = yOf(v);
      svg.appendChild(el('line', { x1: pad.l, y1: yy, x2: W - pad.r, y2: yy, class: 'grid-line' }));
    }

    const warn = msg => { if (typeof console !== 'undefined') console.warn('renderZigzag: ' + msg); };
    if (points[0] && points[0].seg) {
      warn(`第一个点上的 seg "${points[0].seg}" 不会被绘制——seg 表示"以该点为终点"的那一段。`);
    }

    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i], b = points[i + 1];
      const up = b.price >= a.price;
      const cls = `stroke ${up ? 'up' : 'down'} ${b.hl ? 'hl' : ''}`.trim();
      svg.appendChild(el('line', {
        x1: xOf(i), y1: yOf(a.price), x2: xOf(i + 1), y2: yOf(b.price), class: cls,
      }));
      if (b.seg) {
        if (/^X/i.test(b.seg) && up) warn(`"${b.seg}" 标在了一段向上的走势上（X 应为向下笔）。`);
        if (/^S/i.test(b.seg) && !up) warn(`"${b.seg}" 标在了一段向下的走势上（S 应为向上笔）。`);
        const m = /^笔(\d+)$/.exec(b.seg);
        if (m && Number(m[1]) !== i + 1) warn(`"${b.seg}" 出现在第 ${i + 1} 段上，编号与段序不符。`);
        const t = el('text', {
          x: (xOf(i) + xOf(i + 1)) / 2,
          y: (yOf(a.price) + yOf(b.price)) / 2 + (up ? -8 : 16),
          'text-anchor': 'middle', class: 'seg-label',
        });
        t.textContent = b.seg;
        svg.appendChild(t);
      }
    }

    points.forEach((p, i) => {
      svg.appendChild(el('circle', { cx: xOf(i), cy: yOf(p.price), r: 3.4, class: 'dot' }));
      if (p.label) {
        const t = el('text', {
          x: xOf(i), y: yOf(p.price) + (p.labelBelow ? 18 : -10),
          'text-anchor': 'middle', class: 'point-label',
        });
        t.textContent = p.label;
        svg.appendChild(t);
      }
    });

    const overlay = el('g', { class: 'overlay' });
    svg.appendChild(overlay);
    return { x: xOf, y: yOf, overlay, svg, points, width: W, height: H };
  }

  /**
   * 渲染条形元素图（特征序列元素、中枢区间等）
   * @param {Array<{lo:number,hi:number,label?:string}>} bars
   * @param {Object} opts width, height, onClick(i, groupEl)
   * @returns {{x:function, y:function, overlay:SVGElement, svg:SVGElement, bars:Array}}
   */
  function renderBars(svg, bars, opts = {}) {
    const W = opts.width || 320, H = opts.height || 200;
    const pad = { l: 20, r: 20, t: 26, b: 34 };
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.innerHTML = '';

    const hi = Math.max(...bars.map(b => b.hi)), lo = Math.min(...bars.map(b => b.lo));
    const padP = ((hi - lo) || 1) * 0.15;
    const top = hi + padP, bot = lo - padP, span = top - bot;
    const plotH = H - pad.t - pad.b, plotW = W - pad.l - pad.r;
    const yOf = v => pad.t + (top - v) / span * plotH;
    const step = plotW / bars.length;
    const bw = Math.min(step * 0.44, 34);

    const centers = bars.map((b, i) => {
      const cx = pad.l + step * (i + 0.5);
      const g = el('g', { class: 'bar-el' });
      g.dataset.index = i;
      g.appendChild(el('rect', {
        x: cx - bw / 2, y: yOf(b.hi), width: bw,
        height: Math.max(yOf(b.lo) - yOf(b.hi), 2), rx: 2, class: 'bar',
      }));
      if (opts.labelize !== false) {
        const t = el('text', { x: cx, y: H - 12, 'text-anchor': 'middle', class: 'bar-label' });
        t.textContent = b.label || String(i + 1);
        svg.appendChild(t);
      }
      if (opts.onClick) {
        g.style.cursor = 'pointer';
        g.addEventListener('click', () => opts.onClick(i, g));
      }
      svg.appendChild(g);
      return cx;
    });

    const overlay = el('g', { class: 'overlay' });
    svg.appendChild(overlay);
    return { x: i => centers[i], y: yOf, overlay, svg, bars, width: W, height: H };
  }

  /**
   * 在坐标系上画一个区间矩形（中枢区间、上下沿等）
   * @param {Object} chart renderZigzag / renderCandles 返回的坐标系
   * @param {number} x1,x2 矩形左右边界（像素）
   * @param {number} lo,hi 矩形下沿、上沿（价格）
   * @param {Object} opts label（写在矩形上方的文字）, cls
   */
  function zone(chart, x1, x2, lo, hi, opts = {}) {
    const rect = el('rect', {
      x: Math.min(x1, x2), y: chart.y(hi),
      width: Math.abs(x2 - x1), height: Math.max(chart.y(lo) - chart.y(hi), 2),
      class: `zone ${opts.cls || ''}`.trim(),
    });
    chart.overlay.appendChild(rect);
    if (opts.label) {
      const t = el('text', {
        x: (x1 + x2) / 2, y: chart.y(hi) - 6, 'text-anchor': 'middle', class: 'zone-label',
      });
      t.textContent = opts.label;
      chart.overlay.appendChild(t);
    }
    return rect;
  }

  return { renderCandles, renderZigzag, renderBars, stroke, tag, dot, zone, hasInclusion };
})();
