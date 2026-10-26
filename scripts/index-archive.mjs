#!/usr/bin/env node
// Incremental remote-PDF indexer. Passwords/cookies remain in memory only.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';
import { Writable } from 'node:stream';
const execute = promisify(execFile);
import {ROOT,OUTPUT_DIR} from './paths.mjs';
import {publishIndexes} from './publish-indexes.mjs';
const DEFAULT_URL = 'https://www.piedmont-post.com/archive';

function decoded(value) { try { return decodeURIComponent(value); } catch { return value; } }
export function pdfIdentity(value) {
 const url = new URL(value);
 if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw Error('PDF links must be HTTP(S) URLs without embedded credentials');
 // Wix stores distinct documents under unique URL paths. Ignore query strings
 // so tracking parameters or refreshed access tokens do not cause reindexing.
 return createHash('sha256').update(url.origin + decoded(url.pathname)).digest('hex');
}
export function guessDate(value) {
 const text = decoded(value);
 let match = text.match(/\b((?:19|20)\d{2})[-_](\d{1,2})[-_](\d{1,2})\b/);
 let parts;
 if (match) parts = [+match[1], +match[2], +match[3]];
 else if ((match = text.match(/\b(\d{1,2})[-_](\d{1,2})[-_](\d{2}|\d{4})\b/))) parts = [+match[3] < 100 ? 2000 + +match[3] : +match[3], +match[1], +match[2]];
 else {
  match = text.match(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),?\s+((?:19|20)\d{2})\b/i);
  if (match) parts = [+match[3], ['january','february','march','april','may','june','july','august','september','october','november','december'].indexOf(match[1].toLowerCase()) + 1, +match[2]];
 }
 if (!parts) return null;
 const date = new Date(Date.UTC(parts[0],parts[1]-1,parts[2]));
 return date.getUTCFullYear()===parts[0] && date.getUTCMonth()===parts[1]-1 && date.getUTCDate()===parts[2] ? date.toISOString().slice(0,10) : null;
}
export function uniqueLinks(links) {
 const found = new Map();
 for (const item of links) {
  const link = typeof item === 'string' ? {url:item} : item;
  const key = pdfIdentity(link.url);
  if (!found.has(key)) found.set(key, {...link, key});
 }
 return [...found.values()];
}
export function isWeeklyIssue(link) {
 const label=(link.label||'').replace(/[\u200B-\u200D\uFEFF]/g,'').trim();
 if (/\b(?:parade|program|programme)\b/i.test(label)) return false;
 // Unlabelled explicit URLs can still infer their date from the PDF cover.
 return !label || Boolean(guessDate(label)) || Boolean(link.date && guessDate(link.date)===link.date);
}
export async function downloadWithRetry(download,url,{timeoutMs=10000,retries=2,onRetry=()=>{},wait=ms=>new Promise(resolve=>setTimeout(resolve,ms))}={}) {
 for(let attempt=0;;attempt++) {
  try { return await download(url,{timeoutMs}); }
  catch(error) {
   if(attempt>=retries)throw error;
   onRetry(attempt+1,retries,error);
   await wait(500*(attempt+1));
  }
 }
}
async function atomicJSON(file, value) {
 await fs.mkdir(path.dirname(file), {recursive:true});
 const temp = file + '.' + process.pid + '.tmp';
 await fs.writeFile(temp, JSON.stringify(value) + '\n', {mode:0o600});
 await fs.rename(temp, file);
}
async function readJSON(file, fallback) {
 try { return JSON.parse(await fs.readFile(file,'utf8')); }
 catch (error) { if (error.code === 'ENOENT') return fallback; throw Error('Cannot read valid JSON: '+file); }
}
function validIssue(data) {
 return data && /^\d{4}-\d{2}-\d{2}$/.test(data.issue?.date) && data.issue.pages>0 && Array.isArray(data.pages) && data.pages.length===data.issue.pages && data.pages.every((p,i)=>p.page===i+1 && typeof p.text==='string');
}

