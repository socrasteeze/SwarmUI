/** MobileEnhancements standalone client - prompt-image editor.
 * A bottom-sheet, canvas-based crop/rotate tool for prompt images, opened by tapping a thumbnail in the
 * image strip (m_create.js's renderImageStrip - a plain tap, which was a no-op before this and so has no
 * gesture to fight; long-press+drag on the same tile is still reorder, untouched by any of this).
 *
 * Everything here is client-side and throwaway until Save is tapped: the working canvas and its undo
 * history live only on this object, rebuilt fresh each open() and discarded on close, so nothing writes
 * back to mState.promptImages unless the user explicitly saves.
 *
 * Rotate is fixed 90-degree steps only (no free-angle) and crop is a single axis-aligned rectangle with
 * four corner handles - both deliberate scope choices for a small touch sheet, not omissions: free rotation
 * needs its own gesture and a way to show/trim the resulting canvas edges, real added complexity for a
 * screen this size. */
class MImageEdit {

    /** A crop rectangle is never allowed to shrink below this fraction of the shorter working-canvas side -
     * see setCropFromPoints. */
    static MinCropFraction = 0.05;

    /** How many prior canvas states Undo keeps. Each entry is a full-resolution canvas clone, so this is a
     * real memory ceiling on a phone editing a large photo, not just a UX choice - the oldest entry is
     * dropped silently past this depth. */
    static MaxHistory = 6;

    constructor() {
        /** Index into mState.promptImages this session is editing, or null when nothing is open. */
        this.index = null;
        /** The authoritative working canvas, at full source resolution. Never attached to the DOM itself -
         * render() copies its pixels into displayCanvas, which is what's actually on screen. Rotate/crop/undo
         * replace this reference wholesale rather than mutating in place, which is what makes snapshotting it
         * for undo (pushHistory) safe and simple. */
        this.canvas = null;
        /** The one DOM-attached <canvas>, created once per open() and only ever resized/redrawn after that -
         * never replaced - so the crop overlay's geometry math (layoutCropOverlay) doesn't have to account
         * for the element identity changing mid-session. */
        this.displayCanvas = null;
        /** Stack of prior working-canvas snapshots, most recent last. */
        this.history = [];
        /** Pending crop rectangle, in the working canvas's own pixel space: {x, y, w, h}. Dragging a handle
         * only updates this and the overlay - it never touches canvas pixels until Apply Crop is tapped. */
        this.cropRect = null;
        /** True once the source image has actually loaded onto the canvas, so a tap on Rotate/Crop/Undo/Save
         * that lands before then (or after a load error) is a no-op instead of throwing. */
        this.ready = false;
    }

