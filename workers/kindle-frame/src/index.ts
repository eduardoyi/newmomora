import {Buffer} from 'node:buffer';
import {candidates,digest,imageHtml,localDay,schedule,selectImages,type Asset,type Memory} from './core';
export interface Env {
 MEDIA:R2Bucket; BROWSER:{quickAction(action:'screenshot',options:Record<string,unknown>):Promise<Response>};
 SUPABASE_URL:string;SUPABASE_SERVICE_ROLE_KEY:string;FRAME_OWNER_ID:string;FRAME_FAMILY_ID:string;FRAME_TOKEN_HASH:string;ADMIN_TOKEN_HASH:string;TIMEZONE:string;
}
interface Entry {slot:number;object:string;sha:string;memoryId:string;source:string}
interface Batch {day:string;generation:string;entries:Entry[]}
class Denied extends Error {}
const prefix=(e:Env)=>`${e.FRAME_OWNER_ID}/kindle-frame/`;
async function db<T>(e:Env,table:string,q:Record<string,string>):Promise<T[]> {
 const url=new URL(`/rest/v1/${table}`,e.SUPABASE_URL);url.search=new URLSearchParams(q).toString();
 const r=await fetch(url,{headers:{apikey:e.SUPABASE_SERVICE_ROLE_KEY,Authorization:`Bearer ${e.SUPABASE_SERVICE_ROLE_KEY}`},signal:AbortSignal.timeout(20000)});
 if(!r.ok)throw new Error(`Database status ${r.status}`);return r.json();
}
export async function activeOwner(e:Env):Promise<void>{
 const [p,f,m]=await Promise.all([
  db(e,'user_profiles',{select:'id',id:`eq.${e.FRAME_OWNER_ID}`,deleted_at:'is.null',hard_delete_started_at:'is.null'}),
  db(e,'families',{select:'id',id:`eq.${e.FRAME_FAMILY_ID}`,owner_id:`eq.${e.FRAME_OWNER_ID}`,deleted_at:'is.null',deletion_fence_started_at:'is.null'}),
  db(e,'family_memberships',{select:'id',family_id:`eq.${e.FRAME_FAMILY_ID}`,user_id:`eq.${e.FRAME_OWNER_ID}`,role:'eq.owner'})]);
 if(p.length!==1||f.length!==1||m.length!==1)throw new Denied();
}
const fields='id,memory_type,memory_date,content,illustration_key,illustration_status,media_key,media_content_type,memory_media(object_key,content_type,preview_object_key)';
export async function inventory(e:Env):Promise<Asset[]> {
 const all:Asset[]=[];let after='';
 for(let page=0;page<1000;page++){
  const rows=await db<Memory>(e,'memories',{select:fields,family_id:`eq.${e.FRAME_FAMILY_ID}`,order:'id.asc',limit:'100','memory_media.limit':'50',...(after?{id:`gt.${after}`}:{})});
  all.push(...candidates(rows));if(rows.length<100)return [...new Map(all.map(a=>[a.key,a])).values()];after=rows[rows.length-1].id;
 }
 throw new Error('Inventory limit reached; refusing partial random population');
}
async function validEntry(e:Env,entry:Entry){
 const rows=await db<Memory>(e,'memories',{select:fields,family_id:`eq.${e.FRAME_FAMILY_ID}`,id:`eq.${entry.memoryId}`,'memory_media.limit':'50'});
 return candidates(rows).some(a=>a.key===entry.source);
}
async function render(e:Env,a:Asset):Promise<ArrayBuffer>{
 const source=await e.MEDIA.get(a.renderKey??a.key);if(!source||source.size>20000000)throw new Error('Source unavailable or oversized');
 const bytes=await source.arrayBuffer();const b=new Uint8Array(bytes);
 const mime=b[0]===0xff&&b[1]===0xd8?'image/jpeg':b[0]===137&&b[1]===80?'image/png':b[0]===82&&b[8]===87?'image/webp':null;
 if(!mime)throw new Error('Image needs a supported preview');
 const html=imageHtml(a,`data:${mime};base64,${Buffer.from(bytes).toString('base64')}`);
 const response=await e.BROWSER.quickAction('screenshot',{html,viewport:{width:758,height:1024,deviceScaleFactor:1},screenshotOptions:{type:'png',fullPage:false},gotoOptions:{waitUntil:'networkidle0',timeout:30000}});
 if(!response.ok)throw new Error(`Renderer status ${response.status}`);
 const png=await response.arrayBuffer();const data=new DataView(png);
 if(png.byteLength<24||data.getUint32(0)!==0x89504e47||data.getUint32(16)!==758||data.getUint32(20)!==1024||png.byteLength>4000000)throw new Error('Invalid rendered image');
 return png;
}
export async function prepare(e:Env,now=Math.floor(Date.now()/1000)):Promise<Batch>{
 await activeOwner(e);const base=prefix(e),day=localDay(now,e.TIMEZONE),stateKey=base+'current.json';
 const old=await e.MEDIA.get(stateKey);const previous=old?await old.json<Batch>():null;
 if(previous?.day===day)return previous;
 const lockKey=base+'prepare.lock';let lock=await e.MEDIA.get(lockKey);
 if(lock && Number(await lock.text())>now-600)throw new Error('Preparation already running');
 const acquired=await e.MEDIA.put(lockKey,String(now),{onlyIf:lock?{etagMatches:lock.etag}:{etagDoesNotMatch:'*'}});
 if(!acquired)throw new Error('Preparation already running');
 const uploaded:string[]=[];let committed=false;
 try {
  const assets=selectImages(await inventory(e));const generation=crypto.randomUUID();const entries:Entry[]=[];
  for(const [i,a] of assets.entries()){
   const png=await render(e,a);const object=`${base}${day}/${generation}/${i+1}.png`;
   await e.MEDIA.put(object,png,{httpMetadata:{contentType:'image/png',cacheControl:'private, no-store'}});uploaded.push(object);
   entries.push({slot:i+1,object,sha:await digest(png),memoryId:a.memoryId,source:a.key});
  }
  await activeOwner(e);
  for(const entry of entries)if(!await validEntry(e,entry))throw new Error('Source changed during rendering');
  const batch={day,generation,entries};
  await e.MEDIA.put(stateKey,JSON.stringify(batch),{httpMetadata:{contentType:'application/json'}});
  committed=true;
  // Only our generated objects; all remain inside the owner's deletion prefix.
  let cursor:string|undefined;
  do {
   const page=await e.MEDIA.list({prefix:base,cursor});
   for(const o of page.objects)if(/\/\d{4}-\d{2}-\d{2}\//.test(o.key)&&o.uploaded.getTime()<(now-3*86400)*1000)await e.MEDIA.delete(o.key);
   cursor=page.truncated?page.cursor:undefined;
  } while(cursor);
  return batch;
 } catch(err) { if(!committed&&uploaded.length)await e.MEDIA.delete(uploaded);throw err; }
 finally {await e.MEDIA.delete(lockKey);}
}
async function authorized(req:Request,hash:string):Promise<boolean>{
 const h=req.headers.get('Authorization')??'';
 if(!/^[a-f0-9]{64}$/.test(hash??'')||!/^Bearer [a-f0-9]{64}$/.test(h))return false;
 return await digest(new TextEncoder().encode(h.slice(7)))===hash;
}
const response=(body:string,status=200,type='text/plain')=>new Response(body,{status,headers:{'Content-Type':type,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}});
export default {
 async fetch(req:Request,e:Env):Promise<Response>{
  try {
   const url=new URL(req.url);
   if(url.protocol!=='https:')return response('HTTPS required',400);
   if(url.pathname==='/health'&&req.method==='GET')return response('ok');
   if(url.pathname==='/prepare'&&req.method==='POST'){
    if(!await authorized(req,e.ADMIN_TOKEN_HASH))return response('Unauthorized',401);
    const b=await prepare(e);return response(JSON.stringify({day:b.day,count:b.entries.length}),200,'application/json');
   }
   if(req.method!=='GET')return response('Not found',404);
   if(!await authorized(req,e.FRAME_TOKEN_HASH))return response('Unauthorized',401);
   await activeOwner(e);
   const stored=await e.MEDIA.get(prefix(e)+'current.json');if(!stored)return response('Not ready',503);
   const batch=await stored.json<Batch>();
   if(url.pathname==='/manifest'){
    for(const entry of batch.entries)if(!await validEntry(e,entry))return response('Batch source changed',409);
    const now=Math.floor(Date.now()/1000);const plan=schedule(now,e.TIMEZONE);
    return response([`FRAME1 ${now} ${plan.sync} ${batch.generation} ${new Date(now*1000).toISOString().slice(0,19).replace(/-/g,'.').replace('T','-')}`, ...batch.entries.map(x=>`IMAGE ${x.slot} ${x.sha} /image/${batch.generation}/${x.slot}`),...plan.entries.map(x=>`AT ${x.at} ${x.slot}`),'END',''].join('\n'));
   }
   const match=/^\/image\/([a-f0-9-]{36})\/([1-5])$/.exec(url.pathname);
   if(!match||match[1]!==batch.generation)return response('Not found',404);
   const entry=batch.entries.find(x=>x.slot===Number(match[2]));if(!entry||!await validEntry(e,entry))return response('Not found',404);
   const object=await e.MEDIA.get(entry.object);if(!object)return response('Not found',404);
   return new Response(object.body,{headers:{'Content-Type':'image/png','Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}});
  } catch(err){return response(err instanceof Denied?'Access revoked':'Frame temporarily unavailable',err instanceof Denied?403:503);}
 },
 async scheduled(_event:ScheduledController,e:Env):Promise<void>{await prepare(e);}
};
