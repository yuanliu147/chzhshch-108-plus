// 交叉核验 CLI：读样本+口径输入，跑 TS 引擎，导出结果供 Python 参考管线逐根 diff。
// 用法：tsx scripts/exportResults.ts <输入.json> <输出.json>
import { readFileSync, writeFileSync } from 'node:fs';
import { compute, type ChanConfig, type KInput } from '../src/index.ts';

const [, , inPath, outPath] = process.argv;
if (!inPath || !outPath) {
  console.error('用法：tsx scripts/exportResults.ts <输入.json> <输出.json>');
  process.exit(1);
}
const input = JSON.parse(readFileSync(inPath, 'utf-8')) as {
  samples: { code: string; adjust: string; bars: KInput[] }[];
  configs: ChanConfig[];
};
const results = [];
for (const s of input.samples) {
  for (const cfg of input.configs) {
    const r = compute(s.bars, cfg);
    results.push({ code: s.code, adjust: s.adjust, ...r });
  }
}
writeFileSync(outPath, JSON.stringify({ results }), 'utf-8');
console.log(`TS 导出 ${results.length} 组结果 → ${outPath}`);