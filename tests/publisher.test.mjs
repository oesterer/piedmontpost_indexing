import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import {gunzipSync,brotliDecompressSync}from'node:zlib';
import {publishIndexes,bucketFor,lastCompletedQuarter}from'../scripts/publish-indexes.mjs';
const now=new Date('2026-07-01T12:00:00Z');
const settings={batchSize:20,memoryCacheBytes:16777216};
function input(){const issues=['2024-12-25','2026-06-30','2026-07-01','2026-10-14'].map(date=>({date,file:'https://example.org/'+date+'.pdf',pages:1}));return {issues,pages:issues.map(i=>({...i,page:1,text:'Original text '+i.date}))};}
test('quarter cutoff is inclusive and all later issues stay weekly',()=>{assert.equal(bucketFor('2026-06-30',lastCompletedQuarter(now)).id,'2026-Q2');assert.equal(bucketFor('2026-07-01',lastCompletedQuarter(now)).kind,'weekly');assert.equal(bucketFor('2024-12-25').to,'2024-12-31');});
test('publishes mixed immutable files, compression variants and manifest without duplicate pages',async t=>{
 const outputDir=await fs.mkdtemp(path.join(os.tmpdir(),'piedmont-publish-'));t.after(()=>fs.rm(outputDir,{recursive:true,force:true}));
 const index=input(),first=await publishIndexes(index,{outputDir,settings,now});
 assert.equal(first.indexes.length,4);assert.equal(first.indexes.filter(e=>e.kind==='quarterly').length,2);assert.equal(first.indexes[0].latestIssue,'2026-10-14');
 let count=0;
 for(const e of first.indexes){const bytes=await fs.readFile(path.join(outputDir,e.url));assert.equal(bytes.length,e.bytes);assert.deepEqual(gunzipSync(await fs.readFile(path.join(outputDir,e.url+'.gz'))),bytes);assert.deepEqual(brotliDecompressSync(await fs.readFile(path.join(outputDir,e.url+'.br'))),bytes);count+=JSON.parse(bytes).pages.length;}
 assert.equal(count,4);const second=await publishIndexes(index,{outputDir,settings,now});assert.equal(second.generatedAt,first.generatedAt);assert.deepEqual(second.indexes.map(e=>e.url),first.indexes.map(e=>e.url));
 const next={date:'2026-10-21',file:'https://example.org/new.pdf',pages:1};index.issues.push(next);index.pages.push({...next,page:1,text:'New weekly issue'});
 const third=await publishIndexes(index,{outputDir,settings,now});assert.equal(third.indexes.length,5);for(const e of first.indexes)assert(third.indexes.some(x=>x.url===e.url));
 assert(!(await fs.readdir(outputDir)).includes('search-worker.js')); // Frontend belongs to the other repository.
});
test('does not overwrite a valid manifest when input has duplicate pages',async t=>{
 const outputDir=await fs.mkdtemp(path.join(os.tmpdir(),'piedmont-publish-'));t.after(()=>fs.rm(outputDir,{recursive:true,force:true}));const index=input();await publishIndexes(index,{outputDir,settings,now});const old=await fs.readFile(path.join(outputDir,'manifest.json'),'utf8');index.pages.push(index.pages[0]);await assert.rejects(publishIndexes(index,{outputDir,settings,now}),/Duplicate PDF page/);assert.equal(await fs.readFile(path.join(outputDir,'manifest.json'),'utf8'),old);
});

test('quarter cutoff rolls over on Los Angeles quarter boundaries, including year end',()=>{
 assert.equal(lastCompletedQuarter(new Date('2026-10-25T12:00:00Z')),'2026-09-30');
 assert.equal(lastCompletedQuarter(new Date('2026-10-01T06:59:59Z')),'2026-06-30');
 assert.equal(lastCompletedQuarter(new Date('2026-10-01T07:00:00Z')),'2026-09-30');
 assert.equal(lastCompletedQuarter(new Date('2027-01-01T07:59:59Z')),'2026-09-30');
 assert.equal(lastCompletedQuarter(new Date('2027-01-01T08:00:00Z')),'2026-12-31');
 assert.equal(lastCompletedQuarter(new Date('2024-04-01T12:00:00Z')),'2024-03-31');
});

test('publication consolidates a completed quarter without adding a PDF',async t=>{
 const outputDir=await fs.mkdtemp(path.join(os.tmpdir(),'piedmont-rollover-'));t.after(()=>fs.rm(outputDir,{recursive:true,force:true}));
 const index=input();
 const before=await publishIndexes(index,{outputDir,settings,now:new Date('2026-09-30T12:00:00Z')});
 assert(before.indexes.some(e=>e.kind==='weekly'&&e.from==='2026-07-01'));
 const after=await publishIndexes(index,{outputDir,settings,now:new Date('2026-10-01T12:00:00Z')});
 assert.equal(after.quarterThrough,'2026-09-30');assert(after.indexes.some(e=>e.kind==='quarterly'&&e.id==='2026-Q3'));
 assert(!after.indexes.some(e=>e.kind==='weekly'&&e.from==='2026-07-01'));
 assert.equal(after.issueCount,before.issueCount);assert.equal(after.pageCount,before.pageCount);
});
