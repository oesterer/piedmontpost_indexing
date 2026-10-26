import {siteURL} from './site-path.mjs';
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import {parseHTML}from'linkedom';
test('search UI streams results, resumes, ignores obsolete messages, and preserves results on retry',async t=>{
 const {window,document}=parseHTML(await fs.readFile(new URL('index.html',siteURL),'utf8'));
 Object.defineProperty(document,'baseURI',{value:'http://localhost/'});
 // Linkedom's select value is read-only; emulate the browser's read/write value.
 for(const select of document.querySelectorAll('select')){let value='';Object.defineProperty(select,'value',{get:()=>value,set:v=>{value=String(v);}});}
 const manifest={version:1,indexes:[{id:'latest'}],issues:[{id:'a',date:'2026-10-14',file:'https://example.org/a.pdf',pages:28}],issueCount:1,pageCount:28,batchSize:20};
 let stub;class WorkerStub{constructor(){stub=this;this.messages=[];}postMessage(m){this.messages.push(m);if(m.type==='init')queueMicrotask(()=>this.send({type:'ready'}));}send(data){this.onmessage({data});}terminate(){}}
 const saved={};for(const [key,value]of Object.entries({document,location:{search:''},history:{replaceState(){}},Worker:WorkerStub,fetch:async()=>({ok:true,json:async()=>manifest})})){saved[key]=globalThis[key];globalThis[key]=value;}
 t.after(()=>{for(const [key,value]of Object.entries(saved))if(value===undefined)delete globalThis[key];else globalThis[key]=value;});
 await import(new URL('app.js',siteURL));await new Promise(resolve=>setImmediate(resolve));
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