export async function syncIssues({links, cacheDir, download, extract, rebuild=false, limit=Infinity, downloadTimeoutMs=10000, downloadRetries=2, log=console.log}) {
 await fs.mkdir(path.join(cacheDir,'issues'), {recursive:true});
 const manifestFile = path.join(cacheDir,'manifest.json');
 const manifest = await readJSON(manifestFile, {version:1,entries:{}});
 if (manifest.version !== 1 || !manifest.entries) throw Error('Unsupported archive cache format');
 const stats = {discovered:0,added:0,reprocessed:0,skipped:0,ignored:0,failed:0};
 let attempted = 0;
 const failures=[];
 const discovered=uniqueLinks(links),discoveredKeys=new Set(discovered.map(link=>link.key)),currentDates=new Set();
 const confirmDate=(link,date)=>{if((link.date||guessDate(link.label||''))===date)currentDates.add(date);};
 for (const link of discovered) {
  stats.discovered++;
  if(!isWeeklyIssue(link)){stats.ignored++;log('Skipping non-issue link: '+link.label);continue;}
  const file = path.join(cacheDir,'issues',link.key+'.json');
  const previous = manifest.entries[link.key];
  let cached;
  try { cached = await readJSON(file,null); } catch { cached=null; }
  if (previous && validIssue(cached) && !rebuild) {
   previous.sourceUrl=link.url; confirmDate(link,cached.issue.date); stats.skipped++; continue;
  }
  if (attempted>=limit) continue;
  attempted++;
  const name = link.label || path.basename(new URL(link.url).pathname);
  log('Indexing '+name);
  let temporary;
  try {
   const downloaded = await downloadWithRetry(download,link.url,{
    timeoutMs:downloadTimeoutMs,retries:downloadRetries,
    onRetry:(retry,total,error)=>log('Retry '+retry+'/'+total+' for '+name+': '+error.message)
   });
   const buffer = Buffer.from(downloaded.body);
   if (!buffer.subarray(0,1024).includes(Buffer.from('%PDF-'))) throw Error('Download is not a PDF (possibly a login or error page)');
   temporary = await fs.mkdtemp(path.join(os.tmpdir(),'piedmont-issue-'));
   const input = path.join(temporary,'issue.pdf');
   await fs.writeFile(input,buffer,{mode:0o600});
   if (link.date && (guessDate(link.date)!==link.date || !/^\d{4}-\d{2}-\d{2}$/.test(link.date))) throw Error('Invalid issue date in link list');
   const hint = link.date || guessDate(link.label || '') || guessDate(link.url);
   const data = await extract({input,temporary,url:link.url,date:hint});
   if (!validIssue(data)) throw Error('Extractor did not return a complete issue');
   // Commit only after the PDF has downloaded AND every page has been extracted.
   await atomicJSON(file,data);
   manifest.entries[link.key]={sourceUrl:link.url,label:link.label||'',date:data.issue.date,etag:downloaded.etag||null,indexedAt:new Date().toISOString()};
   await atomicJSON(manifestFile,manifest);
   confirmDate(link,data.issue.date);
   stats[previous?'reprocessed':'added']++;
  } catch (error) {
   stats.failed++; failures.push({label:name,message:error.message});
   log('Failed '+name+': '+error.message);
  } finally { if(temporary) await fs.rm(temporary,{recursive:true,force:true}); }
 }
 // A current, successfully indexed dated link supersedes an unlisted URL
 // for the same weekly issue. Keep its JSON on disk for recovery, but stop
 // publishing it. Absent dates and failed replacements remain untouched.
 for(const [key,entry] of Object.entries(manifest.entries)){
  if(!discoveredKeys.has(key)&&currentDates.has(entry.date)){
   log('Retiring superseded PDF for '+entry.date+': '+entry.sourceUrl);
   delete manifest.entries[key];
  }
 }
 await atomicJSON(manifestFile,manifest);
 // Merge cached text, without opening or reprocessing old PDFs. Preserve older
 // issues when an archive page is temporarily incomplete or --limit is used.
 const issues=[],pages=[];
 for (const [key,entry] of Object.entries(manifest.entries)) {
  const data=await readJSON(path.join(cacheDir,'issues',key+'.json'),null);
  if (!validIssue(data)) throw Error('Cached issue is missing or invalid; rerun with --rebuild: '+entry.label);
  const sourceUrl=entry.sourceUrl;
  issues.push({...data.issue,file:sourceUrl,sourceUrl});
  pages.push(...data.pages.map(p=>({...p,file:sourceUrl,sourceUrl})));
 }
 issues.sort((a,b)=>a.date.localeCompare(b.date));
 pages.sort((a,b)=>a.date.localeCompare(b.date)||a.page-b.page);
 return {index:{issues,pages,source:DEFAULT_URL,updatedAt:new Date().toISOString()},stats,failures};
}

