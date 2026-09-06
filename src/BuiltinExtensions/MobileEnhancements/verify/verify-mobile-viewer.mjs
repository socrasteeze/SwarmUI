/**
 * Mobile fullview touch harness (fork). Covers the two remaining pieces of Phase 2 of
 * docs/MobilePWA-Optimization-Plan.md:
 *
 *  - 2b polish: rubber-band resistance at the first/last image when swiping at fit zoom (the boundary is
 *    felt - the image tracks less than the finger and springs back without navigating), and
 *    edge-fling-while-zoomed (a fast horizontal fling that starts with the image already panned to its edge
 *    in that direction advances to the prev/next image via the exact same `animateNav` ->
 *    `shiftToNextImagePreview` path the fit-zoom swipe drives; an ordinary pan, or a fling that didn't start
 *    at the edge, just keeps panning).
 *  - 2c: the mobile viewer chrome overlay - tap toggles a minimal top/bottom bar (index text, close, and the
 *    per-image actions) instead of closing, under body.small-window only; a coarse-pointer device without
 *    that class (or a genuine desktop pointer) is unaffected.
 *
 * Runs the REAL shipped source: mobile_fullview_touch.js is loaded verbatim via addScriptTag and allowed to
 * self-instantiate exactly as it does on the live page (`let mobileFullViewTouch = new MobileFullViewTouch()`
 * at the bottom of the file) against a minimal stand-in for the pieces of core it augments
 * (`imageFullView`, `currentImageHelper`, `buttonsForImage`, `copy_current_image_params`, etc.) - never a
 * retyped copy of the gesture logic under test. The real mobile.css is injected verbatim for the touch-target
 * size assertions. Gesture sequences are driven by calling the instance's own onTouchStart/onTouchMove/
 * onTouchEnd directly with plain touch-list objects (clientX/clientY/target) rather than constructing real
 * `TouchEvent`s - Chromium's TouchEvent support needs real hardware/emulation wiring that would add nothing
 * here, since the methods under test only ever read `.touches[i].clientX/clientY/target` and call
 * `preventDefault`/`stopPropagation`. The T9 overlay buttons are plain DOM elements once built, so those are
 * exercised with real dispatched `touchend` Events instead.
 *
 * Requires playwright + a chromium build; neither is a repo dependency, so this is opt-in tooling rather than
 * part of the CI gate. Run from the repo root:
 *     node src/BuiltinExtensions/MobileEnhancements/verify/verify-mobile-viewer.mjs
 * Set SWARM_CHROMIUM to override the browser path. Exits non-zero if any check fails.
 */
import { chromium } from 'playwright';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const TOUCH_JS = `${REPO}/src/BuiltinExtensions/MobileEnhancements/Assets/mobile_fullview_touch.js`;
const MOBILE_CSS = `${REPO}/src/BuiltinExtensions/MobileEnhancements/Assets/mobile.css`;
const UTIL_JS = `${REPO}/src/wwwroot/js/util.js`;

/** Pull a whole top-level `function name(...) {...}` out of a file by brace-matching (not retyped). */
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

const touchSrc = readFileSync(TOUCH_JS, 'utf8');
const mobileCss = readFileSync(MOBILE_CSS, 'utf8');
const utilSrc = readFileSync(UTIL_JS, 'utf8');
const findParentOfClassSrc = extractFunction(utilSrc, 'findParentOfClass');

const results = [];
function check(name, pass, detail) {
    results.push({ name, pass, detail });
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
}

const browser = await chromium.launch(process.env.SWARM_CHROMIUM ? { executablePath: process.env.SWARM_CHROMIUM } : {});

/**
 * Build one harness page: the minimal DOM ImageFullViewHelper's real markup shape provides
 * (currentimagehandler.js, read-only reference - never edited), a faithful-but-minimal stand-in for
 * `imageFullView` (moveImg's clamp math is copied verbatim from the real ImageFullViewHelper.moveImg, since
 * `computePanEdges()` under test must agree with the exact same clamp or the edge-fling checks are
 * meaningless), and every other global the real mobile_fullview_touch.js reaches for. `pointerCoarse` and
 * `smallWindow` drive the two device profiles the acceptance criteria distinguish (phone vs desktop).
 */
