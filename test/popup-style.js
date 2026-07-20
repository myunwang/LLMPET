'use strict';

// Transparent Electron windows clip CSS shadows at their own bounds. The
// Needs Input surface is only 12px from that boundary, so any outer shadow can
// turn into the dark rectangular strip reported in issue #7.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const css = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'pet.css'), 'utf8');
const askRules = [...css.matchAll(/(?:^|\n)\.ask\s*\{([^}]*)\}/g)];

assert(askRules.length > 0, 'missing .ask surface rule');

// pet.css contains an early legacy rule and a later final override. Guard the
// final rule because that is what Chromium paints.
const finalRule = askRules[askRules.length - 1][1];
const shadow = /box-shadow\s*:\s*([^;]+);/.exec(finalRule);

assert(shadow, 'final .ask rule must define its depth treatment explicitly');
assert(/^inset\b/.test(shadow[1].trim()), '.ask must not use an outer shadow inside the transparent pet window');
assert(/overflow-x\s*:\s*hidden\s*;/.test(finalRule), '.ask must never expose a horizontal scrollbar');
assert(/scrollbar-width\s*:\s*none\s*;/.test(finalRule), 'native popup scrollbar must stay hidden');
assert(/\.ask::-webkit-scrollbar\s*\{[^}]*width\s*:\s*0\s*;[^}]*height\s*:\s*0\s*;/s.test(css), 'popup scrollbar must take no visible space');
assert(/\.ask-sess[^}]*overflow-wrap\s*:\s*anywhere\s*;/s.test(css), 'long session and option text must wrap inside the card');

console.log('popup style checks passed');
