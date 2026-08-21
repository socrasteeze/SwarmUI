/**
 * /simple clipboard-paste harness (fork). One claim, in two halves:
 *
 * 1. The 📋 button never dead-ends. `navigator.clipboard` is undefined outside a secure context, and this
 *    client is normally reached at a LAN address over plain HTTP, so on a phone the read API is simply not
 *    there - and `read()` rejects besides whenever the permission is denied or the document is not focused.
 *    Every one of those cases has to land in the paste sheet, not in a toast telling the user to go paste
 *    somewhere else.
 * 2. The sheet actually attaches. A paste into it, of an image file, of a Swarm path, or of markup with only
 *    an <img> behind it, ends up in mState.promptImages - and a paste with nothing usable in it says so and
 *    leaves the sheet open to try again.
 *
 * The API path is covered too, in both directions: it still attaches when the browser does hand over the
 * clipboard, and it falls through to the sheet when it doesn't.
 *
 * Runs the REAL shipped source, the same way verify-simple-create-panel.mjs does: index.html with its server
 * tokens substituted, the real m.css and m_*.js, Create panel built directly, no server. Clipboard events are
 * hand-built DataTransfers dispatched at the real listeners - not calls to the handlers' internals - because
 * "does a paste attach an image" is a question about the listener wiring as much as the parsing.
 *
 * Requires playwright + a chromium build; neither is a repo dependency, so this is opt-in tooling rather than
 * part of the CI gate. Run from the repo root:
 *     node src/BuiltinExtensions/MobileEnhancements/verify/verify-simple-clipboard-paste.mjs
 * Set SWARM_CHROMIUM to override the browser path. Exits non-zero if any check fails.
 */
import { chromium } from 'playwright';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const M = `${REPO}/src/BuiltinExtensions/MobileEnhancements/Assets/m`;
const WIDTH = 390, HEIGHT = 844;
const PIXEL = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

const TOAST = '<div class="center-toast toast-error-box" id="center_toast">'
    + '<div class="toast hide" id="error_toast_box"><div class="toast-body" id="error_toast_content"></div></div></div>';
const html = readFileSync(`${M}/index.html`, 'utf8')
    .replace('[HEADEXTRA]', '')
    .replace('[REMAPS]', '[]')
    .replaceAll('[TOAST]', TOAST)
    .replaceAll('[VARY]', '1');

/** Client modules served from the real tree. m_app.js is deliberately absent - booting needs a server. */
const CLIENT = ['m.css', 'm_state.js', 'm_gen.js', 'm_ui.js', 'm_autocomplete.js', 'm_create.js', 'm_images.js', 'm_models.js'];
const FILES = {
    '/js/util.js': `${REPO}/src/wwwroot/js/util.js`,
    '/css/site.css': `${REPO}/src/wwwroot/css/site.css`,
    '/css/themes/modern.css': `${REPO}/src/wwwroot/css/themes/modern.css`,
    '/css/themes/modern_dark.css': `${REPO}/src/wwwroot/css/themes/modern_dark.css`,
};
for (const file of CLIENT) {
    FILES[`/ExtensionFile/MobileEnhancementsExtension/Assets/m/${file}`] = `${M}/${file}`;
}

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
// Stands in for site.js: only the handful of globals the Create panel touches, all of them server-facing.
await page.addInitScript(() => {
    window.showError = function (message) { window.__err = message; };
    window.getUserSetting = () => '';
    window.genericRequest = () => {};
    window.makeWSRequest = () => null;
    window.getSession = () => {};
    window.getImageOutPrefix = () => 'View/local';
    window.isValidMediaPath = (path) => typeof path == 'string' && (path.startsWith('inputs/') || path.startsWith('raw/') || path.startsWith('Starred/'));
    window.getTextSelRange = () => [0, 0];
    window.session_id = 'test';
    window.permissions = { hasPermission: () => true };
});
page.on('pageerror', e => check(`no page errors (${e.message})`, false));

