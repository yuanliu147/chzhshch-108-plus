// 跨级别研究证据，不修改原文买卖点。周期只负责时间投影；degree/依赖关系由引擎结构提供。
import type { BuySellPoint, ComputeResult } from '@chan/engine';
import type { RawBar, TimeRange } from '../api.ts';
import { coverageOf, coverageSpan, endOf, mergeRanges as mergeCoverage, overlaps, coveredMs, intersectRanges, verifiedCoverageOf } from './timeMapping.ts';

export type ConfluenceStatus = '支持' | '不支持' | '冲突' | '等待' | '数据不足';

export interface ConfluenceEvidence {
  level: string;
  status: ConfluenceStatus;
  detail: string;
}

export interface ConfluenceResult {
  /** 研究假设结论，不是原文买卖点确认。 */
  status: ConfluenceStatus;
  ruleId: string;
  summary: string;
  evidence: ConfluenceEvidence[];
  asOfMs?: number;
}

interface LevelEvidence {
  levelName: string;
  result: ComputeResult;
  bars: RawBar[];
}

function pointCoverage(bars: RawBar[], p: BuySellPoint): TimeRange | null {
  const idx = Math.max(0, Math.min(bars.length - 1, Math.round(p.atRaw)));
  return coverageSpan(bars, [idx]);
}

function coveredDuration(required: readonly TimeRange[], observed: readonly TimeRange[]) {
  return coveredMs(intersectRanges(required, observed));
}
function verified(bar: RawBar | undefined) {
  return !!bar && verifiedCoverageOf(bar).length > 0;
}
export function pointKnownAt(point: BuySellPoint, bars: readonly RawBar[]): number | null {
  if (point.status !== 'confirmed' || point.confirmedAt == null || !Number.isInteger(point.confirmedAt)) return null;
  const bar = bars[point.confirmedAt];
  const ms = bar ? endOf(bar) : Number.NaN;
  return Number.isFinite(ms) ? ms : null;
}
/** 历史与最新失效分别传截止，不改写父点或历史研究状态。 */
export function evaluatePointInvalidation(point: BuySellPoint, target: LevelEvidence, asOfMs: number): ConfluenceEvidence | null {
  if (point.klass !== 3 || point.refId == null) return null;
  const center = target.result.centers.find(c => point.refKey ? c.key === point.refKey : c.id === point.refId);
  if (!center) return null;
  const invalid = target.result.segments.some(s => {
    if (s.status !== 'confirmed' || s.confirmedAt == null || s.startRaw <= point.atRaw || s.quality === 'incomplete' || s.quality === 'unknown') return false;
    if (point.continuityId && s.continuityId !== point.continuityId) return false;
    const known = target.bars[s.confirmedAt];
    if (!known || !verified(known) || endOf(known) > asOfMs) return false;
    return point.side === 'buy' ? s.low < center.ZG : s.high > center.ZD;
  });
  return invalid ? { level: `${target.levelName}·失效检查`, status: '冲突', detail: '截止前已有完成走势重新越过中枢核心边界；这是明确失效证据，不是普通反向波动。' } : null;
}

/**
 * 评估“父级文本点/结构是否获得子级已完成转折支持”。
 * 普通反向波动不算冲突；只有所选事件的明确失效证据才返回冲突。
 */
