import {describe,it,expect} from 'vitest';
import {candidates,selectImages,schedule,localEpoch,imageHtml,type Memory} from '../src/core';
const m=(x:Partial<Memory>):Memory=>({id:'m',memory_type:'media',memory_date:'2000-01-01',content:null,illustration_key:null,illustration_status:'ready',media_key:null,media_content_type:null,memory_media:[],...x});
describe('equal per-image selection',()=>{
 it('includes every carousel photo, old memories and illustrations; excludes audio, videos and text',()=>{
 const rows=[m({memory_media:[{object_key:'a',content_type:'image/jpeg'},{object_key:'b',content_type:'image/png'},{object_key:'v',content_type:'video/mp4'}],media_key:'stale',media_content_type:'image/jpeg'}),m({id:'new',memory_type:'text_illustration',illustration_key:'c',memory_date:'2026-09-09'}),m({memory_type:'audio',media_key:'x',media_content_type:'image/jpeg'}),m({memory_type:'text_only',illustration_key:'wrong'})];
 expect(candidates(rows).map(a=>a.key)).toEqual(['a','b','c']);
 });
 it('deduplicates an identical asset and keeps photo captions empty',()=>{expect(candidates([m({media_key:'a',media_content_type:'image/jpeg',content:'private caption'}),m({media_key:'a',media_content_type:'image/jpeg'})])).toMatchObject([{key:'a',caption:''}]);});
 it('can choose the oldest or newest entry with identical index probability',()=>{const all=['old','middle','new'];expect([0,1,2].map(i=>selectImages(all,1,()=>i)[0])).toEqual(all);expect(selectImages(all,3,()=>0)).toEqual(all);expect(all).toEqual(['old','middle','new']);});
 it('fails on an insufficient population rather than silently balancing types',()=>expect(()=>selectImages([1,2],5)).toThrow());
});
describe('Lisbon schedule',()=>{
 it('uses five daytime slots and a separate overnight download',()=>{
 const now=Date.parse('2026-09-09T00:00:00Z')/1000;const p=schedule(now,'Europe/Lisbon');
 expect(p.entries.slice(0,5).map(e=>new Date(e.at*1000).getUTCHours())).toEqual([7,10,13,16,19]);expect(new Date(p.sync*1000).getUTCHours()).toBe(2);
 });
 it('accounts for winter time and DST transition',()=>{expect(new Date(localEpoch('2026-10-25',8,'Europe/Lisbon')*1000).getUTCHours()).toBe(8);expect(new Date(localEpoch('2026-10-24',8,'Europe/Lisbon')*1000).getUTCHours()).toBe(7);});
});
it('renders escaped caption, four lines, left aligned date; photos omit captions',()=>{
 const a={memoryId:'x',key:'x',kind:'illustration' as const,date:'2020-01-02',caption:'<script>bad</script>'};const html=imageHtml(a,'data:image/png;base64,AAAA');expect(html).toContain('&lt;script&gt;');expect(html).toContain('-webkit-line-clamp:4');expect(html).not.toContain('<script>');expect(imageHtml({...a,kind:'photo'},'data:image/png;base64,AAAA')).not.toContain('&lt;script&gt;');expect(()=>imageHtml(a,'https://attacker.invalid/')).toThrow();
});
