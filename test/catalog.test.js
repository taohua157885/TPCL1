import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('CurseForge catalog uses categories, filters, pagination, and updates credentials without restart', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tpcl-catalog-'));
  process.env.TPCL_DATA_DIR = dir;
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; fs.rmSync(dir, { recursive: true, force: true }); });
  const cf = await import('../src/core/cf.js');
  assert.equal(cf.sourceStatus().configured, false);
  await assert.rejects(cf.searchCatalog(), /API Key/);
  cf.saveApiKey('test-key');
  const calls=[];
  globalThis.fetch = async (url, opts) => {
    calls.push({url:new URL(url), key:opts.headers['x-api-key']});
    return new Response(JSON.stringify({data:[{id:12,name:'Example Pack',slug:'example-pack',classId:4471,downloadCount:100,authors:[]}],pagination:{totalCount:60}}));
  };
  const result = await cf.searchCatalog({kind:'modpack',offset:24});
  assert.equal(result.hits[0].title,'Example Pack');
  assert.equal(result.total,60);
  assert.equal(calls[0].url.searchParams.get('classId'),'4471');
  assert.equal(calls[0].url.searchParams.get('index'),'24');
  assert.equal(calls[0].url.searchParams.has('gameVersion'),false);
  cf.saveApiKey('replacement-key');
  await cf.searchCatalog({kind:'mod',mc:'1.20.1',loader:'fabric'});
  assert.equal(calls[1].key,'replacement-key');
  assert.equal(calls[1].url.searchParams.get('modLoaderType'),'4');
  assert.equal(JSON.stringify(cf.sourceStatus()).includes('replacement-key'),false);
});

test('Modrinth browse requests return a catalog without search keywords', async t => {
  const original=globalThis.fetch; t.after(()=>{globalThis.fetch=original;});
  let request;
  globalThis.fetch=async url=>{request=new URL(url); return new Response(JSON.stringify({total_hits:1,hits:[{project_id:'pack',title:'Pack',project_type:'modpack'}]}));};
  const { searchProjects }=await import('../src/core/market.js');
  const data=await searchProjects({kind:'modpack',sort:'downloads'});
  assert.equal(data.hits[0].id,'pack');
  assert.equal(request.searchParams.has('query'),false);
  assert.deepEqual(JSON.parse(request.searchParams.get('facets')),[['project_type:modpack']]);
});
