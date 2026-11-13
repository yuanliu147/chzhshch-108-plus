import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { CHAN_PRESETS, type ComputeResult } from '@chan/engine';

type Message = { requestId: number; level: string; result?: ComputeResult; error?: string };
const original = globalThis.self;
const messages: Message[] = [];
const channel = { onmessage: null as ((event: MessageEvent) => void) | null, postMessage: (message: Message) => messages.push(message) };
Object.assign(globalThis, { self: channel });
await import('../src/workers/compute.worker.ts');
after(() => { if (original == null) Reflect.deleteProperty(globalThis, 'self'); else Object.assign(globalThis, { self: original }); });
const config = CHAN_PRESETS.originalDefault;
const daily = [{ date: '2026-09-01', low: 9, high: 10, close: 9.5 }];

test('周期分别发布，分钟失败不丢掉已经完成的日线，也不阻断另一周期', () => {
  messages.length = 0;
  channel.onmessage!({ data: { requestId: 17, config, bars: { d: daily, m30: null, m5: daily } } } as MessageEvent);
  assert.deepEqual(messages.map(m => m.level), ['d', 'm30', 'm5']);
  assert.ok(messages[0].result);
  assert.match(messages[1].error!, /m30/);
  assert.ok(messages[2].result);
  assert.ok(messages.every(m => m.requestId === 17));
});
test('只计算请求周期，历史响应带真实截止而非全量标签', () => {
  messages.length = 0;
  const asOfMs = Date.UTC(2026, 8, 1, 6);
  channel.onmessage!({ data: { requestId: 18, config, bars: { m30: daily }, asOfMs } } as MessageEvent);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].level, 'm30');
  assert.equal(messages[0].result?.asOfMs, asOfMs);
  assert.deepEqual(messages[0].result?.validBars, []);
});
