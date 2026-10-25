'use strict';

// Real Win32 regression. Only windows created by this test are moved/closed.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, BrowserWindow, screen } = require('electron');
const { createWindowsDesktop } = require('../backend/windows-desktop');
const { createWindowsTerritory } = require('../backend/territory-windows');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'llmpet-windows-'));
app.setPath('userData', path.join(root, 'electron'));
app.setPath('sessionData', path.join(root, 'electron'));
const bridge = createWindowsDesktop();
let territory;
let resultCode = 1;
const wait = ms => new Promise(resolve => setTimeout(resolve,ms));
app.on('window-all-closed',()=>{});

app.whenReady().then(async()=>{
  if (process.platform!=='win32') { resultCode=0; return; }
  const wa=screen.getPrimaryDisplay().workArea;
  const main=new BrowserWindow({width:800,height:700,show:false});
  await main.loadURL('data:text/html,<title>LLMPET test main</title><h1>Test main stays open</h1>');
  main.showInactive();
  const pet=new BrowserWindow({width:160,height:150,x:wa.x+Math.floor(wa.width/2),y:wa.y+200,
    frame:false,transparent:true,skipTaskbar:true,show:false,thickFrame:false});
  await pet.loadURL('data:text/html,<title>LLMPET test pet</title><div style="background:royalblue;width:100px;height:100px">Test pet</div>');
  pet.showInactive();
  await wait(200);
  const handle=pet.getNativeWindowHandle().readBigUInt64LE().toString();
  const snapshot=await bridge.request('read',{hwnd:handle});
  assert(snapshot.ok && snapshot.data);
  const target=snapshot.data;
  const rejected=await bridge.request('move',{target:{...target,pid:target.pid+1},x:target.x+40,y:target.y});
  assert(!rejected.ok,'mismatched PID must be rejected');
  const mainBefore=main.getBounds();
  const events=[];
  let bounds={x:wa.x+20,y:wa.y+200,width:120,height:120};
  territory=createWindowsTerritory({
    desktop: {
      stop:()=>bridge.stop(),
      async request(command,args){
        const result=await bridge.request(command,args);
        if(command==='scan' && result.ok)result.data=result.data.filter(w=>w.hwnd===handle);
        return result;
      },
    },
    isEnabled:()=>true,rivalNames:()=>[target.name],excludePids:()=>[],canScan:()=>true,shouldAbort:()=>false,
    getPetBounds:()=>({...bounds}),tweenPetTo:async(x,y)=>{bounds={...bounds,x,y};},
    getWorkArea:()=>wa,assertTop:()=>{},relaxTop:()=>{},emit:e=>events.push(e),
    screenToDipRect:r=>screen.screenToDipRect(null,r),dipToScreenPoint:p=>screen.dipToScreenPoint(p),
  });
  assert.strictEqual(await territory.runNow(),'victory');
  const landed=await bridge.request('read',{hwnd:handle});
  const dip=screen.screenToDipRect(null,{x:landed.data.x,y:landed.data.y,width:landed.data.w,height:landed.data.h});
  assert(Math.abs(dip.x+dip.width-wa.x-wa.width)<=4,'real pet window must reach work-area edge');
  assert.deepStrictEqual(main.getBounds(),mainBefore,'same-process main window must remain unchanged');
  assert((await bridge.request('close',{target:landed.data})).ok);
  for(let i=0;i<30&&!pet.isDestroyed();i++)await wait(100);
  assert(pet.isDestroyed(),'WM_CLOSE closes only the selected test window');
  assert(!main.isDestroyed(),'closing a pet does not terminate its host process');
  assert(events.some(e=>e.phase==='victory'));
  console.log('Real Windows scan/move/readback/close, DPI conversion and same-process main-window isolation passed');
  resultCode=0;
}).catch(error=>console.error(error)).finally(()=>{
  if(territory)territory.stop(); else bridge.stop();
  for(const win of BrowserWindow.getAllWindows())win.destroy();
  app.exit(resultCode);
});
