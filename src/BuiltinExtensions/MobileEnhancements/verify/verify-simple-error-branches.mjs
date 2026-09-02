/**
 * /simple failure-recovery harness (fork). Covers the three actions that used to call genericRequest with
 * three arguments - Interrupt, and the history viewer's Star and Delete. With no error handler the shared
 * transport falls back to the global showError path, which meant a refused call reached the header strip
 * while the control that made it sat there looking exactly as it had before the press: no pending state to
 * undo, no message beside the control, and nothing stopping a second press firing the same call again.
 *
 * Every check here is the failure path, because the success path is the one that already worked. For each
 * of the three:
 *
 * 1. The control changes in the press frame, so a hung call does not look like an ignored press.
 * 2. A second press while the first is in flight sends nothing.
 * 3. On refusal the control returns to exactly its original label and enabled state.
 * 4. The user gets the SERVER's message, not a generic one.
 *
 * Interrupt carries a fifth: it clears the preview optimistically, so a refusal must re-poll status rather
 * than leave the queue count describing an interrupt that never happened.
 *
 * Runs the REAL shipped source: index.html with its server tokens substituted, the real m.css, and the real
 * m_*.js modules, with the panels built directly instead of booting (m_app.js is stubbed out, since there is
 * no server here). genericRequest is scripted per route so a call can be held in flight, then failed.
 *
 * Requires playwright + a chromium build; neither is a repo dependency, so this is opt-in tooling rather than
 * part of the CI gate. Run from the repo root:
 *     node src/BuiltinExtensions/MobileEnhancements/verify/verify-simple-error-branches.mjs
 * Set SWARM_CHROMIUM to override the browser path. Exits non-zero if any check fails.
 */
import { chromium } from 'playwright';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const M = `${REPO}/src/BuiltinExtensions/MobileEnhancements/Assets/m`;
const TAGDEX = `${REPO}/src/BuiltinExtensions/TagDex/Assets`;
const WIDTH = 390, HEIGHT = 844;

const TOAST = '<div class="center-toast toast-error-box" id="center_toast">'
    + '<div class="toast hide" id="error_toast_box"><div class="toast-body" id="error_toast_content"></div></div></div>';
const html = readFileSync(`${M}/index.html`, 'utf8')
    .replace('[HEADEXTRA]', '')
    .replace('[REMAPS]', '[]')
    .replaceAll('[TOAST]', TOAST)
    .replaceAll('[VARY]', '1');

const CLIENT = ['m.css', 'm_state.js', 'm_gen.js', 'm_ui.js', 'm_autocomplete.js', 'm_create.js', 'm_grid.js',
    'm_presets.js', 'm_images.js', 'm_models.js'];
