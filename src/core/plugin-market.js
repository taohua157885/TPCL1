import fs from 'node:fs';
import path from 'node:path';
import {DATA_DIR} from './config.js';
import {BUILTINS,compareVersion,validate} from '../../web/extensions/model.js';

const file=path.join(DATA_DIR,'launcher-plugins-v1.json');
function read() {
  try {return JSON.parse(fs.readFileSync(file,'utf8'))}
  catch(e){if(e.code==='ENOENT') return {offers:[],installed:[]}; throw Error('无法读取插件记录：'+e.message)}
}
const publicState=s=>({catalog:[...BUILTINS,...s.offers],installed:s.installed});
export function marketState(){return publicState(read())}
export function editMarket(body) {
  const s=read(), entry=s.installed.find(x=>x.plugin.id===body.id);
  if(body.action==='import') {
    const rows=body.plugins;
    if(!Array.isArray(rows)||!rows.length||rows.length>64)throw Error('每次可导入 1 至 64 个插件');
    const offers=new Map(s.offers.map(p=>[p.id,p]));
    const incoming=new Set();
    for(const raw of rows){
      const p=validate(raw),old=offers.get(p.id);
      if(incoming.has(p.id))throw Error('目录中有重复 ID：'+p.id);
      incoming.add(p.id);
      if(old && compareVersion(p.version,old.version)<0)throw Error('已有更高版本：'+p.name);
      if(old && p.version===old.version && JSON.stringify(old)!==JSON.stringify(p))throw Error('同一版本的内容有变化，请提高版本号：'+p.name);
      offers.set(p.id,p);
    }
    if(offers.size>256)throw Error('目录最多容纳 256 个外部插件');
    s.offers=[...offers.values()];
  }else if(body.action==='install'){
    const offer=publicState(s).catalog.find(p=>p.id===body.id);
    if(!offer)throw Error('插件已从目录移除');
    if(entry)entry.plugin=offer;
    else s.installed.push({plugin:offer,enabled:true});
  }else if(body.action==='uninstall')s.installed=s.installed.filter(x=>x.plugin.id!==body.id);
  else if(body.action==='toggle' && entry && typeof body.enabled==='boolean')entry.enabled=body.enabled;
  else if(body.action==='forget' && !entry)s.offers=s.offers.filter(x=>x.id!==body.id);
  else throw Error('插件状态已变化，请刷新市场');
  fs.mkdirSync(DATA_DIR,{recursive:true});
  fs.writeFileSync(file+'.tmp',JSON.stringify(s),{mode:0o600});fs.renameSync(file+'.tmp',file);
  return publicState(s);
}
export async function pluginMarketRoute(req,res,json){
  if(req.method==='GET')return json(res,200,marketState());
  if(req.method!=='POST')return json(res,405,{error:'不支持此请求方式'});
  if(req.headers['origin'] && req.headers.origin!=='http://'+req.headers.host)return json(res,403,{error:'只接受来自启动器的更改'});
  if(req.headers['content-type']?.split(';')[0]!=='application/json')return json(res,415,{error:'需要 JSON 文件'});
  const chunks=[];let bytes=0;
  for await(const c of req){bytes+=c.length;if(bytes>262144)return json(res,413,{error:'插件目录超过 256 KiB'});chunks.push(c)}
  const result=editMarket(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  json(res,200,result);
}
