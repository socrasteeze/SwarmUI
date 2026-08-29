/**
 * MobileEnhancements — touch layer for the fullscreen image viewer and the image-compare modal (fork extension).
 *
 * Two independent classes, each augmenting one existing core modal with native-gallery touch gestures. Both
 * only ADD touch listeners and drive the core viewer's own primitives - the desktop mouse/wheel path in
 * currentimagehandler.js is never touched. All handling is gated to coarse (touch) pointers, so mouse
 * users are wholly unaffected. See docs/MobilePWA-Optimization-Plan.md (Phase 2).
 *
 * MobileFullViewTouch augments ImageFullViewHelper (detachImg / moveImg / getHeightPercent / showImage,
 * and the global shiftToNextImagePreview used by the arrow keys). Gestures: pinch-zoom (anchored) +
 * two-finger pan, one-finger pan when zoomed, double-tap zoom toggle, horizontal swipe to move between
 * images (at fit zoom), swipe-down to dismiss, single tap toggles the metadata chrome.
 *
 * MobileImageCompareTouch augments ImageCompareHelper (moveImg / getViewportFromTarget /
 * getOverlayDividerFromTarget / updateOverlaySplitFromClientPosition / clampPan / applyView / stopPanning -
 * the exact same state the mouse handlers drive). Gestures: one-finger pan, pinch-zoom (anchored, replicating
 * onWheel's math), one-finger drag on the slide-mode overlay divider.
 *
 * Every gesture fails safe: on any trouble the image is reset to a visible state.
 */
class MobileFullViewTouch {

    /** Wire touch listeners onto the fullview modal content. */
    constructor() {
        this.moveThreshold = 10;       // px of travel before a one-finger gesture commits to a direction
        this.navThreshold = 60;        // px (or fling) to commit an image change
        this.dismissThreshold = 120;   // px of downward travel to dismiss
        this.doubleTapMs = 300;        // max gap between taps for a double-tap
        this.doubleTapDist = 40;       // max px between taps for a double-tap
        this.reset();
        this.lastTapTime = 0;
        this.lastTapX = 0;
        this.lastTapY = 0;
        this.tapToggleTimer = null;
        this.animating = false;
        // T6 (adjacent-image preload): the two warmed Image() objects are held here so they survive until
        // the browser finishes fetching/decoding them - an unreferenced Image() can be GC'd mid-flight.
        this.preloadImg1 = null;
        this.preloadImg2 = null;
        // T7 (in-viewer Share button): the button element itself and the observer that re-injects it.
        this.shareButton = null;
        this.contentObserver = null;
        this.shareNoCloseTimer = null;
        let content = imageFullView.content;
        content.addEventListener('touchstart', this.onTouchStart.bind(this), { passive: false });
        content.addEventListener('touchmove', this.onTouchMove.bind(this), { passive: false });
        content.addEventListener('touchend', this.onTouchEnd.bind(this), { passive: false });
        content.addEventListener('touchcancel', this.onTouchCancel.bind(this), { passive: false });
        this.watchContent();
    }

    /** Reset per-gesture state. */
    reset() {
        this.ignoring = false;
        this.mode = null;              // null | 'pan' | 'pinch' | 'swipe' | 'dismiss'
        this.startX = 0;
        this.startY = 0;
        this.lastX = 0;
        this.lastY = 0;
        this.startTime = 0;
        this.didMove = false;
        this.pinchPrevDist = 0;
        this.pinchPrevMidX = 0;
        this.pinchPrevMidY = 0;
    }

    /** True only when the viewer is open on a touch device - the sole gate for all handling here. */
    isActive() {
        return imageFullView.isOpen() && window.matchMedia('(pointer: coarse)').matches;
    }

    /** True if the touch should be left to the browser: native media controls, the scrollable metadata /
     *  action-button area under the image, or the floating Share button (T7) overlaid on the image itself -
     *  without this it would otherwise read as "tap on the image" and get swallowed by the pan/tap gesture
     *  state machine below (toggling metadata, or worse, being interpreted as half of a double-tap zoom)
     *  instead of reaching the button's own tap handler. */
    isOnControls(target) {
        return findParentOfClass(target, 'video-controls') || findParentOfClass(target, 'audio-controls')
            || findParentOfClass(target, 'audio-waveform-wrap') || findParentOfClass(target, 'imageview_popup_modal_undertext')
            || findParentOfClass(target, 'mobile-fullview-share-btn');
    }

    /** True if the touch is on the image itself (vs the letterbox / outside area). */
    isOnImage(target) {
        return findParentOfClass(target, 'imageview_modal_imagewrap') != null;
    }

    /** True if the current media is a plain image (pinch/pan only make sense for images, not video/audio). */
    isPlainImage() {
        let img = imageFullView.getImg();
        return img && img.tagName == 'IMG';
    }

    /** True when the image is zoomed in past fit; one-finger drag then pans instead of navigating. */
    isZoomed() {
        return imageFullView.getHeightPercent() > 101;
    }

