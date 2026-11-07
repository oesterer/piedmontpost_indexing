import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import {spawnSync} from 'node:child_process';
import {ROOT} from '../scripts/paths.mjs';import {makeExtractor} from '../scripts/index-archive.mjs';

test('Python parser geometry, schema, and optional real PDF tests',async t=>{
 const local=path.join(ROOT,'.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python');
 let python=process.env.PDF_PYTHON;
 if(!python){try{await fs.access(local);python=local;}catch{python=process.platform==='win32'?'python':'python3';}}
 const result=spawnSync(python,['-m','unittest','discover','-s','tests/python','-p','test_*.py','-v'],{cwd:ROOT,encoding:'utf8'});
 if(result.error?.code==='ENOENT'){t.skip('Optional Python interpreter is not installed');return;}
 t.diagnostic(result.stderr||result.stdout);assert.equal(result.status,0,result.stderr||result.error?.message);
});

test('Python extractor adapter selects Python, forwards the same arguments and never invokes Swift',async t=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'post-python-adapter-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
 const calls=[];
 const extract=await makeExtractor(directory,{parser:'python',python:'python-test',run:async(program,args)=>{
  calls.push([program,...args]);
  if(args[0]==='-c')return {stdout:''};
  assert.equal(args[1],'--extract-one');
  await fs.writeFile(args[3],JSON.stringify({issue:{date:'2026-10-21',pages:1},pages:[{page:1,text:'Test page'}]}));return {stdout:'Extracted 1 pages'};
 }});
 const data=await extract({input:'/tmp/input.pdf',temporary:directory,url:'https://example.org/issue.pdf',date:null});
 assert.equal(data.pages.length,1);assert.equal(calls.length,2);assert(calls.every(c=>c[0]==='python-test'));
 assert.deepEqual(calls[1].slice(-4),['/tmp/input.pdf',path.join(directory,'issue.json'),'https://example.org/issue.pdf','-']);
});

test('Python dependency errors are actionable; unknown parser is rejected',async()=>{
 await assert.rejects(makeExtractor('/tmp',{parser:'python',python:'missing-python',run:async()=>{throw Error('not installed');}}),/requirements-python.txt/);
 await assert.rejects(makeExtractor('/tmp',{parser:'unknown'}),/parser must be/);
});