async function newHarnessPage(pointerCoarse, smallWindow) {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.setContent(`<!doctype html><html><head><style>${mobileCss}</style></head>
    <body class="${smallWindow ? 'small-window' : ''}">
        <div class="modal" id="image_fullview_modal">
            <div id="image_fullview_modal_content"></div>
            <span id="image_fullview_modal_counter"></span>
        </div>
        <div id="image_compare_stage"></div>
        <div id="current_image_batch"></div>
    </body></html>`);

    await page.evaluate(({ findParentOfClassSrc, pointerCoarse }) => {
        window.findParentOfClass = new Function(`return ${findParentOfClassSrc}`)();
        window.isVideoExt = () => false;
        window.isAudioExt = () => false;
        window.getMediaType = () => 'image';
        window.escapeHtmlForUrl = (s) => s;
        window.showError = (msg) => { window.__errors = window.__errors || []; window.__errors.push(msg); };

        window.__navCalls = [];
        window.shiftToNextImagePreview = function (next, expand, isArrows) {
            window.__navCalls.push({ next, expand, isArrows });
            return true;
        };

        window.__cycleSetting = 'false'; // cycling off by default, so first/last image is a real boundary
        window.getUserSetting = function (key, def) {
            if (key == 'ui.imageshiftingcycles') {
                return window.__cycleSetting;
            }
            return def;
        };

        // Real matchMedia is replaced outright: this is the one thing the real code gates coarse-pointer
        // handling on (isActive()), and the harness must control it precisely per page/profile rather than
        // rely on whatever Chromium's headless default happens to be.
        let realMatchMedia = window.matchMedia.bind(window);
        window.matchMedia = (query) => {
            if (query == '(pointer: coarse)') {
                return { matches: pointerCoarse };
            }
            return realMatchMedia(query);
        };

        // --- Stand-in for core's ImageFullViewHelper (currentimagehandler.js, read-only reference) ---
        window.imageFullView = {
            modal: document.getElementById('image_fullview_modal'),
            content: document.getElementById('image_fullview_modal_content'),
            noClose: false,
            showMetadata: true,
            currentSrc: null,
            currentMetadata: null,
            _open: false,
            closeCalls: 0,
            isOpen() { return this._open; },
            close() {
                this.closeCalls++;
                this._open = false;
                this.content.innerHTML = '';
            },
            getImgOrContainer() { return document.getElementById('imageview_popup_modal_img'); },
            getImg() { return this.getImgOrContainer(); },
            getHeightPercent() {
                return parseFloat((this.getImgOrContainer().style.height || '100%').replaceAll('%', ''));
            },
            getImgLeft() {
                return parseFloat((this.getImgOrContainer().style.left || '0').replaceAll('px', ''));
            },
            getImgTop() {
                return parseFloat((this.getImgOrContainer().style.top || '0').replaceAll('px', ''));
            },
            detachImg() { },
            // Copied verbatim from ImageFullViewHelper.moveImg (currentimagehandler.js) - the edge-fling
            // checks under test are meaningless unless this clamp is byte-identical to the real one.
            moveImg(xDiff, yDiff) {
                let img = this.getImgOrContainer();
                let newLeft = this.getImgLeft() + xDiff;
                let newTop = this.getImgTop() + yDiff;
                let overWidth = img.parentElement.offsetWidth / 2;
                let overHeight = img.parentElement.offsetHeight / 2;
                newLeft = Math.min(overWidth, Math.max(newLeft, img.parentElement.offsetWidth - img.offsetWidth - overWidth));
                newTop = Math.min(overHeight, Math.max(newTop, img.parentElement.offsetHeight - img.offsetHeight - overHeight));
                img.style.left = `${newLeft}px`;
                img.style.top = `${newTop}px`;
            },
            zoomAround() { },
            toggleMetadataVisibility(show) {
                window.__metadataToggleCalls = (window.__metadataToggleCalls || 0) + 1;
                this.showMetadata = show;
            }
        };

        window.currentImageHelper = {
            getCurrentImage() { return window.__currentImgElem || null; }
        };

        window.imageCompareHelper = {
            stage: document.getElementById('image_compare_stage'),
            hasSelection: () => false,
            isOpen: () => false
        };

        // --- Stand-ins for the buttonsForImage()/copy_current_image_params() actions T9's bottom bar
        //     triggers (outputhistory.js / currentimagehandler.js, read-only reference) ---
        window.__reuseCalls = 0;
        window.copy_current_image_params = function () { window.__reuseCalls++; };
        window.getImageFullSrc = (src) => src;
        window.__starOnclickCalls = 0;
        window.__deleteOnclickCalls = 0;
        window.buttonsForImage = function (fullSrc, src, metadata, isCurrentImage) {
            return [
                { label: 'Star', onclick: () => { window.__starOnclickCalls++; } },
                { label: 'Delete', onclick: (e) => { window.__deleteOnclickCalls++; if (e) { e.remove(); } } },
                { label: 'Download', href: `${src}?download=1`, is_download: true }
            ];
        };

        /** Populate #current_image_batch with `n` blocks and mark `currentIndex` as the open image, exactly
         *  the shape resolveBlocks()/shiftToNextImagePreview expect (batch mode, non-'history' batch id). */
        window.__setupBatch = function (n, currentIndex) {
            let batchArea = document.getElementById('current_image_batch');
            batchArea.innerHTML = '';
            let current = null;
            for (let i = 0; i < n; i++) {
                let block = document.createElement('div');
                block.className = 'image-block';
                block.dataset.src = `img${i}.png`;
                let inner = document.createElement('img');
                inner.className = 'image-block-img-inner';
                inner.src = `img${i}.png`;
                inner.dataset.src = `img${i}.png`;
                inner.dataset.batch_id = 'batch1';
                block.appendChild(inner);
                batchArea.appendChild(block);
                if (i == currentIndex) {
                    current = inner;
                }
            }
            window.__currentImgElem = current;
            window.imageFullView.currentSrc = `img${currentIndex}.png`;
            window.imageFullView.currentMetadata = '{}';
        };

        /** (Re)build the fullview modal's content exactly the shape ImageFullViewHelper.showImage() leaves
         *  it in - imagewrap > img, undertext - so the real script's DOM queries (isOnImage, currentInner,
         *  ensureOverlay, computePanEdges) all resolve against real, laid-out geometry. `left` is a starting
         *  pan offset (px); `heightPercent` > 101 simulates zoomed-in. The wrap is a fixed 400x400 box and
         *  the image a fixed 800x800 box, so the horizontal pan bounds are exactly [-600, 200]px, and
         *  `left: 200` / `left: -600` are the max/min edges computePanEdges() must detect. */
        window.__openImage = function ({ heightPercent = 100, left = 0, top = 0 } = {}) {
            window.imageFullView.content.innerHTML = `
                <div class="imageview_modal_inner_div">
                    <div class="imageview_modal_imagewrap" style="position:relative;width:400px;height:400px;overflow:hidden;">
                        <img id="imageview_popup_modal_img" style="position:absolute;width:800px;height:${heightPercent}%;left:${left}px;top:${top}px;">
                    </div>
                    <div class="imageview_popup_modal_undertext"><div class="image_fullview_extra_buttons"></div></div>
                </div>`;
            window.imageFullView._open = true;
        };

        /** A minimal touch-event stand-in carrying only what the real handlers read: touches/changedTouches
         *  (clientX/clientY/target) and no-op preventDefault/stopPropagation. */
        window.__fakeTouch = function (points, target) {
            let list = points.map(([x, y]) => ({ clientX: x, clientY: y, target }));
            return { touches: list, changedTouches: list, target, preventDefault() { }, stopPropagation() { } };
        };
        /** Same, but for touchend/touchcancel: real touch events report the LIFTED finger only in
         *  `changedTouches`, with `touches` already down to whatever (if anything) is still pressed - the
         *  real handlers branch on `e.touches.length == 0` to mean "the gesture is fully over", so a fake
         *  touchend with a non-empty `touches` list would silently never look like a released finger. */
        window.__fakeTouchEnd = function (points, target) {
            let list = points.map(([x, y]) => ({ clientX: x, clientY: y, target }));
            return { touches: [], changedTouches: list, target, preventDefault() { }, stopPropagation() { } };
        };
    }, { findParentOfClassSrc, pointerCoarse });

    await page.addScriptTag({ content: touchSrc });
    // Top-level `let` bindings from a classic <script> are visible to later same-realm evaluations in
    // Chromium, but pinning them onto `window` explicitly removes any doubt.
    await page.evaluate(() => {
        window.__touch = mobileFullViewTouch;
    });
    return page;
}