    /** The live inner container that wraps the image + metadata; the element we translate for slide/dismiss. */
    currentInner() {
        return imageFullView.content.querySelector('.imageview_modal_inner_div');
    }

    /** Distance between two active touches. */
    touchDist(a, b) {
        let dx = a.clientX - b.clientX;
        let dy = a.clientY - b.clientY;
        return Math.sqrt(dx * dx + dy * dy);
    }

    onTouchStart(e) {
        if (!this.isActive() || this.animating) {
            this.ignoring = true;
            return;
        }
        if (this.isOnControls(e.target)) {
            this.ignoring = true;
            return;
        }
        this.ignoring = false;
        if (e.touches.length == 2 && this.isPlainImage()) {
            this.mode = 'pinch';
            this.didMove = true;
            this.pinchPrevDist = this.touchDist(e.touches[0], e.touches[1]);
            this.pinchPrevMidX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
            this.pinchPrevMidY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
            e.preventDefault();
            return;
        }
        if (e.touches.length == 1) {
            let t = e.touches[0];
            this.mode = null;
            this.startX = t.clientX;
            this.startY = t.clientY;
            this.lastX = t.clientX;
            this.lastY = t.clientY;
            this.startTime = Date.now();
            this.didMove = false;
            // Touches on the image are handled entirely here; preventDefault suppresses the synthetic mouse
            // events browsers fire after touch (which would otherwise trigger the core's mouse-pan handler).
            // Touches OUTSIDE the image are left alone so their synthetic click still closes the modal.
            if (this.isOnImage(t.target)) {
                e.preventDefault();
            }
        }
    }

    onTouchMove(e) {
        if (!this.isActive() || this.ignoring) {
            return;
        }
        if (this.mode == 'pinch') {
            if (e.touches.length < 2) {
                return;
            }
            e.preventDefault();
            let newDist = this.touchDist(e.touches[0], e.touches[1]);
            let midX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
            let midY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
            if (this.pinchPrevDist > 0) {
                let factor = newDist / this.pinchPrevDist;
                this.zoomAt(midX, midY, factor);
                // Pan by how far the pinch midpoint drifted, so the image tracks the fingers.
                imageFullView.moveImg(midX - this.pinchPrevMidX, midY - this.pinchPrevMidY);
            }
            this.pinchPrevDist = newDist;
            this.pinchPrevMidX = midX;
            this.pinchPrevMidY = midY;
            return;
        }
        if (e.touches.length != 1) {
            return;
        }
        let t = e.touches[0];
        let dx = t.clientX - this.startX;
        let dy = t.clientY - this.startY;
        if (!this.mode) {
            if (Math.abs(dx) < this.moveThreshold && Math.abs(dy) < this.moveThreshold) {
                return;
            }
            // First decisive movement picks the gesture. Zoomed -> pan. At fit: horizontal -> navigate,
            // downward -> dismiss, upward -> pan (harmless).
            if (this.isZoomed()) {
                this.mode = 'pan';
            }
            else if (Math.abs(dx) > Math.abs(dy)) {
                this.mode = 'swipe';
            }
            else if (dy > 0) {
                this.mode = 'dismiss';
            }
            else {
                this.mode = 'pan';
            }
            this.didMove = true;
        }
        if (this.mode == 'pan') {
            e.preventDefault();
            imageFullView.detachImg();
            imageFullView.moveImg(t.clientX - this.lastX, t.clientY - this.lastY);
        }
        else if (this.mode == 'swipe') {
            e.preventDefault();
            this.setInnerTransform(`translateX(${dx}px)`, '');
        }
        else if (this.mode == 'dismiss') {
            e.preventDefault();
            this.setInnerTransform(`translate(${dx * 0.4}px, ${dy}px)`, '');
            // Fade the backdrop toward transparent as the image is dragged away.
            let fade = Math.max(0.25, 1 - dy / (window.innerHeight * 0.8));
            imageFullView.content.style.opacity = `${fade}`;
        }
        this.lastX = t.clientX;
        this.lastY = t.clientY;
    }

    onTouchEnd(e) {
        if (this.ignoring) {
            this.ignoring = false;
            return;
        }
        if (!this.isActive()) {
            this.reset();
            return;
        }
        // Any gesture that moved must suppress the synthetic close-click that follows touchend.
        if (this.didMove) {
            imageFullView.noClose = true;
        }
        if (this.mode == 'swipe') {
            this.finishSwipe(e);
        }
        else if (this.mode == 'dismiss') {
            this.finishDismiss(e);
        }
        else if (!this.mode && e.touches.length == 0) {
            this.handleTap(e);
        }
        if (this.mode != 'pinch' || e.touches.length == 0) {
            this.reset();
        }
    }

    onTouchCancel(e) {
        this.animateInnerHome();
        imageFullView.content.style.opacity = '';
        this.reset();
    }

