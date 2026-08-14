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
assert(/#mascot\.idle #mascot-img\s*\{[^}]*animation\s*:\s*bob/s.test(css),
  'mascot idle motion must animate the artwork inside a stationary hit/anchor box');
assert(!/#(?:mascot|pixel|cat)(?:\.[\w-]+)+\s*\{[^}]*animation\s*:/s.test(css),
  'skin state animations must not move the outer geometry used for popup anchoring and hit testing');
assert(/#mascot\.act-work #mascot-img/.test(css),
  'mascot work motion must also keep the outer geometry stationary');
assert(/#pixel\.waiting \.pixel-sprite\s*\{[^}]*animation\s*:\s*attn/s.test(css)
  && /#pixel\.error \.pixel-sprite\s*\{[^}]*animation\s*:\s*errShake/s.test(css),
  'pixel attention/error motion must animate only its inner artwork');
assert(/const SESSION_PANEL_H = 310;/.test(js),
  'ordinary and streaming session panels must share one fixed three-row height');
assert(/const TAKEOVER_PANEL_H = 320;/.test(js),
  'takeover pages must have a stable viewport independent of the resting window height');
assert(/const panelHeight = fixedTakeoverPage \? TAKEOVER_PANEL_H : SESSION_PANEL_H;/.test(js)
  && /fixedSessionPage \|\| fixedTakeoverPage[\s\S]{0,800}POPUP_BOTTOM \+ panelHeight \+ 24[\s\S]{0,200}popupHeight: panelHeight/.test(js),
  'session pages must resize once to the measured three-row baseline instead of measuring each row');
assert(/\.sesslist\.session-list-mode\s*\{[^}]*height\s*:\s*310px\s*;[^}]*max-height\s*:\s*310px\s*;/s.test(css),
  'the visible session shell must be exactly three rows tall');
assert(/fixedTakeoverPage[\s\S]*TAKEOVER_PANEL_H[\s\S]*popupHeight: panelHeight/.test(js),
  'takeover pages must resize directly instead of measuring against the compact resting frame');
assert(/\.sesslist\.takeover-mode\s*\{[^}]*height\s*:\s*min\(320px, calc\(100vh - 224px\)\)[^}]*max-height\s*:\s*min\(320px, calc\(100vh - 224px\)\)/s.test(css),
  'takeover shell must fill its stable viewport while respecting small screens');
assert(/\.sl-scroll::\-webkit-scrollbar-track[\s\S]*background\s*:\s*transparent/s.test(css)
  && /\.sl-scroll::\-webkit-scrollbar-corner[\s\S]*background\s*:\s*transparent/s.test(css),
  'the compact session scrollbar must not expose a light native track or corner');
assert(/function showSessionPage[\s\S]*session-list-mode/.test(js)
  && /function openTakeoverPage[\s\S]*add\('takeover-mode'\)/.test(js)
  && /function openMemePage[\s\S]*remove\('session-list-mode'\)/.test(js)
  && /function openTravelPage[\s\S]*remove\('session-list-mode'\)/.test(js),
  'only the ordinary/loot session page should use the compact fixed shell');
assert(/window\.innerWidth[^\n]*targetW/.test(js), 'fitPopup must resize to the active surface width before measuring content height');
assert(/askScroll\.scrollTop\s*=\s*0/.test(js), 'switching questions or sessions must reset only the content scroll position');
assert(/\.sesslist\s*\{[^}]*max-height\s*:\s*calc\(100vh - 70px\)[^}]*overflow\s*:\s*hidden\s*;/s.test(css),
  'session popup shell must clip to the viewport instead of spilling across the desktop');
assert(/#sl-session-view\s*\{[^}]*min-height\s*:\s*0\s*;[^}]*display\s*:\s*flex\s*;[^}]*flex\s*:\s*1 1 auto\s*;/s.test(css),
  'session page must be a shrinkable flex column');
