/**
 * Genpage (Text2Image) clipboard / paste-modal harness (fork). The desktop counterpart of
 * verify-simple-clipboard-paste.mjs, for the image editor's "Paste Image as Layer" fallback in
 * src/wwwroot/js/genpage/helpers/image_editor.js (openPasteModal / handlePasteModalPaste / finishPasteModal)
 * and the prompt box's own paste hook (imagePromptImagePaste, main.js). Three claims:
 *
 * 1. With no clipboard API (every LAN address over plain HTTP), Ctrl+V in the editor opens the paste modal
 *    with an empty, focused, contenteditable box - and a pasted image is visible in that box.
 * 2. A paste that lands (an image file on the event, or markup with only an <img> behind it) is the confirm:
 *    it adds exactly one layer whose pixels are the pasted image (read back off the layer canvas, not just a
 *    count), closes the modal and says so. The prompt box paste likewise attaches an .alt-prompt-image whose
 *    src round-trips to the exact bytes pasted.
 * 3. Cancel does not: the layer count is unchanged, the modal closes, and the box is empty on the next open.
 *    A paste with nothing usable in it also adds nothing and leaves the modal open to try again.
 *
 * Unlike the /simple harnesses this cannot assemble the page from disk - Text2Image is a Razor page that needs
 * a running server for its session, params and script list - so it drives a LIVE server instead. Events are
 * hand-built ClipboardEvents dispatched at the real listeners (the box's onpaste, the textarea's onpaste, the
 * editor's keydown), not calls into the handlers.
 *
 * NOT covered: native paste. A synthetic ClipboardEvent has no default action, so the browser never drops an
 * <img> into the contenteditable box on its own; the markup-only case below pre-places the <img> by hand and
 * only checks the read-back. Whether a real Ctrl+V / long-press Paste lands markup in the box is a manual check.
 *
 * Requires playwright + a chromium build; neither is a repo dependency, so this is opt-in tooling rather than
 * part of the CI gate. Run from the repo root against a running Swarm (the server must not require a login,
 * or the /Text2Image load will bounce):
 *     node src/BuiltinExtensions/MobileEnhancements/verify/verify-genpage-clipboard.mjs [http://localhost:7801]
 * The base URL may also be given as SWARM_URL. Set SWARM_CHROMIUM to override the browser path. Exits
 * non-zero if any check fails.
 */
import { chromium } from 'playwright';

let BASE = (process.argv[2] || process.env.SWARM_URL || 'http://localhost:7801').replace(/\/+$/, '');
let WIDTH = 1280, HEIGHT = 900;

let results = [];
function check(name, pass, detail) {
    results.push({ name, pass });
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
}

let browser = await chromium.launch(process.env.SWARM_CHROMIUM ? { executablePath: process.env.SWARM_CHROMIUM } : {});
let page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } });
page.on('pageerror', e => check(`no page errors (${e.message})`, false));

await page.goto(`${BASE}/Text2Image`);
await page.waitForFunction(() => typeof imageEditor != 'undefined' && !!document.getElementById('image_editor_paste_pastebox') && !!document.getElementById('input_width'), null, { timeout: 30000 });

// A 4x4 solid-red PNG built in-page. Its data URL is what the prompt-box read-back is compared against, and
// the layer read-back samples its color, so a paste that lands the wrong bytes fails rather than just counting.
let testImage = await page.evaluate(() => {
    let c = document.createElement('canvas');
    c.width = 4;
    c.height = 4;
    let ctx = c.getContext('2d');
    ctx.fillStyle = '#ff0000';
    ctx.fillRect(0, 0, 4, 4);
    return c.toDataURL('image/png');
});

/** Dispatches a real paste event at a real element. `withFile` puts the test PNG on it as a File; otherwise the
 * event carries nothing, exactly as a markup-only paste does. Returns defaultPrevented plus what the box held
 * synchronously after the listeners ran. */
let paste = (selector, withFile) => page.evaluate(async ([sel, dataUrl, addFile]) => {
    let data = new DataTransfer();
    if (addFile) {
        let bytes = await fetch(dataUrl).then(r => r.arrayBuffer());
        data.items.add(new File([bytes], 'shot.png', { 'type': 'image/png' }));
    }
    let elem = document.querySelector(sel);
    let event = new ClipboardEvent('paste', { 'clipboardData': data, 'bubbles': true, 'cancelable': true });
    elem.dispatchEvent(event);
    let img = elem.querySelector ? elem.querySelector('img') : null;
    return { prevented: event.defaultPrevented, shown: img ? img.src : '' };
}, [selector, testImage, !!withFile]);
let modalShown = () => page.waitForFunction(() => document.getElementById('image_editor_paste_modal').classList.contains('show'), null, { timeout: 2000 })
    .then(() => true, () => false);