// ============================================================================================================
// 2b: rubber-band resistance at the first/last image (fit zoom)
// ============================================================================================================

{
    const page = await newHarnessPage(true, true);
    const out = await page.evaluate(async () => {
        window.__setupBatch(3, 0); // first image of 3, cycling off -> swiping toward "prev" is a real boundary
        window.__openImage({ heightPercent: 100 }); // fit zoom, not zoomed
        await new Promise(r => setTimeout(r, 0));

        let img = document.getElementById('imageview_popup_modal_img');
        let start = window.__fakeTouch([[200, 300]], img);
        window.__touch.onTouchStart(start);
        // Drag right (dx > 0): at the FIRST image this is the "previous image" direction - no neighbour.
        let move1 = window.__fakeTouch([[280, 300]], img); // dx = 80
        window.__touch.onTouchMove(move1);
        let inner = document.querySelector('.imageview_modal_inner_div');
        let transformAt80 = inner.style.transform;
        let move2 = window.__fakeTouch([[320, 300]], img); // dx = 120
        window.__touch.onTouchMove(move2);
        let transformAt120 = inner.style.transform;
        let end = window.__fakeTouchEnd([[320, 300]], img);
        window.__touch.onTouchEnd(end);
        // animateInnerHome() sets the spring-back transform synchronously; clearInner() then wipes it again
        // ~200ms later (its cleanup pass), so this must be read immediately, before that cleanup runs.
        let transformAfterEnd = document.querySelector('.imageview_modal_inner_div').style.transform;
        await new Promise(r => setTimeout(r, 250));
        return { transformAt80, transformAt120, transformAfterEnd, navCalls: window.__navCalls.length };
    });
    const extractPx = (s) => { let m = s && s.match(/translateX\(([-\d.]+)px\)/); return m ? parseFloat(m[1]) : null; };
    const px80 = extractPx(out.transformAt80);
    const px120 = extractPx(out.transformAt120);
    check('boundary swipe translates less than the finger travelled (80px finger)', px80 != null && Math.abs(px80) < 80, `translate=${out.transformAt80}`);
    check('boundary swipe translates less than the finger travelled (120px finger)', px120 != null && Math.abs(px120) < 120, `translate=${out.transformAt120}`);
    check('boundary swipe springs back to translate(0, 0) on release', /translate\(0(px)?,\s*0(px)?\)/.test(out.transformAfterEnd), `got: ${out.transformAfterEnd}`);
    check('boundary swipe never triggers navigation', out.navCalls == 0, `${out.navCalls} shiftToNextImagePreview call(s)`);
    await page.close();
}

