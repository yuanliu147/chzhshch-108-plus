// 交叉核验 CLI：完整导出生产结果及显式 test fixture，不生成参考期望。
// 用法：tsx scripts/exportResults.ts <输入.json> <输出.json>
import { readFileSync, writeFileSync } from 'node:fs';
import {
  compute, analyzeAsOf, createReplay, detectCenters, detectTrends, detectSegments,
  detectDivergences, detectPoints, buildLevels, type ChanConfig, type KInput, type Fractal,
} from '../src/index.ts';
import { sourceOf } from '../src/sourceEvidence.ts';

const [, , inPath, outPath] = process.argv;
if (!inPath || !outPath) {
  console.error('用法：tsx scripts/exportResults.ts <输入.json> <输出.json>');
  process.exit(1);
}
type Fixture = { name: string; kind: string; args: unknown[] };
const input = JSON.parse(readFileSync(inPath, 'utf-8')) as {
  samples: { code: string; adjust: string; bars: KInput[]; configIndices?: number[]; asOfMs?: number }[];
  configs: ChanConfig[];
  fixtures?: Fixture[];
};
const results = [];
for (const s of input.samples) {
  for (const i of s.configIndices ?? input.configs.map((_, i) => i)) {
    const cfg = input.configs[i]!;
    const r = s.asOfMs == null ? compute(s.bars, cfg) : analyzeAsOf(s.bars, cfg, s.asOfMs);
    results.push({ code: s.code, adjust: s.adjust, ...r });
  }
}
function runFixture(f: Fixture): unknown {
  switch (f.kind) {
    case 'source': return sourceOf(...f.args as Parameters<typeof sourceOf>);
    case 'centers': return detectCenters(...f.args as Parameters<typeof detectCenters>);
    case 'trends': return detectTrends(...f.args as Parameters<typeof detectTrends>);
    case 'segments': {
      const [bis, fractals, valid, cfg] = f.args as [Parameters<typeof detectSegments>[0], Fractal[], Parameters<typeof detectSegments>[2], ChanConfig];
      return detectSegments(bis, new Map(fractals.map(x => [x.id, x])), valid, cfg);
    }
    case 'divergences': return detectDivergences(...f.args as Parameters<typeof detectDivergences>);
    case 'points': return detectPoints(...f.args as Parameters<typeof detectPoints>);
    case 'levels': return buildLevels(...f.args as Parameters<typeof buildLevels>);
    case 'asOf': return analyzeAsOf(...f.args as Parameters<typeof analyzeAsOf>);
    case 'compute': return compute(...f.args as Parameters<typeof compute>);
    case 'replay': {
      const [bars, cfg] = f.args as [KInput[], ChanConfig];
      const r = createReplay(cfg);
      for (const b of bars) { r.push(b); r.result(); r.result(); }
      return r.result();
    }
    default: throw new Error(`未知核验 fixture: ${f.kind}`);
  }
}
const fixtures = (input.fixtures ?? []).map(f => {
  try { return { name: f.name, result: runFixture(f) }; }
  catch (error) { return { name: f.name, error: error instanceof Error ? error.message : String(error) }; }
});
// 不剥离任何字段；JSON 自然将 NaN 表示为 null。
writeFileSync(outPath, JSON.stringify({ results, fixtures }), 'utf-8');
console.log(`TS 导出 ${results.length} 组结果 + ${fixtures.length} 个 test fixtures → ${outPath}`);
