'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const vm = require('vm');
const { loadRenderer } = require('./dom-stub');
const { sanitize } = require('../backend/config');
const i18n = require('../shared/i18n');
const root = path.join(__dirname, '..');
const assetDir = path.join(root, 'assets', 'deepseek-maid');
const manifest = JSON.parse(fs.readFileSync(path.join(assetDir, 'manifest.json')));

// Decode the actual LZW pixel indices. A transparency flag alone is not enough:
// a white/checkerboard image may carry an unused transparent palette entry.
function decodeIndices(data, minimumBits, pixelCount) {
  assert(minimumBits >= 2 && minimumBits <= 8);
  const clear = 1 << minimumBits, end = clear + 1;
  let bits, next, table, previous, bit = 0, count = 0, ended = false;
  const result = new Uint8Array(pixelCount);
  const reset = () => {
    table = Array.from({length: clear}, (_, i) => [i]);
    bits = minimumBits + 1; next = end + 1; previous = null;
  };
  reset();
  while (bit + bits <= data.length * 8) {
    let code = 0;
    for (let i = 0; i < bits; i++, bit++) code |= ((data[bit >> 3] >> (bit & 7)) & 1) << i;
    if (code === clear) { reset(); continue; }
    if (code === end) { ended = true; break; }
    const entry = code < next ? table[code] : (code === next && previous ? [...previous, previous[0]] : null);
    assert(entry && entry.length, 'invalid GIF LZW code');
    assert(count + entry.length <= pixelCount, 'GIF frame expands beyond its declared canvas');
    result.set(entry, count); count += entry.length;
    if (previous && next < 4096) {
      table[next++] = [...previous, entry[0]];
      if (next === (1 << bits) && bits < 12) bits++;
    }
    previous = entry;
  }
  assert(ended && count === pixelCount, 'incomplete GIF frame');
  return result;
}

// Parse GIF blocks, not compressed-byte pattern matches: a pixel stream may
// contain a fake image separator or control-extension byte sequence.
function gifMetadata(bytes, inspectFrame) {
  assert(/^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('ascii')));
  const size = [bytes.readUInt16LE(6), bytes.readUInt16LE(8)];
  let p = 13 + ((bytes[10] & 0x80) ? 3 * (1 << ((bytes[10] & 7) + 1)) : 0);
  const globalPalette = bytes.subarray(13, p);
  const delaysMs = [];
  let delay = null;
  let control = null;
  const transparentPixelCounts = [];
  const controlOffsets = [];
  let loop = null;
  const subblocks = () => {
    const blocks = [];
    while (true) {
      assert(p < bytes.length, 'truncated GIF subblock');
      const length = bytes[p++];
      if (!length) break;
      assert(p + length <= bytes.length, 'truncated GIF payload');
      blocks.push(bytes.subarray(p, p + length));
      p += length;
    }
    return blocks;
  };
  while (p < bytes.length) {
    const marker = bytes[p++];
    if (marker === 0x3b) break;
    if (marker === 0x21) {
      const kind = bytes[p++];
      const blocks = subblocks();
      if (kind === 0xf9) {
        assert.strictEqual(blocks[0].length, 4);
        delay = blocks[0].readUInt16LE(1) * 10;
        control = { transparent: !!(blocks[0][0] & 1), disposal: (blocks[0][0] >> 2) & 7, index: blocks[0][3] };
        controlOffsets.push(p - 5);
      } else if (kind === 0xff && blocks[0].toString('ascii') === 'NETSCAPE2.0') {
        assert.strictEqual(blocks[1][0], 1);
        loop = blocks[1].readUInt16LE(1);
      }
    } else if (marker === 0x2c) {
      assert(p + 9 <= bytes.length, 'truncated image descriptor');
      const left = bytes.readUInt16LE(p), top = bytes.readUInt16LE(p + 2);
      const width = bytes.readUInt16LE(p + 4), height = bytes.readUInt16LE(p + 6);
      const packed = bytes[p + 8];
      p += 9;
      if (packed & 0x80) p += 3 * (1 << ((packed & 7) + 1));
      const minimumBits = bytes[p++];
      const pixels = decodeIndices(Buffer.concat(subblocks()), minimumBits, width * height);
      assert(control && control.transparent, 'every frame needs a real transparency index');
      assert.strictEqual(control.disposal, 2, 'full-frame clear prevents animation/loop trails');
      assert.deepStrictEqual([left, top, width, height], [0, 0, ...size], 'independent full frames are required');
      if (inspectFrame) inspectFrame(pixels, control.index, width, {
        frameIndex: delaysMs.length, packed, globalPalette,
      });
      const transparentPixels = pixels.reduce((n, pixel) => n + (pixel === control.index ? 1 : 0), 0);
      assert(transparentPixels > width * height * .01, 'transparent flag must refer to actual empty pixels');
      assert(transparentPixels < width * height * .99, 'not an empty animation frame');
      transparentPixelCounts.push(transparentPixels);
      assert(delay > 0, 'every frame needs a nonzero explicit delay');
      delaysMs.push(delay);
      delay = null;
      control = null;
    } else {
      assert.fail(`unexpected GIF block 0x${marker.toString(16)}`);
    }
  }
  return { size, delaysMs, loop, frameCount: delaysMs.length, transparentPixelCounts, controlOffsets };
}

