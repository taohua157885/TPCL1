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
  const catalog=createCatalog({ api:url=>new Promise(resolve=>requests.push({url,resolve})), selected:()=> 'my-game', enqueue:()=>{}, context:async()=>({mcVer:'1.20.1',loader:'forge'}) });
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
