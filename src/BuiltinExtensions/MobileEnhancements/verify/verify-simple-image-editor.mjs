/**
 * /simple prompt-image editor harness (fork). Covers the two claims that matter for m_image_edit.js:
 *
 * 1. The editor itself is correct - rotate swaps dimensions, a dragged crop rectangle is live-only until
 *    Apply Crop commits it, a committed crop samples the right sub-region of the source (not just resizes
 *    the canvas to the right numbers), Undo reverts exactly one committed op, Save writes a new data URI
 *    back and Cancel discards everything from the session untouched.
 * 2. Tapping a thumbnail to open the editor does not collide with the pre-existing long-press+drag
 *    reorder gesture on the same tile (wireReorder, m_create.js) - a real hold-then-drag still reorders
 *    and does not also open the editor; a plain tap still opens it; the strip's own (now shrunk) remove ×
 *    still removes without opening anything.
 *
 * Runs the REAL shipped source: index.html with its server tokens substituted, the real m.css and every
 * real m_*.js module (m_app.js excluded - booting needs a server), with the Create panel built directly and
 * two in-page-generated canvas images used as prompt images. Crop-handle and reorder drags are exercised via
 * hand-dispatched TouchEvents against the real listeners (wireCropDrag / wireReorder), not by calling their
 * internal methods directly - see the reorder block's comment for a timing pitfall this ran into once
 * (bundling touchstart+move+end into one synchronous dispatch skips wireReorder's 150ms arm timer and reads
 * as a tap instead of a hold-then-drag).
 *
 * Requires playwright + a chromium build; neither is a repo dependency, so this is opt-in tooling rather than
 * part of the CI gate. Run from the repo root:
 *     node src/BuiltinExtensions/MobileEnhancements/verify/verify-simple-image-editor.mjs
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

const CLIENT = ['m.css', 'm_state.js', 'm_gen.js', 'm_ui.js', 'm_autocomplete.js', 'm_image_edit.js', 'm_create.js', 'm_images.js', 'm_models.js'];
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
await page.addInitScript(() => {
    window.showError = function (message) { window.__err = message; };
    window.getUserSetting = () => '';
    window.genericRequest = () => {};
    window.makeWSRequest = () => null;
    window.getSession = () => {};
    window.getImageOutPrefix = () => '/View';
    window.getTextSelRange = () => [0, 0];
    window.session_id = 'test';
    window.permissions = { hasPermission: () => true };
});
page.on('pageerror', e => check(`no page errors (${e.message})`, false));

await page.goto('http://localhost/simple');
await page.waitForFunction(() => typeof mCreate != 'undefined' && typeof mImageEdit != 'undefined');
await page.evaluate(() => {
    let panel = document.querySelector('.m-panel[data-mtab="create"]');
    panel.classList.add('m-tab-active');
    mCreate.build(panel);
});

// An 8x6 test image with a distinct solid color in each quadrant, built entirely in-page (no PNG bytes
// hand-crafted in Node) - lets the crop checks below confirm the result actually samples the right
// sub-region of the source, not just that the canvas resized to the right numbers.
const testImage = await page.evaluate(() => {
    let c = document.createElement('canvas');
    c.width = 8; c.height = 6;
    let ctx = c.getContext('2d');
    ctx.fillStyle = '#ff0000'; ctx.fillRect(0, 0, 4, 3); // NW red
    ctx.fillStyle = '#00ff00'; ctx.fillRect(4, 0, 4, 3); // NE green
    ctx.fillStyle = '#0000ff'; ctx.fillRect(0, 3, 4, 3); // SW blue
    ctx.fillStyle = '#ffff00'; ctx.fillRect(4, 3, 4, 3); // SE yellow
    return c.toDataURL('image/png');
});

/** Dispatches a full touchstart -> touchmove(s) -> touchend sequence in one synchronous call - fine for the
 * crop handles below, which have no arm-timer to race, but NOT fine for wireReorder's hold-then-drag (see
 * the reorder block, which dispatches touchstart on its own with a real wait after it instead). */
async function touchSequence(selector, points) {
    await page.evaluate(([sel, pts]) => {
        let el = document.querySelector(sel);
        let dispatch = (type, x, y) => {
            let touch = new Touch({ identifier: 1, target: el, clientX: x, clientY: y });
            let list = type == 'touchend' ? [] : [touch];
            el.dispatchEvent(new TouchEvent(type, { touches: list, changedTouches: [touch], targetTouches: list, bubbles: true, cancelable: true }));
        };
        dispatch('touchstart', pts[0][0], pts[0][1]);
        for (let i = 1; i < pts.length; i++) {
            dispatch('touchmove', pts[i][0], pts[i][1]);
        }
        dispatch('touchend', pts[pts.length - 1][0], pts[pts.length - 1][1]);
    }, [selector, points]);
}

await page.evaluate(src => {
    mState.promptImages = [{ 'kind': 'data', 'value': src }, { 'kind': 'data', 'value': src }];
    mCreate.renderImageStrip();
}, testImage);
check('two tiles rendered', await page.evaluate(() => document.querySelectorAll('.m-image-tile:not(.m-image-add)').length) == 2);

