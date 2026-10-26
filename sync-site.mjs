#!/usr/bin/env node
// Copy only generated search data. Frontend code and Git configuration stay owned
// by the public repository. Historical immutable files are retained for open tabs.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {gunzipSync,brotliDecompressSync} from 'node:zlib';
import {fileURLToPath} from 'node:url';
import {ROOT,SITE_DIR,OUTPUT_DIR} from './paths.mjs';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
async function readOptional(file){try{return await fs.readFile(file);}catch(error){if(error.code==='ENOENT')return null;throw error;}}
function checkCompressed(bytes,suffix,expected,name){
 let decoded;
 try{decoded=suffix==='.gz'?gunzipSync(bytes):brotliDecompressSync(bytes);}
 catch{throw Error('Invalid compressed index: '+name);}
 if(!decoded.equals(expected))throw Error('Compressed index content mismatch: '+name);
}
async function atomic(file,bytes){await fs.mkdir(path.dirname(file),{recursive:true});const temporary=file+'.'+process.pid+'.tmp';await fs.writeFile(temporary,bytes);await fs.rename(temporary,file);}
export async function syncSite({outputDir=OUTPUT_DIR,siteDir=SITE_DIR}={}){
 if(path.resolve(outputDir)===path.resolve(siteDir)||path.resolve(siteDir)===ROOT)throw Error('Publication needs a separate website directory');
 const manifestBytes=await fs.readFile(path.join(outputDir,'manifest.json')),manifest=JSON.parse(manifestBytes);
 if(manifest.version!==1||!manifest.indexes?.length)throw Error('No valid generated manifest');
 // Validate all referenced files before touching the website checkout.
 const files=[];
 for(const entry of manifest.indexes){
  if(!/^indexes\/[a-zA-Z0-9.-]+\.json$/.test(entry.url))throw Error('Unsafe index path');
  const bytes=await fs.readFile(path.join(outputDir,entry.url));
  if(bytes.length!==entry.bytes||hash(bytes)!==entry.sha256)throw Error('Invalid generated index: '+entry.url);
  files.push({name:entry.url,bytes});
  for(const suffix of ['.gz','.br']){
   const sidecar=await readOptional(path.join(outputDir,entry.url+suffix));
   if(sidecar){
    checkCompressed(sidecar,suffix,bytes,entry.url+suffix);
    const sizeField=suffix==='.gz'?'gzipBytes':'brotliBytes';
    if(entry[sizeField]!==undefined&&entry[sizeField]!==sidecar.length)throw Error('Compressed index size mismatch: '+entry.url+suffix);
    files.push({name:entry.url+suffix,bytes:sidecar,suffix,decoded:bytes});
   }
  }
 }
 // Preflight destination conflicts before writing anything. Only compressed
 // representations may differ, and only if their decompressed JSON is identical.
 const writes=[];
 for(const {name,bytes,suffix,decoded}of files){
  const destination=path.join(siteDir,name),previous=await readOptional(destination);
  if(previous?.equals(bytes))continue;
  if(previous){
   if(!suffix)throw Error('Immutable index collision: '+name);
   checkCompressed(previous,suffix,decoded,name);
  }
  writes.push([destination,bytes]);
 }
 let changed=0;
 for(const [destination,bytes]of writes){await atomic(destination,bytes);changed++;}
 const previous=await readOptional(path.join(siteDir,'manifest.json'));
 if(!previous?.equals(manifestBytes)){await atomic(path.join(siteDir,'manifest.json'),manifestBytes);changed++;}
 return {changed,issueCount:manifest.issueCount,pageCount:manifest.pageCount};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{const result=await syncSite();console.log(`Updated ${result.changed} website files; ${result.issueCount} issues, ${result.pageCount} pages. Website: ${SITE_DIR}`);}
 catch(error){console.error(error.message);process.exitCode=1;}
}