await page.goto('http://localhost/simple');
await page.waitForFunction(() => typeof mCreate != 'undefined');
await page.evaluate(() => {
    let panel = document.querySelector('.m-panel[data-mtab="create"]');
    panel.classList.add('m-tab-active');
    mCreate.build(panel);
    // Test helpers, all of them about observing rather than substituting: the file picker is a native dialog
    // this harness cannot open, and the sheet's close is on a 250ms timer that would otherwise race the
    // assertions that follow it.
    window.__picked = 0;
    mCreate.fileInput.click = () => { window.__picked++; };
});

/** The client's own toast text, which is where mUI.note/mUI.warn land. */
const toast = () => page.evaluate(() => {
    let box = document.querySelector('.m-toast');
    return box ? { text: box.textContent, warn: box.classList.contains('m-toast-warn'), open: box.classList.contains('m-toast-open') } : null;
});
/** Prompt images currently attached, as {kind, value-prefix} so a data URI is comparable. */
const images = () => page.evaluate(() => mState.promptImages.map(i => ({ kind: i.kind, head: `${i.value}`.substring(0, 24) })));
/** Wipes attached images, toast and any open sheet, so each case starts from the same place. */
const reset = () => page.evaluate(() => {
    mState.promptImages = [];
    mState.changed();
    for (let elem of document.querySelectorAll('.m-sheet, .m-sheet-backdrop')) {
        elem.remove();
    }
    let box = document.querySelector('.m-toast');
    if (box) {
        box.textContent = '';
        box.classList.remove('m-toast-open', 'm-toast-warn');
    }
});
/** Dispatches a real paste event at a real element. `files` are [name, type] pairs; `text` is text/plain. */
const paste = (selector, files, text) => page.evaluate(([sel, fileList, plain]) => {
    let data = new DataTransfer();
    for (let entry of fileList) {
        data.items.add(new File([new Uint8Array([1, 2, 3, 4])], entry[0], { 'type': entry[1] }));
    }
    if (plain) {
        data.setData('text/plain', plain);
    }
    let elem = document.querySelector(sel);
    let event = new ClipboardEvent('paste', { 'clipboardData': data, 'bubbles': true, 'cancelable': true });
    elem.dispatchEvent(event);
    return event.defaultPrevented;
}, [selector, files || [], text || '']);
/** True once the paste sheet is gone (openSheet's close() removes it on a 250ms timer). */
const sheetGone = () => page.waitForFunction(() => !document.querySelector('.m-paste-box'), null, { timeout: 2000 })
    .then(() => true, () => false);
const sheetOpen = () => page.evaluate(() => !!document.querySelector('.m-paste-box'));
/** Waits for the FileReader in addImageFile to land. */
const gotImages = (count) => page.waitForFunction(n => mState.promptImages.length >= n, count, { timeout: 2000 })
    .then(() => true, () => false);

// ---- Insecure context: navigator.clipboard is not there at all, which is every LAN address over HTTP ----
await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', { 'value': undefined, 'configurable': true });
});
await reset();
await page.click('.m-batch-group .m-seg-button[aria-label="Paste clipboard as prompt image"]');
check('no clipboard API: the button opens the paste sheet instead of dead-ending', await sheetOpen());
check('no clipboard API: it did not just warn and stop', (await toast())?.open != true, JSON.stringify(await toast()));
check('the paste box is contenteditable, which is what lets a phone paste an IMAGE into it',
    await page.evaluate(() => {
        let box = document.querySelector('.m-paste-box');
        return box.isContentEditable && box.getAttribute('role') == 'textbox';
    }));
check('the sheet offers the photo-library fallback too',
    await page.evaluate(() => !!document.querySelector('.m-paste-box') && [...document.querySelectorAll('.m-sheet .m-wide-button')].some(b => b.textContent == 'Choose an image instead')));

// ---- Pasting an image file into the box attaches it ----
const preventedImage = await paste('.m-paste-box', [['shot.png', 'image/png']]);
check('paste of an image file is consumed by the box', preventedImage);
check('paste of an image file attaches it', await gotImages(1));
check('...as data bytes, not a path', JSON.stringify(await images()) == JSON.stringify([{ kind: 'data', head: 'data:image/png;base64,AQ' }]), JSON.stringify(await images()));
check('a successful paste closes the sheet', await sheetGone());
check('...and says so as a note, not a warning', (await toast())?.text == 'Pasted image.' && (await toast())?.warn == false, JSON.stringify(await toast()));

