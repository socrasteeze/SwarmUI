/**
 * /simple clipboard-paste harness (fork). The quick row has no clipboard button. Pasting an image into the
 * prompt still attaches it, while text remains prompt text. The attachment + remains the explicit file path.
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

const TOAST = '<div class="center-toast toast-error-box" id="center_toast">'
    + '<div class="toast hide" id="error_toast_box"><div class="toast-body" id="error_toast_content"></div></div></div>';
const html = readFileSync(`${M}/index.html`, 'utf8')
    .replace('[HEADEXTRA]', '')
    .replace('[REMAPS]', '[]')
    .replaceAll('[TOAST]', TOAST)
    .replaceAll('[VARY]', '1');

/** Client modules served from the real tree. m_app.js is deliberately absent - booting needs a server. */
const CLIENT = ['m.css', 'm_state.js', 'm_gen.js', 'm_ui.js', 'm_autocomplete.js', 'm_coach.js', 'm_create.js', 'm_grid.js', 'm_presets.js', 'm_images.js', 'm_models.js'];
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
});

/** Prompt images currently attached, as {kind, value-prefix} so a data URI is comparable. */
const images = () => page.evaluate(() => mState.promptImages.map(i => ({ kind: i.kind, head: `${i.value}`.substring(0, 24) })));
/** Wipes attached images so each case starts from the same place. */
const reset = () => page.evaluate(() => {
    mState.promptImages = [];
    mState.changed();
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
/** Waits for the FileReader in addImageFile to land. */
const gotImages = (count) => page.waitForFunction(n => mState.promptImages.length >= n, count, { timeout: 2000 })
    .then(() => true, () => false);

check('quick row has no clipboard button', await page.evaluate(() => !document.querySelector('.m-batch-group [aria-label="Paste clipboard as prompt image"]')));

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