    /** Commit or spring back a horizontal navigation swipe. */
    finishSwipe(e) {
        let dx = this.lastX - this.startX;
        let elapsed = Math.max(1, Date.now() - this.startTime);
        let velocity = Math.abs(dx) / elapsed; // px/ms
        if (Math.abs(dx) > this.navThreshold || velocity > 0.5) {
            this.animateNav(dx < 0);
        }
        else {
            this.animateInnerHome();
        }
    }

    /** Commit dismiss (close) or spring back a downward swipe. */
    finishDismiss(e) {
        let dy = this.lastY - this.startY;
        if (dy > this.dismissThreshold) {
            imageFullView.content.style.opacity = '';
            imageFullView.close();
        }
        else {
            this.animateInnerHome();
            imageFullView.content.style.opacity = '';
        }
    }

    /** Handle a stationary tap: double-tap zooms, single tap toggles the metadata chrome. */
    handleTap(e) {
        if (!this.isOnImage(e.target)) {
            return; // tap outside the image -> let the core click handler close the modal
        }
        // A tap on the image should not close the modal (that would block double-tap zoom).
        imageFullView.noClose = true;
        let now = Date.now();
        let touch = e.changedTouches[0];
        let isDouble = (now - this.lastTapTime < this.doubleTapMs)
            && Math.abs(touch.clientX - this.lastTapX) < this.doubleTapDist
            && Math.abs(touch.clientY - this.lastTapY) < this.doubleTapDist;
        if (isDouble) {
            if (this.tapToggleTimer) {
                clearTimeout(this.tapToggleTimer);
                this.tapToggleTimer = null;
            }
            this.lastTapTime = 0;
            this.doubleTapZoom(touch.clientX, touch.clientY);
            return;
        }
        this.lastTapTime = now;
        this.lastTapX = touch.clientX;
        this.lastTapY = touch.clientY;
        // Defer the single-tap action briefly so a second tap can pre-empt it as a double-tap.
        if (this.tapToggleTimer) {
            clearTimeout(this.tapToggleTimer);
        }
        this.tapToggleTimer = setTimeout(() => {
            this.tapToggleTimer = null;
            if (this.isPlainImage()) {
                imageFullView.toggleMetadataVisibility(!imageFullView.showMetadata);
            }
        }, this.doubleTapMs);
    }

    /** Double-tap: toggle between fit and a comfortable zoom, anchored at the tap point. */
    doubleTapZoom(x, y) {
        if (!this.isPlainImage()) {
            return;
        }
        let cur = imageFullView.getHeightPercent();
        if (cur > 101) {
            this.zoomAt(x, y, 100 / cur);
        }
        else {
            this.zoomAt(x, y, 2.5);
        }
    }

    /**
     * Zoom the image by `factor` about the (clientX, clientY) point, replicating ImageFullViewHelper.onWheel's
     * math exactly (height-percent zoom, max-height clamp, pixelated past threshold, metadata toggle, anchor
     * correction) but driven by an explicit factor instead of a wheel delta.
     */
    zoomAt(clientX, clientY, factor) {
        imageFullView.detachImg();
        let img = imageFullView.getImg();
        let container = imageFullView.getImgOrContainer();
        if (!img || !container) {
            return;
        }
        let origHeight = imageFullView.getHeightPercent();
        let width = img.naturalWidth ?? img.videoWidth;
        let height = img.naturalHeight ?? img.videoHeight;
        let maxHeight = Math.sqrt(width * height) * 2;
        let newHeight = Math.max(10, Math.min(origHeight * factor, maxHeight));
        if (newHeight > maxHeight / 5) {
            img.style.imageRendering = 'pixelated';
        }
        else {
            img.style.imageRendering = '';
        }
        if (newHeight > 100.1) {
            imageFullView.toggleMetadataVisibility(false);
        }
        else if (newHeight < 100.1) {
            imageFullView.toggleMetadataVisibility(true);
        }
        container.style.cursor = 'grab';
        let imgLeft = imageFullView.getImgLeft();
        let imgTop = imageFullView.getImgTop();
        let mouseX = clientX - container.offsetLeft;
        let mouseY = clientY - container.offsetTop;
        let origX = mouseX / origHeight - imgLeft;
        let origY = mouseY / origHeight - imgTop;
        let newX = mouseX / newHeight - imgLeft;
        let newY = mouseY / newHeight - imgTop;
        imageFullView.moveImg((newX - origX) * newHeight, (newY - origY) * newHeight);
        container.style.height = `${newHeight}%`;
    }

    /** Apply a transform to the inner container (used for live swipe/dismiss follow). */
    setInnerTransform(transform, transition) {
        let inner = this.currentInner();
        if (!inner) {
            return;
        }
        inner.style.transition = transition;
        inner.style.transform = transform;
    }

    /** Spring the inner container back to its resting position. */
    animateInnerHome() {
        let inner = this.currentInner();
        if (!inner) {
            return;
        }
        inner.style.transition = 'transform 0.18s ease-out';
        inner.style.transform = 'translate(0, 0)';
        setTimeout(() => this.clearInner(), 200);
    }

