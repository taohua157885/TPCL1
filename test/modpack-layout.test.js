import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { finished } from 'node:stream/promises';
import ZipStream from 'zip-stream';

async function zip(filename, files) {
  const writer = new ZipStream();
  const stream = writer.pipe(fs.createWriteStream(filename));
  const done = finished(stream);
  for (const [name, data] of Object.entries(files)) {
    await new Promise((resolve, reject) => writer.entry(Buffer.from(data), { name }, e => e ? reject(e) : resolve()));
  }
  writer.finalize();
  await done;
}

test('preview and install map wrapped and isolated mods to the content page', async t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tpcl-layout-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  process.env.TPCL_DATA_DIR = tmp;
  const { saveConfig, gameDirFor } = await import('../src/core/config.js');
  const { inspectModpack, importModpack } = await import('../src/core/modpack.js');
  const { listContent } = await import('../src/core/content.js');
  const mcDir = path.join(tmp, 'mc');
  const base = path.join(mcDir, 'versions', '1.20.1');
  fs.mkdirSync(base, { recursive: true });
  fs.writeFileSync(path.join(base, '1.20.1.json'), JSON.stringify({ id: '1.20.1', libraries: [] }));
  const cases = [
    ['nested', { '外层/实例/.minecraft/MODS/nested.jar': 'nested', '外层/readme.txt':'skip' }],
    ['isolated', { '示例/.minecraft/versions/Fabric/Fabric.json': '{"id":"Fabric","inheritsFrom":"1.20.1"}',
      '示例/.minecraft/versions/Fabric/game/mods/isolated.jar':'isolated', '示例/.minecraft/versions/Fabric/game/config/mod.toml':'active' }],
    ['cf', { '包/manifest.json':'{"name":"CF","minecraft":{"version":"1.20.1"},"files":[],"overrides":"custom"}', '包/custom/.minecraft/mods/cf.jar':'cf' }],
    ['mr', { '包/modrinth.index.json':'{"name":"MR","dependencies":{"minecraft":"1.20.1"},"files":[]}', '包/client-overrides/mods/mr.jar':'mr' }],
    ['tpcl', { '包/tpcl-export.json':'{"name":"Native","mc":"1.20.1"}','包/mods/tpcl.jar':'tpcl' }],
  ];
  for (const [index, [name, entries]] of cases.entries()) {
    await t.test(name, async () => {
      saveConfig({ mcDir, selectedVersion:'1.20.1', isolation: ['version','custom','global'][index % 3] });
      const file = path.join(tmp, name + '.zip');
      await zip(file, entries);
      const preview = await inspectModpack(file);
      assert.equal(preview.localMods, 1);
      const result = await importModpack(file);
      assert.equal(result.ok, true);
      assert.equal(result.id, preview.targetId);
      assert.equal(fs.readFileSync(path.join(gameDirFor(result.id), 'mods', name + '.jar'), 'utf8'), name);
      assert.ok((await listContent(result.id)).mods.some(m => m.name === name + '.jar'));
    });
  }
  const multi = path.join(tmp, 'multi.zip');
  await zip(multi, { 'versions/A/game/mods/a.jar':'a','versions/B/mods/b.jar':'b' });
  await assert.rejects(inspectModpack(multi), /多个/);
  await assert.rejects(importModpack(multi), /多个/);
});