// A non-boundary fit-zoom swipe (middle image) must still navigate exactly as before - proves the boundary
// check above isn't just suppressing navigation unconditionally.
{
    const page = await newHarnessPage(true, true);
    const out = await page.evaluate(async () => {
        window.__setupBatch(3, 1); // middle image - both directions have a neighbour
        window.__openImage({ heightPercent: 100 });
        await new Promise(r => setTimeout(r, 0));
        let img = document.getElementById('imageview_popup_modal_img');
        window.__touch.onTouchStart(window.__fakeTouch([[300, 300]], img));
        window.__touch.onTouchMove(window.__fakeTouch([[200, 300]], img)); // dx = -100, past navThreshold
        window.__touch.onTouchEnd(window.__fakeTouchEnd([[200, 300]], img));
        await new Promise(r => setTimeout(r, 400));
        return { navCalls: window.__navCalls.slice() };
    });
    check('a non-boundary fit-zoom swipe still navigates', out.navCalls.length == 1 && out.navCalls[0].next == true, JSON.stringify(out.navCalls));
    await page.close();
}

// ============================================================================================================
// 2b: edge-fling-while-zoomed
// ============================================================================================================

// Wrap is 400x400, image is 800x800 -> horizontal pan bounds are exactly [-600, 200]px (see __openImage doc).
const PAN_MAX = 200;   // image pushed fully right - its LEFT edge is exposed - dragging right further is blocked
const PAN_MIN = -600;  // image pushed fully left - its RIGHT edge is exposed - dragging left further is blocked

{
    const page = await newHarnessPage(true, true);
    const out = await page.evaluate(async ({ PAN_MAX }) => {
        window.__setupBatch(3, 1);
        window.__openImage({ heightPercent: 250, left: PAN_MAX }); // zoomed in, already at the max/left-exposed edge
        await new Promise(r => setTimeout(r, 0));
        let img = document.getElementById('imageview_popup_modal_img');
        // Fast fling to the right (dx > 0), starting exactly at the edge that blocks further rightward pan.
        window.__touch.onTouchStart(window.__fakeTouch([[100, 400]], img));
        window.__touch.onTouchMove(window.__fakeTouch([[220, 400]], img)); // dx = 120, fast (single frame)
        window.__touch.onTouchEnd(window.__fakeTouchEnd([[220, 400]], img));
        await new Promise(r => setTimeout(r, 400));
        return { navCalls: window.__navCalls.slice() };
    }, { PAN_MAX });
    check('edge fling while zoomed, starting at the pan edge, navigates (prev)', out.navCalls.length == 1 && out.navCalls[0].next == false, JSON.stringify(out.navCalls));
    await page.close();
}

{
    const page = await newHarnessPage(true, true);
    const out = await page.evaluate(async ({ PAN_MIN }) => {
        window.__setupBatch(3, 1);
        window.__openImage({ heightPercent: 250, left: PAN_MIN });
        await new Promise(r => setTimeout(r, 0));
        let img = document.getElementById('imageview_popup_modal_img');
        // Fast fling to the left (dx < 0), starting at the opposite edge.
        window.__touch.onTouchStart(window.__fakeTouch([[300, 400]], img));
        window.__touch.onTouchMove(window.__fakeTouch([[180, 400]], img)); // dx = -120, fast
        window.__touch.onTouchEnd(window.__fakeTouchEnd([[180, 400]], img));
        await new Promise(r => setTimeout(r, 400));
        return { navCalls: window.__navCalls.slice() };
    }, { PAN_MIN });
    check('edge fling while zoomed, starting at the opposite pan edge, navigates (next)', out.navCalls.length == 1 && out.navCalls[0].next == true, JSON.stringify(out.navCalls));
    await page.close();
}