let modalHidden = () => page.waitForFunction(() => getComputedStyle(document.getElementById('image_editor_paste_modal')).display == 'none', null, { timeout: 2000 })
    .then(() => true, () => false);
let modalOpen = () => page.evaluate(() => document.getElementById('image_editor_paste_modal').classList.contains('show'));
let layerCount = () => page.evaluate(() => imageEditor.layers.length);
/** Waits for addImageLayerFromClipboard's Image load to land. */
let gotLayers = (count) => page.waitForFunction(n => imageEditor.layers.length >= n, count, { timeout: 2000 })
    .then(() => true, () => false);
/** The newest image layer as {w, h, pixel [r,g,b,a] at (1,1)} - the read-back of what was pasted.
 * Mask layers sort to the end of imageEditor.layers regardless of creation order, so array tail is not newest. */
let newestLayer = () => page.evaluate(() => {
    let layer = imageEditor.layers.reduce((newest, candidate) => {
        return !candidate.isMask && (!newest || candidate.id > newest.id) ? candidate : newest;
    }, null);
    let d = layer.canvas.getContext('2d').getImageData(1, 1, 1, 1).data;
    return { w: layer.canvas.width, h: layer.canvas.height, pixel: [d[0], d[1], d[2], d[3]] };
});
/** Text of the most recent notice popover, if one is on screen. */
let notice = () => page.evaluate(() => {
    let pops = document.querySelectorAll('.sui-popover-notice');
    return pops.length ? pops[pops.length - 1].innerText : null;
});
let clearNotices = () => page.evaluate(() => {
    for (let pop of document.querySelectorAll('.sui-popover-notice')) {
        pop.remove();
    }
});
/** Ctrl+V at the editor's own keydown listener (onKeyDown on inputDiv), with nothing focused that would swallow it. */
let ctrlV = () => page.evaluate(() => {
    if (document.activeElement && document.activeElement.blur) {
        document.activeElement.blur();
    }
    let input = document.getElementById('image_editor_input');
    input.dispatchEvent(new KeyboardEvent('keydown', { 'key': 'v', 'ctrlKey': true, 'bubbles': true, 'cancelable': true }));
    // Read synchronously: openPasteModal focuses the box inside the gesture, and Bootstrap may move focus to
    // the dialog once the show transition ends, so a later read would be measuring Bootstrap, not the editor.
    return document.activeElement == document.getElementById('image_editor_paste_pastebox');
});

// ---- Insecure context: navigator.clipboard is not there, which is every LAN address over HTTP ----
await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', { 'value': undefined, 'configurable': true });
    openEmptyEditor();
});
await page.waitForFunction(() => imageEditor.active && imageEditor.layers.length > 0);
let baseLayers = await layerCount();
let focusedOnOpen = await ctrlV();
check('no clipboard API: Ctrl+V in the editor opens the paste modal instead of dead-ending', await modalShown());
check('the paste box is already focused when the opening keystroke ends', focusedOnOpen);
check('the paste box is contenteditable and empty on open', await page.evaluate(() => {
    let box = document.getElementById('image_editor_paste_pastebox');
    return box.isContentEditable && box.getAttribute('role') == 'textbox' && box.innerHTML == '';
}));

// ---- Markup-only paste: no file on the event, just the <img> the browser would have dropped in the box.
// Pre-placed by hand (see the header): the synthetic event has no default action to land it. ----
await page.evaluate(src => {
    document.getElementById('image_editor_paste_pastebox').innerHTML = `<img src="${src}">`;
}, testImage);
let markup = await paste('#image_editor_paste_pastebox', false);
check('the pasted image is shown in the box when the listeners run', markup.shown == testImage);
check('markup-only paste is not consumed by the listener (default is what lands it)', !markup.prevented);
check('markup-only paste is read back out of the box as one new layer', await gotLayers(baseLayers + 1) && (await layerCount()) == baseLayers + 1, `${baseLayers} -> ${await layerCount()}`);
let layer = await newestLayer();
check('...whose canvas is the pasted image (4x4, red at 1,1)', layer.w == 4 && layer.h == 4 && layer.pixel.join(',') == '255,0,0,255', JSON.stringify(layer));
check('a successful paste closes the modal', await modalHidden());
check('...and says so', (await notice()) == 'Pasted image as new layer', JSON.stringify(await notice()));
check('...and leaves the box empty', await page.evaluate(() => document.getElementById('image_editor_paste_pastebox').innerHTML == ''));

