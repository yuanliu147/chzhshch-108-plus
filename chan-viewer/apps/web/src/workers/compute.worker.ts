// 多周期全量计算 Worker：与主线程图表/交互隔离，切换标的或口径时由主线程 terminate 丢弃旧结果。
import { analyzeAsOf, compute, type ChanConfig, type KInput } from '@chan/engine';

type Level = 'd' | 'm30' | 'm5';
interface Payload {
  requestId: number;
  config: ChanConfig;
  bars: Partial<Record<Level, KInput[]>>;
  asOfMs?: number;
}

self.onmessage = (event: MessageEvent<Payload>) => {
  const { requestId, config, bars, asOfMs } = event.data;
  for (const level of ['d', 'm30', 'm5'] as const) {
    if (!(level in bars)) continue;
    try {
      const input = bars[level];
      if (!Array.isArray(input)) throw new Error(`${level} 行情不是数组`);
      const result = asOfMs == null ? compute(input, config) : analyzeAsOf(input, config, asOfMs);
      self.postMessage({ requestId, level, result });
    } catch (error) {
      self.postMessage({ requestId, level, error: String(error instanceof Error ? error.message : error) });
    }
  }
};