export function evaluatePointConfluence(
  targetPoint: BuySellPoint, target: LevelEvidence, lower: LevelEvidence | null, requestedAsOfMs?: number,
): ConfluenceResult {
  const knownAt = pointKnownAt(targetPoint, target.bars);
  const asOfMs = requestedAsOfMs ?? knownAt ?? undefined;
  const targetBar = target.bars[Math.round(targetPoint.atRaw)];
  const evidence: ConfluenceEvidence[] = [{ level: target.levelName, status: targetPoint.status === 'confirmed' ? '支持' : '等待',
    detail: `${targetPoint.side === 'buy' ? '买' : '卖'}${['一', '二', '三'][targetPoint.klass - 1]}类，${targetPoint.status === 'confirmed' ? '结构已确认' : '候选尚未完成'}，位置 ${targetBar?.date ?? '—'}` }];
  const answer = (status: ConfluenceStatus, summary: string): ConfluenceResult => ({ status, summary, ruleId: 'qjt-evidence-v2', evidence, asOfMs });
  if (targetPoint.status !== 'confirmed') return answer('等待', '父点尚未确认；子级支持不能代替原文确认。');
  if (knownAt == null || asOfMs == null || !Number.isFinite(asOfMs) || asOfMs !== knownAt) return answer('数据不足', '父点首次可知时刻无法验证，不能用最新行情替代。');
  const start = Math.round(targetPoint.atRaw);
  const finish = targetPoint.confirmedAt!;
  if (start < 0 || finish < start || !target.bars[finish] || targetPoint.quality === 'unknown' || targetPoint.quality === 'incomplete') return answer('数据不足', '父点来源或确认依赖不可信。');
  const parentWindow = target.bars.slice(start, finish + 1);
  if (!parentWindow.length || parentWindow.some(b => !verified(b))) return answer('数据不足', '父柱或从结构位置到确认时刻的来源存在缺根/未知完整性。');
  if (!lower || !lower.bars.length) return answer('数据不足', '缺少更低周期数据，未声称共振。');
  if (lower.result.asOfMs !== asOfMs) return answer('等待', '正在等待相同截止时刻的子级快照，最新全量结果不参与历史支持。');
  const required = mergeCoverage(parentWindow.flatMap(coverageOf));
  const relevant = lower.bars.filter(b => endOf(b) <= asOfMs && overlaps(coverageOf(b), required));
  const duration = required.reduce((sum, r) => sum + r.endMs - r.startMs, 0);
  const covered = coveredDuration(required, mergeCoverage(relevant.flatMap(coverageOf)));
  if (!duration || covered !== duration || relevant.some(b => !verified(b))) {
    evidence.push({ level: lower.levelName, status: '数据不足', detail: `必要交易覆盖 ${Math.round(covered / 60000)}/${Math.round(duration / 60000)} 分钟；缺根、缺桶及未知来源不授予确定判断。` });
    return answer('数据不足', '必要子级交易覆盖不完整，研究判定保持数据不足。');
  }
  const invalidation = evaluatePointInvalidation(targetPoint, target, asOfMs);
  if (invalidation) { evidence.push(invalidation); return answer('冲突', '首次可知时刻已有明确失效证据。'); }
  const supported = lower.result.points.filter(p => {
    if (p.side !== targetPoint.side || p.status !== 'confirmed' || p.quality === 'incomplete' || p.quality === 'unknown') return false;
    const childKnownAt = pointKnownAt(p, lower.bars);
    const b = lower.bars[Math.round(p.atRaw)];
    return childKnownAt != null && childKnownAt <= asOfMs && verified(b) && overlaps(coverageOf(b!), coverageOf(targetBar!));
  });
  evidence.push({ level: lower.levelName, status: supported.length ? '支持' : '不支持', detail: `完整必要覆盖 ${relevant.length} 根；截止前同向完成点 ${supported.length} 个。时间重合仅为研究规则，不证明结构 degree 父子关系。` });
  return answer(supported.length ? '支持' : '不支持', supported.length ? '相同截止快照中存在同向完成转折；仅支持该研究规则。' : '覆盖完整，但截止前没有同向完成转折。');
}

export function pointCoverageRange(bars: RawBar[], point: BuySellPoint): TimeRange | null {
  return pointCoverage(bars, point);
}

export function barRangeForDisplay(bars: RawBar[], range: TimeRange): string {
  const start = bars.find((b) => coverageOf(b).some((r) => r.endMs > range.startMs));
  const end = [...bars].reverse().find((b) => coverageOf(b).some((r) => r.startMs < range.endMs));
  return `${start?.date ?? '—'} 至 ${end?.date ?? '—'}`;
}
