import {siteURL} from './site-path.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { syncIssues, pdfIdentity, guessDate, writeSearchSite, downloadWithRetry, isWeeklyIssue } from '../scripts/index-archive.mjs';
const {sourcePdfLink}=await import(new URL('pdf-links.js',siteURL));
const A='https://www.piedmont-post.com/_files/ugd/first.pdf';
const B='https://static.wixstatic.com/ugd/second.pdf';
const C='https://static.wixstatic.com/ugd/third.pdf';
async function fixture(t) {
 const cacheDir=await fs.mkdtemp(path.join(os.tmpdir(),'piedmont-cache-test-'));
 t.after(()=>fs.rm(cacheDir,{recursive:true,force:true}));
 const counts={downloads:0,extractions:0};
 const download=async()=>{counts.downloads++;return {body:Buffer.from('%PDF-1.7\nfixture'),etag:'"v1"'};};
 const extract=async ({url,date})=>{counts.extractions++;return {issue:{date:date||'2026-10-07',file:url,pages:1},pages:[{date:date||'2026-10-07',file:url,page:1,text:'Community newspaper content',articles:[{title:'A new weekly issue',text:'Community newspaper content',source:'detected'}]}]};};
 return {cacheDir,download,extract,counts,log:()=>{}};
}
test('first run processes PDFs; second run downloads/extracts nothing; a new file alone is processed',async t=>{
 const f=await fixture(t);
 let result=await syncIssues({...f,links:[A,B]});
 assert.equal(result.stats.added,2);assert.equal(f.counts.extractions,2);
 result=await syncIssues({...f,links:[A,B]});
 assert.equal(result.stats.skipped,2);assert.equal(f.counts.downloads,2);assert.equal(f.counts.extractions,2);
 result=await syncIssues({...f,links:[A,B,C]});
 assert.equal(result.stats.added,1);assert.equal(result.stats.skipped,2);assert.equal(f.counts.downloads,3);assert.equal(f.counts.extractions,3);assert.equal(result.index.pages.length,3);
});
test('duplicate URL parameters do not reindex; refreshed source links reach the output',async t=>{
 const f=await fixture(t);await syncIssues({...f,links:[A,A+'?download=true']});
 const result=await syncIssues({...f,links:[A+'?download=false']});
 assert.equal(f.counts.downloads,1);assert.equal(f.counts.extractions,1);
 assert.equal(result.index.pages[0].sourceUrl,A+'?download=false');
});
test('limited or incomplete discovery retains previous issues; rebuild refreshes discovered PDFs',async t=>{
 const f=await fixture(t);await syncIssues({...f,links:[A,B]});
 let result=await syncIssues({...f,links:[C],limit:1});assert.equal(result.index.issues.length,3);
 result=await syncIssues({...f,links:[A,B],rebuild:true});assert.equal(result.stats.reprocessed,2);assert.equal(result.index.issues.length,3);
});
test('non-PDF response or extraction failure is not committed and is retried later',async t=>{
 const f=await fixture(t);await syncIssues({...f,links:[A]});
 let result=await syncIssues({...f,links:[B],download:async()=>({body:Buffer.from('<html>Login required</html>')})});
 assert.equal(result.stats.failed,1);assert.equal(result.index.issues.length,1);assert.equal(f.counts.extractions,1);
 result=await syncIssues({...f,links:[B],extract:async()=>{throw Error('OCR required');}});
 assert.equal(result.stats.failed,1);assert.equal(result.index.issues.length,1);
 result=await syncIssues({...f,links:[B]});assert.equal(result.stats.added,1);assert.equal(result.index.issues.length,2);
});
test('missing per-issue cache is repaired when rediscovered',async t=>{
 const f=await fixture(t);await syncIssues({...f,links:[A]});
 await fs.unlink(path.join(f.cacheDir,'issues',pdfIdentity(A)+'.json'));
 const result=await syncIssues({...f,links:[A]});assert.equal(result.stats.reprocessed,1);assert.equal(f.counts.extractions,2);
});
test('identity/date validation',()=>{
 assert.equal(pdfIdentity(A),pdfIdentity(A+'?x=1#page=4'));
 assert.notEqual(pdfIdentity(A),pdfIdentity(B));
 assert.throws(()=>pdfIdentity('javascript:alert(1)'));
 assert.equal(guessDate('10-14-26 Post.pdf'),'2026-10-14');
 assert.equal(guessDate('2026_10_14.pdf'),'2026-10-14');
 assert.equal(guessDate('October 14, 2026'),'2026-10-14');
 assert.equal(guessDate('02-30-26.pdf'),null);assert.equal(guessDate('20% of readers'),null);
});
test('source links preserve existing query parameters, add page query and PDF fragment',()=>{
 const link=new URL(sourcePdfLink({sourceUrl:A+'?download=1',page:25}));
 assert.equal(link.origin,'https://www.piedmont-post.com');assert.equal(link.searchParams.get('download'),'1');assert.equal(link.searchParams.get('page'),'25');assert.equal(link.hash,'#page=25');
 assert.equal(sourcePdfLink({file:'issues/local.pdf',page:2}),null);
 assert.equal(new URL(sourcePdfLink({sourceUrl:A,page:-5})).searchParams.get('page'),'1');
});

