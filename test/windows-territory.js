'use strict';

const assert = require('assert');
const { selectRivals, createWindowsTerritory } = require('../backend/territory-windows');
const { cliInvocation } = require('../backend/cli-invocation');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const pet = { hwnd: '1234', pid: 78, name: 'ChatGPT', title: 'ChatGPT', className: 'Chrome_WidgetWin_1',
  x: 200, y: 0, w: 816, h: 1080, style: 0x14000000, exStyle: 0x2800a8, dpi: 96,
  mascot: { x: 500, y: 400, w: 112, h: 121 } };
const main = { ...pet, hwnd: '1235', style: 0x14cf0000, mascot: null, w: 1920 };

async function run() {
  assert.strictEqual(selectRivals([pet, main]).length, 1, 'modern large overlay requires an accessible pet image');
  assert.strictEqual(selectRivals([{ ...pet, mascot: null }]).length, 0, 'transparent ChatGPT window is not enough');
  assert.strictEqual(selectRivals([{ ...pet, mascot: { ...pet.mascot, x: -5000 } }]).length, 0);
  assert.strictEqual(selectRivals([pet], [], [78]).length, 0);
  assert.strictEqual(selectRivals([{ ...pet, title: 'Codex Pet', mascot: null, w: 243, h: 253 }]).length, 1);
  assert.strictEqual(selectRivals([{ ...pet, title: 'Login', mascot: null, w: 243, h: 253 }]).length, 0);
  assert.strictEqual(selectRivals([main], ['ChatGPT']).length, 0, 'custom rival patterns cannot bypass host protection');
  const scaled = selectRivals([pet], [], [], (r) => ({ x:r.x/2-1000, y:r.y/2, width:r.width/2, height:r.height/2 }))[0];
  assert.deepStrictEqual(scaled.visual, { x:-750,y:200,w:56,h:60.5 });

  function fixture(options = {}) {
    let target = structuredClone(options.target || pet);
    const events = [], commands = [];
    let abort = false, edgeReads = 0, enabled = true, moveCount = 0, closeCount = 0;
    let bounds = options.bounds || { x: 150, y: 300, width: 120, height: 120 };
    const area = options.area || { x:0,y:0,width:1000,height:700 };
    const backend = createWindowsTerritory({
      isEnabled: () => enabled, rivalNames: () => [], excludePids: () => [], canScan: () => true,
      shouldAbort: () => abort, shouldAbortLoot: () => abort,
      getPetBounds: () => ({ ...bounds }),
      tweenPetTo: async (x, y) => { bounds.x=x; bounds.y=y; },
      getWorkArea: () => area, assertTop: () => {}, relaxTop: () => {},
      screenToDipRect: options.toDip, dipToScreenPoint: options.toScreen,
      emit: (event) => { events.push(event); if (options.cancelOn === event.phase) abort=true; },
      sleep: () => new Promise((resolve) => setImmediate(resolve)),
      desktop: {
        stop() {},
        async request(command, args) {
          commands.push(command);
          if (options.failScan && command === 'scan') return { ok:false,error:'denied' };
          if (command === 'scan') {
            if(options.cancelOnScan)backend.cancelPatrol();
            return { ok:true,data:[...(options.parkedRival ? [options.parkedRival] : []),...(target ? [target] : []),main] };
          }
          if (command === 'idle') return { ok:true,data:options.idleSeconds ?? 10 };
          if (command === 'read') {
            if (target && target.mascot.x + target.mascot.w >= 997) {
              edgeReads++;
              if (edgeReads === 3 && options.bounceBeforeClose) { target.x-=100; target.mascot.x-=100; }
              if (edgeReads === 3 && options.abortBeforeClose) abort=true;
            }
            return { ok:true,data:target && (options.reused ? { ...main, hwnd:target.hwnd } : structuredClone(target)) };
          }
          if (command === 'move') {
            moveCount++;
            if (options.disableAfterMove) { enabled=false; void backend.tick(); }
            if (options.cancelAfterMove) backend.cancelPatrol();
            assert.strictEqual(args.target.hwnd,pet.hwnd, 'never move main window');
            if (!options.resist) {
              const dx=args.x-target.x, dy=args.y-target.y;
              target.x=args.x; target.y=args.y;
              target.mascot.x+=dx; target.mascot.y+=dy;
            }
            return { ok:true,data:structuredClone(target) };
          }
          if (command === 'close') {
            closeCount++;
            assert(target.mascot.x+target.mascot.w >= 997, 'close only after visual mascot reaches edge');
            assert.strictEqual(args.target.hwnd,pet.hwnd);
            if (!options.refuseClose) target=null;
            return { ok:!options.refuseClose };
          }
          throw Error(command);
        },
      },
    });
    return { backend, events, commands, get target(){return target;}, get moveCount(){return moveCount;}, get closeCount(){return closeCount;} };
  }
  const patrol = fixture();
  assert.strictEqual(await patrol.backend.runNow(), 'victory');
  assert(Math.abs(patrol.target.mascot.x+pet.mascot.w-1000)<=3);
  assert.strictEqual(patrol.closeCount,0,'patrol moves; loot closes');
  assert(patrol.events.some(e=>e.phase==='victory'));

  const loot = fixture();
  const sessions=[{id:'one'}, {id:'one'}, {id:'two'}, {id:'three'}];
  assert.strictEqual(await loot.backend.runLoot(sessions),'closed');
  assert.strictEqual(loot.closeCount,1);
  assert.deepStrictEqual(loot.events.filter(e=>e.phase==='sessionCaptured').map(e=>e.session.sessionId),['one','two','three']);
  assert(loot.events.findIndex(e=>e.phase==='targetClosed')<loot.events.findIndex(e=>e.phase==='closed'));
  const resisted = fixture({resist:true});
  assert.strictEqual(await resisted.backend.runLoot([]),'defeat');
  assert.strictEqual(resisted.closeCount,0,'never close a pet that refused to move');
  const reused=fixture({reused:true});
  assert.strictEqual(await reused.backend.runNow(),'blocked');
  assert.strictEqual(reused.moveCount,0);
  const cancelled=fixture({cancelOn:'march'});
  assert.strictEqual(await cancelled.backend.runNow(),'abort');
  assert.strictEqual(cancelled.moveCount,0);
  const captureCancelled=fixture({cancelOn:'sessionCaptured'});
  assert.strictEqual(await captureCancelled.backend.runLoot(sessions),'abort');
  assert.strictEqual(captureCancelled.events.filter(e=>e.phase==='sessionCaptured').length,1);
  assert.strictEqual(captureCancelled.moveCount,0,'cancelling capture must not start the kick');
  const failure=fixture({failScan:true});
  assert.strictEqual(await failure.backend.runNow(),'scan-error');
  assert(!failure.events.some(e=>e.phase==='clear'));
  const closed=fixture({refuseClose:true});
  assert.strictEqual(await closed.backend.runLoot([]),'close-failed');
  assert(!closed.events.some(e=>e.phase==='closed'));
  const duplicate=fixture();
  const running=duplicate.backend.runNow();
  assert.strictEqual(duplicate.backend.runNow(),running,'duplicate clicks share the same operation');
  assert.strictEqual(await duplicate.backend.runLoot([]),'busy');
  await running;
  const stopped=fixture(); stopped.backend.stop();
  assert.strictEqual(await stopped.backend.runNow(),'blocked');
  assert.deepStrictEqual(stopped.commands,[]);

  const bounced=fixture({bounceBeforeClose:true});
  assert.strictEqual(await bounced.backend.runLoot([]),'close-failed');
  assert.strictEqual(bounced.closeCount,0,'a pet that moved away from the edge must not be closed');
  const lastSecondCancel=fixture({abortBeforeClose:true});
  assert.strictEqual(await lastSecondCancel.backend.runLoot([]),'abort');
  assert.strictEqual(lastSecondCancel.closeCount,0,'cancellation during final read must prevent WM_CLOSE');
  const disabled=fixture({disableAfterMove:true});
  assert.strictEqual(await disabled.backend.tick(),'abort');
  assert.strictEqual(disabled.moveCount,1,'turning auto patrol off must stop the current episode');

  // The transparent outer window spans onto a 100% monitor, while the actual
  // mascot remains on the primary 200% monitor. Converting the outer origin
  // through the left monitor must not change the requested physical movement.
  const mixed=fixture({
    target:{...pet,x:-200,w:2200,h:1400,mascot:{x:400,y:500,w:224,h:242}},
    area:{x:0,y:0,width:1000,height:700},
    toDip:r=>({x:r.x/2,y:r.y/2,width:r.width/2,height:r.height/2}),
    toScreen:p=>p.x<0?{x:p.x,y:p.y}:{x:p.x*2,y:p.y*2},
  });
  assert.strictEqual(await mixed.backend.runNow(),'victory');
  assert.strictEqual(mixed.target.mascot.y,500,'mixed DPI horizontal pushes must not drift vertically');
  assert(Math.abs(mixed.target.mascot.x+mixed.target.mascot.w-2000)<=6);

  const manualCancel=fixture({cancelAfterMove:true});
  assert.strictEqual(await manualCancel.backend.runNow(),'abort');
  assert.strictEqual(manualCancel.moveCount,1);
  const scanCancelled=fixture({cancelOnScan:true});
  assert.strictEqual(await scanCancelled.backend.runNow(),'abort');
  assert(!scanCancelled.events.some(e=>e.phase==='spotted'));
  assert.strictEqual(scanCancelled.backend.dominating,false,'cancelled scans must not raise the pet again');
  const userActive=fixture({idleSeconds:0});
  assert.strictEqual(await userActive.backend.tick(),'blocked');
  assert(!userActive.commands.includes('scan'));
  assert.strictEqual(await userActive.backend.runNow(),'victory','a manual click authorizes a patrol despite input activity');
  const atEdgeFirst=fixture({parkedRival:{...pet,hwnd:'9999',pid:99,x:588,mascot:{...pet.mascot,x:888}}});
  assert.strictEqual(await atEdgeFirst.backend.runNow(),'victory','a parked rival must not hide a second movable pet');
  const movesBefore=atEdgeFirst.moveCount;
  assert.strictEqual(await atEdgeFirst.backend.runNow(),'present');
  assert.strictEqual(atEdgeFirst.moveCount,movesBefore);
  assert.strictEqual(atEdgeFirst.events.at(-1).phase,'ontop','already-parked pets still produce a terminal UI response');

  let geometryCases=0;
  for(const scale of [1,1.25,1.5,2]) for(const origin of [0,-1920]) for(const direction of [-1,1]) {
    const visualX=origin+400;
    const item=fixture({
      target:{...pet,x:(visualX-100)*scale,y:0,w:816*scale,h:1080*scale,
        mascot:{x:visualX*scale,y:400*scale,w:112*scale,h:121*scale}},
      area:{x:origin,y:0,width:1000,height:700},
      bounds:{x:origin+(direction>0?20:850),y:300,width:120,height:120},
      toDip:r=>({x:r.x/scale,y:r.y/scale,width:r.width/scale,height:r.height/scale}),
      toScreen:p=>({x:Math.round(p.x*scale),y:Math.round(p.y*scale)}),
    });
    assert.strictEqual(await item.backend.runNow(),'victory',`scale=${scale} origin=${origin} dir=${direction}`);
    const actual=direction>0 ? item.target.mascot.x+item.target.mascot.w : item.target.mascot.x;
    const expected=(origin+(direction>0?1000:0))*scale;
    assert(Math.abs(actual-expected)<=3*scale,'visible body must reach the correct display edge');
    assert.strictEqual(item.target.mascot.y,400*scale);
    geometryCases++;
  }
  console.log(`${geometryCases} direction / DPI / negative-origin combinations passed`);

  const invocation=cliInvocation('D:\\CLI With Space\\claude.cmd',['--print','--resume','123-456'],'win32');
  assert(invocation.options.windowsVerbatimArguments);
  assert(invocation.args.at(-1).startsWith('""D:\\CLI With Space\\claude.cmd" '));
  for (const unsafe of ['hello world','&calc','%PATH%','a\nb','"']) {
    assert.throws(()=>cliInvocation('D:\\cli.cmd',[unsafe],'win32'));
  }
  if (process.platform === 'win32') {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'llmpet shim 中文 '));
    try {
      fs.writeFileSync(path.join(root,'capture.js'), 'let text="";process.stdin.setEncoding("utf8");process.stdin.on("data",s=>text+=s);process.stdin.on("end",()=>console.log(JSON.stringify({text,args:process.argv.slice(2),custom:process.env.LLMPET_SHIM_TEST})));');
      const shim=path.join(root,'claude.cmd');
      fs.writeFileSync(shim,`@echo off\r\nset "LLMPET_SHIM_TEST=preserved"\r\n"${process.execPath}" "%~dp0capture.js" %*\r\n`);
      const prompt=('中文表情包 " & | < > %PATH% ! ^ `\nsecond line\n').repeat(260);
      const command=cliInvocation(shim,['--print','--resume','123-456'],'win32');
      const output=spawnSync(command.file,command.args,{ ...command.options,windowsHide:true,encoding:'utf8',input:prompt,
        env:{...process.env,ELECTRON_RUN_AS_NODE:'1'} });
      assert.strictEqual(output.status,0,output.stderr);
      const captured=JSON.parse(output.stdout);
      assert.strictEqual(captured.text,prompt,'long Unicode and shell syntax must arrive literally through stdin');
      assert.strictEqual(captured.custom,'preserved','custom launcher config must be retained');
      assert.deepStrictEqual(captured.args,['--print','--resume','123-456']);
    } finally { fs.rmSync(root,{recursive:true,force:true}); }
  }
  console.log('Windows territory, target identity, DPI, cancellation and CLI invocation tests passed');
}
run().catch((error)=>{console.error(error);process.exitCode=1;});
