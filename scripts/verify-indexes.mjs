#!/usr/bin/env node
import fs from'node:fs/promises';import path from'node:path';import {fileURLToPath}from'node:url';import {createHash}from'node:crypto';import assert from'node:assert/strict';
import {readCachedIndex,issueId}from'./publish-indexes.mjs';
import {ROOT as root,OUTPUT_DIR as directory} from './paths.mjs';
const hash=data=>createHash('sha256').update(data).digest('hex');
const fingerprint=p=>hash(JSON.stringify({date:p.date,page:p.page,text:p.text,articles:p.articles||[],sourceUrl:p.sourceUrl||p.file}));
const original=await readCachedIndex(path.join(root,'cache'));
const expected=new Map(original.pages.map(p=>[issueId(p)+':'+p.page,fingerprint(p)]));
const manifest=JSON.parse(await fs.readFile(path.join(directory,'manifest.json'),'utf8'));
assert.equal(manifest.issueCount,original.issues.length);assert.equal(manifest.pageCount,expected.size);
const seenIssues=new Set(),seenPages=new Set();let count=0;
for(const entry of manifest.indexes){
 const bytes=await fs.readFile(path.join(directory,entry.url));assert.equal(bytes.length,entry.bytes);assert.equal(hash(bytes),entry.sha256);
 const data=JSON.parse(bytes);assert.equal(data.id,entry.id);assert.equal(data.issues.length,entry.issueCount);assert.equal(data.pages.length,entry.pageCount);
 for(const issue of data.issues){assert(!seenIssues.has(issue.id));seenIssues.add(issue.id);assert(issue.date>=entry.from&&issue.date<=entry.to);assert.equal(entry.kind,issue.date<=manifest.quarterThrough?'quarterly':'weekly');if(entry.kind==='weekly')assert.equal(data.issues.length,1);}
 for(const page of data.pages){const key=page.issueId+':'+page.page;assert(!seenPages.has(key));seenPages.add(key);assert.equal(fingerprint(page),expected.get(key),'Changed page content: '+key);count++;}
}
assert.equal(seenIssues.size,manifest.issueCount);assert.equal(count,expected.size);
for(const issue of manifest.issues){assert(seenIssues.has(issue.id));assert(manifest.indexes.some(e=>e.id===issue.indexId));}
const newest=manifest.indexes[0];
console.log(`Verified ${manifest.indexes.length} indexes: ${seenIssues.size} unique issues, ${count} unique pages; all text, titles and PDF URLs match the copied cache.`);
console.log(`Initial data: manifest ${Buffer.byteLength(JSON.stringify(manifest))} bytes + latest index ${newest.bytes} bytes (${newest.gzipBytes} bytes with gzip).`);
