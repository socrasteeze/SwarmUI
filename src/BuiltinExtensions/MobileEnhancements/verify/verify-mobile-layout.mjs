/**
 * Mobile-layout regression harness (fork). Re-run this after any upstream merge that touches
 * layout.js, genpage.css, or mobile.css - see the coupling watchlist in
 * docs/MobilePWA-Optimization-Plan.md and the layout.js entry in CLAUDE.md's Fork Delta.
 *
 * It guards the invariants established when the fork's mobile shell was retired (2026-08):
 * no shell CSS survives, the keyboard inset has no dead zone, the prompt bar lands flush above the
 * keyboard, mobile height math subtracts body padding, and the Simple/Comfy top tabs stay visible.
 *
 * Runs the REAL shipped source: the two layout.js methods under test are extracted from the file by
 * brace-matching (not retyped), and the real genpage.css + mobile.css are injected verbatim. The
 * viewport is a 430x932 phone, so window.innerHeight is genuinely 932 and geometry assertions are real.
 *
 * Requires playwright + a chromium build; neither is a repo dependency, so this is opt-in tooling
 * rather than part of the CI gate. Run from the repo root:
 *     node src/BuiltinExtensions/MobileEnhancements/verify/verify-mobile-layout.mjs
 * Set SWARM_CHROMIUM to override the browser path. Exits non-zero if any check fails.
 */
import { chromium } from 'playwright';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const LAYOUT_JS = `${REPO}/src/wwwroot/js/genpage/gentab/layout.js`;
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
const methods = [extractMethod(layoutSrc, 'getViewportHeight'), extractMethod(layoutSrc, 'getKeyboardInset')].join('\n');
const genpageCss = readFileSync(GENPAGE_CSS, 'utf8');
const mobileCss = readFileSync(MOBILE_CSS, 'utf8');

const results = [];
function check(name, pass, detail) {
    results.push({ name, pass, detail });
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
}

const browser = await chromium.launch(process.env.SWARM_CHROMIUM ? { executablePath: process.env.SWARM_CHROMIUM } : {});
const page = await browser.newPage({ viewport: { width: 430, height: 932 } });

await page.setContent(`<!doctype html><html><head>
<style>${genpageCss}</style>
<style>${mobileCss}</style>
</head><body class="small-window">
  <ul id="toptablist" class="nav nav-tabs">
    <li class="nav-item"><a class="nav-link" id="text2imagetabbutton" href="#Text2Image">Generate</a></li>
    <li class="nav-item"><a class="nav-link" id="simpletabbutton" href="#Simple">Simple</a></li>
    <li class="nav-item"><a class="nav-link" id="maintab_comfyworkflow" href="#comfyworkflow">Comfy Workflow</a></li>
  </ul>
  <div id="t2i_top_bar"><div id="main_image_area">
    <div id="alt_prompt_region"><textarea id="alt_prompt_textbox"></textarea>
      <div class="alt-prompt-buttons-wrapper"><button id="alt_generate_button">Generate</button></div>
    </div>
  </div></div>
  <div id="t2i_bottom_bar"></div>
</body></html>`);

// Install the real methods on a stub carrying just the fields they read.
await page.evaluate(({ methods }) => {
    window.__stub = { isSmallWindow: true, mobilePromptFocused: true };
    const cls = new Function(`return class Probe { ${methods} }`)();
    window.__stub.getViewportHeight = cls.prototype.getViewportHeight;
    window.__stub.getKeyboardInset = cls.prototype.getKeyboardInset;
    // Overridable fake visualViewport, so keyboard/scroll states can be scripted.
    window.__vv = { height: window.innerHeight, offsetTop: 0 };
    Object.defineProperty(window, 'visualViewport', { get: () => window.__vv, configurable: true });
}, { methods });

// ---- 1. No shell rules survive in the stylesheet, and no shell DOM exists ----
const shellCss = await page.evaluate(() => {
    const pats = ['mobile-shell-active', 'shell-drawer', 'shell-more', 'mobile-bottom-nav', 'mobile-options-fab',
        'mobile-more-sheet', 'mobile-drawer', 'mobile-sheet-backdrop', 'mobile-optional-tab'];
    const hits = [];
    for (const sheet of document.styleSheets) {
        for (const rule of sheet.cssRules) {
            if (rule.selectorText && pats.some(p => rule.selectorText.includes(p))) { hits.push(rule.selectorText); }
        }
    }
    return hits;
});
check('no shell CSS rules remain', shellCss.length == 0, shellCss.length ? `found ${JSON.stringify(shellCss)}` : '');

const shellBody = await page.evaluate(() => [...document.body.classList].filter(c => c.startsWith('shell-') || c == 'mobile-shell-active'));
check('body carries no shell classes', shellBody.length == 0, shellBody.join(','));