// ---- Tap opens the editor - a plain click, which faithfully exercises the tile's click listener regardless
// of touch vs mouse input, since that listener doesn't care about input modality at all ----
await page.click('.m-image-tile:not(.m-image-add)');
await page.waitForFunction(() => mImageEdit.ready);
check('sheet is open with the right title', (await page.textContent('.m-sheet-title')) == 'Edit image');
let dims = await page.evaluate(() => ({ w: mImageEdit.canvas.width, h: mImageEdit.canvas.height }));
check('canvas matches source dimensions', dims.w == 8 && dims.h == 6, JSON.stringify(dims));
check('crop rect starts covering the full canvas', await page.evaluate(() => {
    let r = mImageEdit.cropRect;
    return r.x == 0 && r.y == 0 && r.w == 8 && r.h == 6;
}));
check('Undo starts disabled (empty history)', await page.evaluate(() => mImageEdit.undoButton.disabled));
check('Rotate/Crop/Save are enabled once ready', await page.evaluate(() =>
    !document.querySelector('.m-edit-tool-button:nth-child(1)').disabled && !document.querySelector('.m-edit-save-button').disabled));

// ---- Rotate ----
await page.click('.m-edit-tool-button:nth-child(1)'); // Rotate
dims = await page.evaluate(() => ({ w: mImageEdit.canvas.width, h: mImageEdit.canvas.height }));
check('rotate swaps width/height', dims.w == 6 && dims.h == 8, JSON.stringify(dims));
check('Undo enabled after rotate', await page.evaluate(() => !mImageEdit.undoButton.disabled));

// ---- Undo the rotate ----
await page.click('.m-edit-tool-button:nth-child(3)'); // Undo
dims = await page.evaluate(() => ({ w: mImageEdit.canvas.width, h: mImageEdit.canvas.height }));
check('undo reverts the rotate', dims.w == 8 && dims.h == 6, JSON.stringify(dims));
check('Undo disabled again after undoing everything', await page.evaluate(() => mImageEdit.undoButton.disabled));

// ---- Drag the SE handle inward via real dispatched touch events (exercises wireCropDrag itself, not just
// its math helpers) - toward the canvas center, which should crop down toward the SE (yellow) quadrant ----
let seBox = await page.evaluate(() => document.querySelector('.m-edit-crop-handle-se').getBoundingClientRect());
let canvasBox = await page.evaluate(() => mImageEdit.displayCanvas.getBoundingClientRect());
let midX = (canvasBox.left + canvasBox.right) / 2, midY = (canvasBox.top + canvasBox.bottom) / 2;
await touchSequence('.m-edit-crop-handle-se', [
    [seBox.x + seBox.width / 2, seBox.y + seBox.height / 2],
    [midX + (canvasBox.right - midX) * 0.4, midY + (canvasBox.bottom - midY) * 0.4],
]);
let draggedRect = await page.evaluate(() => mImageEdit.cropRect);
check('dragging the handle shrinks the pending crop rect', draggedRect.w < 8 && draggedRect.h < 6, JSON.stringify(draggedRect));
check('dragging does not touch canvas pixels yet', await page.evaluate(() => mImageEdit.canvas.width == 8 && mImageEdit.canvas.height == 6));

// ---- Apply Crop ----
await page.click('.m-edit-tool-button:nth-child(2)'); // Crop
dims = await page.evaluate(() => ({ w: mImageEdit.canvas.width, h: mImageEdit.canvas.height }));
check('Apply Crop resizes the canvas to the dragged rect', dims.w == Math.round(draggedRect.w) && dims.h == Math.round(draggedRect.h), JSON.stringify(dims));
let cornerColor = await page.evaluate(() => {
    let ctx = mImageEdit.canvas.getContext('2d');
    let d = ctx.getImageData(mImageEdit.canvas.width - 1, mImageEdit.canvas.height - 1, 1, 1).data;
    return [d[0], d[1], d[2]];
});
check('the cropped region actually samples the SE (yellow) quadrant', cornerColor[0] > 200 && cornerColor[1] > 200 && cornerColor[2] < 60, JSON.stringify(cornerColor));
check('Undo enabled after a committed crop', await page.evaluate(() => !mImageEdit.undoButton.disabled));

// ---- Undo the crop ----
await page.click('.m-edit-tool-button:nth-child(3)');
check('undo reverts the crop back to 8x6', await page.evaluate(() => mImageEdit.canvas.width == 8 && mImageEdit.canvas.height == 6));
check('Undo disabled again', await page.evaluate(() => mImageEdit.undoButton.disabled));

// ---- Cancel discards everything from this session ----
await page.click('.m-edit-tool-button:nth-child(1)'); // rotate, so there's something to discard
await page.click('.m-edit-cancel-button');
await page.waitForTimeout(300); // sheet close animation
let afterCancel = await page.evaluate(() => mState.promptImages[0]);
check('cancel leaves promptImages[0] untouched', afterCancel.kind == 'data' && afterCancel.value == testImage);

