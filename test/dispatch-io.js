'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { waitForTranscriptPrompt } = require('../backend/command-dispatch');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'llmpet-dispatch-io-'));
  try {
    const prompt = '中文表情包🐳\n检查完成了吗？';
    const line = Buffer.from(JSON.stringify({type:'event_msg',payload:{type:'user_message',message:prompt}})+'\n');
    const log = path.join(root, 'rollout.jsonl');
    for (const symbol of ['中','🐳']) for(let byte=1;byte<Buffer.byteLength(symbol);byte++) {
      fs.writeFileSync(log, '');
      const verification = waitForTranscriptPrompt(log,prompt,0,{pollMs:5,timeoutMs:1200});
      const cut = line.indexOf(Buffer.from(symbol)) + byte;
      fs.appendFileSync(log,line.subarray(0,cut));
      await wait(40);
      fs.appendFileSync(log,line.subarray(cut));
      assert.strictEqual(await verification,true,`partial UTF-8 ${symbol} byte ${byte}`);
    }

    const delayed=path.join(root,'delayed.jsonl');
    const appeared=waitForTranscriptPrompt(delayed,prompt,0,{pollMs:5,timeoutMs:1200});
    await wait(30);
    fs.writeFileSync(delayed,line);
    assert.strictEqual(await appeared,true,'a delayed transcript must be observed until the deadline');
    assert.strictEqual(await waitForTranscriptPrompt(log,'wrong prompt',0,{pollMs:5,timeoutMs:30}),false);
    assert.strictEqual(await waitForTranscriptPrompt(log,prompt,fs.statSync(log).size,{pollMs:5,timeoutMs:30}),false,
      'an identical old prompt is not proof of new delivery');
    fs.writeFileSync(log,'old'.repeat(3000));
    const truncated=waitForTranscriptPrompt(log,prompt,fs.statSync(log).size,{pollMs:5,timeoutMs:1200});
    await wait(30);
    fs.writeFileSync(log,line);
    assert.strictEqual(await truncated,true,'a truncated log resets the byte offset and decoder');
    fs.writeFileSync(log,Buffer.concat([Buffer.from('noise\n'.repeat(100000)),line]));
    assert.strictEqual(await waitForTranscriptPrompt(log,prompt,0,{pollMs:5,timeoutMs:1200}),true,
      'bounded reads still reach a prompt following a large append');
    fs.writeFileSync(log,line.subarray(0,line.length-1));
    assert.strictEqual(await waitForTranscriptPrompt(log,prompt,0,{pollMs:5,timeoutMs:50}),true,
      'a complete final JSON record without newline can be confirmed');
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
  console.log('Transcript I/O edge cases passed');
}
run().catch(error=>{console.error(error);process.exitCode=1;});
