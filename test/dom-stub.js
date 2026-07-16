'use strict';

// Minimal DOM/preload stub — lets renderer/pet.js run headless in Node so the
// state-machine smoke test exercises the REAL renderer code (setState /
// transient / applyStats / skin updates), not a re-implementation.
//
// Only the APIs pet.js actually touches are stubbed (see test/state-smoke.js).

const fs = require('fs');
const path = require('path');
const vm = require('vm');

class ClassList {
  constructor(el) { this._el = el; this._set = new Set(); }
  add(...cs) { cs.forEach((c) => c && this._set.add(c)); }
  remove(...cs) { cs.forEach((c) => this._set.delete(c)); }
  toggle(c, force) {
    const want = force === undefined ? !this._set.has(c) : !!force;
    want ? this._set.add(c) : this._set.delete(c);
    return want;
  }
  contains(c) { return this._set.has(c); }
  get list() { return [...this._set]; }
}

function makeElement(tag, id) {
  const el = {
    tagName: String(tag || 'div').toUpperCase(),
    id: id || '',
    children: [],
    parentNode: null,
    dataset: {},
    style: { setProperty() {}, removeProperty() {} },
    textContent: '',
    title: '',
    value: '',
    scrollTop: 0,
    offsetWidth: 0,
    offsetHeight: 0,
    hidden: false,
    _attrs: {},
    _listeners: {},
    _innerHTML: '',
  };
  el.classList = new ClassList(el);
  Object.defineProperty(el, 'className', {
    get() { return el.classList.list.join(' '); },
    set(v) { el.classList._set = new Set(String(v).split(/\s+/).filter(Boolean)); },
  });
  // src: keep property and attribute in sync (pet.js reads getAttribute('src')
  // and assigns el.src)
  Object.defineProperty(el, 'src', {
    get() { return el._attrs.src || ''; },
    set(v) { el._attrs.src = String(v); },
  });
  Object.defineProperty(el, 'innerHTML', {
    get() { return el._innerHTML; },
    set(v) { el._innerHTML = String(v); if (!v) el.children = []; },
  });
  el.getAttribute = (k) => (k in el._attrs ? el._attrs[k] : (k === 'class' ? el.className : null));
  el.setAttribute = (k, v) => { el._attrs[k] = String(v); };
  el.addEventListener = (ev, fn) => { (el._listeners[ev] = el._listeners[ev] || []).push(fn); };
  el.removeEventListener = () => {};
  el.dispatch = (ev, arg) => { for (const fn of el._listeners[ev] || []) fn(arg || { stopPropagation() {}, preventDefault() {} }); };
  el.appendChild = (c) => { c.parentNode = el; el.children.push(c); return c; };
  el.remove = () => { if (el.parentNode) el.parentNode.children = el.parentNode.children.filter((c) => c !== el); };
  // Auto-vivify per-selector children (pet.js expects .pixel-sprite etc to exist)
  el._selCache = {};
  el.querySelector = (sel) => {
    if (!el._selCache[sel]) el._selCache[sel] = makeElement('div');
    return el._selCache[sel];
  };
  el.querySelectorAll = () => [];
  el.getBoundingClientRect = () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 100, height: 100 });
  el.closest = () => null;
  el.focus = () => {};
  el.blur = () => {};
  el.setPointerCapture = () => {};
  el.releasePointerCapture = () => {};
  return el;
}

function createStubWorld() {
  const elements = new Map(); // id -> element
  const byId = (id) => {
    if (!elements.has(id)) elements.set(id, makeElement('div', id));
    return elements.get(id);
  };

  // pet.html gives these real tags/ids; pre-seed the img so src logic works
  const mascotImg = byId('mascot-img');
  mascotImg.setAttribute('src', '../assets/mascot.png');
  const catImg = byId('cat-img');
  catImg.setAttribute('src', '../assets/cat/cat-idle.gif');

  const document = {
    getElementById: byId,
    createElement: (t) => makeElement(t),
    body: makeElement('body'),
    activeElement: null,
    elementFromPoint: () => null,
    addEventListener: () => {},
  };

  // Captured renderer callbacks (registered via window.pet.onX)
  const handlers = { event: null, stats: null, config: null };
  const calls = []; // record of preload calls for assertions

  const pet = {
    onEvent: (cb) => { handlers.event = cb; },
    onStats: (cb) => { handlers.stats = cb; },
    onConfig: (cb) => { handlers.config = cb; },
    getStats: () => Promise.resolve(null),
    getConfig: () => Promise.resolve(null),
    getWinPos: () => Promise.resolve([0, 0]),
    setWinPos: (...a) => calls.push(['setWinPos', a]),
    setPetSize: (...a) => calls.push(['setPetSize', a]),
    setIgnoreMouse: (...a) => calls.push(['setIgnoreMouse', a]),
    setSkin: (...a) => calls.push(['setSkin', a]),
    toggleMute: () => calls.push(['toggleMute']),
    openPanel: () => calls.push(['openPanel']),
    openLog: () => calls.push(['openLog']),
    quit: () => calls.push(['quit']),
    launchClaude: () => calls.push(['launchClaude']),
    focusSession: (...a) => calls.push(['focusSession', a]),
    blurPet: () => calls.push(['blurPet']),
    decidePermission: (...a) => calls.push(['decidePermission', a]),
    petLog: () => {},
  };

  // Controllable clock: advance() shifts Date.now() so transient windows can be
  // expired deterministically without real sleeps.
  const clock = { offset: 0 };
  const RealDate = Date;
  class StubDate extends RealDate {
    static now() { return RealDate.now() + clock.offset; }
  }

  const window = {
    pet,
    OctoIcons: undefined,
    AudioContext: undefined,
    webkitAudioContext: undefined,
    addEventListener: () => {},
  };

  const sandbox = {
    document,
    window,
    Date: StubDate,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    console,
    Math,
    JSON,
    Promise,
    Number,
    String,
    Boolean,
    Array,
    Object,
    Set,
    Map,
    isFinite,
    parseInt,
    parseFloat,
    // pet.js 启动即读 ?agent=（双宠身份）；沙箱按单宠(all)跑
    URLSearchParams,
    location: { search: '' },
  };
  sandbox.globalThis = sandbox;
  return { sandbox, elements: byId, handlers, calls, clock, document, window };
}

// Load renderer/pet.js (and anything else, e.g. a future shared module) into
// the stub world. Returns the world for driving + assertions.
function loadRenderer(files) {
  const world = createStubWorld();
  vm.createContext(world.sandbox);
  for (const f of files) {
    const code = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    vm.runInContext(code, world.sandbox, { filename: f });
  }
  return world;
}

module.exports = { loadRenderer, createStubWorld };