const FILES = {
    '/js/util.js': `${REPO}/src/wwwroot/js/util.js`,
    '/css/site.css': `${REPO}/src/wwwroot/css/site.css`,
    '/css/themes/modern.css': `${REPO}/src/wwwroot/css/themes/modern.css`,
    '/css/themes/modern_dark.css': `${REPO}/src/wwwroot/css/themes/modern_dark.css`,
    '/ExtensionFile/TagDexExtension/Assets/tagdex_core.js': `${TAGDEX}/tagdex_core.js`,
    '/ExtensionFile/TagDexExtension/Assets/m_tagdex.js': `${TAGDEX}/m_tagdex.js`,
    '/ExtensionFile/TagDexExtension/Assets/m_tagdex.css': `${TAGDEX}/m_tagdex.css`,
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

await page.addInitScript(() => {
    window.showError = function (message) { window.__globalError = message; };
    window.getUserSetting = () => '';
    window.largeCountStringify = value => `${value}`;
    window.getTextSelRange = () => [0, 0];
    window.makeWSRequest = () => null;
    window.getSession = () => {};
    window.getImageOutPrefix = () => 'View/local';
    window.isValidMediaPath = () => true;
    window.permissions = { hasPermission: () => true };
    window.__calls = [];
    // Calls to a route named here are HELD: the pending entry keeps its callbacks so the test can decide,
    // later, whether that call succeeds or fails. Everything else answers immediately and emptily.
    window.__hold = new Set();
    window.__pending = [];
    window.genericRequest = (route, args, callback, depth, errorCallback) => {
        window.__calls.push(route);
        if (window.__hold.has(route)) {
            window.__pending.push({ route, callback, errorCallback });
            return;
        }
        if (route == 'ListImages') {
            callback({ folders: [], files: [{ src: 'img.png', metadata: '' }] });
            return;
        }
        callback({});
    };
    // Fails the newest held call with a message only a server could have produced, so a generic client
    // string cannot pass a check that is meant to prove the server's own text got through.
    window.__failPending = (message) => {
        let entry = window.__pending.pop();
        entry.errorCallback(message);
        return entry.route;
    };
    window.__toastText = () => {
        let toast = document.querySelector('.m-toast');
        return toast ? toast.textContent : '';
    };
    window.__clearToast = () => {
        for (let toast of document.querySelectorAll('.m-toast')) {
            toast.remove();
        }
        if (typeof mUI != 'undefined') {
            mUI.toastBox = null;
        }
    };
});
page.on('pageerror', e => check(`no page errors (${e.message})`, false));

await page.goto('http://localhost/simple');
await page.waitForFunction(() => typeof mCreate != 'undefined' && typeof mImages != 'undefined');
await page.evaluate(() => {
    let panel = document.querySelector('.m-panel[data-mtab="create"]');
    panel.classList.add('m-tab-active');
    mCreate.build(panel);
    let images = document.querySelector('.m-panel[data-mtab="images"]');
    images.classList.add('m-tab-active');
    mImages.build(images);
});

// ---- Interrupt ----
await page.evaluate(() => {
    window.__hold.add('InterruptAll');
    window.__clearToast();
    window.__calls = [];
    // The button only exists on screen once the server reports a queue.
    mGen.queueTotal = 2;
    mCreate.onFrame('status', {});
    mCreate.interruptButton.click();
});
const interruptPending = await page.evaluate(() => ({
    label: mCreate.interruptButton.textContent,
    disabled: mCreate.interruptButton.disabled,
    calls: window.__calls.filter(c => c == 'InterruptAll').length
}));
check('Interrupt changes in the press frame', interruptPending.label == 'Interrupting...' && interruptPending.disabled,
    JSON.stringify(interruptPending));
await page.evaluate(() => mCreate.interruptButton.click());
check('a second Interrupt press while in flight sends nothing',
    await page.evaluate(() => window.__calls.filter(c => c == 'InterruptAll').length) == 1,
    `${await page.evaluate(() => window.__calls.filter(c => c == 'InterruptAll').length)} calls`);
await page.evaluate(() => window.__failPending('Interrupt refused: backend is not accepting control commands.'));
const interruptFailed = await page.evaluate(() => ({
    label: mCreate.interruptButton.textContent,
    disabled: mCreate.interruptButton.disabled,
    toast: window.__toastText(),
    repolled: window.__calls.includes('GetCurrentStatus'),
    global: window.__globalError
}));
check('a refused Interrupt restores the button exactly',
    interruptFailed.label == 'Interrupt' && !interruptFailed.disabled, JSON.stringify(interruptFailed));
check('the user gets the server\'s own message, beside the control',
    interruptFailed.toast == 'Could not interrupt: Interrupt refused: backend is not accepting control commands.',
    interruptFailed.toast);
check('the message does not go to the global error path instead',
    interruptFailed.global == undefined, `${interruptFailed.global}`);
check('a refused Interrupt re-polls status, so the queue count stops describing the optimistic clear',
    interruptFailed.repolled, `repolled=${interruptFailed.repolled}`);

// A successful interrupt must ALSO restore the label: another batch queued behind this one keeps the button
// on screen, where "Interrupting..." would then be a permanent lie.
await page.evaluate(() => {
    window.__clearToast();
    window.__calls = [];
    mCreate.interruptButton.click();
    window.__pending.pop().callback({ success: true });
});
const interruptOk = await page.evaluate(() => ({
    label: mCreate.interruptButton.textContent,
    disabled: mCreate.interruptButton.disabled
}));
check('a successful Interrupt restores the button too',
    interruptOk.label == 'Interrupt' && !interruptOk.disabled, JSON.stringify(interruptOk));

// ---- History viewer: Star ----
const openViewer = async () => page.evaluate(() => {
    for (let overlay of document.querySelectorAll('.m-viewer')) {
        overlay.remove();
    }
    window.__clearToast();
    window.__calls = [];
    mImages.openViewer({ src: 'img.png', fullsrc: 'raw/img.png', url: 'View/local/raw/img.png', metadata: '' }, 0);
});
const actionByLabel = (label) => page.evaluate(text =>
    [...document.querySelectorAll('.m-viewer-action')].find(b => b.textContent.startsWith(text)).click(), label);

await page.evaluate(() => window.__hold.add('ToggleImageStarred'));
await openViewer();
await actionByLabel('Star');
const starPending = await page.evaluate(() => {
    let btn = [...document.querySelectorAll('.m-viewer-action')].find(b => b.textContent.startsWith('Star'));
    return { label: btn.textContent, disabled: btn.disabled, calls: window.__calls.filter(c => c == 'ToggleImageStarred').length };
});
check('Star changes in the press frame', starPending.label == 'Star...' && starPending.disabled, JSON.stringify(starPending));
await actionByLabel('Star');
check('a second Star press while in flight sends nothing',
    await page.evaluate(() => window.__calls.filter(c => c == 'ToggleImageStarred').length) == 1,
    `${await page.evaluate(() => window.__calls.filter(c => c == 'ToggleImageStarred').length)} calls`);
await page.evaluate(() => window.__failPending('Star failed: the output folder is read-only.'));
const starFailed = await page.evaluate(() => {
    let btn = [...document.querySelectorAll('.m-viewer-action')].find(b => b.textContent.startsWith('Star'));
    return {
        label: btn.textContent, disabled: btn.disabled, toast: window.__toastText(),
        viewerOpen: !!document.querySelector('.m-viewer'), refreshed: window.__calls.includes('ListImages')
    };
});
check('a refused Star restores the button exactly', starFailed.label == 'Star' && !starFailed.disabled, JSON.stringify(starFailed));
check('a refused Star reports the server\'s own message',
    starFailed.toast == 'Star failed: Star failed: the output folder is read-only.', starFailed.toast);
check('a refused Star leaves the viewer open rather than closing over the failure',
    starFailed.viewerOpen && !starFailed.refreshed, JSON.stringify(starFailed));

// ---- History viewer: Delete ----
await page.evaluate(() => {
    window.__hold.add('DeleteImage');
    mUI.confirm = (message, onYes) => { window.__confirm = message; onYes(); };
});
await openViewer();
await actionByLabel('Delete');
const deletePending = await page.evaluate(() => {
    let btn = [...document.querySelectorAll('.m-viewer-action')].find(b => b.textContent.startsWith('Delete'));
    return { label: btn.textContent, disabled: btn.disabled, confirmed: window.__confirm,
        calls: window.__calls.filter(c => c == 'DeleteImage').length };
});
check('Delete confirms first, then changes in the press frame',
    `${deletePending.confirmed}`.includes('Delete this image?') && deletePending.label == 'Delete...' && deletePending.disabled,
    JSON.stringify(deletePending));
await actionByLabel('Delete');
check('a second Delete press while in flight sends nothing',
    await page.evaluate(() => window.__calls.filter(c => c == 'DeleteImage').length) == 1,
    `${await page.evaluate(() => window.__calls.filter(c => c == 'DeleteImage').length)} calls`);
await page.evaluate(() => window.__failPending('Delete failed: file is in use.'));
const deleteFailed = await page.evaluate(() => {
    let btn = [...document.querySelectorAll('.m-viewer-action')].find(b => b.textContent.startsWith('Delete'));
    return { label: btn.textContent, disabled: btn.disabled, toast: window.__toastText(),
        viewerOpen: !!document.querySelector('.m-viewer') };
});
check('a refused Delete restores the button exactly', deleteFailed.label == 'Delete' && !deleteFailed.disabled,
    JSON.stringify(deleteFailed));
check('a refused Delete reports the server\'s own message',
    deleteFailed.toast == 'Delete failed: Delete failed: file is in use.', deleteFailed.toast);
check('a refused Delete does not close the viewer, so the image is visibly still there',
    deleteFailed.viewerOpen, JSON.stringify(deleteFailed));

// A success on either still closes and refreshes, which is what the failure path must not do.
await page.evaluate(() => {
    window.__hold.delete('DeleteImage');
    window.__calls = [];
});
await openViewer();
await page.evaluate(() => window.__hold.delete('DeleteImage'));
await actionByLabel('Delete');
const deleteOk = await page.evaluate(() => ({
    viewerOpen: !!document.querySelector('.m-viewer'),
    refreshed: window.__calls.includes('ListImages'),
    dirty: mImages.dirty
}));
check('a successful Delete still closes the viewer and refreshes the grid',
    !deleteOk.viewerOpen && deleteOk.refreshed, JSON.stringify(deleteOk));

// ---- An unsaved image has no path to act on, and says so instead of calling ----
await page.evaluate(() => {
    window.__clearToast();
    window.__calls = [];
    for (let overlay of document.querySelectorAll('.m-viewer')) {
        overlay.remove();
    }
    mImages.openViewer({ src: 'x', fullsrc: '', url: 'data:image/gif;base64,x', metadata: '' }, 0);
});
await actionByLabel('Star');
const unsaved = await page.evaluate(() => ({ toast: window.__toastText(), calls: window.__calls.length }));
check('an unsaved image reports why rather than pressing a dead button',
    unsaved.calls == 0 && `${unsaved.toast}`.includes('cannot be starred'), JSON.stringify(unsaved));

await browser.close();
const failed = results.filter(result => !result.pass).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed > 0 ? 1 : 0);