assert(/\.sl-scroll\s*\{[^}]*min-height\s*:\s*0\s*;[^}]*flex\s*:\s*1 1 auto\s*;[^}]*overflow-y\s*:\s*auto\s*;/s.test(css),
  'session rows must own vertical scrolling when the list exceeds the popup');
assert(/\.sl-foot\s*\{[^}]*flex\s*:\s*0 0 auto\s*;/s.test(css),
  'session footer must remain fixed while rows scroll');
assert(/\.sl-meme-grid\s*\{[^}]*min-height\s*:\s*0\s*;[^}]*flex\s*:\s*1 1 auto\s*;[^}]*overflow-y\s*:\s*auto\s*;/s.test(css),
  'meme choices must share the same bounded scrolling contract');
assert(/\.sl-takeover-view\s*\{[^}]*min-height\s*:\s*0\s*;[^}]*flex\s*:\s*1 1 auto\s*;[^}]*overflow-y\s*:\s*auto\s*;/s.test(css)
  && /\.sl-takeover-view\s*>\s*\*\s*\{[^}]*flex\s*:\s*0 0 auto\s*;/s.test(css),
  'takeover content must scroll internally instead of being clipped by the transparent window');
assert(/\.sl-travel-view\s*\{[^}]*min-height\s*:\s*0\s*;[^}]*flex\s*:\s*1 1 auto\s*;[^}]*overflow-y\s*:\s*auto\s*;/s.test(css),
  'travel page must own bounded vertical scrolling');
assert(/\.sl-travel-view\s*>\s*\*\s*\{[^}]*flex\s*:\s*0 0 auto\s*;/s.test(css),
  'travel sections must overflow into the page scroller instead of shrinking and clipping');
assert(/\.sl-travel-view::-webkit-scrollbar\s*\{[^}]*width\s*:\s*7px\s*;/s.test(css),
  'travel page must expose a visible vertical scroll affordance');
assert(/\.sl-travel-ranks\s*\{[^}]*grid-template-columns\s*:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/s.test(css),
  'travel and whole-machine ranks must share one compact row');
assert(/id="sl-travel-rank-icons"[\s\S]*id="sl-machine-rank-icons"/s.test(html),
  'travel page must expose separate travel and whole-machine progression');
assert(/\.sl-travel-library\s*\{[^}]*grid-template-columns\s*:\s*148px minmax\(0,\s*1fr\)\s*;/s.test(css),
  'postcard album must live in a fixed sidebar beside the selected postcard');
assert(/\.sl-travel-postcard-text\s*\{[^}]*height\s*:\s*236px\s*;[^}]*overflow\s*:\s*hidden\s*;/s.test(css),
  'one postcard must fit as a complete page without a nested scrollbar');
assert(/\.sl-travel-stop-track\s*\{[^}]*overflow\s*:\s*hidden\s*;/s.test(css)
  && /\.sl-travel-stop-card\s*\{[^}]*display\s*:\s*none\s*;/s.test(css)
  && /\.sl-travel-stop-card\.active\s*\{[^}]*display\s*:\s*block\s*;/s.test(css),
  'station navigation must show exactly one postcard instead of horizontally bleeding adjacent cards');
assert(/\.sl-travel-history::-webkit-scrollbar\s*\{[^}]*width\s*:\s*6px\s*;/s.test(css),
  'postcard album must visibly advertise additional saved trips');
assert(/class="sl-travel-library"[\s\S]*class="sl-travel-album"[\s\S]*id="sl-travel-history"[\s\S]*id="sl-travel-postcard"/s.test(html),
  'postcard history must precede the selected postcard inside the side-by-side library');
assert(/const TRAVEL_POPUP_W = 760;/.test(js), 'travel library needs a wider surface than ordinary session popups');
assert(/#stage\.edge-below\s*\{[^}]*justify-content\s*:\s*flex-start\s*;/s.test(css),
  'top-edge mode must anchor the visible pet at the top of its transparent window');
