import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TaskQueue } from '../src/core/taskqueue.js';

test('FIFO, duplicate suppression, cancellation and failure isolation', async () => {
  const reports = [], calls = [];
  const q = new TaskQueue({ report: e => { reports.push(e.message); return 'report.json'; } });
  let release;
  const gate = new Promise(r => { release = r; });
  const first = q.add('first', { id: 1 }, async progress => { calls.push(1); progress({ percent: 35, text: 'downloading' }); await gate; });
  const duplicate = q.add('first', { id: 1 }, async () => assert.fail('duplicate ran'));
  assert.equal(first.id, duplicate.id);
  const cancelled = q.add('cancel', { id: 2 }, async () => assert.fail('cancelled task ran'));
  q.add('failure', { id: 3 }, async () => { calls.push(3); throw new Error('network'); });
  q.add('last', { id: 4 }, async () => { calls.push(4); return { ok: true }; });
  assert.equal(q.cancel(cancelled.id), true);
  await new Promise(r => setImmediate(r));
  assert.equal(q.list()[0].percent, 35);
  assert.equal(q.cancel(first.id), false);
  release();
  while (q.running) await new Promise(r => setImmediate(r));
  assert.deepEqual(calls, [1, 3, 4]);
  assert.deepEqual(reports, ['network']);
  assert.equal(q.list().find(t => t.input.id === 3).report, 'report.json');
  assert.equal(q.list().at(-1).status, 'completed');
  assert.ok(q.list().every(t => t.done));
  q.clear();
  assert.equal(q.list().length, 0);
});

test('retry and partial downloads cannot be marked successful', async () => {
  const q = new TaskQueue();
  let attempt = 0;
  const original = q.add('pack', { id: 1 }, async () => ++attempt === 1 ? { ok: true, failed: ['mod.jar'] } : { ok: true });
  await new Promise(r => setImmediate(r));
  assert.equal(q.list()[0].status, 'failed');
  q.retry(original.id);
  await new Promise(r => setImmediate(r));
  assert.equal(q.list().at(-1).status, 'completed');
  assert.equal(attempt, 2);
});
