#!/usr/bin/env node
// Local equivalent of the indexing workflow. Uses existing Git credentials;
// no token is embedded in this script and no Git history is rewritten.
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {ROOT,SITE_DIR} from './paths.mjs';

export function runCommand(program,args,{cwd,env=process.env,capture=false,allowFailure=false}={}){
 const result=spawnSync(program,args,{cwd,env,encoding:'utf8',stdio:capture?'pipe':'inherit'});
 if(result.error)throw result.error;
 const code=result.status??1;
 if(code!==0&&!allowFailure)throw Error(`${program} ${args.join(' ')} failed (exit ${code}).${capture?'\n'+(result.stderr||result.stdout||'').trim():''}`);
 return {code,stdout:result.stdout||'',stderr:result.stderr||''};
}

export async function updateLocal({root=ROOT,siteDir=SITE_DIR,rebuild=false,browserChannel='chrome',parser='swift',python,run=runCommand,log=console.log}={}){
 if(!['swift','python'].includes(parser))throw Error('--parser must be swift or python');
 root=await fs.realpath(root);siteDir=await fs.realpath(siteDir);
 if(root===siteDir)throw Error('The indexing and public website checkouts must be different repositories.');
 const env={...process.env,SEARCH_SITE_DIR:siteDir,PDF_PARSER_TEST_BACKEND:parser};
 const git=(cwd,args,options={})=>run('git',args,{cwd,env,capture:true,...options});
 const npm=args=>run('npm',args,{cwd:root,env});
 const data={indexer:['cache/manifest.json','cache/issues'],site:['manifest.json','indexes']};
 const isData=(name,paths)=>paths.some(prefix=>name===prefix||name.startsWith(prefix+'/'));
 function clean(cwd,paths){
  if(git(cwd,['diff','--quiet'],{allowFailure:true}).code!==0||git(cwd,['diff','--cached','--quiet'],{allowFailure:true}).code!==0)
   throw Error(`Commit or stash tracked/staged changes first: ${cwd}`);
  const untracked=git(cwd,['ls-files','--others','--exclude-standard','-z','--',...paths]).stdout;
  if(untracked)throw Error(`Commit or remove existing untracked generated data first: ${cwd}`);
 }
 function repository(cwd,paths){
  if(path.resolve(git(cwd,['rev-parse','--show-toplevel']).stdout.trim())!==cwd)
   throw Error('Expected repository root: '+cwd);
  const branch=git(cwd,['symbolic-ref','--quiet','--short','HEAD']).stdout.trim();
  const defaultRef=git(cwd,['symbolic-ref','--quiet','refs/remotes/origin/HEAD'],{allowFailure:true});
  const expected=defaultRef.code===0?defaultRef.stdout.trim().replace('refs/remotes/origin/',''):'main';
  if(branch!==expected)throw Error(`Check out the default branch ${expected} in ${cwd} first.`);
  for(const field of ['user.name','user.email'])if(!git(cwd,['config','--get',field],{allowFailure:true}).stdout.trim())
   throw Error(`Configure git ${field} in ${cwd} before running the update.`);
  clean(cwd,paths);
  return {cwd,paths,branch};
 }
 function fetch(repo){git(repo.cwd,['fetch','origin',repo.branch]);}
 function ensureNoLocalCommits(repo){
  if(Number(git(repo.cwd,['rev-list','--count',`origin/${repo.branch}..HEAD`]).stdout.trim())!==0)
   throw Error(`Push or reconcile existing local commits first: ${repo.cwd}. This script will not push unrelated commits or rebase them.`);
 }
 function fastForward(repo){
  log('Updating '+repo.cwd);
  git(repo.cwd,['merge','--ff-only',`origin/${repo.branch}`]);
 }
 function save(repo,message){
  // Never fold pre-existing staging or unexpected working changes into a bot-like commit.
  if(git(repo.cwd,['diff','--cached','--quiet'],{allowFailure:true}).code!==0)
   throw Error('Unexpected staged changes; inspect before continuing: '+repo.cwd);
  const changed=git(repo.cwd,['diff','--name-only','-z','HEAD']).stdout.split('\0').filter(Boolean);
  if(changed.some(name=>!isData(name,repo.paths)))throw Error('Unexpected non-data changes; inspect before continuing: '+repo.cwd);
  git(repo.cwd,['add','--',...repo.paths]);
  const diff=git(repo.cwd,['diff','--cached','--quiet'],{allowFailure:true});
  if(diff.code===0){log('No data changes to commit in '+repo.cwd);return false;}
  if(diff.code!==1)throw Error('Could not inspect staged data in '+repo.cwd);
  run('git',['commit','-m',message],{cwd:repo.cwd,env});
  // A concurrent remote commit causes a normal safe rejection, never a force push.
  run('git',['push','origin',`HEAD:${repo.branch}`],{cwd:repo.cwd,env});
  return true;
 }

 await fs.mkdir(path.join(root,'cache'),{recursive:true});
 const lockFile=path.join(root,'cache/local-update.lock');
 let lock;
 try{lock=await fs.open(lockFile,'wx',0o600);}catch(error){if(error.code==='EEXIST')throw Error('A local update is already running, or cache/local-update.lock is stale.');throw error;}
 try{
  await lock.writeFile(JSON.stringify({pid:process.pid,startedAt:new Date().toISOString()})+'\n');
  try{await fs.access(path.join(root,'cache/indexer.lock'));throw Error('An indexer is already running; wait for it to finish.');}catch(error){if(error.code!=='ENOENT')throw error;}
  const indexer=repository(root,data.indexer),site=repository(siteDir,data.site);
  git(root,['ls-files','--error-unmatch','cache/manifest.json']);
  const before=await fs.readFile(path.join(root,'package-lock.json'),'utf8');
  // Check both repositories before changing either branch's working files.
  fetch(indexer);fetch(site);ensureNoLocalCommits(indexer);ensureNoLocalCommits(site);
  fastForward(indexer);fastForward(site);
  const pkg=JSON.parse(await fs.readFile(path.join(root,'package.json'),'utf8'));
  let install=before!==await fs.readFile(path.join(root,'package-lock.json'),'utf8');
  for(const name of Object.keys({...pkg.dependencies,...pkg.devDependencies})){
   try{await fs.access(path.join(root,'node_modules',name,'package.json'));}catch(error){if(error.code!=='ENOENT')throw error;install=true;}
  }
  if(install){log('Installing dependencies from the updated lockfile');npm(['ci']);}
  log('Running tests');npm(['test']);
  log(rebuild?'Rebuilding all discovered issues':'Indexing new issues and retrying failed refreshes');
  const args=['run','index:archive','--'];
  if(browserChannel)args.push('--browser-channel',browserChannel);
  if(parser!=='swift')args.push('--parser',parser);
  if(python)args.push('--python',python);
  if(rebuild)args.push('--rebuild');
  const indexed=run('npm',args,{cwd:root,env,allowFailure:true});
  log('Verifying generated indexes');npm(['run','verify:indexes']);
  save(indexer,'Update newspaper issue cache [skip ci]');
  if(indexed.code!==0)throw Error('Indexing was incomplete. Verified cache progress has been saved; the public website was not changed. Run this command again to retry failed issues.');
  // The indexing stage can take time. Refresh the still-clean public checkout
  // again immediately before copying, reducing conflicts with automated updates.
  clean(siteDir,data.site);fetch(site);ensureNoLocalCommits(site);fastForward(site);
  log('Copying generated indexes to the public repository');npm(['run','publish:site']);
  const published=save(site,'Update newspaper search indexes');
  log(published?'Public indexes pushed. GitHub Pages deployment runs separately in the public repository.':'Public indexes are unchanged; no deployment was triggered.');
  return {published};
 }finally{
  await lock.close();await fs.unlink(lockFile);
 }
}

