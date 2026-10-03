/**
 * /simple prompt-image editor harness (fork). Covers the three claims that matter for m_image_edit.js:
 *
 * 1. Every asset index.html loads is actually registered for serving. This check is first and needs no
 *    browser: it exists because m_image_edit.js once shipped referenced-but-unregistered, so the real server
 *    404'd it, `mImageEdit` was undefined, and every tap on a thumbnail threw a ReferenceError - while this
 *    harness (which serves the file straight off disk) passed all its checks against code the server never
 *    delivered. A DOM-only harness structurally cannot see that class of bug; only comparing index.html's
 *    script list against the extension's OtherAssets registration can.
 * 2. The editor itself is correct - 90-degree rotate swaps dimensions, flip mirrors, free rotate steps by a
 *    fixed angle without compounding resamples, padding grows the canvas with white on the chosen side, a
 *    dragged crop rectangle is live-only until something commits it, a committed crop samples the right
 *    sub-region of the source (not just resizes the canvas to the right numbers), Undo reverts exactly one
 *    committed op, Save writes a new data URI back and Cancel discards everything from the session untouched.
 * 3. Tapping a thumbnail to open the editor does not collide with the pre-existing long-press+drag reorder
 *    gesture on the same tile (wireReorder, m_create.js) - a real hold-then-drag still reorders and does not
 *    also open the editor; a plain tap still opens it; the strip's own (now shrunk) remove x still removes
 *    without opening anything.
 *
 * There is no Crop button: a dragged rectangle is committed by Save, or by any transform that would
 * invalidate it. The checks below exercise it that way rather than through a control of its own.
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
 * Set SWARM_CHROMIUM to override the browser path, or SWARM_WEBKIT=1 for WebKit. Set
 * SWARM_EDITOR_DESKTOP_ONLY=1 to run only the native desktop-pointer suite, and SWARM_EDITOR_SOURCE to a
 * local m_image_edit.js path when proving a baseline failure. Exits non-zero if any check fails.
 */
import { chromium, webkit } from 'playwright';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const EXT = `${REPO}/src/BuiltinExtensions/MobileEnhancements`;
const M = `${EXT}/Assets/m`;
const EDITOR_SOURCE = process.env.SWARM_EDITOR_SOURCE || `${M}/m_image_edit.js`;
const WIDTH = 390, HEIGHT = 844;

const results = [];
function check(name, pass, detail) {
    results.push({ name, pass });
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
}

const TOAST = '<div class="center-toast toast-error-box" id="center_toast">'
    + '<div class="toast hide" id="error_toast_box"><div class="toast-body" id="error_toast_content"></div></div></div>';
const rawHtml = readFileSync(`${M}/index.html`, 'utf8');
const html = rawHtml
    .replace('[HEADEXTRA]', '')
    .replace('[REMAPS]', '[]')
    .replaceAll('[TOAST]', TOAST)
    .replaceAll('[VARY]', '1');