// A fling while zoomed but NOT starting at the pan edge must keep panning, never navigate.
{
    const page = await newHarnessPage(true, true);
    const out = await page.evaluate(async () => {
        window.__setupBatch(3, 1);
        window.__openImage({ heightPercent: 250, left: 0 }); // mid-range: neither PAN_MAX nor PAN_MIN
        await new Promise(r => setTimeout(r, 0));
        let img = document.getElementById('imageview_popup_modal_img');
        let leftBefore = window.imageFullView.getImgLeft();
        window.__touch.onTouchStart(window.__fakeTouch([[100, 400]], img));
        window.__touch.onTouchMove(window.__fakeTouch([[220, 400]], img)); // dx = 120, fast, same as the nav case above
        window.__touch.onTouchEnd(window.__fakeTouchEnd([[220, 400]], img));
        await new Promise(r => setTimeout(r, 400));
        let leftAfter = window.imageFullView.getImgLeft();
        return { navCalls: window.__navCalls.slice(), leftBefore, leftAfter };
    });
    check('fast fling while zoomed but not at the edge does not navigate', out.navCalls.length == 0, JSON.stringify(out.navCalls));
    check('...and the pan itself still applied (ordinary pan keeps panning)', out.leftAfter != out.leftBefore, `left ${out.leftBefore} -> ${out.leftAfter}`);
    await page.close();
}

// An ordinary (slow) pan while zoomed, not at the edge, must never navigate either.
{
    const page = await newHarnessPage(true, true);
    const out = await page.evaluate(async () => {
        window.__setupBatch(3, 1);
        window.__openImage({ heightPercent: 250, left: 0 });
        await new Promise(r => setTimeout(r, 0));
        let img = document.getElementById('imageview_popup_modal_img');
        window.__touch.onTouchStart(window.__fakeTouch([[100, 400]], img));
        window.__touch.onTouchMove(window.__fakeTouch([[130, 400]], img)); // small, slow move
        await new Promise(r => setTimeout(r, 300)); // elapsed time makes velocity trivially low
        window.__touch.onTouchEnd(window.__fakeTouchEnd([[130, 400]], img));
        await new Promise(r => setTimeout(r, 400));
        return { navCalls: window.__navCalls.slice() };
    });
    check('a slow ordinary pan while zoomed does not navigate', out.navCalls.length == 0, JSON.stringify(out.navCalls));
    await page.close();
}

// ============================================================================================================
// 2c: mobile viewer chrome overlay
// ============================================================================================================

{
    const page = await newHarnessPage(true, true); // small-window: T9 overlay path
    const out = await page.evaluate(async () => {
        window.__setupBatch(8, 2);
        document.getElementById('image_fullview_modal_counter').textContent = '3/8 '; // core's own updateCounter() format
        window.__openImage({ heightPercent: 100 });
        await new Promise(r => setTimeout(r, 0)); // let the MutationObserver's ensureOverlay() run

        let wrap = document.querySelector('.imageview_modal_imagewrap');
        let indexTextAfterOpen = wrap.querySelector('.mobile-fullview-overlay-index').textContent;

        let img = document.getElementById('imageview_popup_modal_img');
        // Tap 1: touchstart+touchend at the same point, no movement -> handleTap() -> deferred toggle.
        window.__touch.onTouchStart(window.__fakeTouch([[150, 150]], img));
        window.__touch.onTouchEnd(window.__fakeTouchEnd([[150, 150]], img));
        await new Promise(r => setTimeout(r, 350)); // past doubleTapMs, so the deferred toggle has fired
        let visibleAfterTap1 = wrap.querySelector('.mobile-fullview-overlay-top').classList.contains('mobile-fullview-overlay-visible')
            && wrap.querySelector('.mobile-fullview-overlay-bottom').classList.contains('mobile-fullview-overlay-visible');
        let closedAfterTap1 = window.imageFullView.closeCalls > 0;

        // Tap 2: well past doubleTapMs since tap 1, so this is a fresh single tap, not a double-tap.
        window.__touch.onTouchStart(window.__fakeTouch([[150, 150]], img));
        window.__touch.onTouchEnd(window.__fakeTouchEnd([[150, 150]], img));
        await new Promise(r => setTimeout(r, 350));
        let visibleAfterTap2 = wrap.querySelector('.mobile-fullview-overlay-top').classList.contains('mobile-fullview-overlay-visible');

        let btnRects = [...wrap.querySelectorAll('.mobile-fullview-overlay-btn')].map(b => {
            let r = b.getBoundingClientRect();
            return { label: b.textContent || b.className, w: r.width, h: r.height };
        });

        return { indexTextAfterOpen, visibleAfterTap1, closedAfterTap1, visibleAfterTap2, btnRects };
    });
    check('tap toggles the overlay visible under body.small-window', out.visibleAfterTap1, JSON.stringify(out));
    check('tapping the viewer under body.small-window does not close it', !out.closedAfterTap1, `closeCalls>0: ${out.closedAfterTap1}`);
    check('second tap hides the overlay again', !out.visibleAfterTap2, `still visible: ${out.visibleAfterTap2}`);
    check('overlay index text matches the image position ("3 / 8")', out.indexTextAfterOpen == '3 / 8', `got "${out.indexTextAfterOpen}"`);
    check('every overlay button is at least 44x44', out.btnRects.length > 0 && out.btnRects.every(b => b.w >= 44 && b.h >= 44),
        JSON.stringify(out.btnRects));
    await page.close();
}

