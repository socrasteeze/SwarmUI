/**
 * Mobile perf + safe-area-top regression harness (fork). Companion to verify-mobile-layout.mjs; see the
 * coupling watchlist in docs/MobilePWA-Optimization-Plan.md and the layout.js entry in CLAUDE.md.
 *
 * It guards two things:
 *
 *  1. The installed-PWA top inset. iOS reports a top safe-area inset of 0 for home-screen web apps even
 *     under status-bar-style black-translucent, which is exactly the mode that draws the app underneath the
 *     status bar - so consuming env(safe-area-inset-top) directly left the top tab strip behind the clock.
 *     mobile_core.js's measureSafeAreaTop() prefers the reported value and falls back only once it has
 *     confirmed the app is genuinely full-bleed. These checks pin that decision table down.
 *
 *  2. The per-frame cost of the mobile hot paths. setMobileTopbarCollapse() runs on every scroll event and
 *     every touchmove of a topbar drag; it used to interleave a document-root custom-property write with a
 *     bounding rect, a getComputedStyle and two offsetHeight reads, forcing a full synchronous reflow per
 *     frame. It now reads a cache filled once per layout pass. The checks below assert that the hot path
 *     performs ZERO layout reads, and - because the cache replaces a measured root offset with arithmetic -
 *     that the arithmetic agrees with the measurement it replaced, against the real genpage.css rules.
 *
 * Runs the REAL shipped source: every method under test is extracted from its file by brace-matching (not
 * retyped), and the real genpage.css + mobile.css are injected verbatim.
 *
 * Requires playwright + a chromium build; neither is a repo dependency, so this is opt-in tooling rather
 * than part of the CI gate. Run from the repo root:
 *     node src/BuiltinExtensions/MobileEnhancements/verify/verify-mobile-perf.mjs
 * Set SWARM_CHROMIUM to override the browser path. Exits non-zero if any check fails.
 */
import { chromium } from 'playwright';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const LAYOUT_JS = `${REPO}/src/wwwroot/js/genpage/gentab/layout.js`;
const CORE_JS = `${REPO}/src/BuiltinExtensions/MobileEnhancements/Assets/mobile_core.js`;
const GENPAGE_CSS = `${REPO}/src/wwwroot/css/genpage.css`;
const MOBILE_CSS = `${REPO}/src/BuiltinExtensions/MobileEnhancements/Assets/mobile.css`;

/** Pull a whole method out of a class body by brace-matching from its signature. */
function extractMethod(src, name) {
    const sigIdx = src.indexOf(`\n    ${name}(`);
    if (sigIdx < 0) {
        throw new Error(`method ${name} not found`);
    }
    let i = src.indexOf('{', sigIdx);
    let depth = 0;
    for (let j = i; j < src.length; j++) {
        if (src[j] == '{') { depth++; }
        else if (src[j] == '}') {
            depth--;
            if (depth == 0) {
                return src.slice(sigIdx + 1, j + 1);
            }
        }
    }
    throw new Error(`unbalanced braces in ${name}`);
}

const layoutSrc = readFileSync(LAYOUT_JS, 'utf8');
const coreSrc = readFileSync(CORE_JS, 'utf8');
const genpageCss = readFileSync(GENPAGE_CSS, 'utf8');
const mobileCss = readFileSync(MOBILE_CSS, 'utf8');

// The layout methods the mobile hot paths are built from, lifted verbatim onto a stub host object.
const LAYOUT_METHODS = ['refreshMobileMetrics', 'getMobileMetrics', 'setMobileTopbarCollapse', 'scheduleTopbarCollapse', 'getMobileBottomPeekPx', 'isMobileBottomOpen', 'getViewportHeight'];
// Comma-joined: these are spliced into an object literal below, as shorthand methods.
const layoutMethods = LAYOUT_METHODS.map(m => extractMethod(layoutSrc, m)).join(',\n');
// mobile_core.js instantiates itself on load; drop that so the page can construct a controlled instance.
const coreClass = coreSrc.replace(/let mobileEnhancements = new MobileEnhancements\(\);\s*$/, '');

const results = [];
function check(name, pass, detail) {
    results.push({ name, pass, detail });
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
}

