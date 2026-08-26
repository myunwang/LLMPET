'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const expected = {
  'cat-attention.gif': [50, 2640],
  'cat-error.gif': [8, 320],
  'cat-greet.gif': [45, 1960],
  'cat-happy.gif': [47, 2040],
  'cat-idle.gif': [6, 240],
  'cat-juggling.gif': [9, 360],
  'cat-loafing-2.gif': [51, 2160],
  'cat-loafing-3.gif': [3, 120],
  'cat-loafing.gif': [34, 1440],
  'cat-needsinput.gif': [38, 1680],
  'cat-roam.gif': [55, 2680],
  'cat-sad.gif': [21, 880],
  'cat-sleeping-2.gif': [63, 2680],
  'cat-sleeping.gif': [35, 1640],
  'cat-sweeping.gif': [18, 720],
  'cat-talking.gif': [30, 1200],
  'cat-thinking-2.gif': [32, 1560],
  'cat-thinking.gif': [4, 240],
  'cat-waiting.gif': [24, 960],
  'cat-working-2.gif': [54, 2160],
  'cat-working-3.gif': [12, 480],
  'cat-working-4.gif': [56, 2240],
  'cat-working.gif': [36, 1440],
};

function skipSubBlocks(bytes, start) {
  let offset = start;
  while (offset < bytes.length) {
    const size = bytes[offset++];
    if (size === 0) return offset;
    offset += size;
  }
  throw new Error('unterminated GIF sub-block sequence');
}

function inspectGif(bytes) {
  assert(/^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('ascii')), 'invalid GIF header');
  const width = bytes.readUInt16LE(6);
  const height = bytes.readUInt16LE(8);
  const globalPacked = bytes[10];
  let offset = 13;
  if (globalPacked & 0x80) offset += 3 * (2 ** ((globalPacked & 0x07) + 1));

  let frames = 0;
  let durationMs = 0;
  let pendingDelayMs = 0;
  let pendingTransparency = false;
  let hasTransparency = false;

  while (offset < bytes.length) {
    const marker = bytes[offset++];
    if (marker === 0x3b) break;
    if (marker === 0x21) {
      const label = bytes[offset++];
      if (label === 0xf9) {
        const size = bytes[offset++];
        assert.strictEqual(size, 4, 'unexpected graphics control extension size');
        const packed = bytes[offset];
        pendingTransparency = Boolean(packed & 0x01);
        pendingDelayMs = bytes.readUInt16LE(offset + 1) * 10;
        offset += size;
        assert.strictEqual(bytes[offset++], 0, 'unterminated graphics control extension');
      } else {
        offset = skipSubBlocks(bytes, offset);
      }
      continue;
    }
    if (marker === 0x2c) {
      frames += 1;
      durationMs += pendingDelayMs;
      hasTransparency ||= pendingTransparency;
      pendingDelayMs = 0;
      pendingTransparency = false;
      offset += 8;
      const localPacked = bytes[offset++];
      if (localPacked & 0x80) offset += 3 * (2 ** ((localPacked & 0x07) + 1));
      offset += 1; // LZW minimum code size.
      offset = skipSubBlocks(bytes, offset);
      continue;
    }
    throw new Error(`unexpected GIF marker 0x${marker.toString(16)}`);
  }

  return { width, height, frames, durationMs, hasTransparency };
}

const catDir = process.env.LLMPET_CAT_ASSET_DIR
  ? path.resolve(process.env.LLMPET_CAT_ASSET_DIR)
  : path.join(__dirname, '..', 'assets', 'cat');
const names = fs.readdirSync(catDir).filter((name) => name.endsWith('.gif')).sort();
assert.deepStrictEqual(names, Object.keys(expected).sort(), 'the Retina cat pack must keep the exact 23 production animations');

for (const name of names) {
  const actual = inspectGif(fs.readFileSync(path.join(catDir, name)));
  const [frames, durationMs] = expected[name];
  assert.strictEqual(actual.width, 360, `${name} must provide a 2x Retina source width`);
  assert.strictEqual(actual.height, 360, `${name} must provide a 2x Retina source height`);
  assert.strictEqual(actual.frames, frames, `${name} frame count changed during upscaling`);
  assert.strictEqual(actual.durationMs, durationMs, `${name} timing changed during upscaling`);
  assert(actual.hasTransparency, `${name} must preserve its transparent canvas`);
}

console.log('cat Retina asset checks passed');