    /** Opens the editor sheet for mState.promptImages[index]. Shows a "Loading..." placeholder immediately
     * (same pattern as the LoRA/model pickers) and swaps in the canvas once the source image has loaded -
     * fetched same-origin when it's a server-referenced image (kind: 'path'), decoded directly when it's
     * already a data URI (kind: 'data'). Either way, editing never mutates the server's own file: Save always
     * writes a fresh data URI back into promptImages, so a path-based image is effectively forked into a
     * local copy the moment it's edited. */
    open(index) {
        let entry = mState.promptImages[index];
        if (!entry) {
            return;
        }
        this.index = index;
        this.canvas = null;
        this.displayCanvas = null;
        this.history = [];
        this.cropRect = null;
        this.cropRectEl = null;
        this.cropHandles = null;
        this.ready = false;

        let content = mUI.el('div', 'm-edit-sheet');
        content.appendChild(mUI.el('div', 'm-sheet-title', 'Edit image'));
        let wrap = mUI.el('div', 'm-edit-canvas-wrap');
        content.appendChild(wrap);
        let loading = mUI.el('div', 'm-strip-empty', 'Loading...');
        wrap.appendChild(loading);
        this.wrap = wrap;

        let controls = mUI.el('div', 'm-edit-controls');
        let rotateButton = mUI.el('button', 'm-edit-tool-button', '⟳ Rotate');
        let cropButton = mUI.el('button', 'm-edit-tool-button', '✓ Crop');
        let undoButton = mUI.el('button', 'm-edit-tool-button', '↺ Undo');
        for (let button of [rotateButton, cropButton, undoButton]) {
            button.disabled = true;
        }
        controls.appendChild(rotateButton);
        controls.appendChild(cropButton);
        controls.appendChild(undoButton);
        content.appendChild(controls);

        let actions = mUI.el('div', 'm-edit-actions');
        let cancelButton = mUI.el('button', 'm-edit-cancel-button', 'Cancel');
        let saveButton = mUI.el('button', 'm-edit-save-button', 'Save');
        saveButton.disabled = true;
        actions.appendChild(cancelButton);
        actions.appendChild(saveButton);
        content.appendChild(actions);

        // Deliberately small/plain rather than a full-width danger button - this is the deliberate, considered
        // way to remove an image now; the strip keeps its own quick × too (shrunk - see m.css), so this isn't
        // the only path, just the unhurried one.
        let removeButton = mUI.el('button', 'm-edit-remove-button', 'Remove image');
        content.appendChild(removeButton);

        let close = mUI.openSheet(content);
        cancelButton.addEventListener('click', () => close());
        removeButton.addEventListener('click', () => {
            mState.promptImages.splice(index, 1);
            mState.changed();
            close();
        });
        saveButton.addEventListener('click', () => {
            if (!this.ready) {
                return;
            }
            // JPEG, always - buildWorkingCanvas already flattened any source transparency onto opaque white,
            // so there's no alpha to lose, and a photo-sized PNG re-encode would bloat the payload this goes
            // out to the WS API as for no benefit here.
            mState.promptImages[index] = { 'kind': 'data', 'value': this.canvas.toDataURL('image/jpeg', 0.92) };
            mState.changed();
            close();
        });
        rotateButton.addEventListener('click', () => this.rotate90());
        cropButton.addEventListener('click', () => this.applyCrop());
        undoButton.addEventListener('click', () => this.undo());
        this.undoButton = undoButton;

        let img = new Image();
        img.onload = () => {
            // The sheet may already be gone (backdrop tap / swipe-down while this was loading) - appending
            // into a detached node is harmless but pointless, so skip the work rather than do it for nothing.
            if (!content.isConnected) {
                return;
            }
            loading.remove();
            this.buildWorkingCanvas(img);
            wrap.appendChild(this.displayCanvas);
            this.buildCropOverlay();
            this.render();
            this.ready = true;
            for (let button of [rotateButton, cropButton, saveButton]) {
                button.disabled = false;
            }
            this.syncUndoState();
        };
        img.onerror = () => {
            mUI.warn('Could not open that image for editing.');
            close();
        };
        img.src = entry.kind == 'data' ? entry.value : `${getImageOutPrefix()}/${entry.value}`;
    }