// Bottom-bar actions trigger the exact same handlers core uses (buttonsForImage()'s own onclick/href entries,
// and the global copy_current_image_params()) - never a reimplementation.
{
    const page = await newHarnessPage(true, true);
    const out = await page.evaluate(async () => {
        window.__setupBatch(2, 0);
        window.__openImage({ heightPercent: 100 });
        await new Promise(r => setTimeout(r, 0));
        let wrap = document.querySelector('.imageview_modal_imagewrap');
        let byLabel = (label) => [...wrap.querySelectorAll('.mobile-fullview-overlay-btn')].find(b => b.textContent == label);

        let downloads = [];
        let realClick = HTMLAnchorElement.prototype.click;
        HTMLAnchorElement.prototype.click = function () { downloads.push({ href: this.href, download: this.download }); };

        byLabel('Star').dispatchEvent(new Event('touchend', { cancelable: true, bubbles: true }));
        byLabel('Delete').dispatchEvent(new Event('touchend', { cancelable: true, bubbles: true }));
        byLabel('Download').dispatchEvent(new Event('touchend', { cancelable: true, bubbles: true }));
        byLabel('Reuse').dispatchEvent(new Event('touchend', { cancelable: true, bubbles: true }));

        HTMLAnchorElement.prototype.click = realClick;
        return {
            starCalls: window.__starOnclickCalls,
            deleteCalls: window.__deleteOnclickCalls,
            reuseCalls: window.__reuseCalls,
            downloads,
            hasShareButton: !!byLabel('Share')
        };
    });
    check('bottom-bar Star triggers buttonsForImage()\'s own Star onclick', out.starCalls == 1, `calls=${out.starCalls}`);
    check('bottom-bar Delete triggers buttonsForImage()\'s own Delete onclick', out.deleteCalls == 1, `calls=${out.deleteCalls}`);
    check('bottom-bar Download triggers buttonsForImage()\'s own href (download link)', out.downloads.length == 1 && out.downloads[0].href.includes('img0.png') && out.downloads[0].download == '', JSON.stringify(out.downloads));
    check('bottom-bar Reuse triggers the global copy_current_image_params()', out.reuseCalls == 1, `calls=${out.reuseCalls}`);
    check('bottom bar exposes the already-shipped Share action too', out.hasShareButton, '');
    await page.close();
}

// The overlay auto-hides on its own after MobileFullViewTouch.OverlayAutoHideMs with no interaction.
{
    const page = await newHarnessPage(true, true);
    const out = await page.evaluate(async () => {
        window.__setupBatch(3, 1);
        window.__openImage({ heightPercent: 100 });
        await new Promise(r => setTimeout(r, 0));
        let wrap = document.querySelector('.imageview_modal_imagewrap');
        let img = document.getElementById('imageview_popup_modal_img');
        window.__touch.onTouchStart(window.__fakeTouch([[150, 150]], img));
        window.__touch.onTouchEnd(window.__fakeTouchEnd([[150, 150]], img));
        await new Promise(r => setTimeout(r, 350));
        let visibleAfterTap = wrap.querySelector('.mobile-fullview-overlay-top').classList.contains('mobile-fullview-overlay-visible');
        // Just under, then just over, the auto-hide deadline measured from the tap that showed it.
        await new Promise(r => setTimeout(r, MobileFullViewTouch.OverlayAutoHideMs - 800));
        let visibleBeforeDeadline = wrap.querySelector('.mobile-fullview-overlay-top').classList.contains('mobile-fullview-overlay-visible');
        await new Promise(r => setTimeout(r, 900));
        let visibleAfterDeadline = wrap.querySelector('.mobile-fullview-overlay-top').classList.contains('mobile-fullview-overlay-visible');
        return { visibleAfterTap, visibleBeforeDeadline, visibleAfterDeadline, closeCalls: window.imageFullView.closeCalls };
    });
    check('overlay is still shown just before the auto-hide deadline', out.visibleAfterTap && out.visibleBeforeDeadline, JSON.stringify(out));
    check('overlay auto-hides itself after OverlayAutoHideMs (and does not close the viewer)', !out.visibleAfterDeadline && out.closeCalls == 0, JSON.stringify(out));
    await page.close();
}

