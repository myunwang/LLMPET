'use strict';

// Transparent Electron windows clip CSS shadows at their own bounds. The
// Needs Input surface is only 12px from that boundary, so any outer shadow can
// turn into the dark rectangular strip reported in issue #7.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const css = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'pet.css'), 'utf8');
const js = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'pet.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'pet.html'), 'utf8');
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
assert(/overflow\s*:\s*hidden\s*;/.test(surfaceRule), 'the popup shell itself must stay fixed');
assert(/\.ask-scroll\s*\{[^}]*overflow-y\s*:\s*auto\s*;[^}]*overflow-x\s*:\s*hidden\s*;/s.test(css), 'only the middle content region should scroll');
assert(/\.ask-scroll\s*\{[^}]*scrollbar-width\s*:\s*thin\s*;/s.test(css), 'content region should retain a compact vertical scroll affordance');
assert(/\.ask-scroll::-webkit-scrollbar\s*\{[^}]*width\s*:\s*6px\s*;[^}]*height\s*:\s*0\s*;/s.test(css), 'only the vertical scrollbar may take visible space');
assert(layoutRule && /max-height\s*:\s*min\(calc\(100vh - 210px\), 520px\)/.test(layoutRule), 'ask viewport must not fill the desktop');
assert(/\.ask-sess\s*\{[^}]*text-overflow\s*:\s*ellipsis\s*;/s.test(css), 'fixed session header must stay on one compact line');
assert(/\.ask-q[^}]*overflow-wrap\s*:\s*anywhere\s*;/s.test(css), 'long question and option text must wrap inside the card');
assert(/\.ask-toolbar\s*\{[^}]*display\s*:\s*flex\s*;/s.test(css), 'all footer actions should share one compact row');
assert(/class="ask-scroll"[^>]*>[\s\S]*class="ask-card"[\s\S]*class="ask-toolbar"/s.test(html), 'fixed header and toolbar must sit outside the scrolling content');
assert(/id="ask-back"[\s\S]*id="ask-submit"[\s\S]*id="ask-term"/s.test(html), 'footer actions should use back, submit, terminal order');
assert(/const POPUP_W = 520;/.test(js), 'popup window should provide more horizontal room');
assert(/const ASK_VIEWPORT_MAX_H = 520;/.test(js), 'ask measurement must use the same vertical cap');
assert(/window\.innerWidth[^\n]*POPUP_W/.test(js), 'fitPopup must resize width before measuring content height');
assert(/askScroll\.scrollTop\s*=\s*0/.test(js), 'switching questions or sessions must reset only the content scroll position');

console.log('popup style checks passed');