export function parseOptions(args){
 const options={};
 for(let i=0;i<args.length;i++){
  const arg=args[i];
  if(arg==='--help'){options.help=true;continue;}
  if(arg==='--rebuild'){options.rebuild=true;continue;}
  const key={'--site-dir':'siteDir','--browser-channel':'browserChannel','--parser':'parser','--python':'python'}[arg];
  if(!key||args[i+1]===undefined||args[i+1].startsWith('--'))throw Error('Unknown or incomplete option: '+arg);
  options[key]=args[++i];
 }
 if(options.parser&&!['swift','python'].includes(options.parser))throw Error('--parser must be swift or python');
 return options;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{
  const options=parseOptions(process.argv.slice(2));
  if(options.help)console.log('Usage: npm run update:local -- [--rebuild] [--site-dir PATH] [--browser-channel chrome] [--parser swift|python] [--python PATH]\nUpdates both default branches, indexes and verifies PDFs, commits cache and pushes public indexes. Uses installed Chrome by default; pass --browser-channel "" to use Playwright Chromium. Requires existing Git push credentials and clean tracked working files. Swift (default) requires macOS; --parser python requires requirements-python.txt.');
  else{
   if((options.parser||'swift')==='swift'&&process.platform!=='darwin')throw Error('Swift indexing requires macOS. Use --parser python with requirements-python.txt installed for Linux.');
   await updateLocal(options);
  }
 }catch(error){console.error('\nLocal update stopped: '+error.message);process.exitCode=1;}
}
