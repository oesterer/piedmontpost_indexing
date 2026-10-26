import {siteURL} from './site-path.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
const {IndexStore,SearchSession}=await import(new URL('progressive-search.js',siteURL));
function fixture(){
 const issues=[{id:'latest',date:'2026-10-14',indexId:'latest'},{id:'week',date:'2026-10-07',indexId:'week'},{id:'quarter',date:'2025-03-01',indexId:'quarter'}];
 const data={latest:{version:1,id:'latest',pages:Array.from({length:25},(_,i)=>({issueId:'latest',date:'2026-10-14',page:i+1,text:'common council',file:'https://example.org/latest.pdf'}))},week:{version:1,id:'week',pages:[{issueId:'week',date:'2026-10-07',page:1,text:'common raretopic',file:'https://example.org/week.pdf'}]},quarter:{version:1,id:'quarter',pages:[{issueId:'quarter',date:'2025-03-01',page:1,text:'common raretopic',file:'https://example.org/old.pdf'}]}};
 const indexes=issues.map(i=>({id:i.indexId,kind:i.id==='quarter'?'quarterly':'weekly',from:i.date,to:i.date,latestIssue:i.date,oldestIssue:i.date,pageCount:data[i.id].pages.length,bytes:100,url:i.id+'.json'}));
 const manifest={indexes,issues,batchSize:20};const loads=[];
 const store=new IndexStore(manifest,async entry=>{loads.push(entry.id);return data[entry.id];});
 return {manifest,data,loads,store};
}
test('preloads just the newest weekly file; pauses after 20 and resumes without duplicates',async()=>{
 const f=fixture();await f.store.preload();assert.deepEqual(f.loads,['latest']);
 const s=new SearchSession(f.store,{query:'common'}),results=[];
 const first=await s.next({onResults:r=>results.push(...r)});
 assert.equal(first.delivered,20);assert.equal(first.complete,false);assert.deepEqual(f.loads,['latest']);
 const rest=await s.next({onResults:r=>results.push(...r)});
 assert.equal(rest.complete,true);assert.equal(results.length,27);assert.deepEqual(f.loads,['latest','week','quarter']);
 assert.equal(new Set(results.map(r=>r.sourceUrl+':'+r.page)).size,27);
});
test('streams matches from one file before requesting the next',async()=>{
 const f=fixture(),events=[];f.store.loader=async e=>{events.push('load:'+e.id);return f.data[e.id];};
 const s=new SearchSession(f.store,{query:'raretopic'});
 await s.next({onResults:r=>events.push('result:'+r[0].date)});
 assert(events.indexOf('result:2026-10-07')<events.indexOf('load:quarter'));
});
test('year/issue filters skip other files and oldest-first ordering searches history first',async()=>{
 const f=fixture();let s=new SearchSession(f.store,{query:'common',year:'2025'});await s.next();assert.deepEqual(f.loads,['quarter']);
 s=new SearchSession(f.store,{query:'common',issue:'week'});const r=[];await s.next({onResults:x=>r.push(...x)});assert.equal(r.length,1);assert.equal(r[0].date,'2026-10-07');
 s=new SearchSession(f.store,{query:'common',order:'oldest'});const old=[];await s.next({onResults:x=>old.push(...x)});assert.equal(old[0].date,'2025-03-01');
});
test('failure and cancellation leave the failed file available to retry',async()=>{
 const f=fixture();let fail=true;
 f.store.loader=async e=>{if(fail)throw Error('offline');return f.data[e.id];};
 const s=new SearchSession(f.store,{query:'common'});await assert.rejects(s.next(),/offline/);assert.equal(s.cursor,0);
 const abort=new AbortController();abort.abort();await assert.rejects(s.next({signal:abort.signal}),{name:'AbortError'});assert.equal(s.cursor,0);
 fail=false;assert.equal((await s.next()).delivered,20);
});
test('new searches reuse cached files; old files are evicted while latest stays cached',async()=>{
 const f=fixture();f.store.maxFiles=2;await f.store.preload();await f.store.get(f.manifest.indexes[1]);await f.store.get(f.manifest.indexes[2]);
 assert.equal(f.store.cache.size,2);assert(f.store.cache.has('latest'));assert(!f.store.cache.has('week'));
 const s=new SearchSession(f.store,{query:'council'});await s.next();assert.equal(f.loads.filter(id=>id==='latest').length,1);
});
test('phrase/no-match searches finish with accurate completion state',async()=>{
 const f=fixture();const s=new SearchSession(f.store,{query:'zzzzz'});const end=await s.next();assert.equal(end.complete,true);assert.equal(end.delivered,0);assert.equal(end.searched,3);
 const phrase=new SearchSession(f.store,{query:'common council',mode:'phrase'});assert.equal((await phrase.next()).delivered,20);
});