    /** Remove transient transform/transition so it can't interfere with later gestures. */
    clearInner() {
        let inner = this.currentInner();
        if (inner) {
            inner.style.transition = '';
            inner.style.transform = '';
        }
        imageFullView.content.style.opacity = '';
    }

    /**
     * Animate an image change: slide the current image out in the travel direction, ask the core
     * navigator (shiftToNextImagePreview - the same path the arrow keys use) for the next/prev image,
     * then slide the new one in from the opposite edge. Rubber-bands back if there is no next image.
     */
    animateNav(next) {
        let inner = this.currentInner();
        if (!inner || typeof shiftToNextImagePreview != 'function') {
            // Fallback: no animation, just navigate.
            if (typeof shiftToNextImagePreview == 'function') {
                shiftToNextImagePreview(next, true, true);
            }
            this.clearInner();
            return;
        }
        this.animating = true;
        let width = window.innerWidth;
        let outX = next ? -width : width;
        inner.style.transition = 'transform 0.15s ease-out';
        inner.style.transform = `translateX(${outX}px)`;
        setTimeout(() => {
            let moved = false;
            try {
                moved = shiftToNextImagePreview(next, true, true);
            }
            catch (err) {
                console.log(`Mobile swipe navigation failed: ${err}`);
            }
            let newInner = this.currentInner();
            if (moved && newInner) {
                newInner.style.transition = 'none';
                newInner.style.transform = `translateX(${-outX}px)`;
                void newInner.offsetWidth; // force reflow so the next transform animates
                requestAnimationFrame(() => {
                    let ni = this.currentInner();
                    if (ni) {
                        ni.style.transition = 'transform 0.18s ease-out';
                        ni.style.transform = 'translateX(0)';
                    }
                    this.haptic();
                    // T6: warm the new current image's own neighbours now that the swap has committed. The
                    // watchContent() observer below also fires for this same navigation (showImage() rebuilt
                    // imageFullView.content to get here) and calls preloadAdjacent() itself; that's fine
                    // (preloadAdjacent() is idempotent - reusing an already-warm URL just hits cache), this
                    // call just guarantees it happens even if a future refactor changes that observer.
                    this.preloadAdjacent();
                    setTimeout(() => {
                        this.clearInner();
                        this.animating = false;
                    }, 200);
                });
            }
            else {
                // No next image (boundary, cycling off) - bounce the current one back.
                if (newInner) {
                    newInner.style.transition = 'transform 0.18s ease-out';
                    newInner.style.transform = 'translateX(0)';
                }
                setTimeout(() => {
                    this.clearInner();
                    this.animating = false;
                }, 200);
            }
        }, 150);
    }

    /** Light haptic feedback where supported (no-ops on iOS Safari, which lacks the Vibration API). */
    haptic() {
        if (navigator.vibrate) {
            navigator.vibrate(8);
        }
    }

    // ---------------------------------------------------------------------------------------------------
    // T6: adjacent-image preload (docs/MobilePWA-Optimization-Plan.md section 2b)
    // ---------------------------------------------------------------------------------------------------

    /**
     * Preload the +/-1 neighbour images around whatever is currently open in the full-view modal, so a
     * follow-up swipe in either direction shows an already-decoded image instead of a blank/loading frame.
     * Resolves neighbours exactly the way the core shiftToNextImagePreview does it
     * (src/wwwroot/js/genpage/gentab/currentimagehandler.js, ~line 720-790, read-only reference - never
     * edited): history mode walks lastHistoryImageDiv's `.image-block` siblings; batch mode walks
     * #current_image_batch's `.image-block-img-inner` list and maps back to each one's `.image-block`
     * parent. Reads that parent's `dataset.src` - the full-resolution URL - rather than the strip
     * thumbnail's own `img.src` (another agent's parallel work points the strip's `img.src` at a lower-res
     * preview URL; `dataset.src` stays full-res regardless, so this stays correct either way). Warms each
     * with a throwaway `new Image()`. No-ops in a backgrounded tab (nothing to gain warming images the user
     * cannot currently see) or once the touch viewer itself is not open.
     */
    preloadAdjacent() {
        if (document.hidden || !this.isActive()) {
            return;
        }
        if (typeof currentImageHelper == 'undefined' || !currentImageHelper) {
            return;
        }
        let curImgElem = currentImageHelper.getCurrentImage();
        if (!curImgElem) {
            return;
        }
        let doCycle = typeof getUserSetting == 'function' ? getUserSetting('ui.imageshiftingcycles', 'true') == 'true' : true;
        let blocks;
        let index;
        if (curImgElem.dataset.batch_id == 'history') {
            if (typeof lastHistoryImageDiv == 'undefined' || !lastHistoryImageDiv || !lastHistoryImageDiv.parentElement) {
                return;
            }
            blocks = [...lastHistoryImageDiv.parentElement.children].filter(div => div.classList.contains('image-block'));
            index = blocks.findIndex(div => div == lastHistoryImageDiv);
        }
        else {
            let batchArea = document.getElementById('current_image_batch');
            if (!batchArea) {
                return;
            }
            let imgs = [...batchArea.getElementsByClassName('image-block-img-inner')].filter(i => findParentOfClass(i, 'image-block-placeholder') == null);
            function getSrc(elem) {
                if (elem.tagName == 'VIDEO') {
                    let source = elem.querySelector('source');
                    return source ? source.src : '';
                }
                return elem.src;
            }
            let curSrc = getSrc(curImgElem);
            // The batch strip's thumbnails may carry a `?preview=true` suffix on their own `img.src` that
            // the main current image's src does not (see getThumbnailSrc / appendImage in
            // currentimagehandler.js), so the resolved-URL compare alone matches nothing and this would
            // silently never preload anything in batch mode. Fall back to comparing the raw unresolved srcs
            // stashed in dataset, exactly as shiftToNextImagePreview does.
            let curRawSrc = curImgElem.dataset.src;
            blocks = imgs.map(img => findParentOfClass(img, 'image-block'));
            index = imgs.findIndex((img, i) => {
                if (getSrc(img) == curSrc) {
                    return true;
                }
                let block = blocks[i];
                return block != null && curRawSrc != null && block.dataset.src == curRawSrc;
            });
        }
        if (index == -1 || !blocks || blocks.length == 0) {
            return;
        }
        this.preloadImg1 = this.warmSrc(this.neighbourSrc(blocks, index - 1, doCycle));
        this.preloadImg2 = this.warmSrc(this.neighbourSrc(blocks, index + 1, doCycle));
    }