// ---- File paste: an image File on the event itself, the desktop Ctrl+V shape ----
await clearNotices();
await ctrlV();
check('the modal opens again for a second paste', await modalShown());
let file = await paste('#image_editor_paste_pastebox', true);
check('paste of an image file is consumed by the box', file.prevented);
check('paste of an image file adds one layer', await gotLayers(baseLayers + 2) && (await layerCount()) == baseLayers + 2, `${baseLayers + 1} -> ${await layerCount()}`);
layer = await newestLayer();
check('...whose canvas is the pasted file (4x4, red at 1,1)', layer.w == 4 && layer.h == 4 && layer.pixel.join(',') == '255,0,0,255', JSON.stringify(layer));
check('file paste closes the modal too', await modalHidden());
check('...with a note, not a warning', (await notice()) == 'Pasted image as new layer', JSON.stringify(await notice()));

// ---- Nothing usable: adds nothing, says so, and does NOT close the modal out from under the user ----
await clearNotices();
await ctrlV();
await modalShown();
let before = await layerCount();
await paste('#image_editor_paste_pastebox', false);
await page.waitForTimeout(200);
check('unusable paste adds no layer', (await layerCount()) == before, `${before} -> ${await layerCount()}`);
check('unusable paste warns', (await notice()) == 'Nothing usable pasted - copy an image', JSON.stringify(await notice()));
check('unusable paste leaves the modal open to try again', await modalOpen());
check('...with the box cleared rather than holding the failed paste', await page.evaluate(() => document.getElementById('image_editor_paste_pastebox').innerHTML == ''));

// ---- Cancel: with an image sitting in the box, Cancel must discard it ----
await clearNotices();
await page.evaluate(src => {
    document.getElementById('image_editor_paste_pastebox').innerHTML = `<img src="${src}">`;
}, testImage);
before = await layerCount();
await page.click('#image_editor_paste_modal .modal-footer button');
check('Cancel closes the modal', await modalHidden());
await page.waitForTimeout(200);
check('Cancel adds no layer', (await layerCount()) == before, `${before} -> ${await layerCount()}`);
check('Cancel does not say anything was pasted', (await notice()) == null, JSON.stringify(await notice()));
await ctrlV();
await modalShown();
check('the next open starts with an empty box, not the cancelled image', await page.evaluate(() => document.getElementById('image_editor_paste_pastebox').innerHTML == ''));
await page.click('#image_editor_paste_modal .modal-footer button');
await modalHidden();

// ---- The prompt box keeps its own paste behaviour: an image file attaches as a prompt image ----
before = await page.evaluate(() => document.querySelectorAll('#alt_prompt_image_area .alt-prompt-image').length);
let prompt = await paste('#alt_prompt_textbox', true);
let promptAttached = await page.waitForFunction(n => document.querySelectorAll('#alt_prompt_image_area .alt-prompt-image').length > n, before, { timeout: 2000 })
    .then(() => true, () => false);
check('prompt box paste of an image file attaches a prompt image', promptAttached);
check('...whose src round-trips to the exact bytes pasted', await page.evaluate(src => {
    let imgs = document.querySelectorAll('#alt_prompt_image_area .alt-prompt-image');
    let img = imgs[imgs.length - 1];
    return !!img && img.src == src && img.dataset.filedata == src;
}, testImage));
check('prompt box paste of an image is left to the handler, not the textarea (event not prevented, nothing typed)',
    !prompt.prevented && await page.evaluate(() => document.getElementById('alt_prompt_textbox').value == ''));
// Leave the live page as it was found: drop the test prompt image and close the editor.
await page.evaluate(() => {
    let imgs = document.querySelectorAll('#alt_prompt_image_area .alt-prompt-image');
    if (imgs.length) {
        imagePromptRemoveMedia(imgs[imgs.length - 1]);
    }
    imageEditor.deactivate();
});

await browser.close();
let failed = results.filter(r => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