const browser = await chromium.launch(process.env.SWARM_CHROMIUM ? { executablePath: process.env.SWARM_CHROMIUM } : {});
const page = await browser.newPage({ viewport: { width: 430, height: 932 } });

await page.setContent(`<!doctype html><html><head><style>${genpageCss}</style><style>${mobileCss}</style></head>
<body class="small-window pwa-standalone">
    <div id="toptablist" style="height:96px;background:#222;">tabs</div>
    <div class="tab-content tab-hundred">
        <div id="t2i_root">
            <div id="top_section"><div id="main_image_area"><div id="current_image_wrapbox"></div><div id="editor_sizebar"></div></div></div>
            <div id="alt_prompt_region" style="height:70px;"></div>
        </div>
    </div>
    <div id="bottom_bar">
        <div id="bottom_info_bar" style="height:22px;"></div>
        <div id="bottombartabcollection" style="height:38px;"></div>
    </div>
    <button id="quicktools_button"></button>
</body></html>`);

// ---- Part 1: the installed-PWA top safe-area inset -------------------------------------------------

const safeAreaCases = [
    { name: 'reported inset is used as-is', env: 47, innerH: 852, innerW: 393, screenH: 852, screenW: 393, expect: 47 },
    { name: 'absurd reported inset is capped (physical-px bug)', env: 200, innerH: 852, innerW: 393, screenH: 852, screenW: 393, expect: 64 },
    { name: 'iOS zero inset while full-bleed falls back (iPhone 15/16)', env: 0, innerH: 852, innerW: 393, screenH: 852, screenW: 393, expect: 59 },
    { name: 'iOS zero inset while full-bleed falls back (Pro Max)', env: 0, innerH: 932, innerW: 430, screenH: 932, screenW: 430, expect: 59 },
    { name: 'iOS zero inset while full-bleed falls back (iPhone 12-14)', env: 0, innerH: 844, innerW: 390, screenH: 844, screenW: 390, expect: 47 },
    { name: 'OS already reserved the bar - no double padding', env: 0, innerH: 793, innerW: 393, screenH: 852, screenW: 393, expect: 0 },
    { name: 'landscape adds nothing (iOS hides the status bar)', env: 0, innerH: 393, innerW: 852, screenH: 852, screenW: 393, expect: 0 },
    { name: 'unknown notch-class screen errs high rather than clipping', env: 0, innerH: 1000, innerW: 400, screenH: 1000, screenW: 400, expect: 59 },
    { name: 'home-button iPhone gets the classic 20px bar', env: 0, innerH: 667, innerW: 375, screenH: 667, screenW: 375, expect: 20 },
    { name: 'non-iOS zero inset is taken at face value (no phantom band)', env: 0, innerH: 852, innerW: 393, screenH: 852, screenW: 393, ios: false, expect: 0 },
];

const safeAreaOut = await page.evaluate(({ coreClass, cases }) => {
    // A class declaration inside eval() is scoped to that eval, so hand the binding back out explicitly.
    let MobileEnhancements = eval(`${coreClass}\nMobileEnhancements`);
    let out = [];
    for (let c of cases) {
        let inst = Object.create(MobileEnhancements.prototype);
        inst.isStandalone = true;
        inst.readEnvInsetTop = () => c.env;
        // Stubbed rather than UA-spoofed: the harness runs on desktop Chromium, so the real isIos() would
        // report false and every iOS case below would trivially return 0.
        inst.isIos = () => c.ios !== false;
        Object.defineProperty(window, 'innerHeight', { value: c.innerH, configurable: true });
        Object.defineProperty(window, 'innerWidth', { value: c.innerW, configurable: true });
        Object.defineProperty(window, 'screen', { value: { height: c.screenH, width: c.screenW }, configurable: true });
        out.push({ name: c.name, got: inst.measureSafeAreaTop(), expect: c.expect });
    }
    // Non-standalone must be inert - desktop and plain-browser mobile are untouched by any of this.
    let plain = Object.create(MobileEnhancements.prototype);
    plain.isStandalone = false;
    plain.readEnvInsetTop = () => { throw new Error('probed env() outside standalone'); };
    out.push({ name: 'non-standalone measures nothing at all', got: plain.measureSafeAreaTop(), expect: 0 });
    return out;
}, { coreClass, cases: safeAreaCases });