    /**
     * Full-resolution `dataset.src` of the `.image-block` at `index` in `blocks` (wrapping around when
     * `doCycle`, matching the user's own cycle setting rather than always/never wrapping), or null when
     * there is nothing worth preloading there: out of bounds and not cycling, a still-loading placeholder,
     * a `data:` URL (already in memory, nothing to fetch), or a video/audio entry (the viewer streams those
     * rather than showing a decoded bitmap, so warming them through `new Image()` accomplishes nothing).
     */
    neighbourSrc(blocks, index, doCycle) {
        let len = blocks.length;
        if (len == 0) {
            return null;
        }
        if (index < 0) {
            if (!doCycle) {
                return null;
            }
            index = len - 1;
        }
        else if (index >= len) {
            if (!doCycle) {
                return null;
            }
            index = 0;
        }
        let block = blocks[index];
        if (!block || block.classList.contains('image-block-placeholder')) {
            return null;
        }
        let src = block.dataset.src;
        if (!src || src.startsWith('data:') || isVideoExt(src) || isAudioExt(src)) {
            return null;
        }
        return src;
    }

    /** Warm one URL with a throwaway Image() (a no-op for a null/falsy src), returned so the caller can hold
     *  it on `this` and keep it alive until the browser finishes fetching/decoding it. */
    warmSrc(src) {
        if (!src) {
            return null;
        }
        let img = new Image();
        img.src = src;
        return img;
    }

    // ---------------------------------------------------------------------------------------------------
    // T7: in-viewer Share button (touch + Web Share API only)
    // ---------------------------------------------------------------------------------------------------

    /**
     * Watches the full-view modal's content for the complete innerHTML rebuild that showImage() does on
     * every open and every navigation (currentimagehandler.js) - anything appended as a child of
     * imageFullView.content does not survive that rebuild, so this re-applies the per-image setup
     * (Share button injection, adjacent-image preload) each time it happens. This is also the "once when
     * the viewer becomes active for a new image" trigger for both T6 and T7, covering navigation methods
     * this file doesn't itself drive (arrow keys, clicking a history/batch thumbnail directly).
     */
    watchContent() {
        if (!imageFullView || !imageFullView.content) {
            return;
        }
        let onChange = () => {
            this.ensureShareButton();
            this.preloadAdjacent();
        };
        this.contentObserver = new MutationObserver(onChange);
        this.contentObserver.observe(imageFullView.content, { childList: true });
    }

