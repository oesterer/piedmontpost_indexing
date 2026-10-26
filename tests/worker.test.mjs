import {siteURL} from './site-path.mjs';
import test from 'node:test';import assert from 'node:assert/strict';import fs from'node:fs/promises';import {Worker}from'node:worker_threads';
test('real worker preloads one file and pauses after its first 20 real archive results',async t=>{
 const manifest=JSON.parse(await fs.readFile(new URL('manifest.json',siteURL),'utf8'));
 const worker=new Worker(new URL('./worker-adapter.mjs',import.meta.url));t.after(()=>worker.terminate());
 const events=[],queue=[],waiters=[];
 worker.on('message',value=>{events.push(value);const i=waiters.findIndex(w=>w.test(value));if(i>=0){const [w]=waiters.splice(i,1);clearTimeout(w.timer);w.resolve(value);}else queue.push(value);});
 function waitFor(predicate){const i=queue.findIndex(predicate);if(i>=0)return Promise.resolve(queue.splice(i,1)[0]);return new Promise((resolve,reject)=>{const w={test:predicate,resolve,timer:setTimeout(()=>reject(Error('Worker timed out')),15000)};waiters.push(w);});}
 worker.postMessage({type:'init',manifest,base:siteURL.href});await waitFor(m=>m.type==='ready');assert.equal(events.filter(e=>e.type==='test-load').length,1);
 worker.postMessage({type:'search',id:1,options:{query:'the'}});const batch=await waitFor(m=>m.type==='batch'&&m.id===1);
 assert.equal(batch.delivered,20);assert.equal(batch.complete,false);assert.equal(events.filter(e=>e.type==='test-load').length,1);assert.equal(events.filter(e=>e.type==='results').flatMap(e=>e.results).length,20);
 worker.postMessage({type:'more',id:1});await waitFor(m=>m.type==='batch'&&m.id===1);const records=events.filter(e=>e.type==='results').flatMap(e=>e.results);assert.equal(records.length,40);assert.equal(new Set(records.map(r=>r.sourceUrl+':'+r.page)).size,40);
});
