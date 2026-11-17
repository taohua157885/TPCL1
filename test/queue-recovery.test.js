import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TaskQueue } from '../src/core/taskqueue.js';

test('restart preserves unfinished tasks without running them, then continues explicitly', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tpcl-recovery-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'queue.json');
  const q = new TaskQueue({ file });
  let release;
  const gate = new Promise(r => { release = r; });
  const first = q.add('first', { id: 1 }, () => gate);
  const second = q.add('second', { id: 2 }, async () => ({ ok: true }));
  await new Promise(r => setImmediate(r));
  const snapshot = fs.readFileSync(file);
  release();
  while (q.running) await new Promise(r => setImmediate(r));
  fs.writeFileSync(file, snapshot); // Simulate process termination while first runs.
  const called = [];
  const restored = new TaskQueue({ file, resolveRun: input => async () => { called.push(input.id); return { ok: true }; } });
  assert.deepEqual(restored.list().map(t => t.status), ['interrupted', 'interrupted']);
  await new Promise(r => setImmediate(r));
  assert.deepEqual(called, []);
  restored.clear();
  assert.equal(restored.list().length, 2);
  assert.equal(restored.cancel(second.id), true);
  const retry = restored.retry(first.id);
  await new Promise(r => setImmediate(r));
  assert.deepEqual(called, [1]);
  assert.equal(restored.list().find(t => t.id === retry.id).status, 'completed');
  const again = new TaskQueue({ file });
  assert.equal(again.list().find(t => t.id === retry.id).status, 'completed');
});

test('failed persistence does not execute a task the caller thinks was rejected', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tpcl-storage-fail-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const block = path.join(dir, 'file'); fs.writeFileSync(block, 'not a directory');
  const q = new TaskQueue({ file: path.join(block, 'queue.json') });
  assert.throws(() => q.add('task', {}, () => assert.fail('must not execute')));
  await new Promise(r => setImmediate(r));
  assert.equal(q.list().length, 0);
});