    /**
     * (Re)inject the floating Share button into the currently open image, if this device qualifies
     * (a coarse/touch pointer AND the Web Share API exists - both checked fresh on every call, so this
     * never has stale state to react to) and it is not already present. A no-op everywhere else, including
     * every desktop browser regardless of Web Share API support - the pointer check alone keeps the element
     * from ever being created there.
     */
    ensureShareButton() {
        if (!navigator.share || !window.matchMedia('(pointer: coarse)').matches) {
            return;
        }
        let wrap = imageFullView.content.querySelector('.imageview_modal_imagewrap');
        if (!wrap || wrap.querySelector('.mobile-fullview-share-btn')) {
            return;
        }
        let btn = document.createElement('div');
        btn.className = 'mobile-fullview-share-btn';
        btn.textContent = 'Share';
        btn.setAttribute('role', 'button');
        btn.setAttribute('tabindex', '0');
        btn.setAttribute('aria-label', 'Share this image');
        let activate = (e) => {
            e.preventDefault();
            e.stopPropagation();
            this.suppressModalClose();
            this.doShare();
        };
        // touchend (not click) does the real work, and preventDefault()s to suppress the synthetic click that
        // would otherwise follow: this button lives inside imageview_modal_imagewrap, which is NOT one of the
        // classes ImageFullViewHelper's own document-level click listener exempts from its
        // tap-outside-closes-the-modal behavior (currentimagehandler.js) - a real click reaching that listener
        // would close the viewer instead of sharing it. suppressModalClose() is the same noClose backstop this
        // file's own handleTap() already relies on for on-image taps, kept here in case some browser still lets
        // a click through despite preventDefault.
        btn.addEventListener('touchend', activate, { passive: false });
        // Fallback for non-touch activation (e.g. assistive tech triggering a synthetic click) - harmless to
        // keep even though this button is never created on a fine-pointer device in the first place. The
        // pointerdown below is what makes it actually reachable: that document-level click listener runs in the
        // CAPTURE phase, i.e. before this one, so without noClose already set by then it would close the modal
        // and stopPropagation() the click before it ever arrives here.
        btn.addEventListener('pointerdown', () => this.suppressModalClose());
        btn.addEventListener('click', activate);
        wrap.appendChild(btn);
        this.shareButton = btn;
    }

    /**
     * Tell ImageFullViewHelper's document-level click listener to skip its tap-outside-closes-the-modal pass
     * for whatever click this activation may produce, then clear the flag again shortly afterwards. The clear
     * matters: that listener resets `noClose` itself, but only when a click actually reaches it, and the
     * touch path here preventDefault()s the synthetic click out of existence - so the flag would otherwise
     * stay set indefinitely and silently eat the user's NEXT tap-outside instead of closing the viewer.
     */
    suppressModalClose() {
        imageFullView.noClose = true;
        if (this.shareNoCloseTimer) {
            clearTimeout(this.shareNoCloseTimer);
        }
        this.shareNoCloseTimer = setTimeout(() => {
            this.shareNoCloseTimer = null;
            imageFullView.noClose = false;
        }, 700);
    }

    /**
     * Share the currently open image/video via the Web Share API. Prefers sharing the actual file, so the
     * receiving app gets real media data instead of a link the recipient may not be able to open (an
     * internal server hostname, a login-gated page); falls back to a plain URL share whenever the file
     * can't be built or isn't shareable. AbortError (the user dismissing the native share sheet) is
     * swallowed - that is the user's own choice, not a failure. Any other failure surfaces through the same
     * global error toast the rest of the app uses (site.js's showError).
     */
    async doShare() {
        if (!this.isActive() || !navigator.share) {
            return;
        }
        let src = imageFullView.currentSrc;
        if (!src) {
            return;
        }
        try {
            let absUrl = new URL(src, location.href).href;
            let file = await this.buildShareFile(src, absUrl);
            if (file && navigator.canShare && navigator.canShare({ files: [file] })) {
                await navigator.share({ files: [file] });
                return;
            }
            await navigator.share({ url: absUrl });
        }
        catch (err) {
            if (err && err.name == 'AbortError') {
                return;
            }
            showError(`Share failed: ${err}`);
        }
    }

    /**
     * Fetch `src` and wrap it as a File for navigator.share({files}). Never throws - any failure (network
     * error, CORS, a data: URL) returns null instead, so the caller falls back to a plain URL share.
     */
    async buildShareFile(src, absUrl) {
        if (src.startsWith('data:')) {
            return null;
        }
        try {
            let response = await fetch(absUrl);
            if (!response.ok) {
                return null;
            }
            let blob = await response.blob();
            let mediaType = getMediaType(src);
            let extMatch = src.split('?')[0].match(/\.([a-zA-Z0-9]+)$/);
            let ext = extMatch ? extMatch[1] : (mediaType == 'video' ? 'mp4' : (mediaType == 'audio' ? 'mp3' : 'png'));
            return new File([blob], `share.${ext}`, { type: blob.type || `${mediaType}/*` });
        }
        catch (err) {
            return null;
        }
    }
}

let mobileFullViewTouch = new MobileFullViewTouch();

/**
 * MobileEnhancements — touch layer for the image-compare modal (fork extension).
 *
 * Augments the existing ImageCompareHelper modal (`imageCompareHelper`, global) with the same three
 * interactions its mouse path supports, driven through its own public methods and fields so the touch and
 * mouse paths share one viewport state (`panX`/`panY`/`zoom`/`overlaySplitPercent`) and can never diverge:
 *   - one-finger pan of the image(s) - mirrors onMouseDown + onGlobalMouseMove (moveImg + applyView)
 *   - two-finger pinch zoom, anchored at the pinch midpoint - replicates onWheel's zoom math exactly
 *     (zoomAt below), driven by the ratio of successive inter-touch distances instead of a wheel delta,
 *     plus pan by however far that midpoint drifts between frames
 *   - one-finger drag on the slide-mode overlay divider - mirrors the onMouseDown divider branch +
 *     the onGlobalMouseMove isAdjustingOverlaySplit branch (updateOverlaySplitFromClientPosition)
 * Touch events target-lock to their initial element, so (unlike the mouse path) no document-level
 * listeners are needed - touchmove/touchend keep arriving on the stage even once fingers wander outside it.
 */