// ============================================================================================================
// 2c: a COARSE-POINTER device that is NOT under body.small-window (a tablet running the desktop-width layout).
// ensureOverlay() injects the bars there (it only gates on pointer:coarse, exactly like the T7 Share button),
// so the CSS must keep them out of the layout entirely - otherwise they render as bare unstyled block divs
// inside the image wrap - and the tap must keep the original 2a metadata toggle.
// ============================================================================================================

{
    const page = await newHarnessPage(true, false); // coarse pointer, desktop-width layout
    const out = await page.evaluate(async () => {
        window.__setupBatch(3, 1);
        window.__openImage({ heightPercent: 100 });
        await new Promise(r => setTimeout(r, 0));
        let wrap = document.querySelector('.imageview_modal_imagewrap');
        let top = wrap.querySelector('.mobile-fullview-overlay-top');
        let bottom = wrap.querySelector('.mobile-fullview-overlay-bottom');
        let bars = [top, bottom].filter(b => b);
        let displays = bars.map(b => getComputedStyle(b).display);
        let boxes = bars.map(b => b.getBoundingClientRect()).map(r => ({ w: r.width, h: r.height }));
        let img = document.getElementById('imageview_popup_modal_img');
        window.__touch.onTouchStart(window.__fakeTouch([[150, 150]], img));
        window.__touch.onTouchEnd(window.__fakeTouchEnd([[150, 150]], img));
        await new Promise(r => setTimeout(r, 350));
        return {
            displays, boxes,
            visible: bars.some(b => b.classList.contains('mobile-fullview-overlay-visible')),
            metadataToggles: window.__metadataToggleCalls || 0,
            closeCalls: window.imageFullView.closeCalls
        };
    });
    check('coarse-pointer tablet without small-window renders no overlay chrome at all',
        out.displays.length > 0 && out.displays.every(d => d == 'none') && out.boxes.every(b => b.w == 0 && b.h == 0),
        JSON.stringify({ displays: out.displays, boxes: out.boxes }));
    check('coarse-pointer tablet without small-window keeps the original 2a metadata-toggle tap',
        out.metadataToggles == 1 && !out.visible && out.closeCalls == 0, JSON.stringify(out));
    await page.close();
}

// ============================================================================================================
// 2b: the boundary must be the boundary CORE would enforce for this caller. `ui.imageshiftingcycles` has a
// third value, 'only_arrows', under which core's shiftToNextImagePreview cycles whenever isArrows is true -
// and animateNav always passes isArrows true. So on that setting the first/last image is NOT a boundary and
// the swipe must navigate (wrap), not rubber-band.
// ============================================================================================================

{
    const page = await newHarnessPage(true, true);
    const out = await page.evaluate(async () => {
        window.__cycleSetting = 'only_arrows';
        window.__setupBatch(3, 0); // first image - a boundary only if cycling is genuinely off
        window.__openImage({ heightPercent: 100 });
        await new Promise(r => setTimeout(r, 0));
        let img = document.getElementById('imageview_popup_modal_img');
        window.__touch.onTouchStart(window.__fakeTouch([[200, 300]], img));
        window.__touch.onTouchMove(window.__fakeTouch([[300, 300]], img)); // dx = +100 -> "previous image"
        let liveTransform = document.querySelector('.imageview_modal_inner_div').style.transform;
        window.__touch.onTouchEnd(window.__fakeTouchEnd([[300, 300]], img));
        await new Promise(r => setTimeout(r, 400));
        return { navCalls: window.__navCalls.slice(), liveTransform };
    });
    check("with cycling set to 'only_arrows' the first image is not a boundary - the swipe navigates",
        out.navCalls.length == 1 && out.navCalls[0].next == false, JSON.stringify(out.navCalls));
    check("...and that swipe tracks the finger 1:1 (no rubber-band resistance applied)",
        out.liveTransform == 'translateX(100px)', `got: ${out.liveTransform}`);
    await page.close();
}

// ============================================================================================================
// 2c: the haptic tick is feature-guarded, and fires on image change and on dismiss.
// ============================================================================================================

