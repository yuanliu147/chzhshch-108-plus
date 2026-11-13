// 多周期计算调度：全量结果在 Worker 产生；依赖变化时终止旧 Worker，过期结果不写入状态。
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChanConfig, ComputeResult } from '@chan/engine';
import type { RawBar } from '../api.ts';

type Level = 'd' | 'm30' | 'm5';
export type LevelResults = Record<Level, ComputeResult | null>;
interface ResultState {
  input: RawBar[];
  config: ChanConfig;
  cutoff: number | undefined;
  result: ComputeResult | null;
  error: string | null;
  loading: boolean;
}

function useLevelResult(level: Level, bars: RawBar[], config: ChanConfig, cutoff?: number, enabled = true) {
  const requestRef = useRef(0);
  const [state, setState] = useState<ResultState>(() => ({ input: bars, config, cutoff, result: null, error: null, loading: enabled && !!bars.length }));
  useEffect(() => {
    const requestId = ++requestRef.current;
    const empty: ResultState = { input: bars, config, cutoff, result: null, error: null, loading: enabled && !!bars.length };
    setState(empty);
    if (!enabled || !bars.length) return;
    let cancelled = false;
    let worker: Worker | null = null;
    const fail = (error: string) => { if (!cancelled) setState({ ...empty, error, loading: false }); };
    try {
      worker = new Worker(new URL('../workers/compute.worker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = (event: MessageEvent<{ requestId: number; level: Level; result?: ComputeResult; error?: string }>) => {
        if (cancelled || event.data.requestId !== requestId || event.data.level !== level) return;
        if (event.data.error) { fail(event.data.error); return; }
        if (event.data.result) setState({ ...empty, result: event.data.result, loading: false });
      };
      worker.onerror = event => fail(event.message || `${level} 计算 Worker 失败`);
      worker.postMessage({ requestId, config, bars: { [level]: bars }, asOfMs: cutoff });
    } catch (e) { fail(String(e instanceof Error ? e.message : e)); }
    return () => { cancelled = true; worker?.terminate(); };
  }, [level, bars, config, cutoff, enabled]);
  const matches = enabled && state.input === bars && state.config === config && state.cutoff === cutoff;
  return { result: matches ? state.result : null, error: matches ? state.error : null, loading: enabled && !!bars.length && (!matches || state.loading) };
}

export function useEngineResults(d: RawBar[], m30: RawBar[], m5: RawBar[], config: ChanConfig) {
  const daily = useLevelResult('d', d, config);
  const halfHour = useLevelResult('m30', m30, config);
  const fiveMinute = useLevelResult('m5', m5, config);
  const results = useMemo<LevelResults>(() => ({ d: daily.result, m30: halfHour.result, m5: fiveMinute.result }), [daily.result, halfHour.result, fiveMinute.result]);
  const errors = useMemo(() => ({ d: daily.error, m30: halfHour.error, m5: fiveMinute.error }), [daily.error, halfHour.error, fiveMinute.error]);
  return { results, error: daily.error, errors, loading: { d: daily.loading, m30: halfHour.loading, m5: fiveMinute.loading } };
}

/** 历史证据用独立截止 Worker，不清空已发布的全量/日线结果。 */
export function useAsOfResult(level: Level | null, bars: RawBar[], config: ChanConfig, asOfMs: number | null) {
  return useLevelResult(level ?? 'm5', bars, config, asOfMs ?? undefined, level != null && asOfMs != null);
}