test('downloads retry twice with a 10-second timeout per attempt',async()=>{
 let calls=0;const retries=[],timeouts=[];
 const result=await downloadWithRetry(async(_url,{timeoutMs})=>{
  timeouts.push(timeoutMs);calls++;if(calls<3)throw Error('Timeout exceeded');return {body:Buffer.from('%PDF-')};
 },A,{wait:async()=>{},onRetry:(retry,total)=>retries.push([retry,total])});
 assert.equal(calls,3);assert.deepEqual(timeouts,[10000,10000,10000]);assert.deepEqual(retries,[[1,2],[2,2]]);assert(result.body);
});
test('exhausted retries are not cached and a rerun fills the gap',async t=>{
 const f=await fixture(t);await syncIssues({...f,links:[A]});
 let calls=0;
 const result=await syncIssues({...f,links:[A,B],download:async()=>{calls++;throw Error('Timeout exceeded');}});
 assert.equal(calls,3);assert.equal(result.stats.failed,1);assert.equal(result.stats.skipped,1);assert.equal(result.index.issues.length,1);
 const retry=await syncIssues({...f,links:[A,B]});
 assert.equal(retry.stats.added,1);assert.equal(retry.stats.skipped,1);assert.equal(retry.index.issues.length,2);
});
test('non-newspaper labels are ignored before download, without recording a failure',async t=>{
 const f=await fixture(t);
 assert.equal(isWeeklyIssue({label:'\u200bSeptember 30, 2026'}),true);
 assert.equal(isWeeklyIssue({label:'May 28, 2025'}),true);
 assert.equal(isWeeklyIssue({label:'Parade Program'}),false);
 assert.equal(isWeeklyIssue({label:'Parade Program July 4, 2026'}),false);
 assert.equal(isWeeklyIssue({label:'Other event flyer'}),false);
 const result=await syncIssues({...f,links:[{url:A,label:'July 22, 2026'},{url:B,label:'Parade Program'}]});
 assert.equal(result.stats.ignored,1);assert.equal(result.stats.failed,0);assert.equal(result.stats.added,1);assert.equal(f.counts.downloads,1);
});

test('current dated replacement retires only unlisted same-date URLs; failed replacement preserves old issue',async t=>{
 const f=await fixture(t),old={url:A,label:'October 14, 2026'},replacement={url:B,label:'October 14, 2026'},other={url:C,label:'October 7, 2026'};
 await syncIssues({...f,links:[old,other]});
 let result=await syncIssues({...f,links:[replacement,other],download:async()=>{throw Error('offline');},downloadRetries:0});
 assert.equal(result.index.issues.length,2);assert(result.index.issues.some(i=>i.sourceUrl===A));
 result=await syncIssues({...f,links:[replacement,other]});
 assert.equal(result.index.issues.length,2);assert(!result.index.issues.some(i=>i.sourceUrl===A));assert(result.index.issues.some(i=>i.sourceUrl===B));
 assert((await fs.stat(path.join(f.cacheDir,'issues',pdfIdentity(A)+'.json'))).isFile());
 // Two explicitly listed PDFs on the same date remain available.
 result=await syncIssues({...f,links:[old,replacement,other]});assert.equal(result.index.issues.length,3);
});