async function passwordPrompt() {
 if (!process.stdin.isTTY) throw Error('Set PIEDMONT_ARCHIVE_PASSWORD or run in an interactive terminal');
 const silent=new Writable({write(_chunk,_encoding,done){done();}});
 const rl=readline.createInterface({input:process.stdin,output:silent,terminal:true});
 process.stderr.write('Archive password: ');
 const password=await new Promise(resolve=>rl.question('',resolve));
 rl.close();process.stderr.write('\n');return password;
}

export async function discoverArchive(context, archiveUrl, password, {maxPages=100}={}) {
 const base=new URL(archiveUrl), queue=[base.href],visited=new Set(),found=new Map();
 const page=await context.newPage();
 try {
  while(queue.length) {
   if(visited.size>=maxPages) throw Error('Archive navigation limit reached; no partial discovery was published. Increase --max-pages.');
   const url=queue.shift();if(visited.has(url))continue;visited.add(url);
   const response=await page.goto(url,{waitUntil:'domcontentloaded',timeout:60000});
   if(response && response.status()>=400)throw Error('Archive returned HTTP '+response.status());
   await page.waitForFunction(()=>document.querySelector('input[type="password"]') || [...document.querySelectorAll('a[href]')].some(a=>/\.pdf(?:[?#]|$)/i.test(a.href)),null,{timeout:15000}).catch(()=>{});
   let passwordInput=page.locator('input[type="password"]:visible').first();
   if(await passwordInput.count()) {
    await passwordInput.fill(password);
    const form=passwordInput.locator('xpath=ancestor::form');
    const submit=form.locator('button[type="submit"],input[type="submit"]').first();
    const button=page.getByRole('button',{name:/^(go|submit|enter|log ?in|unlock|continue)$/i}).first();
    if(await submit.count())await submit.click();
    else if(await button.count())await button.click();
    else await passwordInput.press('Enter');
    await passwordInput.waitFor({state:'hidden',timeout:20000}).catch(()=>{throw Error('Archive password was not accepted, or the login form needs a site-specific selector');});
    await page.waitForLoadState('domcontentloaded');
   }
   let stable=0,previous='',rounds=0;const yearControls=new Set();
   while(stable<5 && rounds++<100) {
    for(const frame of page.frames()) {
     let links=[];
     try { links=await frame.locator('a[href],iframe[src],embed[src],object[data]').evaluateAll(nodes=>nodes.map(n=>({url:n.href||n.src||n.data,label:(n.innerText||n.title||'').trim()}))); } catch { continue; }
     for(const link of links) {
      let absolute;try{absolute=new URL(link.url,url);}catch{continue;}
      if(!['https:','http:'].includes(absolute.protocol))continue;
      if(/\.pdf$/i.test(absolute.pathname)) {
       const item={url:absolute.href,label:link.label};found.set(pdfIdentity(item.url),item);
      } else if(absolute.origin===base.origin && (absolute.pathname===base.pathname || absolute.pathname.startsWith(base.pathname+'/') || absolute.pathname.startsWith(base.pathname+'-'))) {
       absolute.hash='';if(!visited.has(absolute.href)&&!queue.includes(absolute.href))queue.push(absolute.href);
      }
     }
    }
    // Visit common archive year dropdowns, tabs and accordion buttons.
    // Collect links BEFORE changing a control, then allow the new view to load.
    let changed=false;
    const selects=page.locator('select');
    for(let i=0;i<await selects.count()&&!changed;i++) {
     const select=selects.nth(i);if(!await select.isVisible())continue;
     const options=await select.locator('option').evaluateAll(nodes=>nodes.map(n=>({value:n.value,text:n.textContent.trim()})));
     for(const option of options) {
      const key='select:'+i+':'+option.value;
      if(/^(?:19|20)\d{2}$/.test(option.text)&&!yearControls.has(key)) {
       yearControls.add(key);await select.selectOption(option.value);changed=true;break;
      }
     }
    }
    const years=page.getByRole('button',{name:/^(?:archive\s*)?(?:19|20)\d{2}(?:\s*(?:issues|archive))?$/i}).or(page.getByRole('tab',{name:/^(?:19|20)\d{2}$/}));
    for(let i=0;i<await years.count()&&!changed;i++) {
     const year=years.nth(i),text=(await year.innerText()).trim(),key='year:'+text;
     if(!yearControls.has(key)&&await year.isVisible()&&await year.isEnabled()) {
      yearControls.add(key);await year.click();changed=true;
     }
    }
    const next=page.getByRole('button',{name:/^(load more|show more|next(?: page)?|older(?: posts| issues)?)$/i}).first();
    if(!changed&&await next.count() && await next.isVisible() && await next.isEnabled()) {
     await next.click();changed=true;
    }
    if(changed){stable=0;previous='';}
    await page.evaluate(()=>window.scrollTo(0,document.body.scrollHeight));
    await page.waitForTimeout(700);
    const signature=await page.evaluate(()=>location.href+'|'+document.body.scrollHeight+'|'+[...document.querySelectorAll('a[href]')].map(a=>a.href).join('\n'));
    stable=signature===previous?stable+1:0;previous=signature;
   }
   if(rounds>=100)throw Error('Archive loading did not settle; discovery was stopped without publishing a partial result');
  }
 } finally { await page.close(); }
 if(!found.size)throw Error('No PDF links found after login. The archive may require different selectors; use --links with an explicit link list.');
 return [...found.values()];
}

async function makeExtractor(cacheDir) {
 const source=path.join(ROOT,'scripts/index-pdfs.swift'),binary=path.join(cacheDir,'pdf-indexer');
 let ready=false;
 return async ({input,temporary,url,date})=>{
  if(!ready) {
   const sourceInfo=await fs.stat(source),binaryInfo=await fs.stat(binary).catch(()=>null);
   if(!binaryInfo||binaryInfo.mtimeMs<sourceInfo.mtimeMs) {
    const compileCache=path.join(cacheDir,'swift-cache');await fs.mkdir(compileCache,{recursive:true});
    try {await execute('swiftc',['-module-cache-path',compileCache,source,'-o',binary],{env:{...process.env,CLANG_MODULE_CACHE_PATH:compileCache},maxBuffer:4*1024*1024});}
    catch {throw Error('Swift/PDFKit compilation failed. Run this indexer on macOS with Xcode Command Line Tools installed.');}
   }
   ready=true;
  }
  const output=path.join(temporary,'issue.json');
  try{await execute(binary,['--extract-one',input,output,url,date||'-'],{maxBuffer:32*1024*1024});}
  catch(error){const lines=(error.stderr||'PDF extraction failed').trim().split('\n');throw Error((lines.findLast(line=>line.startsWith('Extraction failed:'))||lines.filter(line=>!line.includes('attributedStringScaled')).slice(-2).join(' ')).slice(-600));}
  return readJSON(output,null);
 };
}

export async function writeSearchSite(directory,index) {
 return publishIndexes(index,{outputDir:directory});
}

async function main() {
 const args=process.argv.slice(2),options={cacheDir:path.join(ROOT,'cache'),outputDir:OUTPUT_DIR,archiveUrl:DEFAULT_URL,maxPages:100,limit:Infinity,rebuild:false,headed:false,downloadTimeoutMs:10000,downloadRetries:2};
 for(let i=0;i<args.length;i++) {
  const arg=args[i];
  if(arg==='--help'){console.log('Usage: node scripts/index-archive.mjs [--rebuild] [--limit N] [--headed] [--browser-channel chrome] [--links FILE] [--cache-dir DIR] [--output-dir DIR] [--max-pages N] [--download-timeout-ms 10000] [--retries 2]\nSet PIEDMONT_ARCHIVE_PASSWORD or enter it at the hidden prompt. PDFs are indexed once per source URL path; --rebuild refreshes all discovered issues. Output defaults to output/.');return;}
  if(arg==='--rebuild'){options.rebuild=true;continue;}if(arg==='--headed'){options.headed=true;continue;}
  const key={'--links':'links','--cache-dir':'cacheDir','--output-dir':'outputDir','--archive-url':'archiveUrl','--max-pages':'maxPages','--limit':'limit','--browser-channel':'browserChannel','--download-timeout-ms':'downloadTimeoutMs','--retries':'downloadRetries'}[arg];
  if(!key||!args[i+1])throw Error('Unknown or incomplete option: '+arg);
  const value=args[++i];options[key]=['maxPages','limit','downloadTimeoutMs','downloadRetries'].includes(key)?Number(value):value;
 }
 for(const key of ['limit','maxPages','downloadTimeoutMs'])if(!(options[key]>0)||(!Number.isInteger(options[key])&&options[key]!==Infinity))throw Error(key+' must be a positive integer');
 if(!Number.isInteger(options.downloadRetries)||options.downloadRetries<0)throw Error('retries must be a nonnegative integer');
 options.cacheDir=path.resolve(options.cacheDir);options.outputDir=path.resolve(options.outputDir);
 // An external index must not overwrite the existing sample archive.
 if(options.outputDir===ROOT)throw Error('Use a separate --output-dir such as output');
 let browser,context;
 await fs.mkdir(options.cacheDir,{recursive:true});
 // Exclusive lock prevents two weekly jobs from overwriting each other's cache.
 const lock=path.join(options.cacheDir,'indexer.lock');
 let handle;try{handle=await fs.open(lock,'wx',0o600);}catch(error){if(error.code==='EEXIST')throw Error('Another indexer is running, or a stale indexer.lock exists in the cache directory');throw error;}
 try {
  await handle.writeFile(JSON.stringify({pid:process.pid,startedAt:new Date().toISOString()}));
  let links,download;
  if(options.links) {
   links=await readJSON(path.resolve(options.links),null);
   if(!Array.isArray(links)||!links.length)throw Error('--links must contain a nonempty JSON array of PDF URLs or {url,label,date} records');
   download=async (url,{timeoutMs})=>{const response=await fetch(url,{signal:AbortSignal.timeout(timeoutMs)});if(!response.ok)throw Error('PDF download returned HTTP '+response.status);return {body:Buffer.from(await response.arrayBuffer()),etag:response.headers.get('etag')};};
  } else {
   let chromium;try{({chromium}=await import('playwright'));}catch{throw Error('Install browser support first: npm install && npx playwright install chromium');}
   const password=process.env.PIEDMONT_ARCHIVE_PASSWORD || await passwordPrompt();
   browser=await chromium.launch({headless:!options.headed,...(options.browserChannel?{channel:options.browserChannel}:{})});context=await browser.newContext();
   console.log('Opening the archive and collecting PDF links…');
   links=await discoverArchive(context,options.archiveUrl,password,{maxPages:options.maxPages});
   download=async (url,{timeoutMs})=>{const response=await context.request.get(url,{timeout:timeoutMs});try{if(!response.ok())throw Error('PDF download returned HTTP '+response.status());return {body:await response.body(),etag:response.headers()['etag']};}finally{await response.dispose();}};
  }
  // Do not store passwords or browser cookies in the discovery manifest.
  await atomicJSON(path.join(options.cacheDir,'discovered-links.json'),links);
  const result=await syncIssues({...options,links,download,extract:await makeExtractor(options.cacheDir)});
  result.index.source=options.archiveUrl;
  if(!result.index.issues.length)throw Error('No issues were indexed; the existing search site was left untouched');
  await writeSearchSite(options.outputDir,result.index);
  console.log(JSON.stringify(result.stats));console.log('Search site: '+options.outputDir);
  if(result.failures.length)process.exitCode=1;
 } finally {
  await browser?.close();await handle.close();await fs.unlink(lock);
 }
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{console.error('Archive indexing failed: '+error.message);process.exitCode=1;});
