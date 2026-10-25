'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');
const { PassThrough, Writable } = require('stream');
const { createWindowsDesktop } = require('../backend/windows-desktop');

function processFixture(onRequest) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new Writable({ write(chunk, _encoding, done) {
    onRequest(JSON.parse(chunk), child);
    done();
  } });
  child.kill = () => {
    child.killed = true;
    child.stdout.end(); child.stderr.end();
    setImmediate(() => child.emit('exit', 1));
  };
  return child;
}
const reply = (child, request, data) => child.stdout.write(JSON.stringify({id:request.id,ok:true,data})+'\n');

async function run() {
  let spawns = 0;
  const queue = [];
  const bridge = createWindowsDesktop({ spawn: (_file, _args, options) => {
    spawns++;
    assert(options.windowsHide);
    return processFixture((request,child) => queue.push({request,child}));
  } });
  const pending = Array.from({length:100},(_,index)=>bridge.request('read',{hwnd:String(index)}));
  assert.strictEqual(spawns,1,'requests share one helper');
  for(const {request,child} of queue.reverse()) reply(child,request,request.hwnd);
  assert.deepStrictEqual((await Promise.all(pending)).map(r=>r.data),Array.from({length:100},(_,i)=>String(i)));
  bridge.stop();

  let attempts=0;
  const recovery=createWindowsDesktop({timeoutMs:30,spawn:()=>{
    attempts++;
    return processFixture((request,child)=>{if(attempts>1)reply(child,request,'recovered');});
  }});
  assert.strictEqual((await recovery.request('idle')).error,'helper-timeout');
  assert.strictEqual((await recovery.request('idle')).data,'recovered');
  recovery.stop();

  const crash=createWindowsDesktop({spawn:()=>processFixture((_request,child)=>{
    child.stderr.write('fixture crashed');
    setImmediate(()=>child.emit('exit',1));
  })});
  const crashed=await crash.request('scan');
  assert.strictEqual(crashed.ok,false);
  assert(crashed.error.includes('fixture crashed'));

  const stopped=createWindowsDesktop({spawn:()=>processFixture(()=>{})});
  const stopping=stopped.request('scan'); stopped.stop();
  assert.strictEqual((await stopping).error,'helper-stopped');

  const broken=createWindowsDesktop({spawn:()=>{
    const child=processFixture(()=>{});
    child.stdin.write=()=>{throw Error('broken input pipe');};
    return child;
  }});
  const failed=await broken.request('scan');
  assert.strictEqual(failed.ok,false);
  assert(failed.error.includes('broken input pipe'));
  broken.stop();
  console.log('Windows helper concurrency, timeout, crash and restart checks passed');
}
run().catch(error=>{console.error(error);process.exitCode=1;});
