export const destinations = Object.freeze({download:'下载',content:'内容管理',worlds:'存档备份',servers:'服务器',skins:'皮肤',settings:'启动器设置',more:'版本工具'});
export const features = Object.freeze({finder:'快捷版本搜索',compact:'紧凑列表',reading:'大号正文',still:'减少动画',quiet:'收起首页公告',shortcuts:'首页快捷入口'});
export const BUILTINS = [
  ['finder','快捷版本搜索','在启动器中按 Ctrl+K 回到首页并聚焦版本搜索框。',['finder']],
  ['compact','紧凑列表','缩短版本与资源列表的行距，一屏显示更多项目。',['compact']],
  ['reading','大字阅读','放大列表、表单和辅助说明的文字。',['reading']],
  ['motion','静态界面','停用界面过渡与装饰动画，减少视觉干扰。',['still']],
  ['focus','专注启动','隐藏首页公告，给账号与版本列表留出空间。',['quiet']],
  ['tools','存档与版本工具','在首页加入存档、内容管理和版本工具的快捷入口。',['shortcuts'],['worlds','content','more']]
].map(([id,name,description,effects,links=[]])=>({api:1,id:'tpcl.'+id,name,description,author:'TPCL',version:'1.0.0',effects,links}));

export function compareVersion(a,b) {
  const parts=b.split('.').map(Number);
  return a.split('.').map((v,i)=>Number(v)-parts[i]).find(Boolean) || 0;
}
export function validate(raw) {
  if (!raw || raw.api!==1) throw Error('插件需要声明 api 为 1');
  const allowed=['api','id','name','description','author','version','effects','links'];
  if (Object.keys(raw).some(k=>!allowed.includes(k))) throw Error('插件包含不支持的字段');
  const str=(key,max)=>{const v=raw[key];if(typeof v!=='string'||!v.trim()||v.length>max)throw Error('插件字段无效：'+key);return v.trim()};
  const id=str('id',70),version=str('version',20);
  if(!/^[a-z][a-z0-9.-]*$/.test(id)||id.startsWith('tpcl.')||['constructor','prototype'].includes(id))throw Error('插件 ID 无效或已被内置插件保留');
  if(!/^(0|[1-9]\d{0,4})(\.(0|[1-9]\d{0,4})){2}$/.test(version))throw Error('版本号应为三个整数，例如 1.0.0');
  function list(value,values){if(!Array.isArray(value)||value.length>Object.keys(values).length||value.some(k=>typeof k!=='string'||!Object.hasOwn(values,k)))throw Error('插件请求了不支持的功能');return [...new Set(value)]}
  const effects=list(raw.effects,features),links=list(raw.links??[],destinations);
  if(!effects.length||effects.includes('shortcuts')!==Boolean(links.length))throw Error('请声明有效的效果，并为 shortcuts 指定目标页面');
  return {api:1,id,version,name:str('name',48),description:str('description',240),author:str('author',48),effects,links};
}