assert(/#stage\.edge-below \.sesslist,[\s\S]*#stage\.edge-below \.todopop\s*\{[^}]*top\s*:\s*200px\s*;[^}]*bottom\s*:\s*auto\s*;/s.test(css),
  'cards must flip below a pet parked at the top edge');
assert(/\.sessions\s*\{[^}]*justify-content\s*:\s*center\s*;/s.test(css),
  'session dots must be centred inside the pet-width anchor');
assert(/body\.skin-pixel \.sessions\s*\{[^}]*width\s*:\s*200px\s*;[^}]*\}/s.test(css)
  && /body\.skin-mascot \.sessions\s*\{[^}]*width\s*:\s*252px\s*;[^}]*\}/s.test(css)
  && /body\.skin-cat \.sessions\s*\{[^}]*width\s*:\s*120px\s*;[^}]*\}/s.test(css),
  'each skin must align the session-dot box to its visible pet width');
assert(/anchoredLayoutPayload/.test(js) && /choosePopupLayout/.test(js),
  'renderer must preserve the visible pet anchor while changing popup direction');
assert(/compactVerticalFrame\s*&&\s*next\.vertical\s*===\s*'below'/s.test(js)
  && /compactHorizontalFrame\s*&&\s*next\.horizontal\s*===\s*'left'/s.test(js),
  'popup-sized frames must never trigger legacy edge-drag snapping while they collapse');
assert(/frameHeightExcess\s*=\s*Math\.max\(0,\s*snapshot\.windowRect\.height\s*-\s*BASE_PET_FRAME_H\)/s.test(js)
  && /snapshot\.petRect\.y\s*-\s*frameHeightExcess\s*\+\s*2/s.test(js),
  'closing a tall popup must compare the pet against its base-frame inset, not its expanded local y');
const mainJs = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
assert(/id="sl-new-dsh"/.test(html) && /slNewDshBtn[\s\S]*launchDsh/.test(js),
  'the combined session panel must expose a working new-dsh action');
assert(/\['claude', 'codex', 'dsh'\]\.includes\(agent\)/.test(mainJs),
  'the tray must allow the dsh startup preference to be changed');