for (let r of safeAreaOut) {
    check(r.name, r.got === r.expect, `got ${r.got}, expected ${r.expect}`);
}

// The CSS half: body.pwa-standalone must consume --safe-top, or the measurement above goes nowhere.
const cssOut = await page.evaluate(() => {
    let tabs = document.getElementById('toptablist');
    let before = getComputedStyle(document.body).paddingTop;
    let topBefore = tabs.getBoundingClientRect().top;
    document.documentElement.style.setProperty('--safe-top', '59px');
    let after = getComputedStyle(document.body).paddingTop;
    let topAfter = tabs.getBoundingClientRect().top;
    document.documentElement.style.removeProperty('--safe-top');
    return { before, after, shift: topAfter - topBefore };
});
check('body.pwa-standalone padding-top follows --safe-top', cssOut.after === '59px', `${cssOut.before} -> ${cssOut.after}`);
check('the top tab strip is actually pushed clear of the status bar', cssOut.shift === 59, `#toptablist moved down ${cssOut.shift}px`);

// ---- Part 2: the per-frame mobile hot path ---------------------------------------------------------

const perfOut = await page.evaluate(({ layoutMethods }) => {
    function getRequiredElementById(id) {
        let elem = document.getElementById(id);
        if (!elem) {
            throw new Error(`missing #${id}`);
        }
        return elem;
    }
    let host = {
        isSmallWindow: true,
        bottomShut: true,
        mobileTopbarCollapsePx: 0,
        mobileMetrics: null,
        pendingTopbarCollapse: null,
        topbarCollapseScheduled: false,
        t2iRootDiv: getRequiredElementById('t2i_root'),
        quickToolsButton: getRequiredElementById('quicktools_button'),
        mainImageArea: getRequiredElementById('main_image_area'),
        topSection: getRequiredElementById('top_section'),
        currentImageWrapbox: getRequiredElementById('current_image_wrapbox'),
        editorSizebar: getRequiredElementById('editor_sizebar'),
        altRegion: getRequiredElementById('alt_prompt_region'),
        bottomInfoBar: getRequiredElementById('bottom_info_bar')
    };
    eval(`Object.assign(host, {${layoutMethods}});`);

    // The measuring implementation this replaced, kept as an oracle so the arithmetic can be checked
    // against the reads it stands in for rather than against itself.
    function legacyTopHeight(collapsePx) {
        let tabs = getRequiredElementById('toptablist');
        let max = Math.max(0, (tabs.scrollHeight || tabs.offsetHeight) - 10);
        let clamped = Math.max(0, Math.min(max, collapsePx));
        document.documentElement.style.setProperty('--mobile-topbar-collapse', `${clamped}px`);
        let rootTop = host.t2iRootDiv.getBoundingClientRect().top;
        let viewH = window.innerHeight - (parseFloat(getComputedStyle(document.body).paddingBottom) || 0);
        let bottomPeek = document.body.classList.contains('mobile-keyboard-open') ? 0 : host.getMobileBottomPeekPx();
        return { clamped, rootTop, topHeight: Math.max(120, viewH - rootTop - bottomPeek) };
    }

    // Linearity + equivalence sweep. The cache trades a live getBoundingClientRect() for
    // rootTopBase - collapsePx, which only holds because the collapse is applied as a translateY plus an
    // equal negative margin-bottom. Sweeping the full clamped range against the real CSS proves it.
    let mismatches = [];
    for (let px = 0; px <= 200; px += 5) {
        let legacy = legacyTopHeight(px);
        host.mobileMetrics = null;
        host.mobileTopbarCollapsePx = 0;
        document.documentElement.style.setProperty('--mobile-topbar-collapse', '0px');
        host.setMobileTopbarCollapse(px);
        let cachedRootTop = host.mobileMetrics.rootTopBase - host.mobileTopbarCollapsePx;
        let liveRootTop = host.t2iRootDiv.getBoundingClientRect().top;
        if (host.mobileTopbarCollapsePx !== legacy.clamped || Math.abs(cachedRootTop - liveRootTop) > 0.5 || Math.abs(cachedRootTop - legacy.rootTop) > 0.5) {
            mismatches.push({ px, cachedRootTop, liveRootTop, legacyRootTop: legacy.rootTop, clamped: host.mobileTopbarCollapsePx, legacyClamped: legacy.clamped });
        }
    }

    // Layout-read counter. Everything here forces the browser to flush pending style/layout work; the
    // whole point of the cache is that a scroll or drag frame triggers none of them.
    let reads = 0;
    let realRect = Element.prototype.getBoundingClientRect;
    let realStyle = window.getComputedStyle;
    let offsetHeightDesc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');
    let scrollHeightDesc = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollHeight');
    function instrument() {
        Element.prototype.getBoundingClientRect = function () { reads++; return realRect.call(this); };
        window.getComputedStyle = function (...args) { reads++; return realStyle.apply(window, args); };
        Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get() { reads++; return offsetHeightDesc.get.call(this); } });
        Object.defineProperty(Element.prototype, 'scrollHeight', { configurable: true, get() { reads++; return scrollHeightDesc.get.call(this); } });
    }
    function restore() {
        Element.prototype.getBoundingClientRect = realRect;
        window.getComputedStyle = realStyle;
        Object.defineProperty(HTMLElement.prototype, 'offsetHeight', offsetHeightDesc);
        Object.defineProperty(Element.prototype, 'scrollHeight', scrollHeightDesc);
    }

    host.mobileMetrics = null;
    instrument();
    host.setMobileTopbarCollapse(10);       // cold cache: this is the one measuring pass
    let coldReads = reads;
    reads = 0;
    for (let i = 0; i < 60; i++) {          // 60 warm frames, as a scroll or drag would produce
        host.setMobileTopbarCollapse(10 + i);
    }
    let warmReads = reads;
    reads = 0;
    let legacyWarm = 0;
    for (let i = 0; i < 60; i++) {
        legacyTopHeight(10 + i);
    }
    legacyWarm = reads;
    restore();

    // Coalescing: a burst of scheduled collapses must produce exactly one apply, on the next frame.
    let applies = 0;
    let realSet = host.setMobileTopbarCollapse.bind(host);
    host.setMobileTopbarCollapse = (px) => { applies++; realSet(px); };
    for (let i = 0; i < 40; i++) {
        host.scheduleTopbarCollapse(i);
    }
    let appliesDuringBurst = applies;
    return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => {
        resolve({ mismatches, coldReads, warmReads, legacyWarm, appliesDuringBurst, appliesAfterFrame: applies, finalPx: host.mobileTopbarCollapsePx });
    })));
}, { layoutMethods });

