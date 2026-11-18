import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCatalog } from '../web/catalog.js';

test('pack browse ignores selected game filters and stale responses cannot overwrite a newer category', async t => {
  class Element {
    constructor() { this.children=[]; this.value=''; this.checked=true; }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children=children; }
  }
  const ids=Object.fromEntries(['mk-type','mk-query','mk-list','mk-sort','mk-scope','catalog-match'].map(id=>[id,new Element()]));
  ids['mk-type'].value='modpack'; ids['mk-sort'].value='downloads';
  const old=globalThis.document;
  globalThis.document={getElementById:id=>ids[id], createElement:()=>new Element(),querySelector:()=>({dataset:{mksrc:'modrinth'}})};
  t.after(()=>{globalThis.document=old;});
  const requests=[];
  const catalog=createCatalog({ api:url=>url === '/api/catalog/sources' ? Promise.resolve({curseforge:{configured:false}}) : new Promise(resolve=>requests.push({url,resolve})), selected:()=> 'my-game', enqueue:()=>{}, context:async()=>({mcVer:'1.20.1',loader:'forge'}) });
  const first=catalog.search(); await new Promise(r=>setImmediate(r));
  assert.equal(new URL(requests[0].url,'http://local').searchParams.get('mc'),'');
  ids['mk-type'].value='mod';
  const second=catalog.search(); await new Promise(r=>setImmediate(r));
  assert.equal(new URL(requests[1].url,'http://local').searchParams.get('mc'),'1.20.1');
  requests[1].resolve({total:1,hits:[{id:'new',title:'New results'}]}); await second;
  requests[0].resolve({total:8,hits:[{id:'old',title:'Stale results'}]}); await first;
  assert.match(ids['mk-scope'].textContent,/1 个项目/);
  assert.equal(ids['mk-list'].children[0].children[1].children[0].textContent,'New results');
});

test('both platforms share one catalog, recover separately and continue at their own offsets', async t => {
  class Element {
    constructor() { this.children = []; this.value = ''; }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
  }
  const ids = Object.fromEntries(['mk-type','mk-query','mk-list','mk-sort','mk-scope','catalog-match'].map(id => [id,new Element()]));
  ids['mk-type'].value = 'mod';
  ids['mk-sort'].value = 'downloads';
  const old = globalThis.document;
  globalThis.document = {getElementById:id=>ids[id], createElement:()=>new Element()};
  t.after(() => {globalThis.document = old;});
  const offsets = [];
  let tries = 0;
  const api = async url => {
    if (url === '/api/catalog/sources') return {curseforge:{configured:true}};
    const parsed = new URL(url, 'http://local');
    const offset = Number(parsed.searchParams.get('offset'));
    if (parsed.pathname.includes('/cf/')) {
      offsets.push('cf:' + offset);
      if (++tries === 1) throw Error('temporary');
      return {total:1,hits:[{id:'1',title:'CF',downloads:5}]};
    }
    offsets.push('mr:' + offset);
    return {total:2,hits:[{id:String(offset), title:'MR' + offset,downloads:offset}]};
  };
  const catalog = createCatalog({api, selected:()=>'', context:async()=>({}), enqueue:()=>{}});
  await catalog.search();
  const results = () => ids['mk-list'].children.filter(el=>el.className==='catalog-card').map(el=>el.children[1].children[0].textContent);
  assert.deepEqual(results(), ['MR0']);
  await ids['mk-list'].children.at(-1).onclick();
  assert.deepEqual(results(), ['CF','MR1','MR0']);
  assert.deepEqual(offsets, ['mr:0','cf:0','mr:1','cf:0']);
});