    /** Builds the initial working canvas from a loaded <img>, filled opaque white first so any source
     * transparency (a pasted screenshot, say) doesn't turn into an unexpected black fill once Save encodes
     * to JPEG. */
    buildWorkingCanvas(img) {
        let canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        let ctx = canvas.getContext('2d');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0);
        this.canvas = canvas;
        this.cropRect = this.fullCropRect();
        this.displayCanvas = document.createElement('canvas');
        this.displayCanvas.className = 'm-edit-canvas';
    }

    /** A crop rect covering the entire current working canvas - the reset point after load, rotate, undo,
     * and a just-committed crop (which becomes the new "full" once it lands). */
    fullCropRect() {
        return { 'x': 0, 'y': 0, 'w': this.canvas.width, 'h': this.canvas.height };
    }

    /** Clones the current canvas onto the undo stack before a destructive op (rotate/crop) replaces it.
     * Cloned rather than referenced, since the op about to run may reuse or resize this.canvas itself. */
    pushHistory() {
        let snapshot = document.createElement('canvas');
        snapshot.width = this.canvas.width;
        snapshot.height = this.canvas.height;
        snapshot.getContext('2d').drawImage(this.canvas, 0, 0);
        this.history.push(snapshot);
        if (this.history.length > MImageEdit.MaxHistory) {
            this.history.shift();
        }
    }

    /** Enables/disables Undo to match whether there's anything to undo, without hiding it - a control that
     * pops in and out of a row shifts everything beside it, which is exactly the kind of movement this
     * client's other recent work went out of its way to avoid. */
    syncUndoState() {
        if (this.undoButton) {
            this.undoButton.disabled = this.history.length == 0;
        }
    }

    /** Restores the most recent snapshot as the working canvas and resets the crop rectangle to its full
     * extent - undoing a crop-then-different-crop is one Undo per commit, not a partial rewind of either. */
    undo() {
        if (!this.ready || this.history.length == 0) {
            return;
        }
        this.canvas = this.history.pop();
        this.cropRect = this.fullCropRect();
        this.render();
        this.syncUndoState();
    }

    /** Rotates the working canvas 90 degrees clockwise (fixed-angle only - see class doc). The crop
     * rectangle resets to the new full extent rather than carrying a rotated rectangle forward: that would
     * need its own coordinate transform for very little benefit, since Apply Crop only ever commits whatever
     * rectangle is currently on screen. */
    rotate90() {
        if (!this.ready) {
            return;
        }
        this.pushHistory();
        let rotated = document.createElement('canvas');
        rotated.width = this.canvas.height;
        rotated.height = this.canvas.width;
        let ctx = rotated.getContext('2d');
        ctx.translate(rotated.width / 2, rotated.height / 2);
        ctx.rotate(Math.PI / 2);
        ctx.drawImage(this.canvas, -this.canvas.width / 2, -this.canvas.height / 2);
        this.canvas = rotated;
        this.cropRect = this.fullCropRect();
        this.render();
        this.syncUndoState();
    }

    /** Commits the pending crop rectangle: crops pixels out of the working canvas and resets the rectangle
     * to the new full extent. A no-op when the rectangle already covers the whole canvas (dragging the
     * handles back out to the edges, or never having touched them) - Apply Crop shouldn't burn an undo slot
     * cropping to everything. */
    applyCrop() {
        if (!this.ready) {
            return;
        }
        let r = this.cropRect;
        if (r.x == 0 && r.y == 0 && r.w == this.canvas.width && r.h == this.canvas.height) {
            return;
        }
        this.pushHistory();
        let cropped = document.createElement('canvas');
        cropped.width = Math.round(r.w);
        cropped.height = Math.round(r.h);
        cropped.getContext('2d').drawImage(this.canvas, r.x, r.y, r.w, r.h, 0, 0, cropped.width, cropped.height);
        this.canvas = cropped;
        this.cropRect = this.fullCropRect();
        this.render();
        this.syncUndoState();
    }

    /** Syncs the display canvas (on-screen size + pixels) and the crop overlay to the current working
     * canvas. Called after every op that can change canvas.width/height (build, rotate, crop, undo) - not
     * from crop-handle dragging itself, which only moves the overlay (layoutCropOverlay) and never touches
     * this.canvas. */
    render() {
        this.fitDisplaySize();
        if (this.displayCanvas.width != this.canvas.width || this.displayCanvas.height != this.canvas.height) {
            this.displayCanvas.width = this.canvas.width;
            this.displayCanvas.height = this.canvas.height;
        }
        this.displayCanvas.getContext('2d').drawImage(this.canvas, 0, 0);
        this.layoutCropOverlay();
    }

    /** Computes the display canvas's on-screen CSS px size to fit the wrap's width and a viewport-height
     * budget, preserving aspect ratio - done in JS rather than via CSS max-width/max-height percentages,
     * which need a definite-width ancestor to resolve against and nothing here is one without introducing
     * exactly that dependency (the wrap centers the canvas via flex; it isn't sized to its content). 40% of
     * the viewport height matches the budget .m-preview-grid already uses on the Create tab, for the same
     * reason: leave clear room below for this sheet's own controls without the canvas fighting them for
     * space. Capped at 1x so a small pasted image isn't blown up past its native size. */
    fitDisplaySize() {
        let maxWidth = this.wrap.getBoundingClientRect().width;
        let maxHeight = document.documentElement.clientHeight * 0.4;
        let scale = Math.min(maxWidth / this.canvas.width, maxHeight / this.canvas.height, 1);
        this.displayCanvas.style.width = `${Math.round(this.canvas.width * scale)}px`;
        this.displayCanvas.style.height = `${Math.round(this.canvas.height * scale)}px`;
    }

    /** Builds the crop rectangle overlay once (a border + four corner handles) as siblings of the display
     * canvas inside the wrap - positioned in CSS px relative to the wrap, not percentages, since the canvas
     * is centered within a wrap that's usually wider or taller than it (a portrait crop in a wrap sized for
     * a landscape image, say), where percentage-of-wrap and percentage-of-canvas would disagree. See
     * layoutCropOverlay for the actual math. */
    buildCropOverlay() {
        let rect = mUI.el('div', 'm-edit-crop-rect');
        this.wrap.appendChild(rect);
        let handles = {};
        for (let corner of ['nw', 'ne', 'sw', 'se']) {
            let handle = mUI.el('div', `m-edit-crop-handle m-edit-crop-handle-${corner}`);
            this.wrap.appendChild(handle);
            handles[corner] = handle;
        }
        this.cropRectEl = rect;
        this.cropHandles = handles;
        this.wireCropDrag(rect, handles);
    }

    /** Repositions the crop rectangle and its four handles from this.cropRect (canvas-pixel space), in CSS
     * px relative to the wrap (their positioned ancestor). canvasRect/wrapRect are both live
     * getBoundingClientRect() reads, so this stays correct regardless of how the canvas is centered inside
     * the wrap - no assumption about offsetParent or which element is "the" positioned ancestor. */
    layoutCropOverlay() {
        if (!this.cropRectEl) {
            return;
        }
        let canvasRect = this.displayCanvas.getBoundingClientRect();
        let wrapRect = this.wrap.getBoundingClientRect();
        let scaleX = canvasRect.width / this.canvas.width;
        let scaleY = canvasRect.height / this.canvas.height;
        let r = this.cropRect;
        let left = (canvasRect.left - wrapRect.left) + r.x * scaleX;
        let top = (canvasRect.top - wrapRect.top) + r.y * scaleY;
        let width = r.w * scaleX;
        let height = r.h * scaleY;
        this.cropRectEl.style.left = `${left}px`;
        this.cropRectEl.style.top = `${top}px`;
        this.cropRectEl.style.width = `${width}px`;
        this.cropRectEl.style.height = `${height}px`;
        let corners = {
            'nw': [left, top],
            'ne': [left + width, top],
            'sw': [left, top + height],
            'se': [left + width, top + height],
        };
        for (let corner in corners) {
            let [x, y] = corners[corner];
            this.cropHandles[corner].style.left = `${x}px`;
            this.cropHandles[corner].style.top = `${y}px`;
        }
    }

    /** Converts a touch point to this session's canvas-pixel space, from the display canvas's own live
     * rendered box - correct regardless of its on-screen size, which fitDisplaySize sets explicitly. */
    touchToCanvas(touch) {
        let rect = this.displayCanvas.getBoundingClientRect();
        let x = ((touch.clientX - rect.left) / rect.width) * this.canvas.width;
        let y = ((touch.clientY - rect.top) / rect.height) * this.canvas.height;
        return {
            'x': Math.min(Math.max(x, 0), this.canvas.width),
            'y': Math.min(Math.max(y, 0), this.canvas.height),
        };
    }

    /** Wires the four corner handles (resize from the opposite corner) and the rectangle's own interior
     * (drag to move, same size) - touch-only, matching this client's existing drag gestures (m_create.js's
     * wireReorder, the bottom-sheet grip), which are mobile-first and don't add a parallel mouse path. */
    wireCropDrag(rect, handles) {
        let opposite = { 'nw': 'se', 'ne': 'sw', 'sw': 'ne', 'se': 'nw' };
        // The canvas-pixel point diagonally opposite whichever handle is currently being dragged - fixed for
        // the duration of that drag, so every move just re-derives the rectangle from (anchor, live point).
        let anchor = null;
        // {touchX, touchY, rectX, rectY} while dragging the rectangle's interior (move, not resize).
        let moveStart = null;

        for (let corner in handles) {
            let handle = handles[corner];
            handle.addEventListener('touchstart', (e) => {
                // Stops this from also being read as the rect's own interior-drag start below.
                e.stopPropagation();
                let opp = opposite[corner];
                let r = this.cropRect;
                anchor = {
                    'x': opp[1] == 'w' ? r.x : r.x + r.w,
                    'y': opp[0] == 'n' ? r.y : r.y + r.h,
                };
            }, { passive: true });
            handle.addEventListener('touchmove', (e) => {
                if (!anchor) {
                    return;
                }
                e.preventDefault();
                let touch = e.touches.item(0);
                if (!touch) {
                    return;
                }
                this.setCropFromPoints(anchor, this.touchToCanvas(touch));
            }, { passive: false });
            let endHandle = () => { anchor = null; };
            handle.addEventListener('touchend', endHandle);
            handle.addEventListener('touchcancel', endHandle);
        }

        rect.addEventListener('touchstart', (e) => {
            let touch = e.touches.item(0);
            if (!touch) {
                return;
            }
            let point = this.touchToCanvas(touch);
            moveStart = { 'touchX': point.x, 'touchY': point.y, 'rectX': this.cropRect.x, 'rectY': this.cropRect.y };
        }, { passive: true });
        rect.addEventListener('touchmove', (e) => {
            if (!moveStart) {
                return;
            }
            e.preventDefault();
            let touch = e.touches.item(0);
            if (!touch) {
                return;
            }
            let point = this.touchToCanvas(touch);
            let r = this.cropRect;
            let x = Math.min(Math.max(moveStart.rectX + (point.x - moveStart.touchX), 0), this.canvas.width - r.w);
            let y = Math.min(Math.max(moveStart.rectY + (point.y - moveStart.touchY), 0), this.canvas.height - r.h);
            this.cropRect = { 'x': x, 'y': y, 'w': r.w, 'h': r.h };
            this.layoutCropOverlay();
        }, { passive: false });
        let endMove = () => { moveStart = null; };
        rect.addEventListener('touchend', endMove);
        rect.addEventListener('touchcancel', endMove);
    }

    /** Recomputes the pending crop rectangle from two opposite corner points (a fixed anchor and the point
     * currently under the finger), normalizing whichever order they come in - dragging a handle past the
     * anchor just flips which corner is visually which, which is the expected behaviour for this kind of
     * crop tool. Below the minimum size the update is skipped outright rather than clamped, so the rectangle
     * sticks at its last valid size instead of jittering at the floor. */
    setCropFromPoints(anchor, point) {
        let x = Math.min(anchor.x, point.x);
        let y = Math.min(anchor.y, point.y);
        let w = Math.abs(point.x - anchor.x);
        let h = Math.abs(point.y - anchor.y);
        let minSize = Math.min(this.canvas.width, this.canvas.height) * MImageEdit.MinCropFraction;
        if (w < minSize || h < minSize) {
            return;
        }
        this.cropRect = { 'x': x, 'y': y, 'w': w, 'h': h };
        this.layoutCropOverlay();
    }
}

mImageEdit = new MImageEdit();
