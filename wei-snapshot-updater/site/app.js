// Loaded in <head> (CSP allows only same-origin scripts): set the theme and boot state before first paint, run the page on DOMContentLoaded.
(()=>{
const root=document.documentElement;
const reduce=matchMedia('(prefers-reduced-motion: reduce)').matches;
const darkQuery=matchMedia('(prefers-color-scheme: dark)');
const store={get(k){try{return localStorage.getItem(k);}catch{return null;}},set(k,v){try{localStorage.setItem(k,v);}catch{}}};
const session={get(k){try{return sessionStorage.getItem(k);}catch{return null;}},set(k,v){try{sessionStorage.setItem(k,v);}catch{}}};
function preferredTheme(){const saved=store.get('rl-theme');return saved==='dark'||saved==='light'?saved:darkQuery.matches?'dark':'light';}
root.dataset.theme=preferredTheme();root.classList.add('rl-js');
const bootNow=!reduce&&session.get('rl-boot')!=='1';
if(bootNow)root.classList.add('rl-booting');

document.addEventListener('DOMContentLoaded',()=>{
const $=id=>document.getElementById(id);
let busy=false,first=true,servers=[];
const voting=new Set(),seen=new Set();const frame=document.querySelector('.rl-frame');
const readyQueue=[];let isReady=false;
function whenReady(fn){if(isReady)fn();else readyQueue.push(fn);}
function element(tag,text,className){const e=document.createElement(tag);if(text!=null)e.textContent=text;if(className)e.className=className;return e;}

// ---------- decorative text effects (only on aria-hidden / code text) ----------
const GLYPHS='ABCDEFGHJKLMNPQRSTUVWXYZ0123456789#%&/<>';
function scramble(el,text,dur=420){
 if(!el)return;cancelAnimationFrame(el._sc||0);
 if(reduce){el.textContent=text;return;}
 const chars=[...text],start=performance.now();
 const tick=now=>{const p=Math.min(1,(now-start)/dur),n=Math.floor(p*chars.length);let out='';
  for(let i=0;i<chars.length;i++)out+=i<n||chars[i]===' '?chars[i]:GLYPHS[Math.random()*GLYPHS.length|0];
  el.textContent=out;if(p<1)el._sc=requestAnimationFrame(tick);};
 el._sc=requestAnimationFrame(tick);
}
function typeText(el,text,step=26){return new Promise(done=>{if(reduce){el.textContent=text;return done();}let i=0;el.textContent='';const t=setInterval(()=>{el.textContent=text.slice(0,++i);if(i>=text.length){clearInterval(t);done();}},step);el._tt=t;});}
function countUp(el,to,dur=650){if(reduce||!Number.isFinite(to)){el.textContent=String(to);return;}const start=performance.now();const tick=now=>{const p=Math.min(1,(now-start)/dur);el.textContent=String(Math.round(to*(1-Math.pow(1-p,3))));if(p<1)requestAnimationFrame(tick);};requestAnimationFrame(tick);}

// ---------- theme ----------
const themeBtn=$('theme'),metaTheme=document.querySelector('meta[name="theme-color"]');
function paintTheme(t){root.dataset.theme=t;themeBtn.setAttribute('aria-pressed',String(t==='dark'));themeBtn.setAttribute('aria-label',t==='dark'?'切换到日间模式':'切换到夜间模式');$('themeText').textContent=t==='dark'?'日间':'夜间';metaTheme.content=t==='dark'?'#101113':'#ecebe7';}
paintTheme(root.dataset.theme);
themeBtn.addEventListener('click',()=>{
 const next=root.dataset.theme==='dark'?'light':'dark';store.set('rl-theme',next);
 if(reduce||!document.startViewTransition)return paintTheme(next);
 const r=themeBtn.getBoundingClientRect();root.style.setProperty('--vx',(r.left+r.width/2)+'px');root.style.setProperty('--vy',(r.top+r.height/2)+'px');
 root.classList.add('rl-vt');document.startViewTransition(()=>paintTheme(next)).finished.finally(()=>root.classList.remove('rl-vt'));
});
darkQuery.addEventListener?.('change',e=>{if(!store.get('rl-theme'))paintTheme(e.matches?'dark':'light');});

// ---------- copy / history / rating (same behaviour as before) ----------
async function copyUrl(url){
 if(navigator.clipboard?.writeText){try{await navigator.clipboard.writeText(url);return true;}catch{}}
 const previous=document.activeElement,field=element('textarea');field.value=url;field.readOnly=true;field.style.cssText='position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;font-size:16px;';document.body.append(field);
 let copied=false;try{field.focus({preventScroll:true});field.select();field.setSelectionRange(0,url.length);copied=document.execCommand('copy');}catch{}finally{field.remove();try{previous?.focus({preventScroll:true});}catch{}}
 return copied;
}
function history(server){
 const box=element('div',null,'rl-history');
 // Prefer OUR OWN probe tally (probeHistory24h, produced by the snapshot Actions runner) over the
 // upstream's history: upstream's numbers are mirrored AND our pin forces uptime to 100%, so only
 // our own tally can show "we actually failed to reach this server". Falls back to upstream's when
 // the probe series is not there yet (fresh installs / older snapshots).
 const own=Array.isArray(server.probeHistory24h)&&server.probeHistory24h.length?server.probeHistory24h.map(([ts,n,ok])=>[ts,null,n?Math.min(1,ok/n):null]):null;
 const series=own||server.history24h;
 const uptime=own?server.probeUptime24h:server.uptime24h;
 const samples=(series||[]).filter(p=>p[2]!=null).length;
 const heading=element('div',null,'rl-hhead');heading.append(element('span',own?'24小时在线情况（本站探测）':'24小时在线情况'),element('strong',samples&&uptime!=null?uptime+'% 在线':'尚无采样'));
 const bars=element('div',null,'rl-bars');bars.setAttribute('role','img');bars.setAttribute('aria-label','最近24小时在线情况，绿色在线、黄色部分可用、红色未连通、灰色未采集');
 (series||Array.from({length:48},()=>[null,null,null])).forEach((p,i)=>{
  const state=p[2]==null?'unknown':p[2]>=.99?'up':p[2]<=.01?'down':'partial';const bar=element('span',null,'rl-bar '+state);bar.style.setProperty('--b',i);
  bar.title=(p[0]?new Date(p[0]).toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'})+' · ':'')+(p[2]==null?'未采集':Math.round(p[2]*100)+'% 检测可用')+(p[1]!=null?' · 峰值 '+p[1]+' 人':'');bars.append(bar);
 });
 const labels=element('div',null,'rl-hlabels');labels.append(element('span','24小时前'),element('span','现在'));
 box.append(heading,bars,labels);
 if(samples<(series||[]).length)box.append(element('small',own?'本站每 30 分钟探测一次；灰色为未采集时段，在线率按已采样数据计算。':'灰色为未采集时段；在线率按已采样数据计算。','rl-hnote'));
 return box;
}
function rating(server){
 const panel=element('div',null,'rl-rating');const r0=server.rating||{large:0,medium:0};
 const heading=element('div',null,'rl-rhead');heading.append(element('span','玩家评分'),element('small',(r0.large+r0.medium)+' 票'));
 const buttons=element('div',null,'rl-votes');const feedback=element('div','每个浏览器一票，当天首次选择即记录','rl-vfeed');feedback.setAttribute('role','status');
 // QUOTA UI (owner rule 2026-10-21, KV free tier = 1000 writes/day red line): a click ALWAYS shows
 // success instantly (optimistic). The POST goes out at most ONCE per UTC day per server (localStorage
 // gate here; the server caps at ≤1 KV write per browser+server+day regardless). Same-day changes are
 // display-only until the next day's click re-syncs.
 const DAY=new Date().toISOString().slice(0,10);const SENT='rl-vote-day:'+server.id;
 // Local record of MY pick today (the snapshot is anonymous, so selection highlight needs this).
 const MINE='rl-vote-mine:'+server.id;
 const localMine=()=>{try{const j=JSON.parse(localStorage.getItem(MINE)||'null');return j&&j.d===DAY&&(j.c==='large'||j.c==='medium')?j.c:null}catch{return null}};
 const votedToday=()=>{try{return localStorage.getItem(SENT)===DAY}catch{return false}};
 const markSent=(c)=>{try{localStorage.setItem(SENT,DAY);localStorage.setItem(MINE,JSON.stringify({d:DAY,c}))}catch{}};
 const counts={large:Math.max(0,r0.large|0),medium:Math.max(0,r0.medium|0)};let mine=localMine()||r0.mine||null;
 const LABEL={large:'超大杯',medium:'中杯'};
 const sync=(bump)=>{for(const [i,key]of ['large','medium'].entries()){const b=buttons.children[i];if(!b)continue;const num=b.querySelector('strong');const changed=num.textContent!==String(counts[key]);b.classList.toggle('selected',mine===key);b.setAttribute('aria-pressed',String(mine===key));num.textContent=counts[key];if((changed||key===mine)&&bump){b.classList.remove('bump');void b.offsetWidth;b.classList.add('bump');}}heading.querySelector('small').textContent=(counts.large+counts.medium)+' 票';};
 for(const [choice,label]of [['large','超大杯'],['medium','中杯']]){
  const button=element('button',null,'rl-vote'+(mine===choice?' selected':''));button.type='button';button.setAttribute('aria-pressed',String(mine===choice));button.append(element('span',label),element('strong',String(counts[choice])));
  button.addEventListener('click',()=>{
   if(mine===choice)return;
   const prev=mine;if(prev)counts[prev]=Math.max(0,counts[prev]-1);counts[choice]+=(1|0);mine=choice;
   sync(true);feedback.textContent='已选择'+label+'，感谢！';
   if(votedToday())return;markSent(choice);
   fetch('/api/vote',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:server.id,choice})}).then(async(res)=>{
    const d=await res.json().catch(()=>null);if(!res.ok||!d||!d.rating)return;
    counts.large=d.rating.large|0;counts.medium=d.rating.medium|0;mine=d.rating.mine||null;sync(false);
    feedback.textContent=d.rating.sameDay&&mine?'今天已记录「'+LABEL[mine]+'」，改选明天生效':'已记录，感谢！';
   }).catch(()=>{/* optimistic display stands; nothing was written today */});
  });
  buttons.append(button);
 }
 panel.append(heading,buttons,feedback);return panel;
}
function stateOf(server){const s=server.status||{};return s.state==='online'?'online':s.state==='maintenance'?'maint':s.state==='checking'?'checking':'offline';}
const STATE_TEXT={online:'在线',maint:'维护中',checking:'查询中',offline:'暂未连通'};

// ---------- list rows ----------
const pending=new Set();
function checkReveal(){if(!isReady)return;const limit=innerHeight*.95;for(const el of pending){if(!el.isConnected){pending.delete(el);continue;}const r=el.getBoundingClientRect();if(r.bottom<=0){pending.delete(el);el.classList.add('static');show(el);}else if(r.top<limit){pending.delete(el);show(el);}}}
function show(el){
 el.classList.add('in');
 if(el.classList.contains('rl-row')){seen.add(el.dataset.id);scramble(el.querySelector('.rl-tile em'),el.querySelector('.rl-tile em').dataset.code,520);}
}
function watch(el){if(reduce){el.classList.add('in','static');return;}pending.add(el);whenReady(()=>requestAnimationFrame(checkReveal));}
function row(server,index){
 const s=server.status||{},state=stateOf(server),no=String(index+1).padStart(2,'0'),code='SRV-'+String(index+1).padStart(3,'0');
 const root=element('article',null,'rl-row is-'+state);root.dataset.id=server.id;root.style.setProperty('--i',index%4);
 const tile=element('div',null,'rl-tile');tile.setAttribute('aria-hidden','true');const em=element('em',code);em.dataset.code=code;tile.append(element('small','NODE'),element('strong',no),em);
 const main=element('div',null,'rl-rmain');const title=element('div',null,'rl-rtitle');title.append(element('h3',server.title),element('span',STATE_TEXT[state],'rl-state'));
 const meta=element('p',server.region+' · '+server.maintainer+' · v'+(s.version||server.version||'未知'),'rl-meta');const tags=element('div',null,'rl-tags');for(const t of server.tags||[])tags.append(element('span',t));
 const stats=element('div',null,'rl-stats');for(const [name,value]of [[s.countKind==='players'?'人在线':'个连接',s.online],['房间',s.rooms],['对局',s.matches]]){const stat=element('span');stat.append(element('strong',value==null?'—':String(value)),element('small',name));stats.append(stat);}
 const actions=element('div',null,'rl-actions');const copy=element('button','复制网址','rl-btn');copy.type='button';copy.title=server.url;copy.setAttribute('aria-label','复制'+server.title+'网址');
 const manual=element('input',null,'rl-manual hidden');manual.readOnly=true;manual.value=server.url;manual.setAttribute('aria-label','长按复制服务器网址');
 copy.onclick=async()=>{const ok=await copyUrl(server.url);copy.textContent=ok?'已复制 ✓':'长按复制';manual.classList.toggle('hidden',ok);if(!ok){manual.focus();manual.select();}setTimeout(()=>copy.textContent='复制网址',2500);};
 const detail=element('button','详情','rl-btn');detail.type='button';detail.setAttribute('aria-label','查看'+server.title+'详情');detail.onclick=()=>showDetails(server,index);
 const join=element('a','加入网站 ↗','rl-btn rl-join');join.href=server.url;join.target='_blank';join.rel='noopener noreferrer';actions.append(copy,detail,join);
 main.append(title,meta,tags);if(server.notice)main.append(element('p',server.notice,'rl-rnotice'));main.append(stats,actions,manual);
 const side=element('div',null,'rl-rside');side.append(history(server),rating(server));root.append(tile,main,side);
 if(seen.has(server.id))root.classList.add('in','static');else watch(root);
 return root;
}

// ---------- hero cluster: one small tile per server, click to jump ----------
const SLOTS=[[30,12],[54,6],[78,10],[93,34],[7,30],[4,62],[93,64],[18,88],[44,95],[72,90],[93,94],[78,30]];
let satsBuilt=false;
function buildSats(){
 const box=$('sats');box.replaceChildren();
 servers.slice(0,SLOTS.length).forEach((server,i)=>{
  const [x,y]=SLOTS[i],state=stateOf(server);const sat=element('button',null,'rl-sat is-'+state+(i%3===1?' light':''));sat.type='button';
  sat.style.setProperty('--x',x+'%');sat.style.setProperty('--y',y+'%');sat.style.setProperty('--k',i);sat.setAttribute('aria-label','跳到 '+server.title+'（'+STATE_TEXT[state]+'）');
  const inner=element('span',null,'rl-sat-in');inner.append(element('strong',String(i+1).padStart(2,'0')),element('small',server.title));sat.append(inner);
  sat.addEventListener('click',()=>jumpTo(server.id));box.append(sat);
 });
 if(!satsBuilt){satsBuilt=true;whenReady(()=>setTimeout(()=>$('cluster').classList.add('settled'),2400));}
}
function jumpTo(id){
 const el=document.querySelector('.rl-row[data-id="'+CSS.escape(id)+'"]');if(!el)return;
 el.scrollIntoView({behavior:reduce?'auto':'smooth',block:'center'});pending.delete(el);show(el);
 el.classList.remove('ping');void el.offsetWidth;el.classList.add('ping');setTimeout(()=>el.classList.remove('ping'),1600);
 el.querySelector('.rl-btn')?.focus({preventScroll:true});
}

// ---------- details dialog ----------
const dialog=element('dialog',null,'rl-dialog');dialog.setAttribute('aria-labelledby','detail-title');document.body.append(dialog);
function closeDialog(){if(!dialog.open||dialog.classList.contains('closing'))return;if(reduce)return dialog.close();dialog.classList.add('closing');setTimeout(()=>{dialog.classList.remove('closing');dialog.close();},230);}
function showDetails(server,index){
 dialog.replaceChildren();const no=String((index??0)+1).padStart(3,'0');
 const head=element('div',null,'rl-dhead');const file=element('span','FILE NUMBER: SRV-'+no,'rl-code');file.setAttribute('aria-hidden','true');const close=element('button','关闭 ×','rl-btn');close.type='button';close.onclick=closeDialog;head.append(file,close);
 const plate=element('div',null,'rl-plate');const title=element('h2',server.title);title.id='detail-title';plate.append(element('small','MAINTAINER / '+server.maintainer),title,element('span',server.region+' · v'+(server.status?.version||server.version||'未知')+' · '+STATE_TEXT[stateOf(server)]));
 const water=element('b','INFO','rl-dwater');water.setAttribute('aria-hidden','true');
 dialog.append(water,head,plate,element('p',server.notes||'暂无补充说明。','rl-ddesc'));if(server.notice)dialog.append(element('p',server.notice,'rl-notice'));
 const links=element('div',null,'rl-links');for(const n of [{name:'主要入口',url:server.url},...(server.nodes||[])]){const a=element('a',null);a.href=n.url;a.target='_blank';a.rel='noopener noreferrer';a.append(element('strong',n.name+' ↗'),element('small',n.url));links.append(a);}
 const hist=history(server);hist.classList.add('in');
 dialog.append(links,hist,element('p','绿色：在线 · 黄色：部分可用 · 红色：未连通 · 灰色：未采集。每段30分钟，在线率按已采样结果计算；无法连接可能是检测线路问题。','rl-foot'));
 if(!dialog.open)dialog.showModal();close.focus();scramble(file,file.textContent,500);
}
dialog.addEventListener('cancel',e=>{e.preventDefault();closeDialog();});
dialog.addEventListener('click',e=>{if(e.target===dialog){const r=dialog.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)closeDialog();}});

// ---------- thanks roll (左右滚动感谢名单) ----------
// 数据：内置副本 public/data/thanks.json（首屏零请求、零等待），挂载后再尝试刷新一次上游
// （ganxiemingdan.jiangjiangze.icu/api/thanks，带 v 版本号；失败/无变化都保持现状，不打扰渲染）。
const THANKS_URL='https://ganxiemingdan.jiangjiangze.icu/api/thanks';
function thanksItem(n,prefix){
 const item=element('span',null,'rl-tk');
 if(prefix)item.append(element('span',prefix,'rl-tk-prefix'));
 item.append(element('strong',n.name,'rl-tk-name'));
 if(n.role)item.append(element('small',n.role,'rl-tk-role'));
 return item;
}
async function loadThanks(){
 const rail=$('thanksRail');if(!rail)return;
 let data=null;
 try{data=await (await fetch('/data/thanks.json',{cache:'force-cache'})).json();}catch{}
 if(!data||!Array.isArray(data.names)||!data.names.length)return;
 paintThanks(data);
 // 静默刷新：仅当上游版本更新时才替换，避免无谓重绘。（超时同理：上游挂住不该拖住页面。）
 try{
  const remote=await (await fetch(THANKS_URL,{cache:'no-store',signal:AbortSignal.timeout(10000)})).json();
  if(remote&&Array.isArray(remote.names)&&remote.names.length&&remote.v!==data.v)paintThanks(remote);
 }catch{}
}
function paintThanks(data){
 const rail=$('thanksRail');if(!rail)return;
 const prefix=data.prefix||'';
 const build=()=>{
  const half=element('div',null,'rl-thanks-track');
  for(const n of data.names||[])half.append(thanksItem(n,prefix));
  if(data.dedication&&data.dedication.name){
   const d=thanksItem(data.dedication,prefix);
   d.classList.add('rl-tk-dedicated');d.prepend(element('span','♥','rl-tk-heart'));
   half.append(d);
  }
  return half;
 };
 // 两份内容首尾相接 → translateX(-50%) 即无缝循环。两份各自 build() 后由 flex 横排，
 // 不要 clone 已挂 DOM 的节点（克隆节点不带后续 style 设置，且 cloneNode 时机易踩坑）。
 const count=(data.names||[]).length+(data.dedication&&data.dedication.name?1:0);
 const wrap=element('div',null,'rl-thanks-wrap');
 const a=build(),b=build();
 wrap.append(a,b);
 // 动画放在 wrap 上：一次平移 50% 正好走完一份，接缝无感。
 wrap.style.setProperty('--roll-dur',Math.min(180,60+Math.round(count/12)*6)+'s');
 rail.replaceChildren(wrap);
 rail.setAttribute('aria-label','感谢名单（'+count+' 位）');
}
loadThanks();

// ---------- data ----------
// Cache-first paint: the previous /api/servers payload (≤24h old) is kept in localStorage and
// rendered instantly on boot, then the network refresh replaces it. A visitor never stares at
// "正在查询状态…" while a request is in flight; they see the last known state, optionally with
// a "数据可能不是最新" hint until the fresh payload lands.
const CACHE_KEY='rl-payload-cache';const CACHE_MAX_AGE_MS=24*3600*1000;
function cachePut(d){try{localStorage.setItem(CACHE_KEY,JSON.stringify({t:Date.now(),d}));}catch{}}
function cacheGet(){try{const c=JSON.parse(localStorage.getItem(CACHE_KEY)||'null');return c&&c.d&&Array.isArray(c.d.servers)&&Date.now()-Number(c.t)<CACHE_MAX_AGE_MS?c:null;}catch{return null;}}
function paint(d,fromCache){
 servers=d.servers;$('servers').replaceChildren(...servers.map(row));buildSats();
 const available=servers.filter(s=>s.status?.state==='online').length;
 if(first){first=false;whenReady(()=>{countUp($('available'),available);countUp($('listed'),servers.length);scramble($('searching').querySelector('b'),'NODES FOUND · '+String(servers.length).padStart(2,'0'),600);});}
 else{$('available').textContent=available;$('listed').textContent=servers.length;}
 // The label shows the DATA's own timestamp, and says "缓存" only when it is served from
 // localStorage (snapshot fetch failed) — never when the fresh payload lands.
 $('updated').textContent=(fromCache?'已更新（缓存） ':'已更新 ')+new Date(d.serverTime).toLocaleTimeString('zh-CN',{hour12:false});
 $('error').classList.add('hidden');updateHud();
}
// Snapshot is now the LIST'S ONLY SOURCE (Workers/Pages Functions are reserved for admin + vote).
// /data/servers-snapshot.json is refreshed every 10 min by GitHub Actions (wei-snapshot-updater),
// which also probes each server for real online/rooms/matches and pins them green. Static edge-cached
// JSON: zero Function calls, zero quota, immune to CF Functions/Workers outages.
// localStorage (≤24h) still gives an instant first paint on slow links before the snapshot lands.
// Retry policy: a failed fetch does NOT clear the rendered list; it keeps serving localStorage and
// retries every RETRY_MS (10s) until the snapshot answers, so a flaky operator link heals in seconds
// instead of leaving "服务暂时不可用" on screen until the next 30s tick.
let snapshotWarned=false,snapshotFails=0;
// A stalled TCP connection never rejects, so with no timeout the very first snapshot request can hang
// forever: `busy` stays true, every retry tick short-circuits, and the list sits on "正在查询状态…"
// until the visitor reloads. Observed 2026-10-26 in the in-app browser on a degraded link.
// AbortSignal.timeout turns a stall into an ordinary failure, which the retry loop already handles.
const SNAPSHOT_TIMEOUT_MS=15000;
async function refresh(){if(busy||voting.size)return;busy=true;$('refresh').disabled=true;$('refresh').classList.add('spin');try{
 const r=await fetch('/data/servers-snapshot.json',{cache:'no-store',signal:AbortSignal.timeout(SNAPSHOT_TIMEOUT_MS)});
 if(!r.ok)throw Error('快照不可用');
 const d=await r.json();
 if(!d||!Array.isArray(d.servers)||!d.servers.length)throw Error('快照为空');
 cachePut(d);paint(d,false);$('error').classList.add('hidden');snapshotWarned=false;snapshotFails=0;
 }catch(e){
  // Snapshot unreachable (rare): keep whatever localStorage has, and say so without hiding the data.
  const cached=cacheGet();
  if(cached&&!snapshotWarned){snapshotWarned=true;paint(cached.d,true);$('error').textContent='实时快照获取失败，先显示本机缓存（数据时间 '+new Date(cached.d.serverTime).toLocaleTimeString('zh-CN',{hour12:false})+'），正在自动重试';$('error').classList.remove('hidden');}
  else if(!cached){$('error').textContent='数据暂时不可用，正在重试';$('error').classList.remove('hidden');}
  else{$('error').textContent='实时快照获取失败，正在自动重试';$('error').classList.remove('hidden');}
 }finally{busy=false;$('refresh').disabled=false;setTimeout(()=>$('refresh').classList.remove('spin'),500);}}
$('refresh').addEventListener('click',refresh);document.addEventListener('visibilitychange',()=>{if(!document.hidden)refresh();});
// 10s poll; when the snapshot is failing, retry faster (every 5s) so recovery is felt immediately.
setInterval(()=>{if(!document.hidden&&!busy&&!voting.size){if(snapshotWarned){if(++snapshotFails%2===0)refresh();}else refresh();}},5000);

// ---------- scroll HUD: lime dot follows progress, side label names the row in view ----------
let hudText='',ticking=false;
function updateHud(){
 const max=Math.max(1,document.documentElement.scrollHeight-innerHeight);frame.style.setProperty('--p',(scrollY/max).toFixed(4));frame.style.setProperty('--sy',String(Math.round(scrollY)));
 let text='SELECTING NODES';const mid=innerHeight/2;const rows=document.querySelectorAll('.rl-row');
 rows.forEach((el,i)=>{const r=el.getBoundingClientRect();if(r.top<=mid&&r.bottom>=mid)text='NODE '+String(i+1).padStart(2,'0')+' / '+String(rows.length).padStart(2,'0');});
 const c=$('community').getBoundingClientRect();if(c.top<mid)text='COMMUNITY SECTION';
 if(text!==hudText){hudText=text;scramble($('hud'),text,360);}
}
addEventListener('scroll',()=>{if(ticking)return;ticking=true;requestAnimationFrame(()=>{ticking=false;updateHud();checkReveal();});},{passive:true});
addEventListener('resize',()=>{updateHud();checkReveal();});
if(!reduce&&matchMedia('(pointer: fine)').matches){let pt=false;addEventListener('pointermove',e=>{if(pt)return;pt=true;requestAnimationFrame(()=>{pt=false;frame.style.setProperty('--mx',(e.clientX/innerWidth-.5).toFixed(3));frame.style.setProperty('--my',(e.clientY/innerHeight-.5).toFixed(3));});},{passive:true});}
document.querySelectorAll('.rl-watch').forEach(watch);

// Cache-first paint lives here, after hudText/updateHud are initialised above, so paint()'s
// updateHud() call never reads a still-in-TDZ binding. The network refresh() below then replaces
// these rows and clears the "（缓存）" hint.
const cachedBoot=cacheGet();
if(cachedBoot)paint(cachedBoot.d,true);

// ---------- page entrance + boot sequence ----------
function ready(){
 if(isReady)return;isReady=true;document.body.classList.add('rl-ready');root.classList.remove('rl-booting');
 scramble($('brandName'),'STRONGHOLD',600);updateHud();readyQueue.splice(0).forEach(fn=>fn());checkReveal();setTimeout(checkReveal,300);
}
const boot=$('boot');let timers=[],booting=false;
function at(ms,fn){timers.push(setTimeout(fn,ms));}
function phase(n){boot.dataset.phase=n;for(let k=1;k<=n;k++)boot.classList.add('g'+k);}
function endBoot(){
 if(!booting)return;booting=false;timers.forEach(clearTimeout);timers=[];clearInterval($('bootAccess')._tt);clearInterval($('bootWelcome')._tt);
 boot.classList.add('out');ready();setTimeout(()=>{boot.hidden=true;boot.className='rl-boot';boot.dataset.phase='';},650);
 removeEventListener('keydown',endBoot);
}
function runBoot(){
 booting=true;session.set('rl-boot','1');root.classList.add('rl-booting');boot.className='rl-boot';boot.hidden=false;boot.dataset.phase='0';$('bootAccess').textContent='';$('bootStatus').textContent='';$('bootWelcome').textContent='';
 const code=$('bootCode');const rnd=()=>Math.random().toString(16).slice(2,6).toUpperCase();
 at(60,()=>{phase(1);typeText($('bootAccess'),'ACCESS PERMISSION REQUIRED',24);scramble(code,'AUTH-'+rnd()+'-'+rnd(),500);});
 at(820,()=>phase(2));
 at(1180,()=>scramble($('bootStatus'),'- ID CONFIRMED',300));
 at(1520,()=>scramble($('bootStatus'),'- REQUEST RECEIVED',300));
 at(1860,()=>{scramble($('bootStatus'),'- START PROCESSING...',320);scramble(code,'PROC-'+rnd()+'-'+rnd(),400);});
 at(2250,()=>phase(3));
 at(3000,()=>{phase(4);typeText($('bootWelcome'),'WELCOME TO',34);scramble(code,'DATABASE-'+rnd(),400);});
 at(3760,()=>phase(5));
 at(3900,endBoot);
 addEventListener('keydown',endBoot);
}
boot.addEventListener('click',endBoot);
$('replay').addEventListener('click',()=>{if(reduce)return;document.body.classList.remove('rl-ready');isReady=false;scrollTo(0,0);runBoot();});
if(bootNow)runBoot();else requestAnimationFrame(ready);
refresh();
});
})();
