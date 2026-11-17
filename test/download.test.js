import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { downloadFile } from '../src/core/download.js';

test('slow mirror switches without waiting for another data chunk', async t => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'tpcl-download-test-'));
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  const requests = [];
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (url, { signal }) => {
    const pathname = new URL(url).pathname;
    requests.push(pathname);
    if (pathname !== '/slow') return new Response('complete-download');
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode('x'));
      signal.addEventListener('abort', () => controller.error(signal.reason), { once: true });
    } }));
  };
  const base = 'https://download.test';
  const file = path.join(folder, 'client.jar');
  const started = Date.now();
  const result = await downloadFile([base + '/slow', base + '/good'], file, { retries: 1, speedWindowMs: 150, minBps: 10000, idleMs: 10000 });
  assert.ok(Date.now() - started < 4000);
  assert.equal(result.from, base + '/good');
  assert.deepEqual(requests, ['/slow', '/good']);
  assert.equal(await fs.readFile(file, 'utf8'), 'complete-download');
  await assert.rejects(fs.stat(file + '.part'));
});
