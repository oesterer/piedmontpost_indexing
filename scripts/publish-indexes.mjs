#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {ROOT,SITE_DIR,OUTPUT_DIR} from './paths.mjs';
import {removeSidecars} from './remove-sidecars.mjs';
const digest=value=>createHash('sha256').update(value).digest('hex');
export function issueId(issue){const url=new URL(issue.sourceUrl||issue.file);let pathname=url.pathname;try{pathname=decodeURIComponent(pathname);}catch{}return digest(url.origin+pathname);}
// Newspaper calendar, independent of the runner's timezone. On the first day
// of a new quarter, the entire previous quarter becomes eligible for grouping.
export function lastCompletedQuarter(now=new Date()) {
 if(!Number.isFinite(now.getTime()))throw Error('Invalid publication date');
 const parts=new Intl.DateTimeFormat('en-US',{timeZone:'America/Los_Angeles',year:'numeric',month:'numeric'}).formatToParts(now);
 const year=Number(parts.find(p=>p.type==='year').value),month=Number(parts.find(p=>p.type==='month').value);
 return new Date(Date.UTC(year,Math.floor((month-1)/3)*3,0)).toISOString().slice(0,10);
}
export function bucketFor(date,quarterThrough=lastCompletedQuarter()) {
 if(date>quarterThrough)return {id:date,kind:'weekly',from:date,to:date};
 const year=Number(date.slice(0,4)),quarter=Math.ceil(Number(date.slice(5,7))/3);
 return {id:`${year}-Q${quarter}`,kind:'quarterly',from:`${year}-${String(quarter*3-2).padStart(2,'0')}-01`,to:new Date(Date.UTC(year,quarter*3,0)).toISOString().slice(0,10)};
}
async function atomic(file,contents){await fs.mkdir(path.dirname(file),{recursive:true});const temp=file+'.'+process.pid+'.tmp';await fs.writeFile(temp,contents);await fs.rename(temp,file);}
export async function readCachedIndex(cacheDir=path.join(ROOT,'cache')) {
 const manifest=JSON.parse(await fs.readFile(path.join(cacheDir,'manifest.json'),'utf8'));
 const issues=[],pages=[];
 for(const [id,entry]of Object.entries(manifest.entries)) {
  if(!/^[a-f0-9]{64}$/.test(id))throw Error('Invalid issue cache identifier');
  const data=JSON.parse(await fs.readFile(path.join(cacheDir,'issues',id+'.json'),'utf8'));
  if(!data.issue||data.pages?.length!==data.issue.pages)throw Error('Incomplete cached issue: '+entry.label);
  issues.push({...data.issue,file:entry.sourceUrl,sourceUrl:entry.sourceUrl});
  pages.push(...data.pages.map(p=>({...p,file:entry.sourceUrl,sourceUrl:entry.sourceUrl})));
 }
 return {source:'https://www.piedmont-post.com/archive',issues,pages};
}
export async function publishIndexes(index,{outputDir=OUTPUT_DIR,settings,now=new Date()}={}) {
 settings??=JSON.parse(await fs.readFile(path.join(ROOT,'settings.json'),'utf8'));
 const cutoff=lastCompletedQuarter(now);
 const groups=new Map(),issuesById=new Map(),seenPages=new Set();
 for(const issue of index.issues) {
  const id=issueId(issue);if(issuesById.has(id))throw Error('Duplicate issue in input');
  const bucket=bucketFor(issue.date,cutoff);
  // Two different PDFs on the same date must remain distinct weekly indexes.
  const key=bucket.kind==='weekly'?bucket.id+'-'+id.slice(0,8):bucket.id;
  if(!groups.has(key))groups.set(key,{...bucket,id:key,issues:[],pages:[]});
  const record={...issue,id,indexId:key};
  groups.get(key).issues.push(record);issuesById.set(id,record);
 }
 for(const page of index.pages) {
  const id=issueId(page),issue=issuesById.get(id);
  if(!issue||issue.date!==page.date)throw Error('Page has no corresponding issue');
  const key=id+':'+page.page;if(seenPages.has(key))throw Error('Duplicate PDF page in input');seenPages.add(key);
  groups.get(issue.indexId).pages.push({...page,issueId:id});
 }
 const descriptors=[];
 await fs.mkdir(path.join(outputDir,'indexes'),{recursive:true});
 for(const group of groups.values()) {
  group.issues.sort((a,b)=>b.date.localeCompare(a.date)||a.id.localeCompare(b.id));
  group.pages.sort((a,b)=>b.date.localeCompare(a.date)||a.issueId.localeCompare(b.issueId)||a.page-b.page);
  for(const issue of group.issues) {
   const pages=group.pages.filter(p=>p.issueId===issue.id);
   if(pages.length!==issue.pages||pages.some((p,i)=>p.page!==i+1))throw Error('Missing or misnumbered pages for '+issue.date);
  }
  const contents=Buffer.from(JSON.stringify({version:1,id:group.id,issues:group.issues,pages:group.pages})+'\n');
  const hash=digest(contents),filename=group.id+'.'+hash.slice(0,16)+'.json';
  const target=path.join(outputDir,'indexes',filename);
  // Content-addressed files are immutable. Keep old generations for open tabs.
  const previous=await fs.readFile(target).catch(error=>{if(error.code!=='ENOENT')throw error;return null;});
  if(previous&&!previous.equals(contents))throw Error('Immutable index collision: '+filename);
  if(!previous)await atomic(target,contents);
  descriptors.push({id:group.id,kind:group.kind,url:'indexes/'+filename,from:group.from,to:group.to,latestIssue:group.issues[0].date,oldestIssue:group.issues.at(-1).date,issueCount:group.issues.length,pageCount:group.pages.length,bytes:contents.length,sha256:hash});
 }
 descriptors.sort((a,b)=>b.latestIssue.localeCompare(a.latestIssue)||a.id.localeCompare(b.id));
 const issues=[...issuesById.values()].sort((a,b)=>b.date.localeCompare(a.date)||a.id.localeCompare(b.id));
 const manifest={version:1,generatedAt:new Date().toISOString(),source:index.source,quarterThrough:cutoff,batchSize:settings.batchSize||20,memoryCacheBytes:settings.memoryCacheBytes||16777216,issueCount:issues.length,pageCount:index.pages.length,indexes:descriptors,issues};
 // Keep no-op checks stable: polling must not create timestamp-only commits.
 try {
  const previous=JSON.parse(await fs.readFile(path.join(outputDir,'manifest.json'),'utf8').catch(error=>{if(error.code!=='ENOENT')throw error;return fs.readFile(path.join(SITE_DIR,'manifest.json'),'utf8');}));
  const {generatedAt:oldTime,...oldContent}=previous;
  const {generatedAt:newTime,...newContent}=manifest;
  if(JSON.stringify(oldContent)===JSON.stringify(newContent))manifest.generatedAt=oldTime;
 } catch(error) {if(error.code!=='ENOENT')throw error;}
 await removeSidecars(path.join(outputDir,'indexes'));
 // The manifest is the final write: every referenced index already exists.
 await atomic(path.join(outputDir,'manifest.json'),JSON.stringify(manifest)+'\n');
 console.log(`Published ${descriptors.filter(d=>d.kind==='quarterly').length} quarterly and ${descriptors.filter(d=>d.kind==='weekly').length} weekly indexes; ${issues.length} issues, ${index.pages.length} pages.`);
 return manifest;
}
async function main(){
 const cacheDir=path.join(ROOT,'cache');
 try{await fs.access(path.join(cacheDir,'indexer.lock'));throw Error('Indexer is running; wait for it to finish before publishing');}catch(error){if(error.code!=='ENOENT')throw error;}
 await publishIndexes(await readCachedIndex(cacheDir));
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{console.error(error.message);process.exitCode=1;});
