// 由探索结果生成无外部依赖的中文单文件报告；不在展示层重算账户收益。
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

type Row = Record<string, any>;
interface Payload { audit: Row; experiments: Row[]; summaries: Row[]; diagnostics: Row[] }
function args() {
  const out = new Map<string, string>();
  for (const arg of process.argv.slice(2)) {
    const match = /^--([^=]+)=(.*)$/.exec(arg);
    if (match) out.set(match[1]!, match[2]!);
  }
  return out;
}
function safeJson(value: unknown): string {
  return JSON.stringify(value).replaceAll('<', '\\u003c');
}
function main() {
  const cli = args();
  const output = resolve(cli.get('output') ?? '报告/缠论策略探索_20261115');
  const data = JSON.parse(readFileSync(join(output, '探索账户结果.json'), 'utf8')) as Payload;
  const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>缠论策略单因素探索报告</title>
<style>
:root{--bg:#f5f6f2;--panel:#fff;--ink:#18231f;--muted:#65736c;--line:#dce2dc;--accent:#176b55;--red:#b54b4b;--blue:#385c78}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.65 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif}main{max-width:1500px;margin:auto;padding:34px 28px 60px}h1{font-size:30px;line-height:1.25;margin:0 0 10px;letter-spacing:-.5px}h2{font-size:20px;margin:0 0 8px}h3{font-size:15px;margin:20px 0 8px}.sub{color:var(--muted);max-width:1000px}.notice{margin:20px 0;padding:14px 17px;background:#fff5da;border:1px solid #ead9a8;border-radius:10px}.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin:22px 0}.card,.panel{background:var(--panel);border:1px solid var(--line);border-radius:12px}.card{padding:16px}.card b{display:block;font-size:25px;line-height:1.3}.card span{color:var(--muted)}.panel{padding:20px;margin-top:18px;overflow:hidden}.controls{display:flex;flex-wrap:wrap;gap:10px;margin:14px 0}label{color:var(--muted);font-size:13px}select{display:block;margin-top:3px;min-width:170px;padding:7px 30px 7px 10px;border:1px solid var(--line);border-radius:7px;background:#fff;color:var(--ink)}.tablewrap{overflow:auto;border:1px solid var(--line);border-radius:9px}table{border-collapse:collapse;width:100%;white-space:nowrap;font-variant-numeric:tabular-nums}th,td{padding:9px 10px;border-bottom:1px solid #e8ece8;text-align:right}th{position:sticky;top:0;background:#f0f3ef;color:#435149;font-size:12px;z-index:1}th:first-child,td:first-child,th:nth-child(2),td:nth-child(2){text-align:left}tr:hover td{background:#f8faf8}.pos{color:var(--accent)}.neg{color:var(--red)}.muted{color:var(--muted)}canvas{width:100%;display:block}.chartbox{height:660px;margin:10px 0 18px}.links{display:flex;flex-wrap:wrap;gap:8px 16px}.links a{color:var(--blue)}.method{columns:2;column-gap:36px}.method li{break-inside:avoid;margin-bottom:8px}.small{font-size:12px;color:var(--muted)}#description{margin:4px 0 12px;color:var(--muted)}@media(max-width:800px){main{padding:22px 14px}h1{font-size:25px}.panel{padding:14px}.method{columns:1}.chartbox{height:540px}.controls{display:grid;grid-template-columns:1fr 1fr}select{min-width:0;width:100%}}
</style></head><body><main>
<h1>缠论策略单因素探索报告</h1>
<div class="sub">2010—2026年主板确认买点 · 每账户2万元 · 最多2仓 · 量能 / 指标 / 周线月线 / 离场分别对照</div>
<div class="notice"><b>研究边界：</b>这是全历史探索，不是未见过数据的样本外证明。每个过滤实验只改变一个条件；路径诊断使用未来收益评价信号，但绝不反向参与过滤。2026年截至11月4日。</div>
<div class="cards" id="cards"></div>
<div class="links"><a href="探索场景汇总.csv">账户场景汇总CSV</a><a href="探索特征汇总.json">逐信号特征JSON</a><a href="诊断分组.csv">信号诊断分组CSV</a><a href="信号路径诊断.csv">逐信号路径CSV</a><a href="探索交易明细.csv">交易明细CSV</a><a href="探索分年度表现.csv">分年度表现CSV</a><a href="探索审计.json">审计JSON</a><a href="探索独立核验.json">独立核验JSON</a><a href="../缠论策略回测_20261115/缠论策略回测报告.html">原始回测报告</a></div>
<section class="panel"><h2>先看结论</h2><div id="findings"></div></section>
<section class="panel"><h2>一、过滤条件账户对照</h2><div class="sub">默认显示三类买点、20日退出。候选数是满足条件的信号，不等于实际成交；满仓未成交仍按原规则处理。</div>
<div class="controls"><label>买点类别<select id="klass"><option value="1">一类</option><option value="2">二类</option><option value="3" selected>三类</option></select></label><label>离场<select id="exit"><option value="any-sell">任一确认卖点</option><option value="same-class-sell">同类确认卖点</option><option value="hold-20" selected>20个市场交易日</option><option value="hold-60">60个市场交易日</option></select></label><label>实验族<select id="family"><option value="">全部实验族</option></select></label><label>排序<select id="sort"><option value="registered">按实验登记顺序</option><option value="return">按总收益降序</option><option value="drawdown">按最大回撤升序</option></select></label></div>
<div class="chartbox"><canvas id="chart"></canvas></div><div class="tablewrap"><table id="results"></table></div></section>
<section class="panel"><h2>二、离场共同样本对照</h2><div class="sub">只保留所有新离场计划均可计算的候选；原卖点和固定期限也在该共同样本上重跑，因此差异只来自离场。</div><div class="controls"><label>买点类别<select id="exitKlass"><option value="1">一类</option><option value="2">二类</option><option value="3" selected>三类</option></select></label></div><div class="tablewrap"><table id="exits"></table></div></section>
<section class="panel"><h2>三、信号路径诊断</h2><div class="sub">后复权开盘到开盘收益，未扣费、未模拟涨跌停成交；MFE/MAE为路径最大有利/不利变动。用于判断信号是否曾有利润空间，不是账户收益。</div>
<div class="controls"><label>诊断实验<select id="diagExp"></select></label><label>买点类别<select id="diagKlass"><option value="1">一类</option><option value="2">二类</option><option value="3" selected>三类</option></select></label></div><div id="description"></div><div class="tablewrap"><table id="diagnostics"></table></div>
<h3>结构段量能四分位</h3><div class="small">四分位阈值在全历史样本上计算，仅用于探索分布，不可直接视为样本外交易参数。</div><div class="tablewrap"><table id="quartiles"></table></div></section>
<section class="panel"><h2>四、口径与防止误读</h2><ol class="method"><li>日线信号继续使用原引擎逐根确认事件，并在下一可交易日开盘成交；结构位置日不等于可知日。</li><li>个股、指数趋势均为收盘价高于均线且均线向上；不同窗口全部展示，没有只保留最优参数。</li><li>周线和月线由日线聚合，只有到达全市场该周/月最后交易日收盘才可见；日历末尾所在周月无法证明完成，保守排除。周月缠论点只认最近完成周期内首次确认的买点。</li><li>一买量能比较背驰c/b段；二买比较回抽/反弹段；三买比较离开/中枢及回踩/离开段的日均成交量。</li><li>结构失效位先按信号日复权因子换算为后复权，再与后续后复权收盘比较，避免除权形成假跌破。</li><li>ATR与反向通道均在收盘后确认，下一可交易日开盘执行；开盘跌停、停牌、退市及费用沿用原账户核心。</li><li>路径诊断样本会跨股票、跨日期重叠，不等于相互独立；不据此提供显著性或收益保证。</li><li>一/二类买点在当前引擎中成对出现且样本很少，不能因为某个过滤后收益高就宣称两类策略各自有效。</li></ol></section>
</main><script>
const DATA=${safeJson({ audit: data.audit, experiments: data.experiments, summaries: data.summaries, diagnostics: data.diagnostics })};
const S=DATA.summaries, D=DATA.diagnostics, E=DATA.experiments;
const pct=v=>v==null||!Number.isFinite(v)?'—':(v*100).toFixed(2)+'%';const money=v=>v==null?'—':Number(v).toFixed(2);const num=(v,n=2)=>v==null||!Number.isFinite(v)?'—':Number(v).toFixed(n);
const cls=v=>typeof v==='number'?(v>0?'pos':v<0?'neg':''):'';const esc=v=>String(v??'—').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function table(el,headers,rows){document.querySelector(el).innerHTML='<thead><tr>'+headers.map(h=>'<th>'+esc(h[0])+'</th>').join('')+'</tr></thead><tbody>'+rows.map(r=>'<tr>'+r.map(v=>'<td class="'+cls(v)+'">'+esc(typeof v==='number'&&String(v).includes('.')?v.toFixed(2):v)+'</td>').join('')+'</tr>').join('')+'</tbody>'}
const audit=DATA.audit;document.querySelector('#cards').innerHTML=[[audit.candidateCount,'原始买入候选'],[audit.filterExperimentCount,'单因素过滤实验（含基线）'],[audit.accountScenarioCount,'账户场景'],[audit.volumeAvailable,'可计算结构段量能'],[audit.weeklyPointSupport,'周线同向点支持'],[audit.monthlyPointSupport,'月线同向点支持'],[Number(audit.maxReconcileError).toExponential(2),'最大账户对账差']].map(x=>'<div class="card"><b>'+esc(x[0])+'</b><span>'+esc(x[1])+'</span></div>').join('');
const byId=(id,k)=>S.find(x=>x.实验ID===id&&x.买点类别===k);const get=(id,k,x)=>S.find(r=>r.实验ID===id&&r.买点类别===k&&r.离场规则===x);const base20=get('baseline',3,'hold-20'),base60=get('baseline',3,'hold-60');
const traded20=S.filter(r=>r.买点类别===3&&r.离场规则==='hold-20'&&r.实验类别!=='离场共同样本'&&r.实验ID!=='baseline'&&r.实际入场笔数>0).sort((a,b)=>b.总收益率-a.总收益率)[0];
const ma60=get('daily-trend-60',3,'hold-60'),ma20=get('daily-trend-20',3,'hold-60'),ma120=get('daily-trend-120',3,'hold-60'),ma250=get('daily-trend-250',3,'hold-60');
const vPass=D.find(r=>r.实验ID==='volume-natural'&&r.买点类别===3&&r.分组==='通过'),vFail=D.find(r=>r.实验ID==='volume-natural'&&r.买点类别===3&&r.分组==='未通过'),vAccount=get('volume-natural',3,'hold-20');
const structure=byId('exit-structure',3),atr2=byId('exit-atr14-2',3),channel10=byId('exit-channel-10',3),small=get('index-trend-120',1,'hold-20'),small60=get('index-trend-120',1,'hold-60');
const findings=[
 '三买20日：基线'+pct(base20.总收益率)+'；有实际成交的过滤中相对最好的是“'+traded20.实验名称+'”，仍为'+pct(traded20.总收益率)+'。没有入场过滤器把20日场景变成正收益。',
 '三买MA60＋60日退出为'+pct(ma60.总收益率)+'，但最大回撤'+pct(ma60.最大回撤)+'，2022—2026年为'+pct(ma60['2022至2026权益收益'])+'；相邻MA20/120/250分别为'+pct(ma20.总收益率)+'、'+pct(ma120.总收益率)+'、'+pct(ma250.总收益率)+'，不是参数高原。',
 '结构量能账户20日从基线'+pct(base20.总收益率)+'变为'+pct(vAccount.总收益率)+'，但全候选路径中位数并未改善：通过组20日'+pct(vPass['20日中位收益'])+'、60日'+pct(vPass['60日中位收益'])+'，未通过组分别为'+pct(vFail['20日中位收益'])+'、'+pct(vFail['60日中位收益'])+'。账户改善不能直接解释为量能预测力。',
 '三买离场：2倍ATR为'+pct(atr2.总收益率)+'，10日通道为'+pct(channel10.总收益率)+'；结构失效为'+pct(structure.总收益率)+'但已平仓'+structure.已平仓交易数+'笔，账面结果不能当成已验证离场收益。',
 '严格高周期同向点：周线支持'+audit.weeklyPointSupport+'个、月线支持'+audit.monthlyPointSupport+'个，零样本不用于评价胜率。',
 '一/二类上证MA120过滤的20日结果为'+pct(small.总收益率)+'，但只有'+small.已平仓交易数+'笔平仓；同一过滤60日为'+pct(small60.总收益率)+'，样本小且对离场敏感。'
];document.querySelector('#findings').innerHTML='<ul>'+findings.map(x=>'<li>'+esc(x)+'</li>').join('')+'</ul>';
const families=[...new Set(S.filter(x=>x.实验类别!=='离场共同样本').map(x=>x.实验类别))];families.forEach(x=>document.querySelector('#family').insertAdjacentHTML('beforeend','<option>'+esc(x)+'</option>'));
let currentRows=[];
function drawChart(rows){const canvas=document.querySelector('#chart'),rect=canvas.getBoundingClientRect(),dpr=window.devicePixelRatio||1;canvas.width=rect.width*dpr;canvas.height=rect.height*dpr;const c=canvas.getContext('2d');c.scale(dpr,dpr);c.clearRect(0,0,rect.width,rect.height);if(!rows.length){c.fillStyle='#65736c';c.fillText('无场景',20,30);return}const left=210,right=30,top=12,rowH=Math.min(28,(rect.height-top-25)/rows.length),width=rect.width-left-right,max=Math.max(.01,...rows.map(r=>Math.abs(r.总收益率))),zero=left+width*.5;c.font='11px sans-serif';rows.forEach((r,i)=>{const y=top+i*rowH,v=r.总收益率,w=Math.abs(v)/max*(width*.48);c.fillStyle='#435149';c.fillText(r.实验名称.length>20?r.实验名称.slice(0,20)+'…':r.实验名称,8,y+rowH*.65);c.fillStyle=v>=0?'#176b55':'#b54b4b';c.fillRect(v>=0?zero:zero-w,y+2,w,Math.max(5,rowH-6));c.fillText(pct(v),v>=0?zero+w+5:zero-w-58,y+rowH*.65)});c.strokeStyle='#829087';c.beginPath();c.moveTo(zero,5);c.lineTo(zero,top+rows.length*rowH);c.stroke()}
function render(){const k=+document.querySelector('#klass').value,ex=document.querySelector('#exit').value,f=document.querySelector('#family').value,sort=document.querySelector('#sort').value;currentRows=S.filter(x=>x.实验类别!=='离场共同样本'&&x.买点类别===k&&x.离场规则===ex&&(!f||x.实验类别===f));if(sort==='return')currentRows.sort((a,b)=>b.总收益率-a.总收益率);if(sort==='drawdown')currentRows.sort((a,b)=>a.最大回撤-b.最大回撤);drawChart(currentRows);table('#results',[['实验类别'],['实验'],['候选'],['实际入场'],['期末权益'],['总收益'],['年化'],['最大回撤'],['平仓'],['胜率'],['盈亏比'],['资金利用率'],['已实现盈亏'],['未实现盈亏'],['2010—2016'],['2017—2021'],['2022—2026']],currentRows.map(r=>[r.实验类别,r.实验名称,r.候选信号数,r.实际入场笔数,money(r.期末权益),r.总收益率,r.年化收益率,r.最大回撤,r.已平仓交易数,pct(r.胜率),num(r.盈亏比),pct(r.平均资金利用率),money(r.已实现盈亏),money(r.未实现盈亏),r['2010至2016权益收益'],r['2017至2021权益收益'],r['2022至2026权益收益']]));document.querySelectorAll('#results tbody tr').forEach((tr,i)=>{[5,6,7,14,15,16].forEach(j=>{const cell=tr.cells[j];if(!cell)return;const key=j===5?'总收益率':j===6?'年化收益率':j===7?'最大回撤':j===14?'2010至2016权益收益':j===15?'2017至2021权益收益':j===16?'2022至2026权益收益':null;if(key){const v=currentRows[i][key];cell.textContent=pct(v);cell.className=j===7?'':cls(v)}});const pnl=currentRows[i];cellSet(tr,12,money(pnl.已实现盈亏),pnl.已实现盈亏);cellSet(tr,13,money(pnl.未实现盈亏),pnl.未实现盈亏)})}
function cellSet(tr,i,text,value){const cell=tr.cells[i];cell.textContent=text;cell.className=cls(value)}
['klass','exit','family','sort'].forEach(id=>document.querySelector('#'+id).addEventListener('change',render));
function renderExits(){const k=+document.querySelector('#exitKlass').value,rows=S.filter(x=>x.实验类别==='离场共同样本'&&x.买点类别===k);table('#exits',[['离场'],['候选'],['期末权益'],['总收益'],['年化'],['最大回撤'],['平仓'],['胜率'],['盈亏比'],['平均持有自然日'],['已实现盈亏'],['未实现盈亏']],rows.map(r=>[r.实验名称,r.候选信号数,money(r.期末权益),r.总收益率,r.年化收益率,r.最大回撤,r.已平仓交易数,pct(r.胜率),num(r.盈亏比),num(r.平均持有自然日),money(r.已实现盈亏),money(r.未实现盈亏)]));document.querySelectorAll('#exits tbody tr').forEach((tr,i)=>{[3,4,5].forEach(j=>{const key=j===3?'总收益率':j===4?'年化收益率':'最大回撤',v=rows[i][key];tr.cells[j].textContent=pct(v);tr.cells[j].className=j===5?'':cls(v)});cellSet(tr,10,money(rows[i].已实现盈亏),rows[i].已实现盈亏);cellSet(tr,11,money(rows[i].未实现盈亏),rows[i].未实现盈亏)})}document.querySelector('#exitKlass').addEventListener('change',renderExits);
const diagExps=E.filter(e=>e.id!=='baseline');diagExps.forEach(e=>document.querySelector('#diagExp').insertAdjacentHTML('beforeend','<option value="'+esc(e.id)+'">'+esc(e.family+' · '+e.label)+'</option>'));document.querySelector('#diagExp').value='volume-natural';
function renderDiag(){const id=document.querySelector('#diagExp').value,k=+document.querySelector('#diagKlass').value,e=E.find(x=>x.id===id);document.querySelector('#description').textContent=e?.description??'';const rows=D.filter(x=>x.实验ID===id&&x.买点类别===k);table('#diagnostics',[['分组'],['候选'],['有效20日'],['20日均值'],['20日中位'],['20日MFE中位'],['20日MAE中位'],['有效60日'],['60日均值'],['60日中位'],['60日MFE中位'],['60日MAE中位']],rows.map(r=>[r.分组,r.候选数,r.有效20日样本,pct(r['20日平均收益']),pct(r['20日中位收益']),pct(r['20日MFE中位数']),pct(r['20日MAE中位数']),r.有效60日样本,pct(r['60日平均收益']),pct(r['60日中位收益']),pct(r['60日MFE中位数']),pct(r['60日MAE中位数'])]));const q=D.filter(x=>x.实验ID==='volume-quantile'&&x.买点类别===k);table('#quartiles',[['分组'],['候选'],['20日均值'],['20日中位'],['20日MFE中位'],['20日MAE中位'],['60日均值'],['60日中位']],q.map(r=>[r.分组,r.候选数,pct(r['20日平均收益']),pct(r['20日中位收益']),pct(r['20日MFE中位数']),pct(r['20日MAE中位数']),pct(r['60日平均收益']),pct(r['60日中位收益'])]))}['diagExp','diagKlass'].forEach(id=>document.querySelector('#'+id).addEventListener('change',renderDiag));
render();renderExits();renderDiag();window.addEventListener('resize',()=>drawChart(currentRows));
</script></main></body></html>`;
  writeFileSync(join(output, '缠论策略探索报告.html'), html);
  console.log(`[报告] ${join(output, '缠论策略探索报告.html')} 场景${data.summaries.length} 诊断${data.diagnostics.length}`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
