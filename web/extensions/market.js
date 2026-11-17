import {compareVersion,destinations,features} from './model.js';

const make=(tag,text,cls)=>{const el=document.createElement(tag);if(text)el.textContent=text;if(cls)el.className=cls;return el};
function button(label,fn,cls){const el=make('button',label,cls);el.type='button';el.addEventListener('click',fn);return el}
let state={catalog:[],installed:[]},scope='all',busy=false;
const dialog=make('dialog');dialog.id='plugin-market';dialog.setAttribute('aria-labelledby','pm-title');
const title=make('h2','插件市场');title.id='pm-title';
const header=make('header');header.append(title,button('关闭',()=>dialog.close()));
const toolbar=make('div','','pm-toolbar'),search=make('input');search.type='search';search.placeholder='搜索名称、功能或作者';search.setAttribute('aria-label','搜索插件');
const scopeButton=(label,value)=>button(label,()=>{scope=value;render()});
const all=scopeButton('全部插件','all'),installed=scopeButton('已安装','installed');
toolbar.append(all,installed,search);
const source=make('details'),sourceTitle=make('summary','导入插件或添加目录'),sourceTools=make('div','','pm-source');
const local=make('input');local.type='file';local.accept='.json,application/json';local.setAttribute('aria-label','导入插件 JSON 文件');
const url=make('input');url.type='url';url.placeholder='https://…/catalog.json';url.setAttribute('aria-label','HTTPS 插件目录地址');
sourceTools.append(local,url,button('读取目录',()=>perform(async()=>{
  const address=new URL(url.value.trim());if(address.protocol!=='https:'||address.username||address.password)throw Error('请输入 HTTPS 公开目录地址');
  const response=await fetch(address,{credentials:'omit',referrerPolicy:'no-referrer',signal:AbortSignal.timeout(12000)});
  if(!response.ok)throw Error('目录返回 HTTP '+response.status);
  const reader=response.body.getReader(),decoder=new TextDecoder();let size=0,raw='';
  while(true){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>262144){await reader.cancel();throw Error('目录超过 256 KiB')}raw+=decoder.decode(value,{stream:true})}
  return importText(raw+decoder.decode());
})));
source.append(sourceTitle,sourceTools);
let failure=null;
const exportError=button('导出错误报告',()=>{
  if(!failure)return;
  const blob=new Blob([JSON.stringify(failure,null,2)],{type:'application/json'});
  const link=make('a');link.href=URL.createObjectURL(blob);link.download='TPCL-plugin-market-error.json';link.click();setTimeout(()=>URL.revokeObjectURL(link.href),1000);
});
exportError.hidden=true;
const status=make('output','','pm-status');status.setAttribute('aria-live','polite');
const list=make('div','','pm-list');dialog.append(header,toolbar,source,status,exportError,list);document.body.append(dialog);
const trigger=button('插件市场',()=>{dialog.showModal();search.focus();perform(refresh)},'mini-btn');trigger.id='btn-plugin-market';
document.querySelector('.top-actions').prepend(trigger);
let activeFeatures=new Set();
document.addEventListener('keydown',event=>{
  if(!activeFeatures.has('finder')||event.repeat||event.key.toLowerCase()!=='k'||!event.ctrlKey||event.altKey||event.shiftKey||document.querySelector('dialog[open],.modal-mask:not([hidden])'))return;
  const field=document.querySelector('#search-version');if(!field)return;
  event.preventDefault();document.querySelector('.nav-btn[data-view="home"]')?.click();field.focus();field.select();
});
function apply(){
  const enabled=state.installed.filter(e=>e.enabled);
  activeFeatures=new Set(enabled.flatMap(e=>e.plugin.effects));
  for(const feature of ['compact','reading','quiet','still'])document.documentElement.classList.toggle('pm-'+feature,activeFeatures.has(feature));
  document.querySelector('#view-home .notice-list')?.closest('.side-card')?.classList.add('pm-notices');
  document.querySelector('#pm-home-tools')?.remove();
  const links=new Set(enabled.flatMap(e=>e.plugin.links));
  if(links.size){
    const tools=make('nav');tools.id='pm-home-tools';tools.setAttribute('aria-label','插件快捷入口');
    for(const key of links)tools.append(button(destinations[key],()=>document.querySelector('.nav-btn[data-view="'+key+'"]')?.click(),'mini-btn'));
    document.querySelector('.home-side')?.append(tools);
  }
}
async function perform(fn){
  if(busy)return;busy=true;exportError.hidden=true;status.textContent='处理中…';
  try {const message=await fn();status.textContent=message||''}
  catch(error){
    status.textContent='操作失败 · '+error.message;
    // Keep imported text, addresses, credentials and profile paths out of exported reports.
    failure={module:'plugin-market',time:new Date().toISOString(),error:error.name,stage:source.open?'catalog or management':'management',online:navigator.onLine,
      reason:error instanceof SyntaxError?'JSON 格式错误':String(error.message).replace(/https?:\/\/[^\s]+/ig,'[URL]').slice(0,200)};
    exportError.hidden=false;
    if(document.getElementById('btn-reports'))fetch('/api/reports/client',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({message:'插件市场 · '+failure.reason,context:{module:'plugin-market'}})}).catch(()=>{});
  }
  finally{busy=false}
}
async function request(body){
  const res=await fetch('/api/plugin-market',body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{cache:'no-store'});
  const data=await res.json();
  if(!res.ok||data.error)throw Error(data.error||'请求失败');
  state=data;apply();render();
}
async function refresh(){await request()}
async function importText(text){
  const obj=JSON.parse(text.replace(/^\uFEFF/,''));
  await request({action:'import',plugins:Array.isArray(obj)?obj:obj.plugins??[obj]});
  scope='all';search.value='';render();return '插件已加入目录，可选择安装。';
}
local.addEventListener('change',()=>perform(async()=>{
  const file=local.files[0];local.value='';if(!file)return;
  if(file.size>262144)throw Error('文件超过 256 KiB');return importText(await file.text());
}));
function render(){
  all.setAttribute('aria-pressed',String(scope==='all'));installed.setAttribute('aria-pressed',String(scope==='installed'));
  installed.textContent='已安装 · '+state.installed.length;
  list.replaceChildren();const query=search.value.trim().toLowerCase();
  for(const p of state.catalog){
    const entry=state.installed.find(x=>x.plugin.id===p.id);
    if(scope==='installed'&&!entry)continue;
    if(![p.name,p.author,p.description,...p.effects.map(k=>features[k])].join(' ').toLowerCase().includes(query))continue;
    const row=make('article','','pm-card'), info=make('div','','pm-info');
    const meta=[p.author,'v'+p.version,...p.effects.map(k=>features[k])];if(entry)meta.push((entry.enabled?'已启用':'已停用')+' v'+entry.plugin.version);
    info.append(make('h3',p.name),make('p',p.description),make('small',meta.join(' · '),'pm-meta'));
    const actions=make('div','','pm-actions');
    function action(label,name,extra={},cls){actions.append(button(label,()=>perform(async()=>{await request({action:name,id:p.id,...extra});return p.name+' · 操作已保存'}),cls))}
    if(!entry)action('安装并启用','install',{},'pm-install');
    else {
      if(compareVersion(p.version,entry.plugin.version)>0)action('更新','install');
      action(entry.enabled?'停用':'启用','toggle',{enabled:!entry.enabled});action('卸载','uninstall');
    }
    if(!entry&&!p.id.startsWith('tpcl.'))action('移出目录','forget');
    row.append(info,actions);list.append(row);
  }
  if(!list.children.length)list.append(make('p',query?'没有匹配的插件。':scope==='installed'?'尚未安装插件。':'目录为空。'));
}
search.addEventListener('input',render);
// Opening the market also refreshes state after a previous startup error.
perform(refresh);
