(()=>{
  'use strict';
  const CREATE_URL='https://api.jsonstorage.net/v1/json';
  const DB_KEY='nuestro-hogar-db-v7';
  const DEVICE_KEY='nuestro-hogar-device-v7';
  const NTFY_BASE='https://ntfy.sh';
  let dbUrl='';
  let state={version:7,updatedAt:0,items:{}};
  let listeners=new Set();
  let statusListeners=new Set();
  let eventSource=null;
  let fallbackTimer=null;
  let lastNtfyId='';
  let writing=false;
  let realtime=false;
  let initialized=false;
  let lastSync=0;
  let deviceId='';

  try{deviceId=localStorage.getItem(DEVICE_KEY)||'';}catch(e){}
  if(!deviceId){deviceId='d-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,10);try{localStorage.setItem(DEVICE_KEY,deviceId);}catch(e){}}

  const safeItems=(items)=>{
    const out={};
    if(items&&typeof items==='object'&&!Array.isArray(items)){
      for(const [id,x] of Object.entries(items)){
        if(!x||typeof x!=='object')continue;
        if(!['note','task','event'].includes(x.kind))continue;
        out[id]={...x,id:String(x.id||id)};
      }
    }else if(Array.isArray(items)){
      for(const x of items){
        if(!x||typeof x!=='object'||!x.id||!['note','task','event'].includes(x.kind))continue;
        out[String(x.id)]={...x,id:String(x.id)};
      }
    }
    return out;
  };

  function normalize(raw){
    raw=(raw&&typeof raw==='object')?raw:{};
    return {version:7,updatedAt:Number(raw.updatedAt)||0,items:safeItems(raw.items)};
  }

  function emit(){for(const fn of listeners){try{fn(getState());}catch(e){}}}
  function emitStatus(extra={}){
    const s={database:!!dbUrl,realtime,writing,initialized,lastSync,dbUrl,...extra};
    for(const fn of statusListeners){try{fn(s);}catch(e){}}
  }
  function getState(){return {version:state.version,updatedAt:state.updatedAt,items:Object.values(state.items).map(x=>({...x}))};}

  function validDb(url){return /^https:\/\/api\.jsonstorage\.net\/v1\/json\/[A-Za-z0-9._~\-]+\/[A-Za-z0-9._~\-]+(?:[/?#].*)?$/.test(String(url||''));}
  function setDb(url){
    dbUrl=String(url||'').split('?')[0].split('#')[0];
    try{localStorage.setItem(DB_KEY,dbUrl);}catch(e){}
    const u=new URL(location.href);
    u.searchParams.set('db',dbUrl);
    history.replaceState(null,'',u.toString());
  }
  function topicForDb(url){
    let h=2166136261;
    for(let i=0;i<url.length;i++){h^=url.charCodeAt(i);h=Math.imul(h,16777619);}
    return 'casa-tablet-v7-'+(h>>>0).toString(16);
  }
  function notifyChange(){
    if(!dbUrl)return;
    const topic=topicForDb(dbUrl);
    const url=`${NTFY_BASE}/${topic}/trigger?t=${Date.now()}&from=${encodeURIComponent(deviceId)}`;
    try{fetch(url,{method:'GET',mode:'no-cors',cache:'no-store'}).catch(()=>{});}catch(e){}
  }

  async function createDb(seedItems=[]){
    const payload={version:7,updatedAt:Date.now(),items:{}};
    for(const item of seedItems||[]){if(item&&item.id)payload.items[item.id]={...item};}
    const r=await fetch(CREATE_URL,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
    if(!r.ok)throw new Error('No se pudo crear la base central ('+r.status+')');
    const data=await r.json();
    if(!data||!validDb(data.uri))throw new Error('El servidor no devolvió una base válida');
    setDb(data.uri);
    state=normalize(payload);
    lastSync=Date.now();
    emit();
    emitStatus();
    return dbUrl;
  }

  async function readRemote(){
    if(!dbUrl)throw new Error('Base central no configurada');
    const join=dbUrl.includes('?')?'&':'?';
    const r=await fetch(dbUrl+join+'_='+Date.now(),{method:'GET',cache:'no-store',headers:{'Accept':'application/json'}});
    if(!r.ok)throw new Error('No se pudo leer la base central ('+r.status+')');
    return normalize(await r.json());
  }

  async function refresh(force=false){
    if(writing&&!force)return getState();
    const remote=await readRemote();
    if(force||remote.updatedAt>=state.updatedAt){state=remote;lastSync=Date.now();emit();emitStatus();}
    return getState();
  }

  async function writeWhole(next){
    if(!dbUrl)throw new Error('Base central no configurada');
    writing=true;emitStatus();
    try{
      next=normalize(next);
      next.updatedAt=Math.max(Date.now(),state.updatedAt+1);
      const r=await fetch(dbUrl,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(next),cache:'no-store'});
      if(!r.ok)throw new Error('No se pudo guardar en la base central ('+r.status+')');
      state=next;lastSync=Date.now();emit();emitStatus();notifyChange();
      return getState();
    }finally{writing=false;emitStatus();}
  }

  async function mutate(mutator){
    writing=true;emitStatus();
    try{
      const latest=await readRemote();
      const draft={version:7,updatedAt:latest.updatedAt,items:{...latest.items}};
      await mutator(draft);
      draft.updatedAt=Math.max(Date.now(),latest.updatedAt+1);
      const r=await fetch(dbUrl,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(draft),cache:'no-store'});
      if(!r.ok)throw new Error('No se pudo guardar en la base central ('+r.status+')');
      state=normalize(draft);lastSync=Date.now();emit();emitStatus();notifyChange();
      return getState();
    }finally{writing=false;emitStatus();}
  }

  function handleNtfyObject(msg){
    if(!msg||msg.event!=='message'||!msg.id)return false;
    if(msg.id===lastNtfyId)return false;
    lastNtfyId=msg.id;
    return true;
  }

  async function pollNtfy(){
    if(!dbUrl)return;
    const topic=topicForDb(dbUrl);
    try{
      const since=lastNtfyId||'10s';
      const r=await fetch(`${NTFY_BASE}/${topic}/json?poll=1&since=${encodeURIComponent(since)}&_=${Date.now()}`,{method:'GET',cache:'no-store'});
      if(!r.ok)throw new Error('ntfy '+r.status);
      const raw=await r.text();
      let changed=false;
      for(const line of raw.split(/\r?\n/)){
        if(!line.trim())continue;
        try{if(handleNtfyObject(JSON.parse(line)))changed=true;}catch(e){}
      }
      realtime=true;emitStatus();
      if(changed)await refresh(false);
    }catch(e){
      if(!eventSource||eventSource.readyState!==1){realtime=false;emitStatus();}
    }
  }

  function startRealtime(){
    if(!dbUrl)return;
    const topic=topicForDb(dbUrl);
    if(!eventSource){
      try{
        eventSource=new EventSource(`${NTFY_BASE}/${topic}/sse?since=10s`);
        eventSource.onopen=()=>{realtime=true;emitStatus();};
        eventSource.onerror=()=>{emitStatus();};
        eventSource.onmessage=e=>{
          try{const msg=JSON.parse(e.data);if(handleNtfyObject(msg))refresh(false).catch(()=>{});}catch(_){refresh(false).catch(()=>{});}
        };
      }catch(e){}
    }
    if(!fallbackTimer){fallbackTimer=setInterval(pollNtfy,1000);setTimeout(pollNtfy,250);}
    window.addEventListener('focus',()=>{refresh(false).catch(()=>{});pollNtfy();});
    window.addEventListener('pageshow',()=>{refresh(false).catch(()=>{});pollNtfy();});
    window.addEventListener('online',()=>{refresh(false).catch(()=>{});pollNtfy();});
    document.addEventListener('visibilitychange',()=>{if(!document.hidden){refresh(false).catch(()=>{});pollNtfy();}});
  }

  async function init({seedItems=[],allowCreate=true}={}){
    if(initialized)return getState();
    const p=new URLSearchParams(location.search).get('db');
    let saved='';try{saved=localStorage.getItem(DB_KEY)||'';}catch(e){}
    if(validDb(p))setDb(p);
    else if(validDb(saved))setDb(saved);
    else if(allowCreate){
      if(!seedItems.length){
        try{const old=JSON.parse(localStorage.getItem('franklin-andrea-panel-v11-clean')||'[]');if(Array.isArray(old))seedItems=old;}catch(e){}
      }
      await createDb(seedItems);
    }else throw new Error('Este editor no tiene una base compartida. Escanea el QR NUEVO que aparece en la tablet.');
    await refresh(true);
    initialized=true;emitStatus();startRealtime();
    return getState();
  }

  function subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);}
  function subscribeStatus(fn){statusListeners.add(fn);fn({database:!!dbUrl,realtime,writing,initialized,lastSync,dbUrl});return()=>statusListeners.delete(fn);}
  function makeId(){return Date.now().toString(36)+Math.random().toString(36).slice(2,8);}
  function editorUrl(){if(!dbUrl)return'';const u=new URL('editor.html',location.href);u.search='';u.hash='';u.searchParams.set('db',dbUrl);u.searchParams.set('v','9');return u.toString();}

  window.HogarSync={init,refresh,mutate,writeWhole,subscribe,subscribeStatus,getState,makeId,editorUrl,getDbUrl:()=>dbUrl,deviceId};
})();