// These revisions use one global palette and a fixed transparent index, so
// decoded index equality also establishes identical visible color and alpha.
function assertMotionRepair(action, decoded) {
  const first = decoded[0];
  assert(first, 'motion repair must contain frames');
  if (action === 'thinking-2') {
    assert.strictEqual(decoded.length, 32);
    for (const [i, pixels] of decoded.entries()) {
      assert.deepStrictEqual(pixels.subarray(180 * 360), first.subarray(180 * 360),
        'bubble animation must not redraw or move the body');
      if (i < 4 || i >= 20) {
        assert(pixels.subarray(0, 180 * 360).every(p => p === 255),
          'empty holds must contain no text cloud or residual bubbles');
      } else {
        assert(pixels.subarray(0, 180 * 360).some(p => p !== 255),
          'each active bubble phase must actually be visible');
      }
    }
    assert.deepStrictEqual(decoded[31], first, 'bubble loop seam must be identical');
  } else if (action === 'sleeping-2') {
    assert.strictEqual(decoded.length, 63);
    for (const pixels of decoded) {
      for (const [left, top, right, bottom] of [[48, 280, 247, 341], [34, 157, 68, 258]]) {
        for (let y = top; y < bottom; y++) {
          assert.deepStrictEqual(pixels.subarray(y * 360 + left, y * 360 + right),
            first.subarray(y * 360 + left, y * 360 + right), 'sleeping feet and chair must stay fixed');
        }
      }
    }
    // The original action resets from the eye mask to preparation at the wrap.
    // Only the final repeated breathing sequence has a fixed upper body.
    for (const pixels of decoded.slice(42)) {
      for (let y = 0; y < 360; y++) {
        for (let x = 0; x < 360; x++) {
          // Include the 3 px feather around the localized breath polygon.
          if (x >= 121 && x <= 210 && y >= 210 && y <= 252) continue;
          assert.strictEqual(pixels[y * 360 + x], decoded[42][y * 360 + x],
            'late sleeping identity must stay fixed outside the breathing patch');
        }
      }
    }
  }
}