check('cached root offset matches the live measurement across the collapse range', perfOut.mismatches.length === 0, `${41 - perfOut.mismatches.length}/41 sweep points exact${perfOut.mismatches.length ? ` - first ${JSON.stringify(perfOut.mismatches[0])}` : ''}`);
check('cold cache still measures once', perfOut.coldReads > 0, `${perfOut.coldReads} reads on the first call`);
check('warm hot path performs zero layout reads', perfOut.warmReads === 0, `${perfOut.warmReads} reads over 60 frames (was ${perfOut.legacyWarm})`);
check('the old implementation really did read every frame (check is non-vacuous)', perfOut.legacyWarm >= 60, `${perfOut.legacyWarm} reads over the same 60 frames`);
check('a burst of scheduled collapses applies nothing synchronously', perfOut.appliesDuringBurst === 0, `${perfOut.appliesDuringBurst} applies during a 40-event burst`);
check('a burst of scheduled collapses coalesces to one apply', perfOut.appliesAfterFrame === 1, `${perfOut.appliesAfterFrame} apply after the frame`);
check('coalescing keeps the newest value, not the oldest', perfOut.finalPx === 39, `landed on ${perfOut.finalPx}, expected 39`);

// ---- Part 3: the lazy-load scan throttles ----------------------------------------------------------

