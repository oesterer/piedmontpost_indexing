import {siteURL} from './site-path.mjs';
// Node adapter for testing the browser worker's real message protocol.
import {parentPort}from'node:worker_threads';import fs from'node:fs/promises';
globalThis.onmessage=null;globalThis.postMessage=value=>parentPort.postMessage(value);
const nativeFetch=globalThis.fetch;
globalThis.fetch=async(input,options={})=>{
 const url=new URL(input);
 if(url.protocol!=='file:')return nativeFetch(input,options);
 if(options.signal?.aborted)throw new DOMException('Stopped','AbortError');
 parentPort.postMessage({type:'test-load',url:url.href});
 try{return new Response(await fs.readFile(url),{status:200});}catch{return new Response('',{status:404});}
};
await import(new URL('search-worker.js',siteURL));
parentPort.on('message',data=>globalThis.onmessage({data}));