assert.strictEqual(manifest.id, 'deepseek-maid');
assert.strictEqual(manifest.background, 'transparent');
assert.strictEqual(manifest.animationCount, 23);
assert.strictEqual(manifest.animations.length, 23);
const actualFiles = fs.readdirSync(assetDir).filter((file) => file.endsWith('.gif')).sort();
assert.deepStrictEqual(actualFiles, manifest.animations.map((a) => a.file).sort());
let frames = 0;
let duration = 0;
for (const animation of manifest.animations) {
  const bytes = fs.readFileSync(path.join(assetDir, animation.file));
  assert.strictEqual(crypto.createHash('sha256').update(bytes).digest('hex'), animation.sha256,
    `${animation.file} must be the byte-identical selected delivery`);
  const repaired = ['sleeping-2', 'thinking-2'].includes(animation.action);
  const decoded = [];
  const meta = gifMetadata(bytes, (pixels, transparentIndex, width, details) => {
    if (animation.action === 'sweeping') {
      for (const x of [130, 145, 195, 205]) {
        assert.notStrictEqual(pixels[330 * width + x], transparentIndex,
          'the clipped white apron must remain opaque in every sweeping frame');
      }
    }
    if (repaired) {
      assert.strictEqual(details.packed & 0xc0, 0, 'repairs require a non-interlaced shared palette');
      assert.strictEqual(details.globalPalette.length, 768);
      assert.strictEqual(transparentIndex, 255);
      for (const index of new Set(pixels)) {
        if (index === transparentIndex) continue;
        const [r, g, b] = details.globalPalette.subarray(index * 3, index * 3 + 3);
        assert(!(g > r + 15 && g > b + 15 && g > 50), 'no green in repaired GIFs');
      }
      decoded.push(pixels);
    }
  });
  if (repaired) {
    assertMotionRepair(animation.action, decoded);
    const hashes = decoded.map(p => crypto.createHash('sha256').update(p).digest('hex'));
    const unique = [...new Set(hashes)];
    assert.strictEqual(unique.length, animation.uniqueFrameCount);
    assert.deepStrictEqual(hashes.map(h => unique.indexOf(h)), animation.repair.framePoseMap);
    const broken = decoded.map(p => p.slice());
    if (animation.action === 'thinking-2') {
      broken[1][300 * 360 + 150] ^= 1;
      assert.throws(() => assertMotionRepair(animation.action, broken), /must not redraw or move/);
      const residue = decoded.map(p => p.slice());
      residue[31][50 * 360 + 80] = 0;
      assert.throws(() => assertMotionRepair(animation.action, residue), /no text cloud or residual/);
    } else {
      broken[1][300 * 360 + 150] ^= 1;
      assert.throws(() => assertMotionRepair(animation.action, broken), /feet and chair must stay fixed/);
    }
  }
  assert.deepStrictEqual(meta.size, [360, 360]);
  assert.strictEqual(meta.frameCount, animation.frameCount);
  assert(meta.frameCount > 1, 'not a static replacement');
  assert.deepStrictEqual(meta.delaysMs, animation.delaysMs);
  assert.strictEqual(meta.loop, animation.loop);
  assert.strictEqual(meta.delaysMs.reduce((a, b) => a + b, 0), animation.durationMs);
  assert.deepStrictEqual(meta.transparentPixelCounts, animation.transparency.decodedTransparentPixelCounts);
  frames += meta.frameCount;
  duration += animation.durationMs;
}
assert.strictEqual(frames, 731);
assert.strictEqual(duration, 31840);
assert.strictEqual(frames, manifest.totalFrames);
assert.strictEqual(duration, manifest.totalDurationMs);
const sampleBytes = fs.readFileSync(path.join(assetDir, 'deepseek-maid-idle.gif'));
const controlOffset = gifMetadata(sampleBytes).controlOffsets[0];
const opaqueRegression = Buffer.from(sampleBytes);
opaqueRegression[controlOffset] &= ~1;
assert.throws(() => gifMetadata(opaqueRegression), /real transparency index/);
const trailRegression = Buffer.from(sampleBytes);
trailRegression[controlOffset] &= ~0x1c;
assert.throws(() => gifMetadata(trailRegression), /prevents animation\/loop trails/);
const animation = (action) => manifest.animations.find((a) => a.action === action);
assert.strictEqual(animation('sweeping').opaqueSourceSha256, '78f041ac997862bf7fc91116fff0be8c224192fdf2975c6ce34ac7cc0a356fd3');
assert.strictEqual(animation('loafing').opaqueSourceSha256, '7c074767f4de3e9aba64901170ca8d844aec185ecb61ec46a622c249a0e2aae4');
assert.strictEqual(animation('working-4').opaqueSourceSha256, '5c8be7b54607dc1189ef80e29a3113ca03a6d4ae432434517a3de34791dbac5f');

