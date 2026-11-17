import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

test('plugin market preserves the installed version and disabled state across catalog updates', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tpcl-plugin-market-'));
  process.env.TPCL_DATA_DIR = dir;
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { pluginMarketRoute } = await import('../src/core/plugin-market.js');
  async function request(body) {
    const req = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []);
    Object.assign(req, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json' } });
    let result;
    await pluginMarketRoute(req, {}, (_, status, data) => { assert.equal(status, 200); result = data; });
    return result;
  }
  assert.equal((await request()).catalog.length, 6);
  const plugin = JSON.parse(fs.readFileSync(new URL('../examples/reading-room.plugin.json', import.meta.url)));
  const id = plugin.id;
  await request({ action: 'import', plugins: [plugin] });
  await request({ action: 'install', id });
  await request({ action: 'toggle', id, enabled: false });
  await request({ action: 'import', plugins: [{ ...plugin, version: '1.1.0' }] });
  assert.equal((await request()).installed[0].plugin.version, plugin.version);
  const updated = (await request({ action: 'install', id })).installed[0];
  assert.equal(updated.plugin.version, '1.1.0');
  assert.equal(updated.enabled, false);
  assert.equal((await request({ action: 'uninstall', id })).installed.length, 0);
});
