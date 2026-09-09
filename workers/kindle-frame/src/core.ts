export interface Asset { memoryId: string; key: string; renderKey?:string; kind: 'photo'|'illustration'; date: string; caption: string }
export interface Memory { id: string; memory_type: string; memory_date: string; content: string|null; illustration_key: string|null; illustration_status: string; media_key: string|null; media_content_type: string|null; memory_media: {object_key:string;content_type:string;preview_object_key?:string|null}[] }
export function candidates(rows: Memory[]): Asset[] {
 const result: Asset[]=[];
 const seen=new Set<string>();
 function add(m:Memory,key:string,kind:Asset['kind'],renderKey?:string) { if(seen.has(key)) return; seen.add(key); result.push({memoryId:m.id,key,renderKey,kind,date:m.memory_date,caption:kind==='illustration' ? (m.content??'') : ''}); }
 for(const m of rows) {
  if(m.memory_type==='text_illustration' && m.illustration_status==='ready' && m.illustration_key) add(m,m.illustration_key,'illustration');
  if(m.memory_type!=='media') continue;
  if(m.memory_media.length>=50) throw new Error('Media pagination required');
  // A populated carousel is authoritative; the legacy lead field may be stale.
  if(m.memory_media.length) { for(const a of m.memory_media) if(/^image\/(jpeg|png|webp|heic|heif)$/i.test(a.content_type)) add(m,a.object_key,'photo',a.preview_object_key??undefined); }
  else if(m.media_key && /^image\/(jpeg|png|webp|heic|heif)$/i.test(m.media_content_type??'')) add(m,m.media_key,'photo');
 }
 return result;
}
export function uniformInt(n:number):number {
 if(!Number.isSafeInteger(n)||n<1||n>0xffffffff) throw new Error('Invalid population');
 const ceiling=Math.floor(0x100000000/n)*n;const x=new Uint32Array(1);
 do {crypto.getRandomValues(x);} while(x[0]>=ceiling);
 return x[0]%n;
}
export function selectImages<T>(all:T[],n=5,random=uniformInt):T[] {
 if(all.length<n) throw new Error('Insufficient eligible images');
 const copy=[...all];
 for(let i=0;i<n;i++){const j=i+random(copy.length-i);[copy[i],copy[j]]=[copy[j],copy[i]];}
 return copy.slice(0,n);
}
export function localDay(now:number,tz:string):string {
 return new Intl.DateTimeFormat('en-CA',{timeZone:tz,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(now*1000));
}
export function localEpoch(day:string,hour:number,tz:string):number {
 const target=Date.parse(`${day}T${String(hour).padStart(2,'0')}:00:00Z`)/1000;let guess=target;
 for(let i=0;i<3;i++){
  const parts=new Intl.DateTimeFormat('en-GB',{timeZone:tz,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(new Date(guess*1000));
  const p=Object.fromEntries(parts.map(p=>[p.type,p.value]));
  const represented=Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}Z`)/1000;
  guess+=target-represented;
 }
 return guess;
}
export function schedule(now:number,tz:string) {
 const today=localDay(now,tz);const start=Date.parse(today+'T12:00:00Z');
 const days=Array.from({length:8},(_,i)=>new Date(start+i*86400000).toISOString().slice(0,10));
 const entries=days.flatMap(day=>[8,11,14,17,20].map((h,i)=>({at:localEpoch(day,h,tz),slot:i+1}))).filter(e=>e.at>now);
 const sync=days.map(day=>localEpoch(day,3,tz)).find(t=>t>now)!;
 return {entries,sync};
}
const escape=(s:string)=>s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
export function imageHtml(a:Asset,dataUrl:string):string {
 if(!/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(dataUrl)) throw new Error('Unsupported rendering input');
 const d=new Date(a.date.slice(0,10)+'T12:00:00Z');
 if(!Number.isFinite(d.getTime())) throw new Error('Invalid date');
 const date=new Intl.DateTimeFormat('en-GB',{day:'numeric',month:'short',year:'numeric',timeZone:'UTC'}).format(d);
 return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'"><style>
 *{box-sizing:border-box}html,body{margin:0;width:758px;height:1024px;background:white;color:#191919;overflow:hidden}img{filter:grayscale(1);object-fit:contain;position:absolute}.photo{left:10px;top:20px;width:738px;height:984px}.illustration{left:20px;top:40px;width:718px;height:718px}.caption{position:absolute;left:48px;top:788px;width:662px;font:27px/37px Georgia,'Times New Roman',serif;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:4;overflow:hidden;overflow-wrap:anywhere;max-height:148px}.date{position:absolute;font:22px/26px Arial,sans-serif;color:#464646}.photo-date{right:30px;bottom:32px;padding:6px 12px;border:1px solid #b4b4b4;border-radius:10px;background:white;color:#232323}.illustration-date{left:48px;top:974px}
 </style></head><body><img class="${a.kind}" src="${dataUrl}">${a.kind==='illustration'?`<div class="caption">${escape(a.caption.replace(/\s+/g,' ').trim())}</div>`:''}<div class="date ${a.kind}-date">${escape(date)}</div></body></html>`;
}
export async function digest(data:BufferSource):Promise<string>{return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',data))).map(n=>n.toString(16).padStart(2,'0')).join('');}
