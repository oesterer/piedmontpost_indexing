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
