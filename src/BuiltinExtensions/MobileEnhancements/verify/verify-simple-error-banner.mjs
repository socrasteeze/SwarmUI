/**
 * /simple error-strip harness (fork). Guards the one property the header error strip exists for: an error
 * arriving, expanding, or clearing must move nothing else on screen. That is a geometry claim, so it is
 * measured rather than reasoned about - the old center_toast was replaced precisely because it covered the
 * header, the prompt box and the model strip on a phone.
 *
 * Runs the REAL shipped source: index.html with its server tokens substituted the way ServeMobileClient
 * substitutes them, the real m.css over the real site.css/modern.css/modern_dark.css stack, and the real
 * m_ui.js (which is where mUI.error and the showError override live). Every other script the page asks for is
 * stubbed empty - m_app.js in particular, so nothing tries to boot against a server that isn't running - and
 * site.js's showError is stubbed to a recorder, so "showError reached the strip and not the toast" is a real
 * assertion about the override rather than an artifact of the stub.
 *
 * Requires playwright + a chromium build; neither is a repo dependency, so this is opt-in tooling rather than
 * part of the CI gate. Run from the repo root:
 *     node src/BuiltinExtensions/MobileEnhancements/verify/verify-simple-error-banner.mjs
 * Set SWARM_CHROMIUM to override the browser path. Exits non-zero if any check fails.
 */
import { chromium } from 'playwright';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const M = `${REPO}/src/BuiltinExtensions/MobileEnhancements/Assets/m`;
const WIDTH = 390, HEIGHT = 844;

/** The markup MobileEnhancementsExtension substitutes for [TOAST] - WebUtil.Toast's shape, kept minimal:
 *  what matters here is that the ids site.js hard-requires exist, so "the toast did NOT show" is testable. */
const TOAST = '<div class="center-toast toast-error-box" id="center_toast">'
    + '<div class="toast hide" id="error_toast_box"><div class="toast-header"><strong class="me-auto">Error</strong></div>'
    + '<div class="toast-body" id="error_toast_content"></div></div></div>';

const html = readFileSync(`${M}/index.html`, 'utf8')
    .replace('[HEADEXTRA]', '')
    .replace('[REMAPS]', '[]')
    .replaceAll('[TOAST]', TOAST)
    .replaceAll('[VARY]', '1');

/** Page paths served from the real tree. Anything else resolves to an empty script. */
const FILES = {
    '/css/bootstrap.min.css': `${REPO}/src/wwwroot/css/bootstrap.min.css`,
    '/css/site.css': `${REPO}/src/wwwroot/css/site.css`,
    '/css/themes/modern.css': `${REPO}/src/wwwroot/css/themes/modern.css`,
    '/css/themes/modern_dark.css': `${REPO}/src/wwwroot/css/themes/modern_dark.css`,
    '/ExtensionFile/MobileEnhancementsExtension/Assets/m/m.css': `${M}/m.css`,
    '/ExtensionFile/MobileEnhancementsExtension/Assets/m/m_ui.js': `${M}/m_ui.js`,
};

const results = [];
function check(name, pass, detail) {
    results.push({ name, pass });
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
}

const browser = await chromium.launch(process.env.SWARM_CHROMIUM ? { executablePath: process.env.SWARM_CHROMIUM } : {});
const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } });

await page.route('**/*', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path == '/simple') {
        return route.fulfill({ contentType: 'text/html', body: html });
    }
    const file = FILES[path];
    if (file) {
        return route.fulfill({ contentType: file.endsWith('.css') ? 'text/css' : 'application/javascript', body: readFileSync(file, 'utf8') });
    }
    return route.fulfill({ contentType: 'application/javascript', body: '' });
});
// Stands in for site.js: showError as a plain global function declaration, which is what the override at the
// bottom of m_ui.js reassigns, and the user setting its filter reads.
await page.addInitScript(() => {
    window.showError = function (message) { window.__toastMessage = message; };
    window.getUserSetting = () => '';
});
page.on('pageerror', e => check(`no page errors (${e.message})`, false));

await page.goto('http://localhost/simple');
await page.waitForFunction(() => typeof mUI != 'undefined');

const geometry = () => page.evaluate(() => {
    const box = sel => document.querySelector(sel).getBoundingClientRect();
    return {
        header: box('.m-header').height,
        panelTop: box('.m-panels').top,
        panelHeight: box('.m-panels').height,
        navTop: box('.m-bottom-nav').top,
        docWidth: document.documentElement.scrollWidth,
    };
});
const SHORT = 'Generation failed: Generation session interrupted.';
const LONG = 'Generation failed: Generation session interrupted. Traceback follows with a long unbroken path'
    + ' models/loras/a/deeply/nested/folder/some_model_file.safetensors and a good deal more text after it.';

const before = await geometry();

// ---- 1. showError lands in the strip, and the shared toast stays down ----
await page.evaluate(msg => showError(msg), SHORT);
check('showError routes to the header strip', await page.evaluate(() => document.querySelector('.m-header-error').style.display != 'none'));
check('center_toast stays hidden', await page.evaluate(() => !document.querySelector('#error_toast_box').classList.contains('show')));
check('the strip carries the message', (await page.textContent('.m-header-error-text')).includes('session interrupted'));
check('the title yields its space rather than the strip stacking below it',
    await page.evaluate(() => getComputedStyle(document.querySelector('.m-header-title')).display == 'none'));