for (const role of ['skin', 'skinCodex', 'skinDsh']) {
  assert.strictEqual(sanitize({ [role]: 'deepseek-maid' })[role], 'deepseek-maid');
}
assert.strictEqual(sanitize({}).skin, 'deepseek-maid', 'new installs use the latest transparent maid pack');
for (const skin of ['mascot', 'pixel', 'cat', 'whale', 'deepseek-maid']) {
  assert.strictEqual(sanitize({ skin }).skin, skin, 'preserve an existing explicit skin choice');
}
for (const lang of ['zh', 'en', 'ja']) {
  assert(Object.hasOwn(i18n.DICT[lang], 'skin.deepseek-maid'), `${lang} needs its own label, not a fallback`);
  i18n.setLang(lang);
  assert(i18n.t('skin.deepseek-maid').includes('DeepSeek'));
}
i18n.setLang('zh');

const w = loadRenderer(['shared/i18n.js', 'shared/states.js', 'renderer/pet.js']);
assert.strictEqual(vm.runInContext('skin', w.sandbox), 'deepseek-maid', 'renderer starts with the same default as config');
vm.runInContext("applySkin('missing-skin')", w.sandbox);
assert.strictEqual(vm.runInContext('skin', w.sandbox), 'deepseek-maid', 'invalid renderer skin uses the current default');
w.handlers.config({ skin: 'deepseek-maid', muted: true });
assert(w.document.body.classList.contains('skin-deepseek-maid'));
assert(w.document.body.classList.contains('skin-cat'), 'reuse the GIF rendering path');
assert(!w.document.body.classList.contains('skin-whale'), 'keep old whale-specific effects isolated');
const pack = vm.runInContext("MEME_PACKS['deepseek-maid']", w.sandbox);
const mappedFiles = new Set([...Object.values(pack.states), ...Object.values(pack.pools).flat()]);
assert.deepStrictEqual([...mappedFiles].sort(), actualFiles, 'all 23 actions must be reachable');
const src = () => w.elements('cat-img').getAttribute('src');
for (const [state, file] of Object.entries(pack.states)) {
  vm.runInContext(`poolIdx = 0; updateCat(${JSON.stringify(state)})`, w.sandbox);
  assert.strictEqual(src(), `../assets/deepseek-maid/${file}`, `${state} selects its own new-pack asset`);
}
for (const [state, files] of Object.entries(pack.pools)) {
  files.forEach((file, index) => {
    vm.runInContext(`poolIdx = ${index}; updateCat(${JSON.stringify(state)})`, w.sandbox);
    assert.strictEqual(src(), `../assets/deepseek-maid/${file}`);
  });
}
vm.runInContext("applySkin('whale'); toggleSkin()", w.sandbox);
assert.strictEqual(vm.runInContext('skin', w.sandbox), 'deepseek-maid');
assert(w.calls.some((call) => call[0] === 'setSkin' && call[1][0] === 'deepseek-maid'));
vm.runInContext('toggleSkin()', w.sandbox);
assert.strictEqual(vm.runInContext('skin', w.sandbox), 'mascot');
assert(!w.document.body.classList.contains('skin-deepseek-maid'), 'no class leakage when switching away');
vm.runInContext("applySkin('cat'); updateCat('sweeping')", w.sandbox);
assert.strictEqual(src(), '../assets/cat/cat-sweeping.gif');
vm.runInContext("applySkin('whale'); updateCat('sweeping')", w.sandbox);
assert.strictEqual(src(), '../assets/whale/whale-sweeping.gif');
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
for (const suffix of ['', ", 'codex'", ", 'dsh'"]) {
  assert(main.includes(`applySkin('deepseek-maid'${suffix})`), 'tray must expose the pack to every pet role');
}
console.log('deepseek-maid: 23 transparent animations, 731 decoded alpha frames, safe disposal, exact timeline, stable sleeping anchors, fixed-body head bubbles, every state/pool, three roles, and skin switching passed');
// The real renderer starts recurring UI timers. This standalone test has
// completed all synchronous assertions; don't keep npm test alive on them.
process.exit(0);
