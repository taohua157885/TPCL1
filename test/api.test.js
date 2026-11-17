import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

test('queue API installs cached versions, survives failure and downloads reports', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tpcl-api-test-'));
  process.env.TPCL_DATA_DIR = dir;
  const { saveConfig } = await import('../src/core/config.js');
  saveConfig({ mcDir: path.join(dir, 'minecraft') });
  const { createServer } = await import('../src/server.js');
  const { stopLanWatcher } = await import('../src/core/lan.js');
  const server = createServer();
  // Dispatch real request handlers directly: this test does not require loopback permission.
  function request(url, method = 'GET', body) {
    return new Promise((resolve, reject) => {
      const req = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []);
      Object.assign(req, { url, method, headers: {} });
      const res = { headersSent: false,
        writeHead(status, headers) { this.status = status; this.headers = headers; this.headersSent = true; },
        end(data) { try { resolve({ status: this.status, data: data ? JSON.parse(data.toString()) : null }); } catch (e) { reject(e); } },
      };
      server.emit('request', req, res);
    });
  }
  try {
    for (const id of ['bad-version', 'good-version']) {
      const folder = path.join(dir, 'minecraft', 'versions', id);
      fs.mkdirSync(folder, { recursive: true });
      fs.writeFileSync(path.join(folder, `${id}.json`), id === 'bad-version' ? 'invalid json' : JSON.stringify({ id, libraries: [] }));
    }
    const bad = await request('/api/queue', 'POST', { type: 'version', id: 'bad-version' });
    assert.equal(bad.status, 202);
    const good = await request('/api/queue', 'POST', { type: 'version', id: 'good-version' });
    assert.equal(good.status, 202);
    let list;
    const deadline = Date.now() + 4000;
    do {
      await new Promise(r => setImmediate(r));
      list = (await request('/api/tasks')).data.tasks;
    } while (list.some(t => !t.done) && Date.now() < deadline);
    assert.equal(list.find(t => t.id === bad.data.task.id).status, 'failed');
    assert.equal(list.find(t => t.id === good.data.task.id).status, 'completed');
    const report = list.find(t => t.id === bad.data.task.id).report;
    const downloaded = await request('/api/reports/' + report);
    assert.equal(downloaded.status, 200);
    assert.match(downloaded.data.error.stack, /installer.js/);
    // A missing required mod dependency must fail the queued task and export a report.
    const originalFetch = globalThis.fetch;
    try {
      const id = '1.20.1-fabric-test';
      const folder = path.join(dir, 'minecraft', 'versions', id);
      fs.mkdirSync(folder, { recursive: true });
      fs.writeFileSync(path.join(folder, id + '.json'), JSON.stringify({ id, libraries: [{ name: 'net.fabricmc:fabric-loader:0.16' }] }));
      globalThis.fetch = async url => new Response(JSON.stringify(String(url).includes('/version/root-version') ? {
        id:'root-version',project_id:'root',name:'Root mod',game_versions:['1.20.1'],loaders:['fabric'],
        files:[{filename:'root.jar',url:'https://files.test/root.jar'}],dependencies:[{project_id:'missing',dependency_type:'required'}],
      } : []));
      const mod = await request('/api/queue', 'POST', {type:'market',project:'root',version:'root-version',resourceType:'mod',target:id});
      const limit=Date.now()+4000;
      let task;
      do {
        await new Promise(r=>setImmediate(r));
        task=(await request('/api/tasks')).data.tasks.find(t=>t.id===mod.data.task.id);
      } while (!task.done && Date.now()<limit);
      assert.equal(task.status,'failed');
      assert.ok(task.report);
      const dependencyReport = await request('/api/reports/' + task.report);
      assert.equal(dependencyReport.status,200);
      assert.match(dependencyReport.data.error.message,/missing/);
      assert.equal(fs.existsSync(path.join(folder,'mods','root.jar')),false);
    } finally { globalThis.fetch=originalFetch; }
    const client = await request('/api/reports/client', 'POST', { message: 'UI broke', stack: 'at app.js:100' });
    assert.ok(client.data.report);
    const history = await request('/api/reports');
    assert.ok(history.data.reports.some(r => r.id === client.data.report));
    await request('/api/queue/action', 'POST', { action: 'clear' });
    assert.equal((await request('/api/tasks')).data.tasks.length, 0);
  } finally {
    await new Promise(r => setImmediate(r));
    stopLanWatcher();
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
