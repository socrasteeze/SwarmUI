/** MobileEnhancements standalone client - prompt-image editor.
 * A bottom-sheet, canvas-based crop/rotate tool for prompt images, opened by tapping a thumbnail in the
 * image strip (m_create.js's renderImageStrip - a plain tap, which was a no-op before this and so has no
 * gesture to fight; long-press+drag on the same tile is still reorder, untouched by any of this).
 *
 * Everything here is client-side and throwaway until Save is tapped: the working canvas and its undo
 * history live only on this object, rebuilt fresh each open() and discarded on close, so nothing writes
 * back to mState.promptImages unless the user explicitly saves.
 *
 * Rotation comes in two forms: the Rotate button's lossless 90-degree quarter turns, and the angle row's
 * free rotation in fixed steps, which grows the canvas to the rotated bounding box and fills the exposed
 * corners white. Flip is horizontal only (a vertical flip is a horizontal one plus two Rotates) and crop is
 * a single axis-aligned rectangle with four corner handles - both deliberate scope choices for a small touch
 * sheet rather than omissions.
 *
 * The crop rectangle has no button of its own. Drag it and tap Save; any transform that would invalidate it
 * commits it first. See applyCrop. */
class MImageEdit {

    /** A crop rectangle is never allowed to shrink below this fraction of the shorter working-canvas side -
     * see setCropFromPoints. */
    static MinCropFraction = 0.05;

    /** How many prior canvas states Undo keeps. Each entry is a full-resolution canvas clone, so this is a
     * real memory ceiling on a phone editing a large photo, not just a UX choice - the oldest entry is
     * dropped silently past this depth. */
    static MaxHistory = 6;

    /** One tap of a pad button adds this fraction of the dimension it extends (10% of the current width for
     * left/right, of the current height for top/bottom). Taken from the live dimension rather than the
     * original, so repeated taps compound slightly - which is the right feel here: the first taps step in
     * meaningful amounts and later ones stay proportional to what's already on screen. */
    static PadFraction = 0.1;

    /** Hard ceiling on either working-canvas dimension. Padding is the only op that grows the canvas, and it
     * is unbounded by nature (nothing stops a finger tapping ← forty times), so it needs a stop: a canvas past
     * this size is slow to re-encode on a phone and would go out to the API as a needlessly huge data URI. */
    static MaxCanvasDimension = 8192;

    /** Degrees per tap of the free-rotate nudge buttons. A coarse step, reachable in a tap or two - this is
     * for tilting an image off-axis, not for straightening a horizon by a degree or two (which this step
     * cannot express at all). The 90-degree Rotate button is unaffected and still handles quarter turns. */
    static FreeRotateStepDegrees = 25;

    /** Free rotation is clamped to this many degrees either way. Kept an exact multiple of the step, so the
     * last tap in each direction lands on the limit instead of stopping at a half-step short of it. Past this
     * the shorter path to any orientation is a 90-degree Rotate plus a smaller free angle. */
    static MaxFreeRotateDegrees = 75;