// ---- A Swarm output path pasted as text is attached as a path, not as base64 ----
await reset();
await page.click('.m-batch-group .m-seg-button[aria-label="Paste clipboard as prompt image"]');
await paste('.m-paste-box', [], 'raw/2026-08-21/00001-a.png');
check('paste of a Swarm path attaches it as kind:path',
    JSON.stringify(await images()) == JSON.stringify([{ kind: 'path', head: 'raw/2026-08-21/00001-a.p' }]), JSON.stringify(await images()));

// ---- Markup-only paste: no file, no usable text, just an <img> the browser dropped in the box ----
await reset();
await page.click('.m-batch-group .m-seg-button[aria-label="Paste clipboard as prompt image"]');
await page.evaluate(pixel => {
    // What a real "copy image from a web page" paste leaves behind once the default action has run. The
    // synthetic event below carries nothing, exactly as that case does.
    document.querySelector('.m-paste-box').innerHTML = `<img src="${pixel}">`;
}, PIXEL);
await paste('.m-paste-box', [], '');
check('markup-only paste is read back out of the box', await gotImages(1));
check('...as the image bytes it points at', (await images())[0]?.kind == 'data', JSON.stringify(await images()));
check('markup-only paste closes the sheet too', await sheetGone());

// ---- Nothing usable: it says so, and it does NOT close the sheet out from under the user ----
await reset();
await page.click('.m-batch-group .m-seg-button[aria-label="Paste clipboard as prompt image"]');
await paste('.m-paste-box', [], 'just some prompt words');
await page.waitForTimeout(200);
check('unusable paste attaches nothing', (await images()).length == 0, JSON.stringify(await images()));
check('unusable paste warns', (await toast())?.warn == true && (await toast())?.open == true, JSON.stringify(await toast()));
check('unusable paste leaves the sheet open to try again', await sheetOpen());
check('...with the box cleared rather than holding the failed paste',
    await page.evaluate(() => document.querySelector('.m-paste-box').innerHTML == ''));

// ---- The photo-library fallback ----
await page.click('.m-sheet .m-wide-button');
check('"Choose an image instead" opens the file picker', await page.evaluate(() => window.__picked) == 1);
check('...and closes the sheet', await sheetGone());

// ---- The API path still works when the browser does hand the clipboard over ----
await reset();
await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', {
        'value': {
            'read': () => Promise.resolve([{
                'types': ['image/png'],
                'getType': () => Promise.resolve(new Blob([new Uint8Array([1, 2, 3, 4])], { 'type': 'image/png' }))
            }])
        },
        'configurable': true
    });
});
await page.click('.m-batch-group .m-seg-button[aria-label="Paste clipboard as prompt image"]');
check('clipboard.read() success still attaches directly', await gotImages(1));
check('...without opening the sheet at all', !await sheetOpen());

// ---- ...and a rejected read (permission denied, unfocused document, extensions-only) falls through ----
await reset();
await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', {
        'value': { 'read': () => Promise.reject(new Error('NotAllowedError')) },
        'configurable': true
    });
});
await page.click('.m-batch-group .m-seg-button[aria-label="Paste clipboard as prompt image"]');
await page.waitForTimeout(100);
check('a rejected clipboard.read() opens the sheet rather than warning', await sheetOpen());
check('...and does not warn on the way there', (await toast())?.open != true, JSON.stringify(await toast()));

// ---- The prompt box keeps its own paste behaviour: images attach, text stays text ----
await reset();
const preventedPrompt = await paste('.m-prompt-box', [['shot.png', 'image/png']]);
check('prompt box still attaches a pasted image', await gotImages(1) && preventedPrompt);
await reset();
const preventedText = await paste('.m-prompt-box', [], 'raw/2026-08-21/00001-a.png');
check('prompt box does NOT attach pasted text - a path typed into a prompt is text',
    (await images()).length == 0 && !preventedText, JSON.stringify(await images()));

await browser.close();
const failed = results.filter(r => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
