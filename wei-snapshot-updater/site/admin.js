// Loaded in <head>: apply the same day/night choice as the list page before first paint.
(()=>{
const root=document.documentElement;
const store={get(k){try{return localStorage.getItem(k);}catch{return null;}},set(k,v){try{localStorage.setItem(k,v);}catch{}}};
const darkQuery=matchMedia('(prefers-color-scheme: dark)');
const saved=store.get('rl-theme');root.dataset.theme=saved==='dark'||saved==='light'?saved:darkQuery.matches?'dark':'light';root.classList.add('rl-js');

document.addEventListener('DOMContentLoaded',()=>{
const $=id=>document.getElementById(id);let csrf='',servers=[];
const reduce=matchMedia('(prefers-reduced-motion: reduce)').matches;
const themeBtn=$('theme'),metaTheme=document.querySelector('meta[name="theme-color"]');
function paintTheme(t){root.dataset.theme=t;themeBtn.setAttribute('aria-pressed',String(t==='dark'));themeBtn.setAttribute('aria-label',t==='dark'?'切换到日间模式':'切换到夜间模式');$('themeText').textContent=t==='dark'?'日间':'夜间';metaTheme.content=t==='dark'?'#101113':'#ecebe7';}
paintTheme(root.dataset.theme);
themeBtn.addEventListener('click',()=>{const next=root.dataset.theme==='dark'?'light':'dark';store.set('rl-theme',next);
 if(reduce||!document.startViewTransition)return paintTheme(next);
 const r=themeBtn.getBoundingClientRect();root.style.setProperty('--vx',(r.left+r.width/2)+'px');root.style.setProperty('--vy',(r.top+r.height/2)+'px');
 root.classList.add('rl-vt');document.startViewTransition(()=>paintTheme(next)).finished.finally(()=>root.classList.remove('rl-vt'));});
darkQuery.addEventListener?.('change',e=>{if(!store.get('rl-theme'))paintTheme(e.matches?'dark':'light');});
requestAnimationFrame(()=>document.body.classList.add('rl-ready'));

function message(text,error=false){const m=$('message');m.textContent=text;m.classList.remove('hidden');m.classList.toggle('rl-alert',error);m.classList.remove('flash');void m.offsetWidth;m.classList.add('flash');}
// Every call goes through here. `r.json()` used to throw "Unexpected end of JSON input" whenever the
// endpoint answered HTML instead of JSON (e.g. a Pages Functions outage falls back to the static SPA
// shell). Read the body once as text, then parse defensively so the panel shows a real message.
async function request(path,body){
 let r,raw='';
 try{r=await fetch(path,{method:body?'POST':'GET',headers:body?{'Content-Type':'application/json','X-CSRF-Token':csrf}:{},body:body?JSON.stringify(body):undefined});}
 catch(e){throw Error('网络连接失败，请检查网络后重试');}
 try{raw=await r.text();}catch{raw='';}
 let data=null;
 try{data=raw?JSON.parse(raw):null;}catch{data=null;}
 if(r.ok&&(!data||typeof data!=='object'))throw Error('接口返回异常（非 JSON），稍后重试');
 if(!r.ok){
  // An HTML body here means the request never reached the Function (routing/outage), not an auth error.
  if(r.status===401&&path!='/api/admin/login'){
   csrf='';$('dashboard').classList.add('hidden');$('login-panel').classList.remove('hidden');
   throw Error('登录已过期，请重新登录');
  }
  if(data&&data.error)throw Error(data.error);
  throw Error('服务暂时不可用（HTTP '+r.status+'），请稍后刷新');
 }
 return data;
}
function reset(){const f=$('editor-form');HTMLFormElement.prototype.reset.call(f);f.elements.id.value='';f.elements.order.value=servers.length?Math.max(...servers.map(s=>s.order))+1:1;$('editor-title').textContent='添加服务器';}
function render(){const box=$('records');box.replaceChildren();[...servers].sort((a,b)=>a.order-b.order).forEach((s,i)=>{
 const row=document.createElement('article');row.className='rl-rec'+(s.enabled?'':' is-off');row.style.setProperty('--i',Math.min(i,10));
 const tile=document.createElement('div');tile.className='rl-rec-tile';tile.setAttribute('aria-hidden','true');tile.textContent=String(i+1).padStart(2,'0');
 const info=document.createElement('div');info.className='rl-rec-info';const title=document.createElement('strong');title.textContent=s.title+' · '+s.region;const desc=document.createElement('small');desc.textContent=s.maintainer+' / '+s.url;info.append(title,desc);
 const actions=document.createElement('div');actions.className='rl-actions';
 const edit=document.createElement('button');edit.type='button';edit.className='rl-btn';edit.textContent='编辑';edit.onclick=()=>{const f=$('editor-form');for(const key of ['id','title','region','maintainer','url','version','order','notes','statusPath'])f.elements[key].value=s[key]??'';f.elements.tags.value=(s.tags||[]).join(', ');f.elements.enabled.checked=s.enabled;$('editor-title').textContent='编辑 '+s.title;for(const r of box.children)r.classList.toggle('editing',r===row);$('editor-form').scrollIntoView({behavior:reduce?'auto':'smooth',block:'start'});};
 const del=document.createElement('button');del.type='button';del.className='rl-btn rl-danger';del.textContent='删除';del.onclick=async()=>{if(!confirm('确定删除 '+s.title+'？'))return;try{await request('/api/admin/delete',{id:s.id});await load();reset();message('已删除服务器');}catch(e){message(e.message,true);}};
 actions.append(edit,del);row.append(tile,info,actions);box.append(row);
 });if(!servers.length){const p=document.createElement('p');p.className='rl-notice';p.textContent='列表为空，添加你的第一个服务器。';box.append(p);}}
async function load(){const data=await request('/api/admin/state');csrf=data.csrf;servers=data.servers;$('login-panel').classList.add('hidden');$('dashboard').classList.remove('hidden');render();}
$('login-form').onsubmit=async e=>{e.preventDefault();const f=e.target;try{const data=await request('/api/admin/login',{username:f.elements.username.value,password:f.elements.password.value});csrf=data.csrf;f.elements.password.value='';await load();reset();message('登录成功');}catch(err){message(err.message,true);}};
$('editor-form').onsubmit=async e=>{e.preventDefault();const f=e.target;const body={};for(const key of ['id','title','region','maintainer','url','version','order','notes','statusPath'])body[key]=f.elements[key].value;body.tags=f.elements.tags.value.split(/[,，]/).map(v=>v.trim()).filter(Boolean);body.enabled=f.elements.enabled.checked;const button=f.querySelector('[type=submit]');button.disabled=true;try{await request('/api/admin/save',body);await load();reset();message('已保存。人数状态将在下一次自动检测时更新。');}catch(err){message(err.message,true);}finally{button.disabled=false;}};
$('password-form').onsubmit=async e=>{e.preventDefault();try{await request('/api/admin/password',Object.fromEntries(new FormData(e.target)));e.target.reset();csrf='';$('dashboard').classList.add('hidden');$('login-panel').classList.remove('hidden');message('密码已修改，请重新登录');}catch(err){message(err.message,true);}};
$('add').onclick=()=>{reset();for(const r of $('records').children)r.classList.remove('editing');$('editor-form').scrollIntoView({behavior:reduce?'auto':'smooth'});};$('reset').onclick=()=>{reset();for(const r of $('records').children)r.classList.remove('editing');};
$('logout').onclick=async()=>{try{await request('/api/admin/logout',{});csrf='';$('dashboard').classList.add('hidden');$('login-panel').classList.remove('hidden');message('已退出登录');}catch(err){message(err.message,true);}};
// Auto-enter: a still-valid session cookie means load() succeeds and the dashboard opens on its own;
// no cookie (or expired) leaves the login panel up. Previously the rejection was swallowed by
// `.catch(()=>{})`, so an outage looked like "nothing happens" — now it states why.
load().then(reset).catch(err=>{
 const msg=String(err&&err.message||'');
 // 401 is the normal "not logged in yet" path — stay quiet, the login form is the UI.
 if(/登录已过期|未登录/.test(msg))return;
 message(msg||'无法连接后台接口，请稍后重试',true);
});
});
})();