    constructor() {
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
         * only updates this and the overlay - it never touches canvas pixels until something calls applyCrop
         * (Save, or any transform that would invalidate the rectangle). */
        this.cropRect = null;
        /** Pristine canvas the current free-rotate session rotates *from*, or null when no session is open.
         * This is what keeps incremental nudging from compounding: every nudge redraws this snapshot once at
         * the new accumulated angle, so twenty taps to 20 degrees is a single resample of the original, not
         * twenty stacked ones each blurring the last. Any op that rewrites the canvas ends the session
         * (endRotateSession), so the next nudge re-snapshots from that new result. */
        this.rotateSource = null;
        /** Accumulated free-rotate angle in degrees for the open session, signed clockwise-positive. Only
         * meaningful while rotateSource is non-null. */
        this.rotateAngle = 0;
        /** True once the source image has actually loaded onto the canvas, so a tap on any of the tool, pad,
         * or Save buttons that lands before then (or after a load error) is a no-op instead of throwing. */
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
        this.canvas = null;
        this.displayCanvas = null;
        this.history = [];
        this.cropRect = null;
        this.cropRectEl = null;
        this.cropHandles = null;
        this.rotateSource = null;
        this.rotateAngle = 0;
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
        let flipButton = mUI.el('button', 'm-edit-tool-button', '⇄ Flip');
        let undoButton = mUI.el('button', 'm-edit-tool-button', '↺ Undo');
        for (let button of [rotateButton, flipButton, undoButton]) {
            button.disabled = true;
        }
        controls.appendChild(rotateButton);
        controls.appendChild(flipButton);
        controls.appendChild(undoButton);
        content.appendChild(controls);

        // Free rotation, incremental. The readout is the reset: it shows the accumulated angle and taps back
        // to 0, which beats a fourth button in the row and gives the number something to do.
        let angleRow = mUI.el('div', 'm-edit-angle-row');
        angleRow.appendChild(mUI.el('span', 'm-edit-angle-label', 'Angle'));
        let step = MImageEdit.FreeRotateStepDegrees;
        let angleDownButton = mUI.el('button', 'm-edit-angle-button', '↺');
        angleDownButton.setAttribute('aria-label', `Rotate counter-clockwise by ${step} degrees`);
        let angleReadout = mUI.el('button', 'm-edit-angle-readout', '0°');
        angleReadout.setAttribute('aria-label', 'Reset angle to zero');
        let angleUpButton = mUI.el('button', 'm-edit-angle-button', '↻');
        angleUpButton.setAttribute('aria-label', `Rotate clockwise by ${step} degrees`);
        angleDownButton.addEventListener('click', () => this.nudgeRotate(-MImageEdit.FreeRotateStepDegrees));
        angleUpButton.addEventListener('click', () => this.nudgeRotate(MImageEdit.FreeRotateStepDegrees));
        angleReadout.addEventListener('click', () => this.resetRotate());
        let angleButtons = [angleDownButton, angleReadout, angleUpButton];
        for (let button of angleButtons) {
            button.disabled = true;
            angleRow.appendChild(button);
        }
        content.appendChild(angleRow);
        this.angleReadout = angleReadout;

        // Padding gets its own row rather than four more buttons in the tool row above: at four sides plus the
        // three existing tools, one row of seven would put every target under the ~44px this client holds as
        // its touch-target floor everywhere else.
        let padRow = mUI.el('div', 'm-edit-pad-row');
        padRow.appendChild(mUI.el('span', 'm-edit-pad-label', 'Add white'));
        let padButtons = [];
        for (let [side, glyph] of [['left', '←'], ['top', '↑'], ['bottom', '↓'], ['right', '→']]) {
            let button = mUI.el('button', 'm-edit-pad-button', glyph);
            // The glyph alone is meaningless to a screen reader, and the direction it names is the edge the
            // white goes on - not a direction of travel.
            button.title = `Add white to the ${side}`;
            button.setAttribute('aria-label', `Add white to the ${side}`);
            button.disabled = true;
            button.addEventListener('click', () => this.padSide(side));
            padRow.appendChild(button);
            padButtons.push(button);
        }
        content.appendChild(padRow);

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
            // Save commits whatever rectangle is on screen: dragging the handles and tapping Save is the whole
            // crop flow, and there is no separate Crop button to forget. Free when nothing was dragged, since
            // applyCrop no-ops on a full-extent rectangle rather than copying pixels to the same size.
            this.applyCrop();
            // JPEG, always - buildWorkingCanvas already flattened any source transparency onto opaque white,
            // so there's no alpha to lose, and a photo-sized PNG re-encode would bloat the payload this goes
            // out to the WS API as for no benefit here.
            mState.promptImages[index] = { 'kind': 'data', 'value': this.canvas.toDataURL('image/jpeg', 0.92) };
            mState.changed();
            close();
        });
        rotateButton.addEventListener('click', () => this.rotate90());
        flipButton.addEventListener('click', () => this.flipHorizontal());
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
            for (let button of [rotateButton, flipButton, saveButton, ...angleButtons, ...padButtons]) {
                button.disabled = false;
            }
            this.syncUndoState();
            this.syncRotateState();
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
        this.endRotateSession();
        this.render();
        this.syncUndoState();
    }

    /** Rotates the working canvas 90 degrees clockwise (fixed-angle only - see class doc). */
    rotate90() {
        if (!this.ready) {
            return;
        }
        this.applyCrop();
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
        this.endRotateSession();
        this.render();
        this.syncUndoState();
    }

    /** Commits the pending crop rectangle: crops pixels out of the working canvas and resets the rectangle
     * to the new full extent. A no-op when the rectangle already covers the whole canvas (dragging the
     * handles back out to the edges, or never having touched them), which is what lets every caller below
     * invoke it unconditionally without burning an undo slot cropping to everything.
     *
     * There is no Crop button. Save calls this, and so does every op that rewrites the canvas underneath the
     * rectangle (rotate90, flipHorizontal, padSide) - all of them work in canvas-pixel space, so a pending
     * rectangle that survived one of them would be pointing at the wrong pixels. Committing first means a
     * dragged rectangle is never silently thrown away; the cost is that crop-then-rotate is two Undo steps
     * rather than one, which is the honest accounting anyway. */
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
        this.endRotateSession();
        this.render();
        this.syncUndoState();
    }

    /** Adds one step to the free-rotate angle, opening a session (snapshot + one undo entry) on the first
     * nudge of a run. All later nudges in that run redraw the same snapshot at the new total, so the run
     * costs exactly one undo slot and one resample no matter how many taps it takes - see rotateSource. */
    nudgeRotate(delta) {
        if (!this.ready) {
            return;
        }
        if (!this.rotateSource) {
            // Committing the pending crop first for the same reason the other transforms do: the rectangle is
            // in canvas-pixel space and free rotation rewrites that space.
            this.applyCrop();
            this.pushHistory();
            this.rotateSource = document.createElement('canvas');
            this.rotateSource.width = this.canvas.width;
            this.rotateSource.height = this.canvas.height;
            this.rotateSource.getContext('2d').drawImage(this.canvas, 0, 0);
            this.rotateAngle = 0;
        }
        let max = MImageEdit.MaxFreeRotateDegrees;
        let next = Math.min(Math.max(this.rotateAngle + delta, -max), max);
        if (next == this.rotateAngle) {
            return;
        }
        this.rotateAngle = next;
        this.drawFreeRotation();
    }

    /** Returns the open session to 0 degrees, restoring the snapshot exactly - a tap on the readout after
     * overshooting, rather than an equal number of taps back the other way. A no-op with no session open, so
     * the readout is inert rather than misleading when it already says 0. */
    resetRotate() {
        if (!this.ready || !this.rotateSource || this.rotateAngle == 0) {
            return;
        }
        this.rotateAngle = 0;
        this.drawFreeRotation();
    }

    /** Redraws the working canvas as rotateSource rotated by the accumulated angle, onto a canvas grown to the
     * rotated bounding box so no content is pushed off-frame, with the exposed corners filled opaque white.
     *
     * White rather than auto-cropping inward to the largest inscribed rectangle: this editor already puts
     * deliberate white on an image (the pad row), so a white wedge is an artifact of the same kind the user
     * has already opted into, and it keeps every pixel of the source instead of silently eating content to
     * hide the corners. */
    drawFreeRotation() {
        let source = this.rotateSource;
        let radians = this.rotateAngle * Math.PI / 180;
        let cos = Math.abs(Math.cos(radians));
        let sin = Math.abs(Math.sin(radians));
        let width = Math.round(source.width * cos + source.height * sin);
        let height = Math.round(source.width * sin + source.height * cos);
        if (Math.max(width, height) > MImageEdit.MaxCanvasDimension) {
            mUI.warn(`Can't rotate past ${MImageEdit.MaxCanvasDimension}px on a side.`);
            // Back out the step that would have overflowed, so the readout keeps matching what's on screen.
            this.rotateAngle -= Math.sign(this.rotateAngle) * MImageEdit.FreeRotateStepDegrees;
            return;
        }
        let rotated = document.createElement('canvas');
        rotated.width = width;
        rotated.height = height;
        let ctx = rotated.getContext('2d');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, width, height);
        ctx.translate(width / 2, height / 2);
        ctx.rotate(radians);
        ctx.drawImage(source, -source.width / 2, -source.height / 2);
        this.canvas = rotated;
        this.cropRect = this.fullCropRect();
        this.render();
        this.syncUndoState();
        this.syncRotateState();
    }

    /** Ends any open free-rotate session, so the next nudge snapshots afresh from whatever the canvas has
     * become. Called by every op that replaces the canvas out from under the session. */
    endRotateSession() {
        this.rotateSource = null;
        this.rotateAngle = 0;
        this.syncRotateState();
    }

    /** Points the readout at the current angle. */
    syncRotateState() {
        if (this.angleReadout) {
            this.angleReadout.textContent = `${this.rotateAngle}°`;
        }
    }

    /** Mirrors the working canvas left-to-right. Horizontal only, and that is not a missing half: a vertical
     * flip is this plus two Rotates, and on a three-button row a second flip control would cost more than the
     * one extra tap it saves. Canvas dimensions are unchanged, so unlike rotate/pad this could in principle
     * carry the pending crop rectangle across (mirrored) - it commits it like the others instead, so that all
     * three transforms behave the same way rather than one of them being subtly special. */
    flipHorizontal() {
        if (!this.ready) {
            return;
        }
        this.applyCrop();
        this.pushHistory();
        let flipped = document.createElement('canvas');
        flipped.width = this.canvas.width;
        flipped.height = this.canvas.height;
        let ctx = flipped.getContext('2d');
        ctx.translate(flipped.width, 0);
        ctx.scale(-1, 1);
        ctx.drawImage(this.canvas, 0, 0);
        this.canvas = flipped;
        this.cropRect = this.fullCropRect();
        this.endRotateSession();
        this.render();
        this.syncUndoState();
    }

    /** Grows the working canvas by one PadFraction step on one side, filling the new strip opaque white and
     * redrawing the existing pixels offset into it. White specifically, not transparent: Save encodes JPEG
     * (see the save handler), which has no alpha, so a transparent pad would arrive as black. */
    padSide(side) {
        if (!this.ready) {
            return;
        }
        this.applyCrop();
        let horizontal = side == 'left' || side == 'right';
        let step = Math.round((horizontal ? this.canvas.width : this.canvas.height) * MImageEdit.PadFraction);
        // A sub-pixel step on a tiny canvas would silently do nothing and still burn an undo slot.
        if (step < 1) {
            return;
        }
        let width = this.canvas.width + (horizontal ? step : 0);
        let height = this.canvas.height + (horizontal ? 0 : step);
        if (Math.max(width, height) > MImageEdit.MaxCanvasDimension) {
            mUI.warn(`Can't pad past ${MImageEdit.MaxCanvasDimension}px on a side.`);
            return;
        }
        this.pushHistory();
        let padded = document.createElement('canvas');
        padded.width = width;
        padded.height = height;
        let ctx = padded.getContext('2d');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, width, height);
        // Only left and top displace the existing pixels; right and bottom leave them at the origin and let
        // the already-white remainder of the larger canvas be the pad.
        ctx.drawImage(this.canvas, side == 'left' ? step : 0, side == 'top' ? step : 0);
        this.canvas = padded;
        this.cropRect = this.fullCropRect();
        this.endRotateSession();
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
