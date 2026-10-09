(()=>{
'use strict';

const SUPABASE_URL='https://bmcfsimkgwxqdmaenvda.supabase.co';
const SUPABASE_KEY='sb_publishable_c16qn84PssrtSscz0yRv1g_4FUrG9yV';
const ROOM_ID='franklin-andrea-7f2d8c4a9e1b6f305d7c2a8e4b1f9362';
const TABLE='home_items';
const CACHE_KEY='nuestro-hogar-cache-v10';
const OLD_KEY='franklin-andrea-panel-v11-clean';

let client=null;
let state={version:10,items:[]};
let listeners=new Set();
let statusListeners=new Set();
let realtime=false;
let initialized=false;
let writing=false;
let lastSync=0;
let channel=null;
let fallbackTimer=null;

function getClient(){
  if(client)return client;
  if(!window.supabase||typeof window.supabase.createClient!=='function')throw new Error('No se cargó Supabase JS');
  client=window.supabase.createClient(SUPABASE_URL,SUPABASE_KEY,{
    auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false},
    realtime:{params:{eventsPerSecond:10}}
  });
  return client;
}

function rowToItem(r){
  return {
    id:String(r.id),
    author:r.author==='Andrea'?'Andrea':'Franklin',
    kind:r.kind,
    text:String(r.text||''),
    done:!!r.done,
    eventDate:r.event_date||'',
    eventTime:r.event_time?String(r.event_time).slice(0,5):'',
    noteDate:r.note_date||'',
    createdAt:Number(r.created_at)||Date.now(),
    updatedAt:Number(r.updated_at)||Date.now()
  };
}

function itemToRow(x){
  return {
    id:String(x.id),
    room_id:ROOM_ID,
    kind:x.kind,
    author:x.author==='Andrea'?'Andrea':'Franklin',
    text:String(x.text||'').trim().slice(0,500),
    done:x.kind==='task'?!!x.done:false,
    event_date:x.kind==='event'&&x.eventDate?x.eventDate:null,
    event_time:x.kind==='event'&&x.eventTime?x.eventTime:null,
    note_date:x.kind==='note'&&x.noteDate?x.noteDate:null,
    created_at:Number(x.createdAt)||Date.now(),
    updated_at:Number(x.updatedAt)||Date.now()
  };
}

function cleanItems(list){
  if(!Array.isArray(list))return [];
  return list.filter(x=>x&&typeof x.id==='string'&&['note','task','event'].includes(x.kind)&&typeof x.text==='string'&&x.text.trim()).map(x=>({
    ...x,
    author:x.author==='Andrea'?'Andrea':'Franklin',
    text:x.text.trim().slice(0,500),
    done:x.kind==='task'?!!x.done:false,
    eventDate:x.kind==='event'?(x.eventDate||''):'',
    eventTime:x.kind==='event'?(x.eventTime||''):'',
    noteDate:x.kind==='note'?(x.noteDate||''):'',
    createdAt:Number(x.createdAt)||Date.now(),
    updatedAt:Number(x.updatedAt)||Date.now()
  }));
}

function emit(){
  const snapshot=getState();
  for(const fn of listeners){try{fn(snapshot)}catch(e){}}
}

function emitStatus(extra={}){
  const s={database:true,realtime,writing,initialized,lastSync,dbUrl:SUPABASE_URL,...extra};
  for(const fn of statusListeners){try{fn(s)}catch(e){}}
}

function saveCache(){
  try{localStorage.setItem(CACHE_KEY,JSON.stringify(state.items))}catch(e){}
}

function loadCache(){
  try{
    const x=cleanItems(JSON.parse(localStorage.getItem(CACHE_KEY)||'[]'));
    if(x.length){state={version:10,items:x};emit();}
  }catch(e){}
}

function getState(){
  return {version:10,items:state.items.map(x=>({...x}))};
}

async function fetchRows(){
  const {data,error}=await getClient()
    .from(TABLE)
    .select('*')
    .eq('room_id',ROOM_ID)
    .order('created_at',{ascending:true});
  if(error)throw new Error('Supabase lectura: '+error.message);
  return (data||[]).map(rowToItem);
}

async function refresh(force=false){
  if(writing&&!force)return getState();
  const rows=await fetchRows();
  state={version:10,items:rows};
  lastSync=Date.now();
  saveCache();
  emit();
  emitStatus();
  return getState();
}

async function migrateLegacyIfNeeded(){
  const current=await fetchRows();
  if(current.length)return false;
  let legacy=[];
  try{legacy=cleanItems(JSON.parse(localStorage.getItem(OLD_KEY)||'[]'))}catch(e){}
  if(!legacy.length)return false;
  const rows=legacy.map(itemToRow);
  const {error}=await getClient().from(TABLE).upsert(rows,{onConflict:'id'});
  if(error)throw new Error('Migración de datos antiguos: '+error.message);
  return true;
}

function maps(list){
  const m={};
  for(const x of list)m[x.id]={...x};
  return m;
}

function same(a,b){
  return JSON.stringify(a)===JSON.stringify(b);
}

async function mutate(mutator){
  writing=true;
  emitStatus();
  try{
    const latest=await fetchRows();
    const before=maps(latest);
    const draft={version:10,items:latest.map(x=>({...x}))};
    await mutator({
      get items(){return maps(draft.items)},
      set items(v){draft.items=Object.values(v||{})}
    });

    // Compatibility with the existing UI callbacks, which expect db.items[id].
    // Re-run mutator against a plain object if no change was made via the proxy.
    if(same(latest,draft.items)){
      const db={items:maps(latest)};
      await mutator(db);
      draft.items=Object.values(db.items||{});
    }

    draft.items=cleanItems(draft.items);
    const after=maps(draft.items);

    const deleted=Object.keys(before).filter(id=>!after[id]);
    const changed=Object.values(after).filter(x=>!before[x.id]||!same(before[x.id],x));

    if(deleted.length){
      const {error}=await getClient().from(TABLE).delete().eq('room_id',ROOM_ID).in('id',deleted);
      if(error)throw new Error('Supabase borrar: '+error.message);
    }

    if(changed.length){
      const rows=changed.map(itemToRow);
      const {error}=await getClient().from(TABLE).upsert(rows,{onConflict:'id'});
      if(error)throw new Error('Supabase guardar: '+error.message);
    }

    await refresh(true);
    return getState();
  }finally{
    writing=false;
    emitStatus();
  }
}

function startRealtime(){
  if(channel)return;
  const c=getClient();
  channel=c
    .channel('nuestro-hogar-v10')
    .on('postgres_changes',{
      event:'*',
      schema:'public',
      table:TABLE,
      filter:'room_id=eq.'+ROOM_ID
    },()=>{refresh(false).catch(()=>{})})
    .subscribe((status)=>{
      realtime=status==='SUBSCRIBED';
      emitStatus({realtimeStatus:status});
      if(realtime)refresh(false).catch(()=>{});
    });

  // Realtime is the fast path. Polling is only a repair mechanism if an event is lost.
  if(!fallbackTimer)fallbackTimer=setInterval(()=>{
    if(!document.hidden&&!writing)refresh(false).catch(()=>{});
  },5000);

  window.addEventListener('focus',()=>refresh(false).catch(()=>{}));
  window.addEventListener('online',()=>refresh(false).catch(()=>{}));
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)refresh(false).catch(()=>{})});
}

async function init(){
  if(initialized)return getState();
  loadCache();
  getClient();
  await migrateLegacyIfNeeded();
  await refresh(true);
  initialized=true;
  emitStatus();
  startRealtime();
  return getState();
}

function subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn)}
function subscribeStatus(fn){statusListeners.add(fn);fn({database:true,realtime,writing,initialized,lastSync,dbUrl:SUPABASE_URL});return()=>statusListeners.delete(fn)}
function makeId(){return Date.now().toString(36)+Math.random().toString(36).slice(2,8)}
function editorUrl(){const u=new URL('editor.html',location.href);u.search='';u.hash='';u.searchParams.set('v','10');return u.toString()}

window.HogarSync={
  init,
  refresh,
  mutate,
  subscribe,
  subscribeStatus,
  getState,
  makeId,
  editorUrl,
  getDbUrl:()=>SUPABASE_URL,
  roomId:ROOM_ID
};
})();