// ---- Serving registration. Static, no browser: /ExtensionFile/ is a whitelist (WebServer.cs builds
// ExtensionAssets from each extension's OtherAssets list), not a directory mount, so a file referenced by
// index.html but missing from that list is a 404 in production no matter how correct the file itself is. ----
// All three lists count: ViewExtensionScript resolves ScriptFiles/StyleSheetFiles out of ExtensionSharedFiles
// and OtherAssets out of ExtensionAssets, and serves from either. Matching only OtherAssets would report every
// injected script (mobile_core.js and friends) as a false 404.
const extensionCs = readFileSync(`${EXT}/MobileEnhancementsExtension.cs`, 'utf8');
const registered = new Set([...extensionCs.matchAll(/(?:OtherAssets|ScriptFiles|StyleSheetFiles)\.Add\("([^"]+)"\)/g)].map(m => m[1]));
const referenced = [...rawHtml.matchAll(/\/ExtensionFile\/MobileEnhancementsExtension\/([^"?]+)/g)].map(m => m[1]);
const unregistered = referenced.filter(path => !registered.has(path));
check('every index.html asset is registered in OtherAssets (would 404 otherwise)',
    referenced.length > 0 && unregistered.length == 0,
    unregistered.length ? `unregistered: ${unregistered.join(', ')}` : `${referenced.length} checked`);

const CLIENT = ['m.css', 'm_state.js', 'm_gen.js', 'm_ui.js', 'm_autocomplete.js', 'm_coach.js', 'm_enhance.js', 'm_image_edit.js', 'm_create.js', 'm_grid.js', 'm_presets.js', 'm_images.js', 'm_models.js'];
const FILES = {
    '/js/util.js': `${REPO}/src/wwwroot/js/util.js`,
    '/css/site.css': `${REPO}/src/wwwroot/css/site.css`,
    '/css/themes/modern.css': `${REPO}/src/wwwroot/css/themes/modern.css`,
    '/css/themes/modern_dark.css': `${REPO}/src/wwwroot/css/themes/modern_dark.css`,
};
for (const file of CLIENT) {
    FILES[`/ExtensionFile/MobileEnhancementsExtension/Assets/m/${file}`] = `${M}/${file}`;
}
FILES['/ExtensionFile/MobileEnhancementsExtension/Assets/m/m_image_edit.js'] = EDITOR_SOURCE;

const engine = process.env.SWARM_WEBKIT == '1' ? webkit : chromium;
const browser = await engine.launch(engine == chromium && process.env.SWARM_CHROMIUM ? { executablePath: process.env.SWARM_CHROMIUM } : {});
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

const desktopOnly = process.env.SWARM_EDITOR_DESKTOP_ONLY == '1';
if (!desktopOnly) {
await page.goto('http://localhost/simple');
await page.waitForFunction(() => typeof mCreate != 'undefined' && typeof mImageEdit != 'undefined');
await page.evaluate(() => {
    let panel = document.querySelector('.m-panel[data-mtab="create"]');
    panel.classList.add('m-tab-active');
    mCreate.build(panel);
    window.dispatchSyntheticTouch = (el, type, x, y) => {
        let init = { identifier: 1, target: el, clientX: x, clientY: y, pageX: x, pageY: y, screenX: x, screenY: y };
        let touch;
        try {
            touch = new Touch(init);
        }
        catch {
            touch = init;
        }
        let makeList = values => {
            values.item = index => values[index] || null;
            return values;
        };
        let active = makeList(type == 'touchend' ? [] : [touch]);
        let changed = makeList([touch]);
        let event;
        try {
            event = new TouchEvent(type, { touches: active, changedTouches: changed, targetTouches: active,
                bubbles: true, cancelable: true });
        }
        catch {
            event = new Event(type, { bubbles: true, cancelable: true });
            Object.defineProperties(event, {
                'touches': { value: active },
                'changedTouches': { value: changed },
                'targetTouches': { value: active }
            });
        }
        el.dispatchEvent(event);
    };
});

// An 8x6 test image with a distinct solid color in each quadrant, built entirely in-page (no PNG bytes
// hand-crafted in Node) - lets the crop and flip checks below confirm the result actually samples/mirrors the
// right sub-region of the source, not just that the canvas resized to the right numbers.
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
        dispatchSyntheticTouch(el, 'touchstart', pts[0][0], pts[0][1]);
        for (let i = 1; i < pts.length; i++) {
            dispatchSyntheticTouch(el, 'touchmove', pts[i][0], pts[i][1]);
        }
        dispatchSyntheticTouch(el, 'touchend', pts[pts.length - 1][0], pts[pts.length - 1][1]);
    }, [selector, points]);
}

const dimsOf = () => page.evaluate(() => ({ w: mImageEdit.canvas.width, h: mImageEdit.canvas.height }));
/** Samples one working-canvas pixel as [r, g, b]. */
const pixelAt = (x, y) => page.evaluate(([px, py]) => {
    let d = mImageEdit.canvas.getContext('2d').getImageData(px, py, 1, 1).data;
    return [d[0], d[1], d[2]];
}, [x, y]);
const colorNear = (actual, expected) => actual.every((value, index) => Math.abs(value - expected[index]) <= 1);

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
let dims = await dimsOf();
check('canvas matches source dimensions', dims.w == 8 && dims.h == 6, JSON.stringify(dims));
check('crop rect starts covering the full canvas', await page.evaluate(() => {
    let r = mImageEdit.cropRect;
    return r.x == 0 && r.y == 0 && r.w == 8 && r.h == 6;
}));
check('Undo starts disabled (empty history)', await page.evaluate(() => mImageEdit.undoButton.disabled));
check('the tool row is Rotate / Flip / Undo', await page.evaluate(() =>
    [...document.querySelectorAll('.m-edit-tool-button')].map(b => b.textContent.replace(/[^A-Za-z]/g, '')).join(',')) == 'Rotate,Flip,Undo');
check('no Crop control exists (Save commits the rectangle instead)', await page.evaluate(() =>
    ![...document.querySelectorAll('button')].some(b => /crop/i.test(b.textContent) || /crop/i.test(b.getAttribute('aria-label') || ''))));
check('every tool, angle, pad and Save control is enabled once ready', await page.evaluate(() =>
    [...document.querySelectorAll('.m-edit-tool-button:not(:nth-child(3)), .m-edit-angle-button, .m-edit-angle-readout, .m-edit-pad-button, .m-edit-save-button')]
        .every(b => !b.disabled)));

// ---- 90-degree rotate ----
await page.click('.m-edit-tool-button:nth-child(1)');
dims = await dimsOf();
check('rotate swaps width/height', dims.w == 6 && dims.h == 8, JSON.stringify(dims));
check('Undo enabled after rotate', await page.evaluate(() => !mImageEdit.undoButton.disabled));
await page.click('.m-edit-tool-button:nth-child(3)');
dims = await dimsOf();
check('undo reverts the rotate', dims.w == 8 && dims.h == 6, JSON.stringify(dims));
check('Undo disabled again after undoing everything', await page.evaluate(() => mImageEdit.undoButton.disabled));

// ---- Flip. Dimensions are unchanged, so this is a pixel check or it is nothing: the NW quadrant must
// become what the NE quadrant was (red -> green). ----
check('NW starts red', (await pixelAt(1, 1)).join(',') == '255,0,0');
await page.click('.m-edit-tool-button:nth-child(2)');
dims = await dimsOf();
check('flip leaves dimensions unchanged', dims.w == 8 && dims.h == 6, JSON.stringify(dims));
let nw = await pixelAt(1, 1), ne = await pixelAt(6, 1);
check('flip mirrors left/right (NW is now the old NE green)', colorNear(nw, [0, 255, 0]) && colorNear(ne, [255, 0, 0]), `NW ${nw} NE ${ne}`);
await page.click('.m-edit-tool-button:nth-child(3)');
check('undo reverts the flip', (await pixelAt(1, 1)).join(',') == '255,0,0');

// ---- Free rotate. The claim under test is that stepping is incremental to the user but never compounds:
// every nudge redraws the SAME pristine snapshot at the new accumulated angle, so a run costs one undo slot
// and one resample regardless of how many taps it took. ----
const angleUp = '.m-edit-angle-button:last-of-type';
const readout = () => page.textContent('.m-edit-angle-readout');
check('angle readout starts at 0', (await readout()) == '0°');
await page.click(angleUp);
dims = await dimsOf();
check('one nudge grows the canvas to the rotated bounding box', dims.w > 8 && dims.h > 6, JSON.stringify(dims));
check('the exposed corner is filled white, not transparent/black', (await pixelAt(0, 0)).join(',') == '255,255,255');
check('readout tracks the step', (await readout()) == '25°');
check('one nudge takes one undo slot', await page.evaluate(() => mImageEdit.history.length) == 1);
await page.click(angleUp);
await page.click(angleUp);
check('three nudges reach the clamp', (await readout()) == '75°');
await page.click(angleUp);
check('a fourth nudge is clamped, not accumulated', (await readout()) == '75°');
check('the whole run still costs exactly one undo slot', await page.evaluate(() => mImageEdit.history.length) == 1);
check('the rotate source is still the ORIGINAL canvas (no compounding resamples)',
    await page.evaluate(() => mImageEdit.rotateSource.width == 8 && mImageEdit.rotateSource.height == 6));
await page.click('.m-edit-angle-readout');
dims = await dimsOf();
check('tapping the readout resets the angle exactly', dims.w == 8 && dims.h == 6 && (await readout()) == '0°', JSON.stringify(dims));
await page.click(angleUp);
await page.click('.m-edit-tool-button:nth-child(2)'); // Flip
check('a transform ends the free-rotate session', await page.evaluate(() => mImageEdit.rotateSource == null && mImageEdit.rotateAngle == 0));
check('the readout follows the session ending', (await readout()) == '0°');
await page.click('.m-edit-tool-button:nth-child(3)'); // undo the flip
await page.click('.m-edit-tool-button:nth-child(3)'); // undo the whole rotate run
dims = await dimsOf();
check('undo rewinds the entire rotate run in one step', dims.w == 8 && dims.h == 6, JSON.stringify(dims));
check('Undo disabled again after unwinding the rotate run', await page.evaluate(() => mImageEdit.undoButton.disabled));

// ---- Padding. One tap per side; each grows only the dimension it extends and leaves a white strip on that
// side specifically (checked by sampling inside the new strip, so a pad on the wrong edge fails). ----
const padButton = side => `.m-edit-pad-button:nth-of-type(${{ left: 1, top: 2, bottom: 3, right: 4 }[side]})`;
await page.click(padButton('left'));
dims = await dimsOf();
check('pad left grows width only', dims.w == 9 && dims.h == 6, JSON.stringify(dims));
check('the new left strip is white', (await pixelAt(0, 1)).join(',') == '255,255,255');
check('content shifted right rather than being overwritten', (await pixelAt(2, 1)).join(',') == '255,0,0');
await page.click(padButton('bottom'));
dims = await dimsOf();
check('pad bottom grows height only', dims.w == 9 && dims.h == 7, JSON.stringify(dims));
check('the new bottom strip is white', (await pixelAt(4, 6)).join(',') == '255,255,255');
check('each pad is its own undo step', await page.evaluate(() => mImageEdit.history.length) == 2);

// ---- Cancel discards everything from this session ----
await page.click('.m-edit-cancel-button');
await page.waitForTimeout(300);
let afterCancel = await page.evaluate(() => mState.promptImages[0]);
check('cancel leaves promptImages[0] untouched', afterCancel.kind == 'data' && afterCancel.value == testImage);

// ---- Drag the NW handle to the canvas center via real dispatched touch events (exercises wireCropDrag
// itself, not just its math helpers), then Save - with no Crop button, Save is what commits the rectangle.
//
// NW specifically, dragged to dead center: that anchors on the SE corner and selects exactly the SE (yellow)
// quadrant, so the color check below reads a pixel well inside a solid region. Dragging SE inward instead
// selects the NW-anchored region, which is almost entirely red with yellow only in its last corner pixel -
// and at this canvas size JPEG chroma subsampling smears that boundary enough to fail on a blend. ----
await page.click('.m-image-tile:not(.m-image-add)');
await page.waitForFunction(() => mImageEdit.ready);
let nwBox = await page.evaluate(() => document.querySelector('.m-edit-crop-handle-nw').getBoundingClientRect());
let canvasBox = await page.evaluate(() => mImageEdit.displayCanvas.getBoundingClientRect());
let midX = (canvasBox.left + canvasBox.right) / 2, midY = (canvasBox.top + canvasBox.bottom) / 2;
await touchSequence('.m-edit-crop-handle-nw', [
    [nwBox.x + nwBox.width / 2, nwBox.y + nwBox.height / 2],
    [midX, midY],
]);
let draggedRect = await page.evaluate(() => mImageEdit.cropRect);
check('dragging the handle shrinks the pending crop rect', draggedRect.w < 8 && draggedRect.h < 6, JSON.stringify(draggedRect));
check('the rectangle anchored on the opposite (SE) corner', draggedRect.x > 0 && draggedRect.y > 0, JSON.stringify(draggedRect));
check('dragging does not touch canvas pixels yet', await page.evaluate(() => mImageEdit.canvas.width == 8 && mImageEdit.canvas.height == 6));
await page.click('.m-edit-save-button');
await page.waitForTimeout(300);
let saved = await page.evaluate(() => mState.promptImages[0]);
check('save writes a new data URI', saved.kind == 'data' && saved.value != testImage && saved.value.startsWith('data:image/jpeg'));
// Read the SAVED bytes back, not the in-memory canvas: this is the artifact that actually goes to the API.
let savedProbe = await page.evaluate(async value => {
    let img = new Image();
    await new Promise(r => { img.onload = r; img.src = value; });
    let c = document.createElement('canvas');
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    c.getContext('2d').drawImage(img, 0, 0);
    let d = c.getContext('2d').getImageData(Math.floor(c.width / 2), Math.floor(c.height / 2), 1, 1).data;
    return { w: img.naturalWidth, h: img.naturalHeight, middle: [d[0], d[1], d[2]] };
}, saved.value);
check('Save committed the dragged rectangle without a Crop tap',
    savedProbe.w == Math.round(draggedRect.w) && savedProbe.h == Math.round(draggedRect.h), JSON.stringify(savedProbe));
check('the saved crop actually samples the SE (yellow) quadrant',
    savedProbe.middle[0] > 200 && savedProbe.middle[1] > 200 && savedProbe.middle[2] < 60, JSON.stringify(savedProbe.middle));
check('the strip re-renders with the saved image', await page.evaluate(v => document.querySelector('.m-image-tile:not(.m-image-add) img').src == v, saved.value));

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

// ---- Reorder (long-press + drag) still works, unaffected by the tap-to-edit listener ----
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
    dispatchSyntheticTouch(el, 'touchstart', x, y);
}, [startX, y]);
await page.waitForTimeout(200);
await page.evaluate(([x1, y, x2]) => {
    let el = document.querySelectorAll('.m-image-tile:not(.m-image-add)')[0];
    let move = (x) => {
        dispatchSyntheticTouch(el, 'touchmove', x, y);
    };
    move(x1 + (x2 - x1) * 0.5);
    move(x2);
    dispatchSyntheticTouch(el, 'touchend', x2, y);
}, [startX, y, pastSecondX]);
let orderAfterDrag = await page.evaluate(() => mState.promptImages.map(p => p._tag));
check('long-press+drag reorder still works', orderAfterDrag.join(',') == 'second,first', orderAfterDrag.join(','));
check('the completed drag did not also open the editor', await page.evaluate(() => document.querySelector('.m-sheet') == null));
}

// ---- Desktop pointer regression. The small 8x6 fixture above intentionally makes the 44px handles overlap;
// use a large image and real Playwright mouse actions here so the browser sends native PointerEvents through
// the Create thumbnail -> editor path. Crop coordinates always come from live display bounds, never guessed CSS.
if (desktopOnly) {
    await page.goto('http://localhost/simple');
    await page.waitForFunction(() => typeof mCreate != 'undefined' && typeof mImageEdit != 'undefined');
    await page.evaluate(() => {
        let panel = document.querySelector('.m-panel[data-mtab="create"]');
        panel.classList.add('m-tab-active');
        mCreate.build(panel);
    });
}
await page.setViewportSize({ width: 1440, height: 900 });
const desktopImage = await page.evaluate(() => {
    let canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 480;
    let ctx = canvas.getContext('2d');
    ctx.fillStyle = '#f00'; ctx.fillRect(0, 0, 320, 240);
    ctx.fillStyle = '#0f0'; ctx.fillRect(320, 0, 320, 240);
    ctx.fillStyle = '#00f'; ctx.fillRect(0, 240, 320, 240);
    ctx.fillStyle = '#ff0'; ctx.fillRect(320, 240, 320, 240);
    return canvas.toDataURL('image/png');
});
await page.evaluate(src => {
    mState.promptImages = [{ 'kind': 'data', 'value': src }];
    mCreate.renderImageStrip();
}, desktopImage);
await page.locator('.m-image-tile:not(.m-image-add)').click();
await page.waitForFunction(() => mImageEdit.ready && mImageEdit.canvas.width == 640);
// Native coordinate drags need the sheet's opening animation to finish before measuring their targets.
await page.waitForTimeout(300);

/** Returns a point in the displayed canvas at fractional source coordinates. */
const canvasPoint = (x, y) => page.evaluate(([fx, fy]) => {
    let box = mImageEdit.displayCanvas.getBoundingClientRect();
    return { x: box.left + box.width * fx, y: box.top + box.height * fy };
}, [x, y]);
/** Real native mouse drag. The final point may be outside the canvas to prove pointer capture. */
async function mouseDrag(start, end) {
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(end.x, end.y, { steps: 4 });
    await page.mouse.up();
}

let handleBox = await page.locator('.m-edit-crop-handle-nw').boundingBox();
let resizeEnd = await canvasPoint(0.25, 0.25);
await mouseDrag({ x: handleBox.x + handleBox.width / 2, y: handleBox.y + handleBox.height / 2 }, resizeEnd);
let desktopRect = await page.evaluate(() => mImageEdit.cropRect);
check('desktop mouse resizes the NW corner while anchoring SE', desktopRect.x > 0 && desktopRect.y > 0
    && desktopRect.w > 20 && desktopRect.h > 20 && Math.abs(desktopRect.x + desktopRect.w - 640) < 1
    && Math.abs(desktopRect.y + desktopRect.h - 480) < 1, JSON.stringify(desktopRect));
check('desktop corner drag only changes pending crop state before Save', await page.evaluate(() => mImageEdit.canvas.width == 640 && mImageEdit.canvas.height == 480));

// Keep the move target clear of 44px corner handles on both engines. This is setup only; the following
// native mouse drag is what proves the editor's move path preserves a cropped rectangle's dimensions.
await page.evaluate(() => { mImageEdit.cropRect = { 'x': 100, 'y': 100, 'w': 400, 'h': 250 }; mImageEdit.layoutCropOverlay(); });
await page.locator('.m-edit-crop-rect').scrollIntoViewIfNeeded();
let cropBox = await page.evaluate(() => {
    let box = document.querySelector('.m-edit-crop-rect').getBoundingClientRect();
    return { x: box.x, y: box.y, width: box.width, height: box.height };
});
let moveStart = { x: cropBox.x + cropBox.width / 2, y: cropBox.y + cropBox.height / 2 };
let moveEnd = { x: moveStart.x - 80, y: moveStart.y };
let beforeMove = await page.evaluate(() => ({ ...mImageEdit.cropRect }));
let moveTarget = await page.evaluate(point => document.elementFromPoint(point.x, point.y)?.className || '', moveStart);
await mouseDrag(moveStart, moveEnd);
let afterMove = await page.evaluate(() => mImageEdit.cropRect);
check('desktop mouse moves a non-full crop rectangle', afterMove.x < beforeMove.x && afterMove.w == beforeMove.w && afterMove.h == beforeMove.h, JSON.stringify({ moveTarget, afterMove }));

// Starting inside a full crop is a new-selection gesture. It must not try to move the full rectangle.
await page.evaluate(() => { mImageEdit.cropRect = mImageEdit.fullCropRect(); mImageEdit.layoutCropOverlay(); });
let drawStart = await canvasPoint(0.15, 0.20);
let drawEnd = await canvasPoint(0.70, 0.75);
await mouseDrag(drawStart, drawEnd);
let drawnRect = await page.evaluate(() => mImageEdit.cropRect);
check('desktop mouse drags across a full crop to draw a new pending rectangle', drawnRect.x > 50 && drawnRect.y > 50 && drawnRect.w < 500 && drawnRect.h < 400, JSON.stringify(drawnRect));

// Pointer capture must carry the resize outside the canvas and clamp at the source edge.
handleBox = await page.locator('.m-edit-crop-handle-nw').boundingBox();
let outside = await canvasPoint(-0.40, -0.30);
await mouseDrag({ x: handleBox.x + handleBox.width / 2, y: handleBox.y + handleBox.height / 2 }, outside);
let clampedRect = await page.evaluate(() => mImageEdit.cropRect);
check('desktop pointer capture continues outside canvas and clamps to its edge', clampedRect.x == 0 && clampedRect.y == 0, JSON.stringify(clampedRect));

let beforeRight = await page.evaluate(() => JSON.stringify(mImageEdit.cropRect));
let rightPoint = await canvasPoint(0.35, 0.35);
await page.mouse.move(rightPoint.x, rightPoint.y);
await page.mouse.down({ button: 'right' });
await page.mouse.move(rightPoint.x + 90, rightPoint.y + 70);
await page.mouse.up({ button: 'right' });
check('right-click does not begin a desktop crop gesture', await page.evaluate(() => JSON.stringify(mImageEdit.cropRect)) == beforeRight);

// The native down gives the browser's primary pointer id. Cancel must restore the rectangle, and later
// movement from that still-held physical mouse must be inert.
await page.evaluate(() => { mImageEdit.cropRect = mImageEdit.fullCropRect(); mImageEdit.layoutCropOverlay(); window.__cropPointerId = null; });
handleBox = await page.locator('.m-edit-crop-handle-nw').boundingBox();
await page.evaluate(() => document.querySelector('.m-edit-crop-handle-nw').addEventListener('pointerdown', event => { window.__cropPointerId = event.pointerId; }, { once: true }));
await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
await page.mouse.down();
let cancelId = await page.evaluate(() => window.__cropPointerId);
let cancelOriginal = await page.evaluate(() => ({ ...mImageEdit.cropRect }));
let cancelMove = await canvasPoint(0.35, 0.35);
await page.mouse.move(cancelMove.x, cancelMove.y);
await page.evaluate(id => {
    let event = new Event('pointercancel', { bubbles: true });
    Object.defineProperty(event, 'pointerId', { value: id });
    document.querySelector('.m-edit-crop-handle-nw').dispatchEvent(event);
}, cancelId);
let afterPointerCancel = await page.evaluate(() => ({ ...mImageEdit.cropRect }));
await page.mouse.move(cancelMove.x + 90, cancelMove.y + 70);
await page.mouse.up();
let afterCancelledMouse = await page.evaluate(() => ({ ...mImageEdit.cropRect }));
check('pointercancel restores the native drag rectangle and ends that drag', JSON.stringify(afterPointerCancel) == JSON.stringify(cancelOriginal) && JSON.stringify(afterCancelledMouse) == JSON.stringify(cancelOriginal), JSON.stringify(afterCancelledMouse));

// Release the real capture mid-drag. Later movement must be ignored, while a new drag must work without
// resetting the rectangle in between.
await page.evaluate(() => { mImageEdit.cropRect = mImageEdit.fullCropRect(); mImageEdit.layoutCropOverlay(); window.__cropPointerId = null; });
let releaseStart = await canvasPoint(0.20, 0.20);
await page.evaluate(() => document.querySelector('.m-edit-crop-rect').addEventListener('pointerdown', event => { window.__cropPointerId = event.pointerId; }, { once: true }));
await page.mouse.move(releaseStart.x, releaseStart.y);
await page.mouse.down();
let releaseId = await page.evaluate(() => window.__cropPointerId);
let releaseMove = await canvasPoint(0.55, 0.55);
await page.mouse.move(releaseMove.x, releaseMove.y);
let beforeRelease = await page.evaluate(() => ({ ...mImageEdit.cropRect }));
await page.evaluate(id => document.querySelector('.m-edit-crop-rect').releasePointerCapture(id), releaseId);
await page.waitForTimeout(0);
let postReleaseMove = await canvasPoint(0.80, 0.75);
await page.mouse.move(postReleaseMove.x, postReleaseMove.y);
await page.mouse.up();
let afterRelease = await page.evaluate(() => ({ ...mImageEdit.cropRect }));
drawStart = await canvasPoint(0.25, 0.25);
drawEnd = await canvasPoint(0.60, 0.60);
await mouseDrag(drawStart, drawEnd);
let afterFreshDrag = await page.evaluate(() => ({ ...mImageEdit.cropRect }));
check('lost pointer capture freezes the crop and permits a later native drag', JSON.stringify(afterRelease) == JSON.stringify(beforeRelease) && JSON.stringify(afterFreshDrag) != JSON.stringify(afterRelease), JSON.stringify({ afterRelease, afterFreshDrag }));

await page.locator('.m-edit-save-button').click();
await page.waitForTimeout(300);
let desktopSaved = await page.evaluate(() => mState.promptImages[0].value);
let desktopSavedDims = await page.evaluate(async value => {
    let image = new Image();
    await new Promise(resolve => { image.onload = resolve; image.src = value; });
    return { w: image.naturalWidth, h: image.naturalHeight };
}, desktopSaved);
check('desktop Save commits the pending crop to changed output bytes', desktopSaved != desktopImage && desktopSavedDims.w < 640 && desktopSavedDims.h < 480, JSON.stringify(desktopSavedDims));

await page.locator('.m-image-tile:not(.m-image-add)').click();
await page.waitForFunction(() => mImageEdit.ready);
await page.waitForTimeout(300);
await mouseDrag(await canvasPoint(0.25, 0.25), await canvasPoint(0.70, 0.70));
await page.locator('.m-edit-cancel-button').click();
await page.waitForTimeout(300);
check('desktop Cancel leaves the previously saved bytes unchanged', await page.evaluate(value => mState.promptImages[0].value == value, desktopSaved));

await browser.close();

const failed = results.filter(r => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
