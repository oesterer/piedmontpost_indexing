import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {updateLocal,runCommand,parseOptions} from '../scripts/update-local.mjs';

const git=(cwd,args)=>runCommand('git',args,{cwd,capture:true}).stdout.trim();
async function fixture(t){
 const directory=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'post-local-update-')));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
 async function repository(name,files){
  const remote=path.join(directory,name+'.git'),cwd=path.join(directory,name);
  git(directory,['init','--bare','--initial-branch=main',remote]);git(directory,['clone',remote,cwd]);
  git(cwd,['config','user.name','Test Operator']);git(cwd,['config','user.email','operator@example.org']);
  await fs.writeFile(path.join(cwd,'.gitignore'),'node_modules/\noutput/\ncache/*.lock\n');
  for(const [name,contents]of Object.entries(files)){const file=path.join(cwd,name);await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,contents);}
  git(cwd,['add','.']);git(cwd,['commit','-m','Initial data']);git(cwd,['push','-u','origin','main']);
  return {cwd,remote};
 }
 const indexer=await repository('indexer',{'package.json':'{"devDependencies":{}}','package-lock.json':'{}','README.md':'Indexing code','cache/manifest.json':'{"old":true}','cache/issues/first.json':'{"old":true}'});
 const site=await repository('site',{'app.js':'// Search app','manifest.json':'{"old":true}','indexes/old.json':'{"old":true}'});
 await fs.writeFile(path.join(site.cwd,'resume.sh'),'Unrelated personal helper');
 return {directory,indexer,site};
}
function mockPipeline(f,{indexFailure=false,verifyFailure=false,noChanges=false,beforeCopy}={}){
 const commands=[];
 const run=(program,args,options)=>{
  commands.push([program,...args]);
  if(program==='git')return runCommand(program,args,{...options,capture:true});
  assert.equal(program,'npm');assert.equal(options.env.SEARCH_SITE_DIR,f.site.cwd);
  const command=args.join(' ');
  if(args[1]==='index:archive'){
   if(!noChanges){writeFileSync(path.join(f.indexer.cwd,'cache/manifest.json'),'{"updated":true}');writeFileSync(path.join(f.indexer.cwd,'cache/issues/new.json'),'{"updated":true}');}
   return {code:indexFailure?1:0};
  }
  if(command==='run verify:indexes'&&verifyFailure)throw Error('Verification failed');
  if(command==='run publish:site'){
   beforeCopy?.();
   if(!noChanges){writeFileSync(path.join(f.site.cwd,'manifest.json'),'{"updated":true}');writeFileSync(path.join(f.site.cwd,'indexes/new.json'),'{"updated":true}');}
  }
  return {code:0};
 };
 return {run,commands};
}
const options=(f,mock)=>({root:f.indexer.cwd,siteDir:f.site.cwd,run:mock.run,log:()=>{}});

test('local update pulls remote changes and pushes only generated data in the two repositories',async t=>{
 const f=await fixture(t),author=path.join(f.directory,'other-author');
 git(f.directory,['clone',f.indexer.remote,author]);git(author,['config','user.name','Other Author']);git(author,['config','user.email','other@example.org']);
 await fs.writeFile(path.join(author,'README.md'),'Remote documentation update');git(author,['add','README.md']);git(author,['commit','-m','Update docs']);git(author,['push']);
 const mock=mockPipeline(f,{beforeCopy:()=>assert.equal(git(f.directory,['--git-dir='+f.indexer.remote,'show','main:cache/manifest.json']),'{"updated":true}')});
 assert.deepEqual(await updateLocal(options(f,mock)),{published:true});
 assert.equal(await fs.readFile(path.join(f.indexer.cwd,'README.md'),'utf8'),'Remote documentation update');
 assert.equal(git(f.directory,['--git-dir='+f.site.remote,'show','main:manifest.json']),'{"updated":true}');
 assert.equal(git(f.site.cwd,['ls-files','resume.sh']),'');assert.equal(await fs.readFile(path.join(f.site.cwd,'resume.sh'),'utf8'),'Unrelated personal helper');
 assert.equal(git(f.indexer.cwd,['diff','HEAD','--name-only']),'');assert.equal(git(f.site.cwd,['diff','HEAD','--name-only']),'');
 await assert.rejects(fs.access(path.join(f.indexer.cwd,'cache/local-update.lock')));
 assert(mock.commands.some(c=>c.join(' ')==='npm run index:archive -- --browser-channel chrome'));
});

