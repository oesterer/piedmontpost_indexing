import {gzipSync,brotliCompressSync,constants} from 'node:zlib';
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import {createHash} from 'node:crypto';
import {syncSite} from '../scripts/sync-site.mjs';
test('publication copies generated data only, preserves frontend and old generations, and skips unchanged files',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'post-sync-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const outputDir=path.join(dir,'output'),siteDir=path.join(dir,'site');await fs.mkdir(path.join(outputDir,'indexes'),{recursive:true});await fs.mkdir(path.join(siteDir,'indexes'),{recursive:true});
 await fs.writeFile(path.join(siteDir,'index.html'),'keep frontend');await fs.writeFile(path.join(siteDir,'indexes/old.json'),'keep old');
 const bytes=Buffer.from('{"version":1}');await fs.writeFile(path.join(outputDir,'indexes/2026-Q3.hash.json'),bytes);
 const manifest={version:1,issueCount:1,pageCount:1,indexes:[{url:'indexes/2026-Q3.hash.json',bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')}]};
 await fs.writeFile(path.join(outputDir,'manifest.json'),JSON.stringify(manifest));
 assert.equal((await syncSite({outputDir,siteDir})).changed,2);assert.equal((await syncSite({outputDir,siteDir})).changed,0);
 assert.equal(await fs.readFile(path.join(siteDir,'index.html'),'utf8'),'keep frontend');assert.equal(await fs.readFile(path.join(siteDir,'indexes/old.json'),'utf8'),'keep old');
 await fs.writeFile(path.join(outputDir,'indexes/2026-Q3.hash.json'),'corrupt');await assert.rejects(syncSite({outputDir,siteDir}),/Invalid generated index/);
});

test('compression differences are accepted only for byte-identical decompressed JSON',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'post-compression-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const outputDir=path.join(dir,'output'),siteDir=path.join(dir,'site');
 for(const root of [outputDir,siteDir])await fs.mkdir(path.join(root,'indexes'),{recursive:true});
 const name='indexes/2026-10-21.hash.json',bytes=Buffer.from(JSON.stringify({text:'Weekly newspaper content. '.repeat(100)}));
 const gzip=gzipSync(bytes,{level:9}),oldGzip=gzipSync(bytes,{level:1});
 const brotli=brotliCompressSync(bytes,{params:{[constants.BROTLI_PARAM_QUALITY]:5}}),oldBrotli=brotliCompressSync(bytes,{params:{[constants.BROTLI_PARAM_QUALITY]:1}});
 assert(!gzip.equals(oldGzip));assert(!brotli.equals(oldBrotli));
 for(const root of [outputDir,siteDir])await fs.writeFile(path.join(root,name),bytes);
 await fs.writeFile(path.join(outputDir,name+'.gz'),gzip);await fs.writeFile(path.join(siteDir,name+'.gz'),oldGzip);
 await fs.writeFile(path.join(outputDir,name+'.br'),brotli);await fs.writeFile(path.join(siteDir,name+'.br'),oldBrotli);
 const manifest={version:1,issueCount:1,pageCount:1,indexes:[{url:name,bytes:bytes.length,gzipBytes:gzip.length,brotliBytes:brotli.length,sha256:createHash('sha256').update(bytes).digest('hex')}]};
 await fs.writeFile(path.join(outputDir,'manifest.json'),JSON.stringify(manifest));
 assert.equal((await syncSite({outputDir,siteDir})).changed,3);
 assert.deepEqual(await fs.readFile(path.join(siteDir,name+'.gz')),gzip);
 assert.deepEqual(await fs.readFile(path.join(siteDir,name+'.br')),brotli);
 assert.equal((await syncSite({outputDir,siteDir})).changed,0);
 // Different decoded content remains an error, and failure does not overwrite the manifest.
 const originalManifest=await fs.readFile(path.join(siteDir,'manifest.json'));
 await fs.writeFile(path.join(siteDir,name+'.gz'),gzipSync(Buffer.from('different JSON')));
 await assert.rejects(syncSite({outputDir,siteDir}),/Compressed index content mismatch/);
 assert.deepEqual(await fs.readFile(path.join(siteDir,'manifest.json')),originalManifest);
 await fs.writeFile(path.join(siteDir,name+'.gz'),gzip);
 await fs.writeFile(path.join(outputDir,name+'.br'),Buffer.from('broken brotli'));
 await assert.rejects(syncSite({outputDir,siteDir}),/Invalid compressed index/);
 await fs.writeFile(path.join(outputDir,name+'.br'),brotli);
 await fs.writeFile(path.join(siteDir,name),'different JSON');
 await assert.rejects(syncSite({outputDir,siteDir}),/Immutable index collision/);
});
