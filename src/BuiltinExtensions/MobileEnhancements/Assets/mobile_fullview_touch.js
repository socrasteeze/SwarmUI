/**
 * MobileEnhancements — touch layer for the fullscreen image viewer (fork extension).
 *
 * Augments the existing ImageFullViewHelper modal with native-gallery touch gestures. It only ADDS
 * touch listeners and drives the core viewer's own primitives (detachImg / moveImg / getHeightPercent /
 * showImage, and the global shiftToNextImagePreview used by the arrow keys) - the desktop mouse path in
 * currentimagehandler.js is never touched. All handling is gated to coarse (touch) pointers, so mouse
 * users are wholly unaffected. See docs/MobilePWA-Optimization-Plan.md (Phase 2).
 *
 * Gestures: pinch-zoom (anchored) + two-finger pan, one-finger pan when zoomed, double-tap zoom toggle,
 * horizontal swipe to move between images (at fit zoom), swipe-down to dismiss, single tap toggles the
 * metadata chrome. Every gesture fails safe: on any trouble the image is reset to a visible state.
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
        let content = imageFullView.content;
        content.addEventListener('touchstart', this.onTouchStart.bind(this), { passive: false });
        content.addEventListener('touchmove', this.onTouchMove.bind(this), { passive: false });
        content.addEventListener('touchend', this.onTouchEnd.bind(this), { passive: false });
        content.addEventListener('touchcancel', this.onTouchCancel.bind(this), { passive: false });
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

    /** True if the touch should be left to the browser: native media controls, or the scrollable metadata /
     *  action-button area under the image. */
    isOnControls(target) {
        return findParentOfClass(target, 'video-controls') || findParentOfClass(target, 'audio-controls')
            || findParentOfClass(target, 'audio-waveform-wrap') || findParentOfClass(target, 'imageview_popup_modal_undertext');
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
}

let mobileFullViewTouch = new MobileFullViewTouch();