check('the header More link stays visible, on one line', await page.evaluate(() => {
    const link = document.querySelector('.m-header-link');
    // It is a 44px-tall tap target by design, so height proves nothing about wrapping - count line boxes.
    const range = document.createRange();
    range.selectNodeContents(link);
    return link.getBoundingClientRect().width > 0 && range.getClientRects().length == 1;
}));

// ---- 2. Nothing moves ----
const shown = await geometry();
check('header height unchanged while erred', shown.header == before.header, `${before.header} -> ${shown.header}`);
check('panels do not move or resize', shown.panelTop == before.panelTop && shown.panelHeight == before.panelHeight,
    `top ${before.panelTop} -> ${shown.panelTop}, height ${before.panelHeight} -> ${shown.panelHeight}`);
check('bottom nav does not move', shown.navTop == before.navTop, `${before.navTop} -> ${shown.navTop}`);
check('no horizontal overflow', shown.docWidth <= WIDTH, `scrollWidth ${shown.docWidth}`);

// ---- 3. A long message clips to one line instead of growing the header ----
await page.evaluate(msg => showError(msg), LONG);
const long = await geometry();
check('a long message leaves the header height alone', long.header == before.header, `${before.header} -> ${long.header}`);
check('a long message is clipped, not wrapped', await page.evaluate(() => {
    const line = document.querySelector('.m-header-error-text');
    return line.scrollWidth > line.clientWidth && line.getBoundingClientRect().height <= 44;
}));
check('no horizontal overflow on a long message', long.docWidth <= WIDTH, `scrollWidth ${long.docWidth}`);

// ---- 4. The detail panel is an overlay, not a reflow ----
await page.click('.m-header-error-text');
const expanded = await geometry();
check('the detail panel shows the untruncated text', await page.evaluate(msg => {
    const detail = document.querySelector('.m-header-error-detail');
    return detail.style.display != 'none' && detail.textContent == msg && detail.getBoundingClientRect().height > 20;
}, LONG));
check('expanding still moves nothing', expanded.panelTop == before.panelTop && expanded.header == before.header,
    `panelTop ${before.panelTop} -> ${expanded.panelTop}, header ${before.header} -> ${expanded.header}`);
check('the detail panel hangs off the bottom of the header, clear of its border', await page.evaluate(() => {
    const detail = document.querySelector('.m-header-error-detail').getBoundingClientRect();
    const header = document.querySelector('.m-header').getBoundingClientRect();
    return Math.abs(detail.top - header.bottom) < 1 && detail.width > 300;
}));
await page.click('.m-header-error-text');
check('tapping again closes the detail panel', await page.evaluate(() => document.querySelector('.m-header-error-detail').style.display == 'none'));

// ---- 5. Dismissal, both routes ----
await page.evaluate(msg => showError(msg), SHORT);
await page.click('.m-header-error-x');
const cleared = await geometry();
check('the X hides the strip and restores the title', await page.evaluate(() => document.querySelector('.m-header-error').style.display == 'none'
    && getComputedStyle(document.querySelector('.m-header-title')).display != 'none'));
check('clearing moves nothing either', cleared.header == before.header && cleared.panelTop == before.panelTop && cleared.navTop == before.navTop);
await page.evaluate(msg => showError(msg), SHORT);
await page.evaluate(() => mUI.clearError());
check('mUI.clearError (the doGenerate path) clears it too',
    await page.evaluate(() => document.querySelector('.m-header-error').style.display == 'none'));

// ---- 6. The upstream ui.HideErrorMessages filter survives the override ----
await page.evaluate(() => { window.getUserSetting = () => 'session interrupted'; });
await page.evaluate(msg => showError(msg), SHORT);
check('ui.HideErrorMessages still suppresses matching errors',
    await page.evaluate(() => document.querySelector('.m-header-error').style.display == 'none'));
await page.evaluate(() => { window.getUserSetting = () => ''; });
// getUserSetting above only exists because the line before it invents one - it is a genpage global and /simple
// never loads the file that defines it. mUI.errorFilters is the source that actually populates on this client
// (from GetUserSettings), so it needs its own check or the filter can go dead again without failing anything.
await page.evaluate(() => { delete window.getUserSetting; mUI.setErrorFilters('session interrupted'); });
await page.evaluate(msg => showError(msg), SHORT);
check('mUI.errorFilters suppresses matching errors with no getUserSetting present',
    await page.evaluate(() => document.querySelector('.m-header-error').style.display == 'none'));
await page.evaluate(msg => showError(msg), 'a totally unrelated failure');
check('a non-matching error still shows while a filter is set',
    await page.evaluate(() => document.querySelector('.m-header-error').style.display != 'none'));
await page.evaluate(() => { mUI.setErrorFilters(''); mUI.clearError(); });

// ---- 7. Landscape (the manifest declares orientation "any", so this really happens) ----
await page.setViewportSize({ width: HEIGHT, height: WIDTH });
await page.evaluate(msg => showError(msg), SHORT);
const landscape = await geometry();
check('landscape: no horizontal overflow', landscape.docWidth <= HEIGHT, `scrollWidth ${landscape.docWidth}`);
check('landscape: panels still start under the header', await page.evaluate(() => Math.abs(
    document.querySelector('.m-panels').getBoundingClientRect().top - document.querySelector('.m-header').getBoundingClientRect().bottom) < 1));

await browser.close();

const failed = results.filter(r => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
