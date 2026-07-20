'use strict';

// Transparent Electron windows clip CSS shadows at their own bounds. The
// Needs Input surface is only 12px from that boundary, so any outer shadow can
// turn into the dark rectangular strip reported in issue #7.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const css = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'pet.css'), 'utf8');
const js = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'pet.js'), 'utf8');
const askRules = [...css.matchAll(/(?:^|\n)\.ask\s*\{([^}]*)\}/g)];

assert(askRules.length > 0, 'missing .ask surface rule');

// pet.css contains an early legacy rule and later focused overrides. Pick the
// dark surface rule explicitly instead of relying on source order.
const surfaceRule = askRules.map((m) => m[1]).find((rule) => /background\s*:\s*rgba\(26, 26, 29/.test(rule));
const layoutRule = askRules.map((m) => m[1]).find((rule) => /520px/.test(rule));
const shadow = surfaceRule && /box-shadow\s*:\s*([^;]+);/.exec(surfaceRule);

assert(shadow, 'final .ask rule must define its depth treatment explicitly');
assert(/^inset\b/.test(shadow[1].trim()), '.ask must not use an outer shadow inside the transparent pet window');
assert(/max-width\s*:\s*none\s*;/.test(surfaceRule), 'dark popup must override the legacy 290px width cap');
assert(/overflow-x\s*:\s*hidden\s*;/.test(surfaceRule), '.ask must never expose a horizontal scrollbar');
assert(/scrollbar-width\s*:\s*thin\s*;/.test(surfaceRule), 'popup should retain a compact vertical scroll affordance');
assert(/\.ask::-webkit-scrollbar\s*\{[^}]*width\s*:\s*6px\s*;[^}]*height\s*:\s*0\s*;/s.test(css), 'only the vertical scrollbar may take visible space');
assert(layoutRule && /max-height\s*:\s*min\(calc\(100vh - 210px\), 520px\)/.test(layoutRule), 'ask viewport must not fill the desktop');
assert(/\.ask-sess[^}]*overflow-wrap\s*:\s*anywhere\s*;/s.test(css), 'long session and option text must wrap inside the card');
assert(/const POPUP_W = 520;/.test(js), 'popup window should provide more horizontal room');
assert(/const ASK_VIEWPORT_MAX_H = 520;/.test(js), 'ask measurement must use the same vertical cap');
assert(/window\.innerWidth[^\n]*POPUP_W/.test(js), 'fitPopup must resize width before measuring content height');

console.log('popup style checks passed');