const lazyOut = await page.evaluate(async ({ layoutLazy, browserLazy }) => {
    let scans = 0;
    let browserUtil = { makeVisible: () => { scans++; } };
    let GenTabLayout = { LazyScanMs: 150 };
    // Backdated so the first call is unambiguously past the throttle window. performance.now() restarts
    // with the document, so leaving this at 0 makes the branch depend on how long the earlier parts took.
    let host = { lastLazyScan: performance.now() - 1000, lazyScanTimer: null };
    eval(`Object.assign(host, {${layoutLazy}});`);
    // 200 layout passes back to back, as a burst of keystrokes or iOS keyboard events produces.
    for (let i = 0; i < 200; i++) {
        host.scheduleLazyLoadScan();
    }
    let burstScans = scans;
    // The throttle must not DROP the trailing update - the last pass still has to be reflected.
    await new Promise(r => setTimeout(r, GenTabLayout.LazyScanMs + 80));
    let afterSettle = scans;

    let browserScans = 0;
    let util = Object.create(null);
    util.pendingVisible = new Set();
    util.makeVisible = () => { browserScans++; };
    eval(`Object.assign(util, {${browserLazy}});`);
    let elem = document.getElementById('t2i_root');
    let other = document.getElementById('bottom_bar');
    for (let i = 0; i < 40; i++) {          // 40 scroll events in one frame, over two containers
        util.scheduleVisible(elem);
        util.scheduleVisible(other);
    }
    let duringFrame = browserScans;
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    return { burstScans, afterSettle, duringFrame, afterFrame: browserScans };
}, { layoutLazy: extractMethod(layoutSrc, 'scheduleLazyLoadScan'), browserLazy: extractMethod(readFileSync(`${REPO}/src/wwwroot/js/genpage/helpers/browsers.js`, 'utf8'), 'scheduleVisible') });

check('200 layout passes collapse to a single immediate lazy scan', lazyOut.burstScans === 1, `${lazyOut.burstScans} scans (was 200)`);
check('the throttled burst still gets its trailing scan (nothing dropped)', lazyOut.afterSettle === 2, `${lazyOut.afterSettle} scans once settled`);
check('browser scroll lazy scans do nothing synchronously', lazyOut.duringFrame === 0, `${lazyOut.duringFrame} scans during the burst`);
check('80 browser scroll events collapse to one scan per container', lazyOut.afterFrame === 2, `${lazyOut.afterFrame} scans after the frame (was 80)`);

// ---- Part 4: the lazy multiselect ------------------------------------------------------------------
//
// A 'list' parameter ships every valid value, and T2IParamTypes.Loras ships every LoRA in the library. At
// the fork owner's 18.5k that was 16.7s of page load, on a phone-class CPU, for a control that is
// IsAdvanced + VisibleNormally:false. These checks pin down that the lazy form still behaves.

const siteSrc = readFileSync(`${REPO}/src/wwwroot/js/site.js`, 'utf8');
/** Pull a top-level `function name(...) {...}` out of a file by brace-matching. */
function extractFunction(src, name) {
    const sigIdx = src.indexOf(`\nfunction ${name}(`);
    if (sigIdx < 0) {
        throw new Error(`function ${name} not found`);
    }
    let i = src.indexOf('{', sigIdx);
    let depth = 0;
    for (let j = i; j < src.length; j++) {
        if (src[j] == '{') { depth++; }
        else if (src[j] == '}') {
            depth--;
            if (depth == 0) {
                return src.slice(sigIdx + 1, j + 1);
            }
        }
    }
    throw new Error(`unbalanced braces in ${name}`);
}

const lazyPage = await browser.newPage({ viewport: { width: 430, height: 932 } });
await lazyPage.setContent('<!doctype html><html><body><div id="host"></div></body></html>');
await lazyPage.addScriptTag({ content: readFileSync(`${REPO}/src/wwwroot/js/lib/jquery.min.js`, 'utf8') });
await lazyPage.addScriptTag({ content: readFileSync(`${REPO}/src/wwwroot/js/lib/select2.min.js`, 'utf8') });