assert(!/runAgentStartup\(\{\s*agents:\s*\['claude', 'codex', 'dsh'\]/.test(mainJs),
  'start-missing must respect saved provider toggles instead of forcing all three');
assert(/ensureDshWeb\(\{\s*url:\s*DSH_WEB_URL/.test(mainJs),
  'dsh focus must ensure the generic Web frontend is ready before opening it');
const travelStartBegin = mainJs.indexOf("ipcMain.handle('travel-start'");
const travelStartEnd = mainJs.indexOf("ipcMain.handle('travel-wander'", travelStartBegin);
const travelStartHandler = mainJs.slice(travelStartBegin, travelStartEnd);
const travelProviderGuard = travelStartHandler.indexOf("agent !== 'claude' && agent !== 'codex'");
const travelManagerStart = travelStartHandler.indexOf('travelManager.start({');
assert(travelProviderGuard >= 0,
  'travel-start must reject providers other than Claude and Codex');
assert(travelManagerStart > travelProviderGuard,
  'travel-start must reject unsupported providers before starting a trip');
assert(travelStartHandler.slice(travelProviderGuard, travelManagerStart).includes("code: 'invalid-target'"),
  'travel-start must return invalid-target for DSH and unknown providers');
const territoryTween = mainJs.slice(
  mainJs.indexOf('function tweenTerritoryPetTo'),
  mainJs.indexOf('function bootTerritory'));
assert(/const from = getTerritoryPetBounds\(\)/.test(territoryTween)
  && /const rect = primaryVisualRect\(\)[\s\S]*petWin\.setBounds/.test(territoryTween)
  && !/return tweenPetTo\(/.test(territoryTween),
  'territory tween must recompute the visible-body offset on every frame while popups resize');
assert(/wr\.y\s*<=\s*wa\.y\s*\+\s*3[\s\S]*screenY\s*=\s*wa\.y/.test(js),
  'a top-clamped transparent frame must snap the visible pet body to the work-area top');
assert(/PetGeometry\.radialLayout/.test(js),
  'right-click menu must use bounded edge-aware geometry');
assert(/getWindowMetrics:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('get-window-metrics'\)/.test(
  fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8')),
  'renderer must be able to request exact BrowserWindow and display bounds');
assert(/ipcMain\.handle\('get-window-metrics'[\s\S]*screen\.getDisplayMatching\(windowBounds\)\.workArea/.test(mainJs),
  'radial layout must use the main-process work area for the window current display');
assert(/async function openRadial[\s\S]*closeSessList\(\)[\s\S]*await settledRadialMetrics\(\)[\s\S]*buildRadial\(metrics\)/.test(js),
  'right-click menu must wait for popup collapse and renderer reflow before positioning controls');
assert(/id="sl-loot"/.test(html),
  'session panel must include the loot progress banner');
assert(/\.sl-row\.loot-enter/.test(css) && /@keyframes lootSessionIn/.test(css),
  'captured Codex sessions must enter with a visible staggerable animation');
assert(/case 'loot':/.test(js)
  && /case 'captureStart':[\s\S]*startLootCapture\(ev\.available\)/.test(js)
  && /case 'sessionCaptured':[\s\S]*appendLootSession\(ev\.session\)/.test(js),
  'renderer must consume the backend-owned per-session capture stream');
assert(/function appendLootSession[\s\S]*enteringSessionId = key[\s\S]*renderSessList\(\)/.test(js)
  && /case 'ready':[\s\S]*revealLootReady\(ev\.count\)/.test(js),
  'each explicit session event must animate once before the real drag-ready event');
const appendLootSource = js.slice(js.indexOf('function appendLootSession'), js.indexOf('function markLootCaptureWaiting'));
assert(!/fitPopup\(sesslist\)/.test(appendLootSource)
  && /slRows\.scrollTop\s*=\s*slRows\.scrollHeight/.test(appendLootSource),
  'streamed sessions must scroll inside the fixed panel without resizing the pet window');
assert(/else if \(!memeTarget && !takeoverTarget && !lootCapture\)/.test(js)
  && /sessListOpen && !memeTarget && !takeoverTarget && !lootCapture/.test(js),
  'ordinary stats/config refreshes must not rebuild an open sub-page or restart an active loot animation');
assert(/lastPetSizeRequestSig/.test(js)
  && /!options\.popup && requestSig === lastPetSizeRequestSig/.test(js),
  'non-popup geometry may use request dedupe without swallowing a live popup repair');
assert(/function popupFrameAlreadySettled[\s\S]*window\.innerWidth[\s\S]*window\.innerHeight[\s\S]*nextLayout\.vertical === edgeLayout\.vertical/.test(js)
  && /windowFitsWorkArea\(frame, wa\)/.test(js)
  && /options\.popup && popupFrameAlreadySettled\(width, height, nextLayout\)/.test(js),
  'only an on-screen settled popup may skip a resize; stale request signatures must not block repair');
assert(/function activeSizedSurface[\s\S]*sessListOpen[\s\S]*askActive[\s\S]*todoPopOpen[\s\S]*bubble/.test(js)
  && /function settleEdgeLayout[\s\S]*const surface = activeSizedSurface\(\)[\s\S]*if \(surface\) fitPopup\(surface\)/.test(js),
  'drag release must refit the still-open session, choice, todo, or speech surface instead of collapsing it');
assert(/function showBubble[\s\S]*fitPopup\(activeSizedSurface\(\) \|\| bubble\)/.test(js),
  'background status bubbles must not steal BrowserWindow sizing from an open interactive panel');
assert(/function finishChoice[\s\S]*hideAsk\(true\)[\s\S]*if \(!showBubble\(bubbleMsg, 2600\)\) resetPetSize\(\)/.test(js),
  'permission confirmation must inherit the expanded window without a base-frame resize in between');
assert(/function movePetDuringDrag[\s\S]*chooseDragHorizontalLayout[\s\S]*nextHorizontal/.test(js),
  'wide popups must switch horizontal anchors during a drag before they leave the work area');
assert(/buttons\s*&\s*1[\s\S]*clearDragGesture\(gesture\)/.test(js)
  && /lostpointercapture/.test(js)
  && /window\.addEventListener\('mousemove'[\s\S]*cancelActiveDrag\(\)/.test(js),
  'a released or lost pointer must not leave hover events owning a stale drag');
assert(/if \(g === gesture\) gesture\.win/.test(js),
  'an old getWinPos response must not overwrite the origin of a newer drag');
assert(/function openSessList[\s\S]*closeTodoPop\(true\)[\s\S]*hideAsk\(true\)/.test(js)
  && /function openTodoPop[\s\S]*hideAsk\(true\)[\s\S]*closeSessList\(true\)/.test(js)
  && /function closeSessList\(preserveSize = false\)[\s\S]*if \(!preserveSize\) resetPetSize\(\)/.test(js),
  'switching popup surfaces must not collapse through the 340px resting frame');
assert(/function resetPetSize\(\)\s*\{[\s\S]{0,500}if \(sessListOpen \|\| askActive \|\| todoPopOpen\) return false;/.test(js),
  'stale delayed callbacks must not collapse a popup that still owns the BrowserWindow');
assert(/lastSessListRenderSig/.test(js)
  && /renderSig === lastSessListRenderSig/.test(js)
  && /existingRows = new Map/.test(js)
  && /updateSessRow\(row, session\)/.test(js)
  && /previousScrollTop/.test(js),
  'session refreshes must reuse keyed row nodes and preserve the scroll position');
assert(/lastSessionDotsRenderSig/.test(js),
  'unchanged stats must not recreate the pet session dots');
assert(/lastTravelMailboxRenderSig/.test(js)
  && /lastTravelHistoryRenderSig/.test(js)
  && /lastTravelTemplatesRenderSig/.test(js),
  'unchanged travel snapshots must preserve mailbox, album, and template DOM');
assert(/function showAskPanel[\s\S]*if \(sessListOpen\) return;/.test(js),
  'background permission snapshots must not flash-close a session panel the user opened');
assert(/let stableSessionOrder = \[\]/.test(js)
  && /ordered\.push\(\.\.\.byKey\.values\(\)\)/.test(js)
  && /function resetSessionListOrder/.test(js),
  'live stats must update session rows in place instead of continuously reshuffling them');
assert(/#cat\.loot-action-mirrored img\s*\{[^}]*scaleX\(-1\)/s.test(css)
  && /function lootVisualNeedsMirror[\s\S]*const nativeDirection = -1/.test(js)
  && /case 'captureStart':[\s\S]*startLootCaptureVisual\(ev\.direction\)/.test(js)
  && /case 'kick':[\s\S]*startLootKick\(ev\.direction\)/.test(js)
  && /function startLootKick[\s\S]*loot-kick=[\s\S]*Date\.now\(\)/.test(js),
  'loot visuals must respect each GIF native direction and restart the kick from frame one');
assert(/lookout:\s*'cat-thinking-2\.gif'/.test(js)
  && /case 'targetClosed':[\s\S]*startLootLookout\(ev\.direction, 3600\)/.test(js),
  'the kick GIF must stop as soon as the exact Codex pet close action succeeds');
assert(/success \? 1400 : 2200/.test(js),
  'the special loot view must return quickly to the normal session list');
assert(/function mergedOrdinarySessions/.test(js)
  && /lootCapturedUntil/.test(js)
  && /lootKeptSessions = Array\.isArray\(cfg\.lootCapturedSessions\)/.test(js),
  'captured sessions must survive as time-bounded entries in the normal session list');

console.log('popup style checks passed');