// ---- 2. Keyboard dead zone is gone ----
const KB = 380, INNER = 932;
const sweep = await page.evaluate(({ KB, INNER }) => {
    const out = [];
    for (let offsetTop = 0; offsetTop <= KB; offsetTop += 20) {
        window.__vv = { height: INNER - KB, offsetTop };
        out.push({ offsetTop, inset: window.__stub.getKeyboardInset(), want: Math.max(0, KB - offsetTop) });
    }
    return out;
}, { KB, INNER });
const bad = sweep.filter(s => s.inset != (s.want < 2 ? 0 : s.want));
check('keyboard inset exact across full offsetTop sweep (0..380)', bad.length == 0,
    bad.length ? `mismatches: ${JSON.stringify(bad.slice(0, 3))}` : `${sweep.length} states, all exact`);

const dropped = sweep.filter(s => s.want >= 2 && s.inset == 0);
check('no lift is silently discarded while keyboard is up', dropped.length == 0,
    dropped.length ? `dropped at offsetTop=${dropped.map(d => d.offsetTop).join(',')}` : '');

const regression = sweep.find(s => s.offsetTop == 340);
check('regression case offsetTop=340 of a 380px keyboard returns 40 (old 60px floor returned 0)',
    regression.inset == 40, `got ${regression.inset}`);

// ---- 3. Prompt bar lands flush on the visible band's bottom edge ----
const flush = await page.evaluate(({ INNER }) => {
    const region = document.getElementById('alt_prompt_region');
    const out = [];
    for (const [kb, offsetTop] of [[0, 0], [380, 0], [380, 100], [380, 200], [380, 300], [380, 340], [380, 370], [300, 150], [420, 60], [250, 249], [380, 379], [380, 380]]) {
        window.__vv = { height: INNER - kb, offsetTop };
        const inset = window.__stub.getKeyboardInset();
        document.body.classList.toggle('mobile-keyboard-pin', inset > 0);
        document.documentElement.style.setProperty('--mobile-keyboard-inset', `${inset}px`);
        const bottom = Math.round(region.getBoundingClientRect().bottom);
        out.push({ kb, offsetTop, inset, bottom, bandBottom: window.__vv.offsetTop + window.__vv.height });
    }
    return out;
}, { INNER });
const notFlush = flush.filter(f => f.inset > 0 && f.bottom != f.bandBottom);
check('#alt_prompt_region bottom edge == visible band bottom in every pinned state', notFlush.length == 0,
    notFlush.length ? JSON.stringify(notFlush) : `${flush.filter(f => f.inset > 0).length} pinned states all flush`);

// Convergence: repeated event bursts must settle on one value, not oscillate.
const burst = await page.evaluate(({ INNER }) => {
    window.__vv = { height: INNER - 380, offsetTop: 200 };
    const seen = new Set();
    for (let i = 0; i < 40; i++) {
        const inset = window.__stub.getKeyboardInset();
        document.documentElement.style.setProperty('--mobile-keyboard-inset', `${inset}px`);
        document.getElementById('alt_prompt_region').getBoundingClientRect();
        seen.add(inset);
    }
    return [...seen];
}, { INNER });
check('40 repeated measurements converge to a single value', burst.length == 1, `values seen: ${burst.join(',')}`);

// ---- 4. Height math respects body padding-bottom ----
const heights = await page.evaluate(() => {
    document.body.style.paddingBottom = '';
    const noPad = window.__stub.getViewportHeight();
    document.body.style.paddingBottom = '34px';
    const withPad = window.__stub.getViewportHeight();
    document.body.style.paddingBottom = '';
    return { noPad, withPad, inner: window.innerHeight };
});
check('getViewportHeight() == innerHeight with no body padding (desktop unchanged)',
    heights.noPad == heights.inner, `${heights.noPad} vs ${heights.inner}`);
check('getViewportHeight() subtracts body padding-bottom exactly',
    heights.withPad == heights.inner - 34, `${heights.withPad}, expected ${heights.inner - 34}`);

// ---- 5. Simple / Comfy Workflow top tabs are visible on mobile ----
// Apply the class the deleted tagOptionalTopTabs() used to add, so this asserts the CSS rule is really
// gone rather than merely that nothing tagged the tabs (which would pass vacuously either way).
const tabs = await page.evaluate(() => {
    const get = id => {
        const el = document.getElementById(id);
        el.classList.add('mobile-optional-tab');
        const cs = getComputedStyle(el);
        return { display: cs.display, visible: el.getBoundingClientRect().width > 0 };
    };
    return { simple: get('simpletabbutton'), comfy: get('maintab_comfyworkflow') };
});
check('Simple top tab visible at small-window', tabs.simple.display != 'none' && tabs.simple.visible, JSON.stringify(tabs.simple));
check('Comfy Workflow top tab visible at small-window', tabs.comfy.display != 'none' && tabs.comfy.visible, JSON.stringify(tabs.comfy));

await browser.close();

const failed = results.filter(r => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