class MobileImageCompareTouch {

    /** Wire touch listeners onto the compare stage. */
    constructor() {
        this.stage = imageCompareHelper.stage;
        this.mode = null;              // null | 'pan' | 'divider' | 'pinch'
        this.didMove = false;
        this.lastX = 0;
        this.lastY = 0;
        this.holdingPanState = false;  // true while we own imageCompareHelper's isDragging/isAdjustingOverlaySplit
        this.pinchViewport = null;
        this.pinchPrevDist = 0;
        this.pinchPrevMidX = 0;
        this.pinchPrevMidY = 0;
        this.stage.addEventListener('touchstart', this.onTouchStart.bind(this), { passive: false });
        this.stage.addEventListener('touchmove', this.onTouchMove.bind(this), { passive: false });
        this.stage.addEventListener('touchend', this.onTouchEnd.bind(this), { passive: false });
        this.stage.addEventListener('touchcancel', this.onTouchCancel.bind(this), { passive: false });
    }

    /** True only when the compare modal is open with two images selected, on a touch device. */
    isActive() {
        return imageCompareHelper.hasSelection() && imageCompareHelper.isOpen() && window.matchMedia('(pointer: coarse)').matches;
    }

    /**
     * Hand back any pan/divider state we took from imageCompareHelper. Must run on every exit from a 'pan' or
     * 'divider' gesture - including the mid-gesture exits (a second finger arriving to start a pinch, or a
     * touch that lands somewhere we don't handle) - or isDragging / isAdjustingOverlaySplit would stay stuck
     * true and the viewport cursor stuck on 'grabbing', diverging from the mouse path's state.
     * stopPanning() (ignoreDragClose defaulted false) folds didDrag into noClose exactly as onGlobalMouseUp does.
     */
    releasePanState() {
        if (this.holdingPanState) {
            this.holdingPanState = false;
            imageCompareHelper.stopPanning();
        }
    }

    /** Distance between two active touches. */
    touchDist(a, b) {
        let dx = a.clientX - b.clientX;
        let dy = a.clientY - b.clientY;
        return Math.sqrt(dx * dx + dy * dy);
    }

    onTouchStart(e) {
        if (!this.isActive()) {
            this.releasePanState();
            this.mode = null;
            return;
        }
        if (e.touches.length == 2) {
            let t0 = e.touches[0], t1 = e.touches[1];
            this.pinchViewport = imageCompareHelper.getViewportFromTarget(t0.target) || imageCompareHelper.getViewportFromTarget(t1.target);
            // A pinch normally begins as a one-finger pan/divider drag, so release that state before switching.
            this.releasePanState();
            if (!this.pinchViewport) {
                this.mode = null;
                return;
            }
            this.mode = 'pinch';
            this.didMove = false;
            this.pinchPrevDist = this.touchDist(t0, t1);
            this.pinchPrevMidX = (t0.clientX + t1.clientX) / 2;
            this.pinchPrevMidY = (t0.clientY + t1.clientY) / 2;
            e.preventDefault();
            return;
        }
        if (e.touches.length != 1) {
            this.releasePanState();
            this.mode = null;
            return;
        }
        let t = e.touches[0];
        let viewport = imageCompareHelper.getViewportFromTarget(t.target);
        if (!viewport) {
            // Not over the image/overlay (e.g. mode buttons, metadata, scrub row) - leave untouched so the
            // browser's native tap/scroll behavior on those controls still works.
            this.releasePanState();
            this.mode = null;
            return;
        }
        this.lastX = t.clientX;
        this.lastY = t.clientY;
        this.didMove = false;
        imageCompareHelper.lastMouseX = t.clientX;
        imageCompareHelper.lastMouseY = t.clientY;
        let divider = imageCompareHelper.getOverlayDividerFromTarget(t.target);
        if (divider) {
            this.mode = 'divider';
            imageCompareHelper.updateOverlaySplitFromClientPosition(viewport, t.clientX, t.clientY);
            imageCompareHelper.isAdjustingOverlaySplit = true;
            imageCompareHelper.setViewportCursor(imageCompareHelper.getSlideAxis() == 'y' ? 'ns-resize' : 'ew-resize');
        }
        else {
            this.mode = 'pan';
            imageCompareHelper.isDragging = true;
            imageCompareHelper.setViewportCursor('grabbing');
        }
        this.holdingPanState = true;
        e.preventDefault();
    }

