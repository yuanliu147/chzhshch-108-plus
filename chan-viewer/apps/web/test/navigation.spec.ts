import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  currentStep, drillDown, goBack, initialNav, jumpTo, requestView, resetNav, selectOnLevel, updateView,
} from '../src/chart/navigation.ts';

test('相等视窗保留整个导航及 path 引用，不产生新定位', () => {
  const empty = initialNav();
  assert.equal(updateView(empty, 'd', null), empty);
  const nav = updateView(empty, 'd', { start: 431, end: 449, total: 6420 });
  const same = updateView(nav, 'd', { start: 431, end: 449, total: 6420 });
  assert.equal(same, nav);
  assert.equal(same.path, nav.path);
  assert.equal(same.requestSeq, 0);
  assert.notEqual(updateView(nav, 'd', { start: 431, end: 449, total: 6421 }), nav);
});

test('30分钟19根→5分钟→返回精确恢复实际索引，不以父 range 替代', () => {
  let nav = updateView(initialNav(), 'd', { start: 1900, end: 2119, total: 2120 });
  const daily = currentStep(nav);
  nav = drillDown(nav, [300, 651]);
  assert.equal(nav.path[0], daily, '下钻不改父视窗');
  nav = updateView(nav, 'm30', { start: 431, end: 449, total: 6420 });
  const m30View = currentStep(nav).view;
  nav = drillDown(nav, [900, 1020]);
  nav = updateView(nav, 'm5', { start: 950, end: 961, total: 38520 });
  const seq = nav.requestSeq;
  nav = goBack(nav);
  assert.equal(currentStep(nav).level, 'm30');
  assert.equal(currentStep(nav).view, m30View);
  assert.deepEqual(currentStep(nav).range, [300, 651]);
  assert.deepEqual(currentStep(nav).viewRequest, { seq: seq + 1, start: 431, end: 449 });
  nav = jumpTo(nav, 'd');
  assert.deepEqual(currentStep(nav).viewRequest, { seq: seq + 2, start: 1900, end: 2119 });
});

test('父层重新选中截断旧下游；图上选中不发定位请求', () => {
  let nav = updateView(initialNav(), 'd', { start: 20, end: 39, total: 100 });
  nav = drillDown(drillDown(nav, [2, 30]), [3, 40]);
  const seq = nav.requestSeq;
  const view = nav.path[0]!.view;
  nav = selectOnLevel(nav, 'd', { kind: 'segment', id: 7 });
  assert.equal(nav.path.length, 1);
  assert.equal(currentStep(nav).view, view);
  assert.deepEqual(currentStep(nav).ref, { kind: 'segment', id: 7 });
  assert.equal(nav.requestSeq, seq);
  assert.equal(currentStep(nav).viewRequest, null);
});

test('列表/重新定位只发单次请求，平移不更改完整range或请求序号', () => {
  let nav = drillDown(initialNav(), [100, 499]);
  nav = selectOnLevel(nav, 'm30', { kind: 'center', id: 4 });
  nav = requestView(nav, 'm30', [211, 222]);
  const request = currentStep(nav).viewRequest;
  nav = updateView(nav, 'm30', { start: 300, end: 311, total: 1000 });
  assert.equal(currentStep(nav).viewRequest, request);
  assert.deepEqual(currentStep(nav).range, [100, 499]);
  nav = resetNav(nav);
  assert.equal(nav.path.length, 1);
  assert.equal(currentStep(nav).level, 'd');
  assert.equal(currentStep(nav).ref, null);
  assert.equal(currentStep(nav).range, null);
  assert.deepEqual(currentStep(nav).viewRequest, { seq: request!.seq + 1, start: null, end: null });
});

test('最低m5不再下钻，无效层与当前面包屑保持引用', () => {
  const nav = drillDown(drillDown(initialNav()));
  assert.equal(drillDown(nav, [0, 11]), nav);
  assert.equal(jumpTo(nav, 'm5'), nav);
  assert.equal(updateView(initialNav(), 'm5', null).path.length, 1);
  assert.equal(goBack(initialNav()).path.length, 1);
});
