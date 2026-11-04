import {siteURL} from './site-path.mjs';
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import {parseHTML}from'linkedom';
let importId=0;
async function browserFixture(t,{embedded=false}={}){
 const {window,document}=parseHTML(await fs.readFile(new URL('index.html',siteURL),'utf8'));
 Object.defineProperty(document,'baseURI',{value:'http://localhost/'});
 // Linkedom's select value is read-only; emulate the browser's read/write value.
 for(const select of document.querySelectorAll('select')){let value='';Object.defineProperty(select,'value',{get:()=>value,set:v=>{value=String(v);}});}
 const manifest={version:1,indexes:[{id:'latest'}],issues:[{id:'a',date:'2026-10-14',file:'https://example.org/a.pdf',pages:28}],issueCount:1,pageCount:28,batchSize:20};
 let stub;class WorkerStub{constructor(){stub=this;this.messages=[];}postMessage(m){this.messages.push(m);if(m.type==='init')queueMicrotask(()=>this.send({type:'ready'}));}send(data){this.onmessage({data});}terminate(){}}
 const topMessages=[],parent={postMessage:(data,origin)=>topMessages.push({data,origin})};
 const saved={},timers=[];
 const nativeSetInterval=globalThis.setInterval,nativeSetTimeout=globalThis.setTimeout;
 // Linkedom's window forwards global properties. Supply both window and top,
 // and restore both: top===window is standalone, otherwise this is an iframe.
 const globals={window,top:embedded?parent:window,document,location:{search:''},history:{replaceState(){}},Worker:WorkerStub,fetch:async()=>({ok:true,json:async()=>manifest})};
 if(embedded){
  // Real, tracked timers exercise bridge initialization without leaking its
  // 20-second handshake timeout into this test or keeping the runner alive.
  globals.setInterval=(...args)=>{const timer=nativeSetInterval(...args);timer.unref();timers.push(timer);return timer;};
  globals.setTimeout=(...args)=>{const timer=nativeSetTimeout(...args);timer.unref();timers.push(timer);return timer;};
 }
 for(const [key,value]of Object.entries(globals)){saved[key]=Object.getOwnPropertyDescriptor(globalThis,key);globalThis[key]=value;}
 t.after(()=>{
  for(const timer of timers)clearTimeout(timer);
  for(const [key,descriptor]of Object.entries(saved))if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];
 });
 // Each fixture must execute app initialization, rather than reuse ESM state.
 const appURL=new URL('app.js',siteURL);appURL.searchParams.set('ui-test',String(++importId));
 await import(appURL);await new Promise(resolve=>setImmediate(resolve));
 return {window,document,stub,parent,topMessages};
}

test('search UI streams results, resumes, ignores obsolete messages, and preserves results on retry',async t=>{
 const {window,document,stub,topMessages}=await browserFixture(t);
 assert.equal(topMessages.length,0);
 assert.equal(document.querySelector('#submit').disabled,false);assert.equal(document.querySelectorAll('.issue-card').length,1);
 const submit=()=>document.querySelector('#search-form').dispatchEvent(new window.Event('submit',{cancelable:true}));
 document.querySelector('#query').value='City Council';submit();const first=stub.messages.at(-1);assert.equal(first.type,'search');
 const record={date:'2026-10-14',page:3,sourceUrl:'https://example.org/a.pdf',title:'City Council meeting',titleSource:'detected',terms:['city','council'],excerpt:'City Council considered the project.'};
 stub.send({type:'results',id:first.id,results:[record]});assert.equal(document.querySelectorAll('.result').length,1);
 assert(document.querySelector('.result h3 a').getAttribute('href').endsWith('?page=3#page=3'));assert.equal(document.querySelector('.result h3 a').target,'_blank');
 stub.send({type:'batch',id:first.id,complete:false});assert.equal(document.querySelector('#more').hidden,false);document.querySelector('#more').click();assert.equal(stub.messages.at(-1).type,'more');
 stub.send({type:'error',id:first.id,message:'Download failed'});assert.equal(document.querySelectorAll('.result').length,1);assert.equal(document.querySelector('#more').textContent,'Retry and continue');
 document.querySelector('#more').click();stub.send({type:'batch',id:first.id,complete:true});assert.equal(document.querySelector('#more').hidden,true);
 document.querySelector('#query').value='Bonnie';submit();const second=stub.messages.at(-1);assert(second.id>first.id);
 stub.send({type:'results',id:first.id,results:[record]});assert.equal(document.querySelectorAll('.result').length,0);
 document.querySelector('#stop').click();assert.equal(stub.messages.at(-1).type,'stop');stub.send({type:'stopped',id:second.id});assert.equal(document.querySelector('#more').textContent,'Continue search');
});

test('embedded UI opens PDFs through Wix only after its parent acknowledges the bridge',async t=>{
 const {window,document,parent,topMessages}=await browserFixture(t,{embedded:true});
 assert.equal(document.querySelector('#submit').disabled,false);
 assert.deepEqual(topMessages[0].data,{source:'piedmontpost-archive',action:'hello',version:1});
 const link=document.querySelector('.issue-card');assert(link);
 function click(properties={}){
  const event=new window.Event('click',{cancelable:true,bubbles:true});
  Object.assign(event,{button:0,...properties});link.dispatchEvent(event);return event;
 }
 function ready(source=parent,version=1){
  const event=new window.Event('message');Object.assign(event,{source,data:{source:'piedmontpost-wix',action:'ready',version}});window.dispatchEvent(event);
 }
 assert.equal(click().defaultPrevented,false); // No parent acknowledgment yet.
 ready({},1);assert.equal(click().defaultPrevented,false); // Wrong sender.
 ready(parent,2);assert.equal(click().defaultPrevented,false); // Wrong protocol.
 ready();
 assert.equal(click().defaultPrevented,true);
 assert.deepEqual(topMessages.at(-1).data,{source:'piedmontpost-archive',action:'open-pdf',version:1,url:link.href});
 const sent=topMessages.length;
 assert.equal(click({ctrlKey:true}).defaultPrevented,false);assert.equal(topMessages.length,sent);
});
