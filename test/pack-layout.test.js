import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { crc32 } from 'node:zlib';
import { wrapperPrefix } from '../src/core/pack-layout.js';

// Real stored ZIPs with file entries only, as written by many modpack exporters.
function archive(dir, name, files, zip64 = false) {
  const locals = [], directory = [];
  let offset = 0;
  for (const [filename, contents] of Object.entries(files)) {
    const key = Buffer.from(filename), data = Buffer.from(contents);
    const hdr = Buffer.alloc(30), cd = Buffer.alloc(46);
    hdr.writeUInt32LE(0x04034b50); cd.writeUInt32LE(0x02014b50);
    hdr.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6);
    hdr.writeUInt32LE(crc32(data), 14); cd.writeUInt32LE(crc32(data), 16);
    hdr.writeUInt32LE(data.length, 18); hdr.writeUInt32LE(data.length, 22);
    cd.writeUInt32LE(data.length, 20); cd.writeUInt32LE(data.length, 24);
    hdr.writeUInt16LE(key.length, 26); cd.writeUInt16LE(key.length, 28);
    cd.writeUInt32LE(offset, 42);
    locals.push(hdr, key, data); directory.push(cd, key);
    offset += hdr.length + key.length + data.length;
  }
  const end = Buffer.alloc(22), index = Buffer.concat(directory);
  const count = Object.keys(files).length;
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(count, 8); end.writeUInt16LE(zip64 ? 65535 : count, 10);
  end.writeUInt32LE(index.length, 12); end.writeUInt32LE(offset, 16);
  const footer = [];
  if (zip64) {
    const record = Buffer.alloc(56), locator = Buffer.alloc(20);
    record.writeUInt32LE(0x06064b50); record.writeBigUInt64LE(44n, 4);
    record.writeBigUInt64LE(BigInt(count), 24); record.writeBigUInt64LE(BigInt(count), 32);
    record.writeBigUInt64LE(BigInt(index.length), 40); record.writeBigUInt64LE(BigInt(offset), 48);
    locator.writeUInt32LE(0x07064b50); locator.writeBigUInt64LE(BigInt(offset + index.length), 8);
    locator.writeUInt32LE(1, 16); footer.push(record, locator);
  }
  const file = path.join(dir, name);
  fs.writeFileSync(file, Buffer.concat([...locals, index, ...footer, end]));
  return file;
}

test('preview and import locate nested mod directories and retain the selected loader', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tpcl-pack-'));
  process.env.TPCL_DATA_DIR = dir;
  t.after(() => fs.rmSync(dir, {recursive:true, force:true}));
  const { saveConfig, gameDirFor } = await import('../src/core/config.js');
  const { inspectModpack, importModpack } = await import('../src/core/modpack.js');
  const mcDir = path.join(dir, 'minecraft');
  saveConfig({mcDir, selectedVersion:'loader', isolation:'custom'});
  const base = path.join(mcDir, 'versions', 'loader');
  fs.mkdirSync(base, {recursive:true});
  fs.writeFileSync(path.join(base, 'loader.json'), '{"id":"loader","inheritsFrom":"1.20.1"}');
  const wrapped = archive(dir, 'example.zip', {
    'Readme.txt':'pack', '__MACOSX/mods/no.jar':'x',
    'World/.minecraft/mods/example.jar':'mod', 'World/.minecraft/config/settings.ini':'config',
  }, true);
  const preview = await inspectModpack(wrapped);
  assert.deepEqual(preview.overrides, ['mods', 'config']);
  const imported = await importModpack(wrapped);
  assert.equal(preview.targetId, imported.id);
  assert.equal(fs.readFileSync(path.join(gameDirFor(imported.id), 'mods/example.jar'), 'utf8'), 'mod');
  assert.equal(fs.existsSync(path.join(gameDirFor(imported.id), 'Readme.txt')), false);
  assert.equal(imported.mc, 'loader');
  const isolated = archive(dir, 'isolated.zip', {
    'MyPack/versions/forge/forge.json':'{"id":"forge","inheritsFrom":"loader"}',
    'MyPack/versions/forge/game/mods/example.jar':'isolated',
    'MyPack/versions/loader/loader.json':'{"id":"loader"}',
    'MyPack/options.txt':'settings',
  });
  const preview2 = await inspectModpack(isolated);
  const imported2 = await importModpack(isolated);
  assert.equal(preview2.targetId, imported2.id);
  assert.equal(imported2.mc, 'forge');
  assert.equal(fs.readFileSync(path.join(gameDirFor(imported2.id), 'mods/example.jar'), 'utf8'), 'isolated');
  assert.equal(JSON.parse(fs.readFileSync(path.join(base, 'loader.json'))).inheritsFrom, '1.20.1');
  assert.ok(fs.existsSync(path.join(mcDir, 'versions/forge/forge.json')));
  for (const [filename, manifest, key, overrides] of [
    ['cf.zip', 'manifest.json', {minecraft:{version:'1.20.1'}, overrides:'custom'}, 'custom'],
    ['mr.mrpack', 'modrinth.index.json', {dependencies:{minecraft:'1.20.1'}}, 'client-overrides'],
  ]) {
    const file = archive(dir, filename, {'Docs/readme.txt':'note', ['Outer/' + manifest]:JSON.stringify(key), ['Outer/' + overrides + '/mods/a.jar']:'jar'});
    assert.deepEqual((await inspectModpack(file)).overrides, [overrides]);
  }
  assert.throws(() => wrapperPrefix(['A/mods/a.jar','B/mods/b.jar']), /多个独立/);
});