    onTouchMove(e) {
        if (!this.isActive() || !this.mode) {
            return;
        }
        if (this.mode == 'pinch') {
            if (e.touches.length < 2) {
                return;
            }
            e.preventDefault();
            let t0 = e.touches[0], t1 = e.touches[1];
            let newDist = this.touchDist(t0, t1);
            let midX = (t0.clientX + t1.clientX) / 2;
            let midY = (t0.clientY + t1.clientY) / 2;
            if (this.pinchPrevDist > 0) {
                let factor = newDist / this.pinchPrevDist;
                this.zoomAt(this.pinchViewport, midX, midY, factor);
                // Pan by how far the pinch midpoint drifted, so the image tracks the fingers.
                imageCompareHelper.moveImg(midX - this.pinchPrevMidX, midY - this.pinchPrevMidY);
                imageCompareHelper.applyView();
            }
            this.pinchPrevDist = newDist;
            this.pinchPrevMidX = midX;
            this.pinchPrevMidY = midY;
            this.didMove = true;
            return;
        }
        if (e.touches.length != 1) {
            return;
        }
        let t = e.touches[0];
        if (this.mode == 'divider') {
            e.preventDefault();
            let overlay = imageCompareHelper.getOverlay();
            if (overlay) {
                imageCompareHelper.updateOverlaySplitFromClientPosition(overlay, t.clientX, t.clientY);
            }
            if (Math.abs(t.clientX - this.lastX) > 1 || Math.abs(t.clientY - this.lastY) > 1) {
                imageCompareHelper.didDrag = true;
            }
        }
        else if (this.mode == 'pan') {
            e.preventDefault();
            let xDiff = t.clientX - imageCompareHelper.lastMouseX;
            let yDiff = t.clientY - imageCompareHelper.lastMouseY;
            imageCompareHelper.lastMouseX = t.clientX;
            imageCompareHelper.lastMouseY = t.clientY;
            imageCompareHelper.moveImg(xDiff, yDiff);
            if (Math.abs(xDiff) > 1 || Math.abs(yDiff) > 1) {
                imageCompareHelper.didDrag = true;
            }
            imageCompareHelper.applyView();
        }
        else {
            return;
        }
        this.lastX = t.clientX;
        this.lastY = t.clientY;
        this.didMove = true;
    }

    onTouchEnd(e) {
        // Mirrors onGlobalMouseUp exactly: releases the cursor, clears isDragging/isAdjustingOverlaySplit,
        // and folds didDrag into noClose so the tap-to-close handler ignores a click that ends a drag.
        this.releasePanState();
        if (this.didMove) {
            imageCompareHelper.noClose = true;
        }
        if (e.touches.length == 0) {
            this.mode = null;
            this.didMove = false;
            this.pinchPrevDist = 0;
        }
        else if (this.mode == 'pinch' && e.touches.length < 2) {
            // A finger lifted mid-pinch - end the gesture cleanly rather than guessing a new anchor.
            this.mode = null;
            this.pinchPrevDist = 0;
        }
    }

    onTouchCancel(e) {
        this.releasePanState();
        this.mode = null;
        this.didMove = false;
        this.pinchPrevDist = 0;
    }

    /**
     * Zoom the compare viewport by `factor` about the (clientX, clientY) point, replicating
     * ImageCompareHelper.onWheel's math exactly (height-percent zoom, max-height clamp, pixelated past
     * threshold, anchor-preserving pan correction, clampPan) but driven by an explicit factor instead of a
     * wheel delta.
     */
    zoomAt(viewport, clientX, clientY, factor) {
        let layout = imageCompareHelper.getViewportLayout(viewport);
        if (!layout) {
            return;
        }
        let rect = layout.rect;
        if (!rect.width || !rect.height) {
            return;
        }
        let origHeight = imageCompareHelper.getHeightPercent();
        let minHeight = 10;
        let maxHeight = imageCompareHelper.getMaxHeight();
        if (maxHeight <= 0) {
            maxHeight = Math.max(minHeight, origHeight * 4);
        }
        let newHeight = Math.max(minHeight, Math.min(origHeight * factor, maxHeight));
        if (Math.abs(newHeight - origHeight) < 0.0001) {
            return;
        }
        imageCompareHelper.updateImageRendering(newHeight);
        imageCompareHelper.setViewportCursor('grab');
        let localX = Math.max(0, Math.min(rect.width, clientX - rect.left));
        let localY = Math.max(0, Math.min(rect.height, clientY - rect.top));
        let zoomRatio = newHeight / origHeight;
        let imgLeft = imageCompareHelper.getImgLeft();
        let imgTop = imageCompareHelper.getImgTop();
        let newPanX = localX - layout.baseLeft - (localX - layout.baseLeft - imgLeft) * zoomRatio;
        let newPanY = localY - layout.baseTop - (localY - layout.baseTop - imgTop) * zoomRatio;
        imageCompareHelper.panX = newPanX;
        imageCompareHelper.panY = newPanY;
        imageCompareHelper.setHeightPercent(newHeight);
        imageCompareHelper.clampPan(newPanX, newPanY);
        imageCompareHelper.applyView();
    }
}

let mobileImageCompareTouch = new MobileImageCompareTouch();