test('unchanged data produces no commits or public push; rebuild is forwarded when requested',async t=>{
 const f=await fixture(t),indexHead=git(f.indexer.cwd,['rev-parse','HEAD']),siteHead=git(f.site.cwd,['rev-parse','HEAD']);
 const mock=mockPipeline(f,{noChanges:true});
 assert.deepEqual(await updateLocal({...options(f,mock),rebuild:true}),{published:false});
 assert.equal(git(f.indexer.cwd,['rev-parse','HEAD']),indexHead);assert.equal(git(f.site.cwd,['rev-parse','HEAD']),siteHead);
 assert(!mock.commands.some(c=>c[0]==='git'&&c[1]==='push'));assert(mock.commands.some(c=>c.includes('--rebuild')));
});

test('partial indexing failure saves verified cache but never updates the public repository',async t=>{
 const f=await fixture(t),siteHead=git(f.site.cwd,['rev-parse','HEAD']);const mock=mockPipeline(f,{indexFailure:true});
 await assert.rejects(updateLocal(options(f,mock)),/Indexing was incomplete/);
 assert.equal(git(f.directory,['--git-dir='+f.indexer.remote,'show','main:cache/manifest.json']),'{"updated":true}');
 assert.equal(git(f.site.cwd,['rev-parse','HEAD']),siteHead);assert(!mock.commands.some(c=>c.join(' ')==='npm run publish:site'));
 await assert.rejects(fs.access(path.join(f.indexer.cwd,'cache/local-update.lock')));
});

test('verification failure leaves cache changes uncommitted and blocks all pushes',async t=>{
 const f=await fixture(t),head=git(f.indexer.cwd,['rev-parse','HEAD']);const mock=mockPipeline(f,{verifyFailure:true});
 await assert.rejects(updateLocal(options(f,mock)),/Verification failed/);
 assert.equal(git(f.indexer.cwd,['rev-parse','HEAD']),head);assert(!mock.commands.some(c=>c[0]==='git'&&c[1]==='push'));
});

test('tracked edits and existing untracked generated data are rejected before fetching',async t=>{
 const f=await fixture(t),mock=mockPipeline(f);
 await fs.writeFile(path.join(f.indexer.cwd,'README.md'),'Uncommitted work');
 await assert.rejects(updateLocal(options(f,mock)),/Commit or stash/);
 assert(!mock.commands.some(c=>c[1]==='fetch'));git(f.indexer.cwd,['restore','README.md']);
 await fs.writeFile(path.join(f.site.cwd,'indexes/manual.json'),'Pre-existing index');
 await assert.rejects(updateLocal(options(f,mock)),/untracked generated data/);
});

test('existing local commits are not silently pushed along with generated data',async t=>{
 const f=await fixture(t),mock=mockPipeline(f);
 await fs.writeFile(path.join(f.indexer.cwd,'README.md'),'Local code update');git(f.indexer.cwd,['add','README.md']);git(f.indexer.cwd,['commit','-m','Local code']);
 await assert.rejects(updateLocal(options(f,mock)),/existing local commits/);
 assert(!mock.commands.some(c=>c[0]==='npm'||c[1]==='push'));
});

test('a concurrent public push is rejected without force and keeps the verified cache and local public commit',async t=>{
 const f=await fixture(t),author=path.join(f.directory,'concurrent-author');
 git(f.directory,['clone',f.site.remote,author]);git(author,['config','user.name','Other Author']);git(author,['config','user.email','other@example.org']);
 const mock=mockPipeline(f,{beforeCopy:()=>{
  writeFileSync(path.join(author,'app.js'),'// Concurrent frontend change');git(author,['add','app.js']);git(author,['commit','-m','Frontend update']);git(author,['push']);
 }});
 await assert.rejects(updateLocal(options(f,mock)),/git push/);
 assert.equal(git(f.directory,['--git-dir='+f.indexer.remote,'show','main:cache/manifest.json']),'{"updated":true}');
 assert.equal(git(f.site.cwd,['show','HEAD:manifest.json']),'{"updated":true}');
 assert.equal(git(f.directory,['--git-dir='+f.site.remote,'show','main:app.js']),'// Concurrent frontend change');
 assert(!mock.commands.some(c=>c.some(arg=>arg.startsWith('--force'))));
});

test('parses local update options and rejects missing/unknown arguments',()=>{
 assert.deepEqual(parseOptions(['--rebuild','--site-dir','/tmp/site','--browser-channel','']),{rebuild:true,siteDir:'/tmp/site',browserChannel:''});
 assert.throws(()=>parseOptions(['--site-dir']),/incomplete option/);assert.throws(()=>parseOptions(['--force']),/Unknown/);
});
