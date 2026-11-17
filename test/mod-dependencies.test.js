import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

test('mod installation resolves compatible required dependencies before downloading', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tpcl-mod-deps-'));
  process.env.TPCL_DATA_DIR = dir;
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; fs.rmSync(dir, { recursive: true, force: true }); });
  const { saveConfig } = await import('../src/core/config.js');
  saveConfig({ mcDir: path.join(dir, 'minecraft') });
  const { versionDir } = await import('../src/core/version.js');
  const { installProjectVersion, versionContext } = await import('../src/core/market.js');
  const cf = await import('../src/core/cf.js');
  const { planDependencies } = await import('../src/core/mod-dependencies.js');
  cf.saveApiKey('fixture-key');
  const makeTarget = (id, loader = 'fabric') => {
    fs.mkdirSync(versionDir(id), { recursive: true });
    fs.writeFileSync(path.join(versionDir(id), id + '.json'), JSON.stringify({ id, inheritsFrom: '1.20.1', libraries: [{ name: ({fabric:'net.fabricmc:fabric-loader:0.16.0',quilt:'org.quiltmc:quilt-loader:0.26',neoforge:'net.neoforged:forge:1.20.1-47',forge:'net.minecraftforge:forge:1.20.1-47'})[loader] }] }));
    return id;
  };
  fs.mkdirSync(versionDir('1.20.1'), { recursive: true });
  fs.writeFileSync(path.join(versionDir('1.20.1'), '1.20.1.json'), JSON.stringify({ id: '1.20.1' }));
  const bytes = id => Buffer.from('fixture jar ' + id);
  const hash = id => crypto.createHash('sha1').update(bytes(id)).digest('hex');
  const mrVersion = (project, id, deps = [], mc = '1.20.1', loader = 'fabric') => ({
    project_id: project, id, name: project + ' ' + id, version_number: id, date_published: '2026-01-01', game_versions: [mc], loaders: [loader], dependencies: deps,
    files: [{ filename: id + '.jar', url: 'https://files.test/' + id, size: bytes(id).length, hashes: { sha1: hash(id) }, primary: true }],
  });
  const dep = (project, version, type = 'required') => ({ project_id: project, version_id: version, dependency_type: type });
  let versions, downloads, requests;
  function mockMr(data) {
    versions = data; downloads = []; requests = [];
    globalThis.fetch = async url => {
      const u = new URL(url); requests.push(u);
      if (u.host === 'files.test') { downloads.push(u.pathname.slice(1)); return new Response(bytes(u.pathname.slice(1))); }
      if (u.pathname.startsWith('/v2/version/')) return Response.json(versions[u.pathname.split('/').at(-1)] || {});
      const id = u.pathname.split('/')[3];
      return Response.json(Object.values(versions).filter(v => v.project_id === id));
    };
  }
  await t.test('renamed profiles detect all four loaders from libraries', async () => {
    for (const loader of ['fabric','quilt','forge','neoforge']) {
      const id = makeTarget('custom-' + loader.slice(0,2), loader);
      assert.equal(versionContext(id).loader, loader);
      assert.equal((await cf.targetContext(id)).mcVer, '1.20.1');
      assert.equal((await cf.targetContext(id)).loader, loader);
    }
  });
  await t.test('Modrinth follows deep chains, version-only pins and cycles, deduplicates and reuses verified files', async () => {
    const target = makeTarget('deep');
    mockMr({ a:mrVersion('A','a',[dep('B'),dep('C'),dep('unused',null,'optional'),dep('embedded',null,'embedded')]),
      b:mrVersion('B','b',[dep('D')]), c:mrVersion('C','c',[dep('D')]),
      d:mrVersion('D','d',[dep(null,'e')]), e:mrVersion('E','e',[dep('A')]),
      wrong:mrVersion('B','wrong',[],'1.21.1'), wrongLoader:mrVersion('B','wrongLoader',[],'1.20.1','forge') });
    const progress = [];
    const result = await installProjectVersion({projectId:'A',versionId:'a',target,onProgress:p=>progress.push(p)});
    assert.equal(result.length,5);
    assert.deepEqual(downloads,['e','d','b','c','a']);
    const query = requests.find(u=>u.pathname==='/v2/project/B/version').searchParams;
    assert.equal(query.get('game_versions'),'["1.20.1"]');
    assert.equal(query.get('loaders'),'["fabric"]');
    assert.equal(progress.at(-1).percent,100);
    await installProjectVersion({projectId:'A',versionId:'a',target});
    assert.equal(downloads.length,5);
  });
  await t.test('a later exact dependency pin replaces an automatic latest choice', async () => {
    const target = makeTarget('late-pin');
    mockMr({a:mrVersion('A','a',[dep('B'),dep('C')]),b:mrVersion('B','b'),older:mrVersion('B','older'),c:mrVersion('C','c',[dep(null,'older')])});
    versions.older.date_published='2025-01-01';
    const result = await installProjectVersion({projectId:'A',versionId:'a',target});
    assert.equal(result.find(v=>v.projectId==='B').version,'older');
    assert.equal(downloads.includes('b'),false);
    assert.equal(result.length,3);
  });
  await t.test('Modrinth fails closed on missing, incompatible or conflicting required versions before writing files', async () => {
    const target = makeTarget('failures');
    for (const fixture of [
      {a:mrVersion('A','a',[dep('B')])},
      {a:mrVersion('A','a',[dep('B','b')]),b:mrVersion('B','b',[],'1.21.1')},
      {a:mrVersion('A','a',[dep('B','b'),dep('B','b2')]),b:mrVersion('B','b'),b2:mrVersion('B','b2')},
      {a:mrVersion('A','a',[dep(null,null)])},
      {a:mrVersion('A','a',[dep('B'),dep('B',null,'incompatible')]),b:mrVersion('B','b')},
    ]) {
      mockMr(fixture);
      await assert.rejects(installProjectVersion({projectId:'A',versionId:'a',target}), /前置|依赖|冲突/);
      assert.equal(downloads.length,0);
      assert.equal(fs.existsSync(path.join(versionDir(target),'mods','a.jar')),false);
    }
    mockMr({a:mrVersion('A','a')});
    await assert.rejects(installProjectVersion({projectId:'A',versionId:'deleted',target}));
    assert.equal(downloads.length,0);
    await assert.rejects(installProjectVersion({projectId:'A',versionId:'a',target:'1.20.1'}), /加载器/);
  });
  const cfFile = (modId,id,deps=[],loader='Fabric') => ({modId,id,displayName:'mod '+modId,fileName:id+'.jar',gameVersions:['1.20.1',loader],isAvailable:true,fileDate:'2026-01-01',fileLength:bytes(String(id)).length,hashes:[{algo:1,value:hash(String(id))}],downloadUrl:'https://files.test/'+id,dependencies:deps});
  function mockCf(data) {
    downloads=[]; requests=[];
    globalThis.fetch=async url=>{
      const u=new URL(url); requests.push(u);
      if(u.host==='files.test'){ downloads.push(Number(u.pathname.slice(1))); return new Response(bytes(u.pathname.slice(1))); }
      const parts=u.pathname.split('/');
      const value=parts.length===6 ? data[parts[5]] : Object.values(data).filter(f=>String(f.modId)===parts[3]);
      return Response.json({data:value});
    };
  }
  await t.test('CurseForge installs recursive compatible dependencies once and skips optional/embedded files', async () => {
    const target=makeTarget('cf-success');
    const required=modId=>({modId,relationType:3});
    mockCf({11:cfFile(1,11,[required(2),required(3),{modId:99,relationType:2},{modId:98,relationType:1}]),
      21:cfFile(2,21,[required(4)]),31:cfFile(3,31,[required(4)]),41:cfFile(4,41,[required(1)]),22:cfFile(2,22,[],'Forge')});
    const result=await cf.installCfFile({modId:1,fileId:11,target,classId:6});
    assert.equal(result.installed.length,4);
    assert.deepEqual(downloads,[41,21,31,11]);
    const query=requests.find(u=>u.pathname==='/v1/mods/2/files').searchParams;
    assert.equal(query.get('gameVersion'),'1.20.1');
    assert.equal(query.get('modLoaderType'),'4');
  });
  await t.test('CurseForge missing compatible dependency stops the root download', async () => {
    const target=makeTarget('cf-failure');
    mockCf({11:cfFile(1,11,[{modId:2,relationType:3}]),21:cfFile(2,21,[],'Forge')});
    await assert.rejects(cf.installCfFile({modId:1,fileId:11,target,classId:6}), /必需前置/);
    assert.deepEqual(downloads,[]);
  });
  await t.test('a failed dependency download cannot report success or install the root jar', async () => {
    const target=makeTarget('transfer-failure');
    mockMr({a:mrVersion('A','a',[dep('B')]),b:mrVersion('B','b')});
    const mock=globalThis.fetch;
    globalThis.fetch=async url=>new URL(url).host==='files.test' ? new Response('unavailable',{status:503}) : mock(url);
    const progress=[];
    await assert.rejects(installProjectVersion({projectId:'A',versionId:'a',target,onProgress:p=>progress.push(p)}), /必需前置下载失败/);
    assert.equal(progress.some(p=>p.percent===100),false);
    assert.equal(fs.existsSync(path.join(versionDir(target),'mods','a.jar')),false);
  });
  await t.test('file collisions and unsafe filenames are rejected during planning', async () => {
    for(const filename of ['../escape.jar','x.jar']) {
      await assert.rejects(planDependencies({projectId:'A'},async ref=>({projectId:ref.projectId,versionId:'1',name:ref.projectId,file:{filename},required:ref.projectId==='A'?[{projectId:'B'}]:[]})), /文件名/);
    }
  });
});
