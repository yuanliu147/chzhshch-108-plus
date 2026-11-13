import type { KInput, SourceEvidence, StructureEvidence } from './types.ts';
import { barKnownAt } from './analysisTime.ts';

/** 无 time 仅为纯算法调用的完整输入契约；显式 false/unknown 不可升级。 */
export function sourceOf(bar: KInput): SourceEvidence {
  const time = bar.time;
  const knownAt = barKnownAt(bar);
  const coverage = time?.coverage.map((r) => ({ ...r })) ?? [];
  const validCoverage = coverage.length > 0 && coverage.every(r => Number.isFinite(r.startMs) && Number.isFinite(r.endMs) && r.endMs > r.startMs && knownAt != null && r.endMs <= knownAt);
  return {
    endMs: knownAt ?? NaN,
    coverage,
    complete: time?.complete ?? true,
    quality: time?.quality === 'unknown' ? 'unknown' : time?.complete === false ? 'incomplete'
      : time != null && (!validCoverage || knownAt == null) ? 'unknown'
      : bar.endMs != null && knownAt == null ? 'unknown' : time?.quality ?? 'verified',
    continuityId: time?.continuityId ?? 'legacy',
  };
}

export function sourceKey(x: { key?: string; id?: number }, kind: string): string {
  return x.key ?? `historical:${kind}:${x.id}`;
}

export function evidenceOf(xs: readonly StructureEvidence[], dependencyKeys: string[]): StructureEvidence {
  const continuityId = xs[0]?.continuityId ?? 'legacy';
  const quality = xs.some((x) => x.quality === 'incomplete') ? 'incomplete'
    : xs.some((x) => x.quality === 'unknown' || (x.continuityId ?? 'legacy') !== continuityId) ? 'unknown' : 'verified';
  return { continuityId, dependencyKeys: [...new Set(dependencyKeys)], quality };
}

export function sameContinuity(a: StructureEvidence, b: StructureEvidence): boolean {
  return (a.continuityId ?? 'legacy') === (b.continuityId ?? 'legacy');
}