{
    const page = await newHarnessPage(true, true);
    const out = await page.evaluate(async () => {
        let calls = [];
        Object.defineProperty(navigator, 'vibrate', { configurable: true, writable: true, value: (ms) => { calls.push(ms); return true; } });
        window.__setupBatch(3, 1);
        window.__openImage({ heightPercent: 100 });
        await new Promise(r => setTimeout(r, 0));
        let img = document.getElementById('imageview_popup_modal_img');
        // Navigation swipe -> haptic on image change.
        window.__touch.onTouchStart(window.__fakeTouch([[300, 300]], img));
        window.__touch.onTouchMove(window.__fakeTouch([[180, 300]], img));
        window.__touch.onTouchEnd(window.__fakeTouchEnd([[180, 300]], img));
        await new Promise(r => setTimeout(r, 400));
        let onNav = calls.length;
        // Swipe down past the dismiss threshold -> haptic on dismiss.
        window.__openImage({ heightPercent: 100 });
        await new Promise(r => setTimeout(r, 0));
        img = document.getElementById('imageview_popup_modal_img');
        window.__touch.onTouchStart(window.__fakeTouch([[200, 100]], img));
        window.__touch.onTouchMove(window.__fakeTouch([[200, 350]], img)); // dy = 250 > dismissThreshold
        window.__touch.onTouchEnd(window.__fakeTouchEnd([[200, 350]], img));
        await new Promise(r => setTimeout(r, 50));
        let onDismiss = calls.length - onNav;
        let closedByDismiss = window.imageFullView.closeCalls > 0;
        // Now the feature guard itself: no Vibration API at all must not throw.
        Object.defineProperty(navigator, 'vibrate', { configurable: true, writable: true, value: undefined });
        let threw = null;
        try {
            window.__openImage({ heightPercent: 100 });
            await new Promise(r => setTimeout(r, 0));
            let img2 = document.getElementById('imageview_popup_modal_img');
            window.__touch.onTouchStart(window.__fakeTouch([[200, 100]], img2));
            window.__touch.onTouchMove(window.__fakeTouch([[200, 350]], img2));
            window.__touch.onTouchEnd(window.__fakeTouchEnd([[200, 350]], img2));
        }
        catch (err) {
            threw = `${err}`;
        }
        return { onNav, onDismiss, closedByDismiss, threw, calls };
    });
    check('haptic tick fires on image change', out.onNav >= 1, JSON.stringify(out.calls));
    check('haptic tick fires on dismiss (which closes the viewer)', out.onDismiss >= 1 && out.closedByDismiss, JSON.stringify(out));
    check('haptic is feature-guarded - no Vibration API does not throw', out.threw == null, `${out.threw}`);
    await page.close();
}

// ============================================================================================================
// 2c: desktop (no body.small-window, no coarse pointer) - the touch layer stays fully inert, so the tap
// reaches the real core close-on-tap-outside-the-chrome listener untouched (reproduced here faithfully from
// currentimagehandler.js's ImageFullViewHelper constructor, read-only reference, since that listener itself
// lives outside this file's scope).
// ============================================================================================================

{
    const page = await newHarnessPage(false, false); // fine pointer, desktop-width layout
    const out = await page.evaluate(async () => {
        window.__setupBatch(3, 1);
        window.__openImage({ heightPercent: 100 });
        await new Promise(r => setTimeout(r, 0));
        let img = document.getElementById('imageview_popup_modal_img');

        // The real touch layer must never engage at all on a fine pointer.
        window.__touch.onTouchStart(window.__fakeTouch([[150, 150]], img));
        window.__touch.onTouchEnd(window.__fakeTouchEnd([[150, 150]], img));
        let noCloseSetByTouchLayer = window.imageFullView.noClose;

        // Reproduces ImageFullViewHelper's real document-level click listener condition verbatim
        // (currentimagehandler.js): close unless noClose, or the target is inside one of its exempt regions.
        function coreDocumentClickCloses(target) {
            if (!imageFullView.noClose && imageFullView.isOpen()
                && !findParentOfClass(target, 'imageview_popup_modal_undertext')
                && !findParentOfClass(target, 'video-controls') && !findParentOfClass(target, 'audio-controls')
                && !findParentOfClass(target, 'audio-waveform-wrap') && !findParentOfClass(target, 'image_fullview_extra_buttons')) {
                imageFullView.close();
                return true;
            }
            imageFullView.noClose = false;
            return false;
        }
        let overlayElems = document.querySelectorAll('.mobile-fullview-overlay-top, .mobile-fullview-overlay-bottom').length;
        let closed = coreDocumentClickCloses(img);
        return { noCloseSetByTouchLayer, closed, overlayElems, closeCalls: window.imageFullView.closeCalls };
    });
    check('no overlay chrome is ever injected on a fine pointer (desktop viewer DOM unchanged)', out.overlayElems == 0, `${out.overlayElems} element(s)`);
    check('the touch layer never engages on a fine pointer (noClose left untouched)', !out.noCloseSetByTouchLayer, `noClose=${out.noCloseSetByTouchLayer}`);
    check('desktop (no small-window, fine pointer) tap on the image still closes the viewer', out.closed && out.closeCalls == 1, JSON.stringify(out));
    await page.close();
}

await browser.close();

const failed = results.filter(r => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