// ---- Save writes a new data URI back ----
await page.click('.m-image-tile:not(.m-image-add)');
await page.waitForFunction(() => mImageEdit.ready);
await page.click('.m-edit-tool-button:nth-child(1)'); // rotate, a real change to save
await page.click('.m-edit-save-button');
await page.waitForTimeout(300);
let afterSave = await page.evaluate(() => mState.promptImages[0]);
check('save writes a new data URI', afterSave.kind == 'data' && afterSave.value != testImage && afterSave.value.startsWith('data:image/jpeg'));
check('the strip re-renders with the saved image', await page.evaluate(v => document.querySelector('.m-image-tile:not(.m-image-add) img').src == v, afterSave.value));

// ---- Remove from inside the editor ----
let beforeRemoveCount = await page.evaluate(() => mState.promptImages.length);
await page.click('.m-image-tile:not(.m-image-add)');
await page.waitForFunction(() => mImageEdit.ready);
await page.click('.m-edit-remove-button');
await page.waitForTimeout(300);
let afterRemoveCount = await page.evaluate(() => mState.promptImages.length);
check('Remove image deletes exactly one', afterRemoveCount == beforeRemoveCount - 1, `${beforeRemoveCount} -> ${afterRemoveCount}`);
check('the strip reflects the removal', await page.evaluate(() => document.querySelectorAll('.m-image-tile:not(.m-image-add)').length) == afterRemoveCount);

// ---- The strip's own shrunk x still works independently, without opening the editor ----
await page.evaluate(src => { mState.promptImages.push({ 'kind': 'data', 'value': src }); mCreate.renderImageStrip(); }, testImage);
let beforeX = await page.evaluate(() => mState.promptImages.length);
await page.click('.m-image-tile:not(.m-image-add) .m-image-tile-remove');
await page.waitForTimeout(50);
let afterX = await page.evaluate(() => mState.promptImages.length);
let sheetOpenAfterX = await page.evaluate(() => document.querySelector('.m-sheet') != null);
check('the strip x still removes without opening the editor', afterX == beforeX - 1 && !sheetOpenAfterX, `${beforeX} -> ${afterX}, sheet open: ${sheetOpenAfterX}`);

// ---- Reorder (long-press + drag) still works, unaffected by the new tap-to-edit listener ----
await page.evaluate(src => {
    mState.promptImages = [{ 'kind': 'data', 'value': src, '_tag': 'first' }, { 'kind': 'data', 'value': src, '_tag': 'second' }];
    mCreate.renderImageStrip();
}, testImage);
let tiles = await page.$$('.m-image-tile:not(.m-image-add)');
let firstBox = await tiles[0].boundingBox();
let secondBox = await tiles[1].boundingBox();
let startX = firstBox.x + firstBox.width / 2, y = firstBox.y + firstBox.height / 2;
let pastSecondX = secondBox.x + secondBox.width / 2 + 5;
// touchstart dispatched on its own, with a real wait after it, so wireReorder's 150ms arm timer gets actual
// wall-clock time to fire before anything else happens - bundling touchstart+move+end into one synchronous
// call (as touchSequence above does for the crop handles) skips that window and reads as a tap, not a
// hold-then-drag. This was a real bug in an earlier version of this harness, not in the app.
await page.evaluate(([x, y]) => {
    let el = document.querySelectorAll('.m-image-tile:not(.m-image-add)')[0];
    let touch = new Touch({ identifier: 1, target: el, clientX: x, clientY: y });
    el.dispatchEvent(new TouchEvent('touchstart', { touches: [touch], changedTouches: [touch], targetTouches: [touch], bubbles: true, cancelable: true }));
}, [startX, y]);
await page.waitForTimeout(200);
await page.evaluate(([x1, y, x2]) => {
    let el = document.querySelectorAll('.m-image-tile:not(.m-image-add)')[0];
    let move = (x) => {
        let touch = new Touch({ identifier: 1, target: el, clientX: x, clientY: y });
        el.dispatchEvent(new TouchEvent('touchmove', { touches: [touch], changedTouches: [touch], targetTouches: [touch], bubbles: true, cancelable: true }));
    };
    move(x1 + (x2 - x1) * 0.5);
    move(x2);
    let touch = new Touch({ identifier: 1, target: el, clientX: x2, clientY: y });
    el.dispatchEvent(new TouchEvent('touchend', { touches: [], changedTouches: [touch], targetTouches: [], bubbles: true, cancelable: true }));
}, [startX, y, pastSecondX]);
let orderAfterDrag = await page.evaluate(() => mState.promptImages.map(p => p._tag));
check('long-press+drag reorder still works', orderAfterDrag.join(',') == 'second,first', orderAfterDrag.join(','));
check('the completed drag did not also open the editor', await page.evaluate(() => document.querySelector('.m-sheet') == null));

await browser.close();

const failed = results.filter(r => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