const multiOut = await lazyPage.evaluate(({ makeMulti, fillLazy, threshold }) => {
    // Minimal stand-ins for the page helpers makeMultiselectInput leans on, so the real function runs.
    function escapeHtml(t) { return `${t}`.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;'); }
    function escapeHtmlNoBr(t) { return escapeHtml(t); }
    function translateableHtml(t) { return t; }
    function getToggleHtml() { return ''; }
    function getPopoverElemsFor() { return ['', '']; }
    let multiselectLazyThreshold = threshold;
    eval(makeMulti);
    eval(fillLazy);

    let big = [];
    for (let i = 0; i < 18561; i++) {
        big.push(`some/folder/path/loraName_v${i}_epoch12.safetensors`);
    }
    let small = ['alpha', 'beta', 'gamma'];
    let host = document.getElementById('host');

    // Small lists must be completely unaffected - this is the desktop/stock-install path.
    host.innerHTML = makeMultiselectInput('', 'small_sel', 'p', 'Small', '', small, 'beta', 'Select...');
    let smallElem = document.getElementById('small_sel');
    let smallEager = { options: smallElem.options.length, lazyFlag: !!smallElem.dataset.lazyOptions, selected: [...smallElem.selectedOptions].map(o => o.value) };

    host.innerHTML = makeMultiselectInput('', 'loras_sel', 'loras', 'LoRAs', '', big, '', 'Select...');
    let elem = document.getElementById('loras_sel');
    let emittedOptions = elem.options.length;
    let htmlBytes = host.innerHTML.length;
    let lazyFlag = !!elem.dataset.lazyOptions;

    let t0 = performance.now();
    $(elem).select2({ theme: 'bootstrap-5', width: 'style', closeOnSelect: false });
    void host.offsetHeight;
    let initMs = performance.now() - t0;
    fillLazyMultiselectOnOpen('loras_sel', big);

    // The setDirectParamValue path: set two values while the option list is still empty.
    let vals = [big[5000], big[9000]];
    for (let val of vals) {
        if (val && !$(elem).find(`option[value="${val}"]`).length) {
            $(elem).append(new Option(val, val, false, false));
        }
    }
    $(elem).val(vals);
    $(elem).trigger('change');
    let selectedBeforeOpen = [...elem.selectedOptions].map(o => o.value);

    // Now open, which must fill the list exactly once and preserve the selection.
    $(elem).select2('open');
    let filled = elem.options.length;
    let selectedAfterOpen = [...elem.selectedOptions].map(o => o.value);
    let duplicates = elem.options.length - new Set([...elem.options].map(o => o.value)).size;
    $(elem).select2('close');
    $(elem).select2('open');
    let afterSecondOpen = elem.options.length;
    return { smallEager, emittedOptions, htmlBytes, lazyFlag, initMs, selectedBeforeOpen, selectedAfterOpen, filled, duplicates, afterSecondOpen, wanted: vals };
}, { makeMulti: extractFunction(siteSrc, 'makeMultiselectInput'), fillLazy: extractFunction(readFileSync(`${REPO}/src/wwwroot/js/genpage/gentab/params.js`, 'utf8'), 'fillLazyMultiselectOnOpen'), threshold: 500 });

check('a small value list keeps the original eager options', multiOut.smallEager.options === 3 && !multiOut.smallEager.lazyFlag, JSON.stringify(multiOut.smallEager));
check('a huge value list emits no options at page load', multiOut.emittedOptions === 0, `${multiOut.emittedOptions} options, ${(multiOut.htmlBytes / 1048576).toFixed(2)}MB of HTML (was 18561 / 2.28MB)`);
check('the huge list is flagged for lazy filling', multiOut.lazyFlag, 'data-lazy-options present');
check('select2 init over the empty list is fast', multiOut.initMs < 1000, `${multiOut.initMs.toFixed(0)}ms (was 6724ms at this size)`);
check('a value can still be set before the options exist', JSON.stringify(multiOut.selectedBeforeOpen) === JSON.stringify(multiOut.wanted), JSON.stringify(multiOut.selectedBeforeOpen));
check('opening fills the full option list', multiOut.filled === 18561, `${multiOut.filled} options after open`);
check('filling introduces no duplicate options', multiOut.duplicates === 0, `${multiOut.duplicates} duplicates`);
check('the selection survives the fill', JSON.stringify(multiOut.selectedAfterOpen) === JSON.stringify(multiOut.wanted), JSON.stringify(multiOut.selectedAfterOpen));
check('a second open does not fill again', multiOut.afterSecondOpen === 18561, `${multiOut.afterSecondOpen} options after reopening`);

// End-to-end wiring: the production path (real makeMultiselectInput + fillLazyMultiselectOnOpen +
// BusyIndicatorHelper together), proving the first tap on a huge dropdown defers past a paint instead of
// freezing inline. This is the actual bug report: opening the LoRA list should show something before it
// blocks, not nothing.
const wiredPage = await browser.newPage({ viewport: { width: 430, height: 932 } });
await wiredPage.setContent(`<!doctype html><html><head><style>${mobileCss}</style></head><body><div id="host"></div></body></html>`);
await wiredPage.addScriptTag({ content: readFileSync(`${REPO}/src/wwwroot/js/lib/jquery.min.js`, 'utf8') });
await wiredPage.addScriptTag({ content: readFileSync(`${REPO}/src/wwwroot/js/lib/select2.min.js`, 'utf8') });
await wiredPage.addScriptTag({ content: readFileSync(`${REPO}/src/BuiltinExtensions/MobileEnhancements/Assets/busy_indicator.js`, 'utf8') });

const wiredOut = await wiredPage.evaluate(async ({ makeMulti, fillLazy }) => {
    function escapeHtml(t) { return `${t}`.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;'); }
    function escapeHtmlNoBr(t) { return escapeHtml(t); }
    function translateableHtml(t) { return t; }
    function getToggleHtml() { return ''; }
    function getPopoverElemsFor() { return ['', '']; }
    let multiselectLazyThreshold = 500;
    eval(makeMulti);
    eval(fillLazy);

    let big = [];
    for (let i = 0; i < 18561; i++) {
        big.push(`some/folder/path/loraName_v${i}_epoch12.safetensors`);
    }
    let host = document.getElementById('host');
    host.innerHTML = makeMultiselectInput('', 'wired_sel', 'loras', 'LoRAs', '', big, '', 'Select...');
    let elem = document.getElementById('wired_sel');
    $(elem).select2({ theme: 'bootstrap-5', width: 'style', closeOnSelect: false });
    fillLazyMultiselectOnOpen('wired_sel', big);

    // Pre-select two values the way setDirectParamValue does, against the still-empty list.
    let wanted = [big[100], big[200]];
    for (let val of wanted) {
        $(elem).append(new Option(val, val, false, false));
    }
    $(elem).val(wanted).trigger('change');

    let openReturned = false;
    $(elem).select2('open');
    openReturned = true;
    // The critical assertion: immediately after select2('open') returns, the fill must NOT have happened
    // yet (proves preventDefault actually stopped the synchronous path) and the bar must already be visible
    // (proves show() ran before the deferred work).
    let optionsRightAfterOpen = elem.options.length;
    let barVisibleRightAfterOpen = document.querySelector('.swarm-busybar-visible') !== null;
    let resultsRenderedRightAfterOpen = document.querySelectorAll('.select2-results__option').length;

    // Now let the deferred work actually run.
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await new Promise(resolve => setTimeout(resolve, 0));

    return {
        openReturned,
        optionsRightAfterOpen,
        barVisibleRightAfterOpen,
        resultsRenderedRightAfterOpen,
        optionsAfterSettle: elem.options.length,
        barVisibleAfterSettle: document.querySelector('.swarm-busybar-visible') !== null,
        resultsAfterSettle: document.querySelectorAll('.select2-results__option').length,
        selectionSurvived: JSON.stringify([...elem.selectedOptions].map(o => o.value)) === JSON.stringify(wanted)
    };
}, { makeMulti: extractFunction(siteSrc, 'makeMultiselectInput'), fillLazy: extractFunction(readFileSync(`${REPO}/src/wwwroot/js/genpage/gentab/params.js`, 'utf8'), 'fillLazyMultiselectOnOpen') });

check('the first open on a huge list returns immediately (defers, does not block)', wiredOut.openReturned && wiredOut.optionsRightAfterOpen === 2, `${wiredOut.optionsRightAfterOpen} options present right after open() returned (was pre-seeded with 2)`);
check('the loading bar is already visible before the freeze starts', wiredOut.barVisibleRightAfterOpen, `visible=${wiredOut.barVisibleRightAfterOpen}`);
check('select2 has not rendered results yet at that same instant', wiredOut.resultsRenderedRightAfterOpen === 0, `${wiredOut.resultsRenderedRightAfterOpen} results rendered before the deferred fill ran`);
check('once settled, the full list is filled and rendered', wiredOut.optionsAfterSettle === 18561 && wiredOut.resultsAfterSettle > 18000, `${wiredOut.optionsAfterSettle} options, ${wiredOut.resultsAfterSettle} results rendered`);
check('the bar hides again once the dropdown has actually opened', !wiredOut.barVisibleAfterSettle, `still visible: ${wiredOut.barVisibleAfterSettle}`);
check('the pre-open selection survives the whole deferred round-trip', wiredOut.selectionSurvived, 'selection mismatch after defer+fill+reopen');

// ---- Part 5: the discrete loading bar --------------------------------------------------------------
//
// runDeferred() exists because a single-threaded JS freeze can't update its own progress - the only lever
// is painting SOMETHING before the freeze starts. These checks assert that paint actually happens (the bar
// is visible, and the browser has genuinely rendered a frame) before the heavy synchronous work runs, and
// that the reference-counted show/hide survives overlapping callers and a thrown error.

const busySrc = readFileSync(`${REPO}/src/BuiltinExtensions/MobileEnhancements/Assets/busy_indicator.js`, 'utf8');
const busyPage = await browser.newPage({ viewport: { width: 430, height: 932 } });
await busyPage.setContent(`<!doctype html><html><head><style>${mobileCss}</style></head><body></body></html>`);
await busyPage.addScriptTag({ content: busySrc.replace(/^let busyIndicator = new BusyIndicatorHelper\(\);\s*$/m, '') });

const busyOut = await busyPage.evaluate(async () => {
    let inst = new BusyIndicatorHelper();

    // Reference counting: two overlapping callers, bar must survive until BOTH have hidden.
    inst.show();
    inst.show();
    let visibleAfterTwoShows = inst.elem.classList.contains('swarm-busybar-visible');
    inst.hide();
    let visibleAfterOneHide = inst.elem.classList.contains('swarm-busybar-visible');
    inst.hide();
    let visibleAfterBothHide = inst.elem.classList.contains('swarm-busybar-visible');
    inst.hide();  // extra hide beyond the show count - must not go negative or throw
    let survivedExtraHide = inst.count === 0;

    // The actual paint-before-freeze guarantee: record whether the bar's real computed opacity (not just
    // the class) was 1 BEFORE the synchronous "heavy work" ran, using getComputedStyle - which forces the
    // browser to resolve the CSS transition, so this only reads 1 if a style/layout pass has genuinely
    // happened since the class was added.
    let opacityWhenHeavyWorkRan = null;
    let frameCountBeforeHeavyWork = 0;
    let framesSeen = 0;
    let counter = () => { framesSeen++; requestAnimationFrame(counter); };
    requestAnimationFrame(counter);
    await new Promise(resolve => {
        inst.runDeferred(() => {
            opacityWhenHeavyWorkRan = getComputedStyle(inst.elem).opacity;
            frameCountBeforeHeavyWork = framesSeen;
            resolve();
        });
    });

    // Error safety: a throwing fn must still release the bar via finally.
    let threw = false;
    try {
        await inst.runDeferred(() => { throw new Error('boom'); });
    }
    catch (e) {
        threw = true;
    }
    let hiddenAfterThrow = !inst.elem.classList.contains('swarm-busybar-visible');

    return { visibleAfterTwoShows, visibleAfterOneHide, visibleAfterBothHide, survivedExtraHide, opacityWhenHeavyWorkRan, frameCountBeforeHeavyWork, threw, hiddenAfterThrow };
});

check('bar stays visible while a second caller still holds it', busyOut.visibleAfterTwoShows && busyOut.visibleAfterOneHide, JSON.stringify(busyOut));
check('bar hides once every caller has released it', !busyOut.visibleAfterBothHide, `still visible: ${busyOut.visibleAfterBothHide}`);
check('an unmatched extra hide() does not go negative or throw', busyOut.survivedExtraHide, `count after extra hide: ${busyOut.survivedExtraHide}`);
check('runDeferred actually paints the bar before running the heavy work', busyOut.opacityWhenHeavyWorkRan === '1', `computed opacity was ${busyOut.opacityWhenHeavyWorkRan} when the heavy callback ran`);
check('at least one real animation frame elapsed before the heavy work ran', busyOut.frameCountBeforeHeavyWork >= 1, `${busyOut.frameCountBeforeHeavyWork} frames elapsed`);
check('a throwing callback still releases the bar (finally runs)', busyOut.threw && busyOut.hiddenAfterThrow, JSON.stringify(busyOut));

await browser.close();

const failed = results.filter(r => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
