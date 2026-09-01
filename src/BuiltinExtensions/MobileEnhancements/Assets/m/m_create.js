/** MobileEnhancements standalone client - Create tab: live preview, preset strip, model picker, prompt +
 * prompt-image strip, quick params, LoRA sheet, advanced chips, generate bar, grid form. All state lives in
 * mState; this file is DOM. The live batch preview lives here rather than on the Images tab so that
 * generating never navigates away from the prompt box - mImages owns history plus the shared viewer. */
class MCreate {

    constructor() {
        /** Cached LoRA model list from ListModels (fetched lazily on first sheet open). */
        this.loraList = null;
        /** LoRA name -> model object, indexed by both the ListModels name and the extension-stripped form
         * (presets and starred_models omit .safetensors). Built with loraList so active-row enrichment is O(1). */
        this.loraMap = null;
        /** Cached checkpoint list from ListModels (fetched lazily on first model sheet open). */
        this.modelList = null;
        /** True when the last ListModels for that list failed, so the sheet offers Retry instead of sitting
         * on "Loading..." forever. Cleared on each attempt. */
        this.modelListError = false;
        this.loraListError = false;
        /** Live preview tiles by `${request_id}_${batch_index}`. Only ever one batch's worth. */
        this.liveTiles = {};
        /** Request id currently on display; a different one wipes the preview. */
        this.currentRequest = null;
        /** [{url, metadata}] of the last batch that actually finished, for the cancelled-batch fallback. */
        this.lastCompleted = [];
        /** Covered param ids that have dedicated controls (everything else renders as an Advanced chip).
         * width/height are covered because the resolution controls own them - see mState.buildGenInput. */
        this.coveredParams = ['prompt', 'negativeprompt', 'images', 'seed', 'steps', 'cfgscale', 'aspectratio', 'sidelength', 'width', 'height', 'model', 'loras', 'loraweights', 'promptimages', 'filenameprefix'];
        /** Quick numeric steppers keyed by parameter id. */
        this.numberSteppers = {};
        /** Whether the user has manually collapsed the preview. */
        this.previewCollapsed = localStorage.getItem('m_client_preview_collapsed') == 'yes';
        // The preview is built here, detached, rather than in build(). Generation frames can arrive before
        // the Create panel has ever been built (deep-link to #models, then generate), and a tile handler
        // that assumed its container existed is exactly the crash this ordering avoids.
        this.buildPreview();
        this.buildResolvedPrompt();
        mGen.onFrame((kind, data) => this.onFrame(kind, data));
    }

    /** Builds the (initially detached) live preview block. */
    buildPreview() {
        this.previewWrap = mUI.el('div', 'm-create-preview m-preview-empty');
        let head = mUI.el('div', 'm-preview-head');
        this.previewToggle = mUI.el('button', 'm-preview-toggle');
        this.previewToggle.addEventListener('click', () => {
            this.previewCollapsed = !this.previewCollapsed;
            localStorage.setItem('m_client_preview_collapsed', this.previewCollapsed ? 'yes' : 'no');
            this.renderPreviewState();
        });
        head.appendChild(this.previewToggle);
        this.previewWrap.appendChild(head);
        this.previewGrid = mUI.el('div', 'm-preview-grid');
        this.previewWrap.appendChild(this.previewGrid);
        // The empty canvas: what stands in for the images before any exist. It is exactly as tall as the grid
        // that replaces it (--m-preview-h, in m.css), which is the point - the space is reserved from first
        // paint, so tapping Generate and then receiving tiles doesn't push the model row, the Generate button
        // and the prompt box down the screen mid-generation.
        // It also carries the queued state: from the instant Generate is tapped until the first frame lands,
        // its label and progress bar are the only sign anything is happening. Queueing behind a loading model
        // can take a while, and without that the screen sits unchanged, indistinguishable from a dead button.
        this.previewCanvas = mUI.el('div', 'm-preview-canvas');
        this.previewCanvasLabel = mUI.el('div', 'm-preview-canvas-label');
        this.previewCanvas.appendChild(this.previewCanvasLabel);
        this.previewCanvas.appendChild(mUI.el('div', 'm-preview-canvas-bar'));
        this.previewWrap.appendChild(this.previewCanvas);
        this.pending = false;
        this.renderPreviewState();
    }

    /** Builds the (initially detached, empty) resolved-prompt readout shown below the preview. Not part of
     * previewWrap on purpose: previewWrap is a sticky header (position: sticky; top: 0), so anything added
     * inside it eats permanent screen space at the top of the panel at every scroll position. This sits
     * after it in normal flow instead, so it appears once, below the images, and scrolls away like anything
     * else - matching "below the preview", not "pinned under the preview". */
    buildResolvedPrompt() {
        this.resolvedWrap = mUI.el('div', 'm-resolved-prompt m-resolved-empty');
        this.resolvedWrap.appendChild(mUI.el('div', 'm-resolved-label', 'Resolved prompt'));
        this.resolvedText = mUI.el('div', 'm-resolved-text');
        this.resolvedWrap.appendChild(this.resolvedText);
        this.resolvedWildcards = mUI.el('div', 'm-resolved-wildcards');
        this.resolvedWrap.appendChild(this.resolvedWildcards);
    }

    /** Shows the server's fully-resolved prompt (post-wildcard, post-<trigger>, etc.) for one completed
     * image - not the raw text still sitting in the prompt box - so wildcard/tag expansion is visible right
     * under the preview without a trip into the full viewer. Updates per completed image in a batch, so on
     * a multi-image batch it ends up showing the last one to finish; wildcards can differ per image (each
     * gets its own wildcard seed), and this box is deliberately singular rather than per-tile to keep it
     * readable on a phone. Silently no-ops on unreadable metadata rather than showing something misleading -
     * see applyMetadata in m_state.js for the same JSON-shape assumptions. */
    updateResolvedPrompt(metadataStr) {
        if (!metadataStr) {
            return;
        }
        try {
            let full = JSON.parse(metadataStr);
            let meta = full.sui_image_params || {};
            let extra = full.sui_extra_data || {};
            let resolved = `${meta.prompt || ''}`;
            this.resolvedText.textContent = resolved;
            this.resolvedWrap.classList.toggle('m-resolved-empty', !resolved);
            let used = extra.used_wildcards || [];
            this.resolvedWildcards.textContent = used.length ? `Wildcards used: ${used.join(', ')}` : '';
        }
        catch (e) {
            console.error('could not parse image metadata for resolved-prompt readout', e);
        }
    }

    /** Marks a batch as requested; cleared by the first frame or by a failure. */
    setPending(pending) {
        this.pending = pending;
        this.renderPreviewState();
    }

    /** Syncs the preview's collapsed/idle/pending classes, the canvas label, and the toggle glyph.
     *
     * The block occupies the same height in every one of these states - idle, queued, generating, done - so
     * none of the transitions between them moves anything below it. `m-preview-idle` (no tiles, nothing
     * queued) is the one state that is not pinned: an empty placeholder following you down the panel while
     * you edit params is not worth the top 40% of the screen, and dropping the sticky costs no layout because
     * a sticky element occupies its flow space either way. */
    renderPreviewState() {
        let count = Object.keys(this.liveTiles).length;
        this.previewWrap.classList.toggle('m-preview-idle', count == 0 && !this.pending);
        this.previewWrap.classList.toggle('m-preview-empty', count == 0);
        this.previewCanvas.classList.toggle('m-preview-canvas-pending', this.pending);
        this.previewCanvasLabel.textContent = this.pending ? 'Queued...' : 'No preview yet';
        this.previewWrap.classList.toggle('m-preview-collapsed', this.previewCollapsed);
        this.previewToggle.textContent = this.previewCollapsed ? '▾ Preview' : '▴ Preview';
        let columns = count > 1 ? 2 : 1;
        // Cells are sized to fill the reserved canvas rather than to a fixed dvh, so a 1-up, a 2-up and a 2x2
        // all come out the same total height instead of each batch size being its own layout.
        let rows = Math.min(2, Math.max(1, Math.ceil(count / columns)));
        this.previewGrid.style.gridTemplateColumns = `repeat(${columns}, 1fr)`;
        this.previewGrid.style.setProperty('--m-preview-cell-h', rows > 1 ? 'calc((var(--m-preview-h) - 0.3rem) / 2)' : 'var(--m-preview-h)');
    }

    /** WS frame handling for the live preview tiles. */
    onFrame(kind, data) {
        if (kind == 'progress') {
            let tile = this.getLiveTile(`${data.request_id}_${data.batch_index}`);
            if (data.preview) {
                tile.querySelector('img').src = data.preview;
            }
            let pct = Math.round((data.overall_percent || 0) * 100);
            tile.querySelector('.m-tile-progress').style.width = `${pct}%`;
        }
        else if (kind == 'image') {
            let tile = this.getLiveTile(`${data.request_id}_${data.batch_index}`);
            let url = data.image.startsWith('data:') ? data.image : `${data.image}`;
            tile.querySelector('img').src = url;
            tile.dataset.metadata = data.metadata || '';
            tile.dataset.url = url;
            // Keep the output-relative path on the tile so Prompt Img never has to reverse a data URI or a
            // View URL. urlToPath returns null for unsaved (data-URI) images, and that is the correct answer
            // - attaching those as kind:'path' is what sent a multi-megabyte string as a "path".
            let path = mImages.urlToPath(url);
            if (path) {
                tile.dataset.fullsrc = path;
            }
            tile.classList.add('m-tile-done');
            tile.querySelector('.m-tile-progress').style.width = '';
            this.updateResolvedPrompt(data.metadata);
            this.snapshotCompleted();
        }
        else if (kind == 'discard') {
            for (let key in this.liveTiles) {
                if (data.includes(parseInt(key.split('_').pop()))) {
                    this.liveTiles[key].remove();
                    delete this.liveTiles[key];
                }
            }
            this.renderPreviewState();
        }
        else if (kind == 'status' && this.interruptButton) {
            this.interruptButton.style.display = mGen.queueTotal > 0 ? '' : 'none';
        }
        else if (kind == 'error') {
            // A failed batch is the same situation as a cancelled one: nothing more is coming for it.
            this.clearUnfinished();
        }
        if (kind == 'progress' || kind == 'image') {
            this.pending = false;
        }
    }

    /** Empties the preview grid. */
    clearTiles() {
        this.previewGrid.innerHTML = '';
        this.liveTiles = {};
    }

    /** Records the current batch's finished images, so a batch that gets cancelled before producing
     * anything can fall back to the last one that did rather than leaving the preview blank. */
    snapshotCompleted() {
        let snapshot = [];
        for (let key in this.liveTiles) {
            let tile = this.liveTiles[key];
            if (tile.classList.contains('m-tile-done') && tile.dataset.url) {
                snapshot.push({ 'url': tile.dataset.url, 'metadata': tile.dataset.metadata || '', 'fullsrc': tile.dataset.fullsrc || '' });
            }
        }
        if (snapshot.length > 0) {
            this.lastCompleted = snapshot;
        }
    }

    /** Interrupt: in-flight tiles are never going to arrive, so drop them. If that empties the preview -
     * a batch cancelled before it produced anything - put the last completed batch back rather than
     * leaving a blank panel where an image used to be. */
    clearUnfinished() {
        for (let key in this.liveTiles) {
            if (!this.liveTiles[key].classList.contains('m-tile-done')) {
                this.liveTiles[key].remove();
                delete this.liveTiles[key];
            }
        }
        this.pending = false;
        if (Object.keys(this.liveTiles).length == 0) {
            this.restoreLastCompleted();
        }
        this.renderPreviewState();
    }

    /** Rebuilds the preview from the last completed batch, under a request id no live batch can match, so
     * the next real generation replaces it the same way it would replace any other batch. */
    restoreLastCompleted() {
        this.clearTiles();
        this.currentRequest = 'restored';
        for (let i = 0; i < this.lastCompleted.length; i++) {
            let entry = this.lastCompleted[i];
            let tile = this.buildTile();
            tile.querySelector('img').src = entry.url;
            tile.dataset.url = entry.url;
            tile.dataset.metadata = entry.metadata;
            if (entry.fullsrc) {
                tile.dataset.fullsrc = entry.fullsrc;
            }
            tile.classList.add('m-tile-done');
            this.liveTiles[`restored_${i}`] = tile;
            this.previewGrid.appendChild(tile);
        }
        // Keep the resolved-prompt readout in sync with whatever's back on screen, so an interrupted batch
        // doesn't leave it showing text for an image that's no longer visible.
        if (this.lastCompleted.length > 0) {
            this.updateResolvedPrompt(this.lastCompleted[this.lastCompleted.length - 1].metadata);
        }
    }

    /** One preview cell: image, progress bar, tap-to-open in the shared viewer. */
    buildTile() {
        let tile = mUI.el('div', 'm-preview-cell');
        tile.appendChild(document.createElement('img'));
        tile.appendChild(mUI.el('div', 'm-tile-progress'));
        tile.addEventListener('click', () => {
            if (tile.dataset.url) {
                mImages.openViewer({ 'url': tile.dataset.url, 'metadata': tile.dataset.metadata, 'fullsrc': tile.dataset.fullsrc || mImages.urlToPath(tile.dataset.url) });
            }
        });
        return tile;
    }

    /** Gets or creates a live preview tile. The preview only ever shows ONE batch: the first frame of a new
     * request id wipes whatever was there. This is not conditioned on the old tiles being finished, which is
     * what used to leave a cancelled generation sitting on screen next to the batch that replaced it. */
    getLiveTile(key) {
        if (this.liveTiles[key]) {
            return this.liveTiles[key];
        }
        let requestId = key.substring(0, key.lastIndexOf('_'));
        if (requestId != this.currentRequest) {
            this.currentRequest = requestId;
            this.clearTiles();
        }
        let tile = this.buildTile();
        this.liveTiles[key] = tile;
        this.previewGrid.appendChild(tile);
        this.renderPreviewState();
        return tile;
    }

    /** Builds the Create panel once. */
    build(panel) {
        // Flex column so children keep their natural height rather than being shrunk to fit (see m.css).
        panel.classList.add('m-create-panel');
        panel.appendChild(this.previewWrap);
        panel.appendChild(this.resolvedWrap);
        this.presetRow = mUI.el('div', 'm-preset-row');
        this.archSelect = mUI.el('select', 'm-arch-select');
        this.archSelect.addEventListener('change', () => {
            mState.archFilter = this.archSelect.value;
            mState.changed();
        });
        this.presetRow.appendChild(this.archSelect);
        this.presetSelect = mUI.el('select', 'm-preset-select');
        this.presetSelect.addEventListener('change', () => {
            let title = this.presetSelect.value;
            if (!title) {
                return;
            }
            let idx = mState.activePresets.indexOf(title);
            if (idx == -1) {
                mState.activePresets.push(title);
            }
            else {
                mState.activePresets.splice(idx, 1);
            }
            mState.changed();
        });
        this.presetRow.appendChild(this.presetSelect);
        panel.appendChild(this.presetRow);
        // Model and LoRAs share one row: two taps that open two sheets, no reason to spend two rows on them.
        this.pickerRow = mUI.el('div', 'm-picker-row');
        this.modelButton = mUI.el('button', 'm-picker-button m-model-button');
        this.modelButton.addEventListener('click', () => this.openModelSheet());
        this.pickerRow.appendChild(this.modelButton);
        this.loraButton = mUI.el('button', 'm-picker-button');
        this.loraButton.addEventListener('click', () => this.openLoraSheet());
        this.pickerRow.appendChild(this.loraButton);
        if (typeof mTagDex != 'undefined' && typeof mTagDex.installBrowse == 'function') {
            mTagDex.installBrowse(this.pickerRow);
        }
        this.resetButton = mUI.el('button', 'm-picker-button m-reset-button', '↺');
        this.resetButton.title = 'Reset params';
        this.resetButton.addEventListener('click', () => {
            mUI.confirm('Reset prompt, images, model, LoRAs, and all other params to blank?', () => {
                // Clears any suggestions left over from the prompt text this is about to erase - onInput()
                // only recomputes on the box's own 'input' event, and this reset never fires one.
                mAutoComplete.hide();
                mState.resetParams();
                mUI.note('Params reset.');
            });
        });
        this.pickerRow.appendChild(this.resetButton);
        panel.appendChild(this.pickerRow);
        // Generate/Interrupt sit directly ABOVE the prompt box rather than at the foot of the panel. At the
        // foot they were sticky to the bottom of the layout viewport, which is exactly where the on-screen
        // keyboard is - so the one moment you most want to tap Generate (having just finished typing) was
        // the one moment it was buried. Above the prompt it rides along with whatever iOS scrolls into view.
        let genBar = mUI.el('div', 'm-gen-bar');
        this.interruptButton = mUI.el('button', 'm-interrupt-button', 'Interrupt');
        this.interruptButton.style.display = 'none';
        this.interruptButton.addEventListener('click', () => {
            mGen.interrupt();
            // Anything still in flight is never going to arrive, so drop it now rather than leaving it to
            // be swept when the next batch happens to start.
            this.clearUnfinished();
        });
        genBar.appendChild(this.interruptButton);
        this.genButton = mUI.el('button', 'm-generate-button', 'Generate');
        this.wireGenerateButton();
        genBar.appendChild(this.genButton);
        panel.appendChild(genBar);
        let promptWrap = mUI.el('div', 'm-prompt-wrap');
        this.promptBox = mUI.el('textarea', 'm-prompt-box');
        this.promptBox.placeholder = 'Type your prompt, or paste an image...';
        this.promptBox.rows = 3;
        this.promptBox.addEventListener('input', () => {
            mState.params['prompt'] = this.promptBox.value;
            mState.save();
            this.autoGrow(this.promptBox);
        });
        this.promptBox.addEventListener('paste', (e) => this.onPaste(e));
        // Remember where the caret was. By the time a trigger chip is tapped the box has long since lost
        // focus to a bottom sheet, so "insert at the cursor" has to mean the last cursor position.
        for (let event of ['keyup', 'click', 'select', 'input', 'blur']) {
            this.promptBox.addEventListener(event, () => {
                this.promptCaret = getTextSelRange(this.promptBox)[0];
            });
        }
        promptWrap.appendChild(this.promptBox);
        this.imageStrip = mUI.el('div', 'm-image-strip');
        promptWrap.appendChild(this.imageStrip);
        this.ratioRow = mUI.el('div', 'm-ratio-row');
        let exactButton = mUI.el('button', 'm-ratio-button', 'Use image ratio');
        exactButton.addEventListener('click', () => this.applyImageRatio(true));
        this.ratioRow.appendChild(exactButton);
        let closestButton = mUI.el('button', 'm-ratio-button', 'Use closest ratio');
        closestButton.addEventListener('click', () => this.applyImageRatio(false));
        this.ratioRow.appendChild(closestButton);
        promptWrap.appendChild(this.ratioRow);
        panel.appendChild(promptWrap);
        panel.appendChild(this.buildQuickParams());
        let negWrap = mUI.el('details', 'm-neg-wrap');
        this.negSummary = mUI.el('summary', 'm-neg-summary', 'Negative prompt');
        negWrap.appendChild(this.negSummary);
        this.negBox = mUI.el('textarea', 'm-neg-box');
        this.negBox.rows = 2;
        this.negBox.addEventListener('input', () => {
            mState.params['negativeprompt'] = this.negBox.value;
            mState.save();
        });
        negWrap.appendChild(this.negBox);
        this.negWrap = negWrap;
        panel.appendChild(negWrap);
        this.advChips = mUI.el('div', 'm-adv-chips');
        panel.appendChild(this.advChips);
        let fileInput = document.createElement('input');
        fileInput.type = 'file';
        fileInput.accept = 'image/*';
        fileInput.multiple = true;
        fileInput.style.display = 'none';
        fileInput.addEventListener('change', () => {
            for (let file of fileInput.files) {
                this.addImageFile(file);
            }
            fileInput.value = '';
        });
        panel.appendChild(fileInput);
        this.fileInput = fileInput;
        mAutoComplete.enableFor(this.promptBox, 'prompt');
        mAutoComplete.enableFor(this.negBox, 'negativeprompt');
        mState.onChange(() => this.render());
        this.render();
    }

    /** How far a finger may travel and still count as a tap rather than a scroll, in CSS pixels. */
    static TapSlopPx = 10;

    /** Generate on tap; long-press (600ms) opens the grid form.
     *
     * The finger's travel is tracked, not just the fact that it moved. Previously any touchmove cleared the
     * long-press timer but recorded nothing, so touchend still fired a generation - meaning a scroll that
     * merely STARTED on the button queued a batch on release. Moving the generate bar up next to the prompt
     * put a full-width target in the middle of the scroll area and made that misfire easy to hit.
     * The slop also stops sub-pixel jitter from cancelling a deliberate long-press, which previously made the
     * grid sheet a coin flip to open. */
    wireGenerateButton() {
        let holdTimer = null;
        let held = false;
        let moved = false;
        let startX = 0;
        let startY = 0;
        let cancelHold = () => {
            if (holdTimer) {
                clearTimeout(holdTimer);
                holdTimer = null;
            }
        };
        this.genButton.addEventListener('touchstart', (e) => {
            held = false;
            moved = false;
            let touch = e.touches.item(0);
            startX = touch ? touch.clientX : 0;
            startY = touch ? touch.clientY : 0;
            cancelHold();
            holdTimer = setTimeout(() => {
                held = true;
                this.openGridSheet();
            }, 600);
        }, { passive: true });
        this.genButton.addEventListener('touchmove', (e) => {
            let touch = e.touches.item(0);
            if (!touch) {
                return;
            }
            if (Math.abs(touch.clientX - startX) > MCreate.TapSlopPx || Math.abs(touch.clientY - startY) > MCreate.TapSlopPx) {
                moved = true;
                cancelHold();
            }
        }, { passive: true });
        this.genButton.addEventListener('touchend', (e) => {
            cancelHold();
            if (!held && !moved) {
                e.preventDefault();
                this.doGenerate();
            }
        });
        // A touch the system takes away is never a tap. Without this the flags keep their last values and a
        // later stray touchend could still generate.
        this.genButton.addEventListener('touchcancel', () => {
            cancelHold();
            moved = true;
        });
        this.genButton.addEventListener('contextmenu', (e) => e.preventDefault());
        this.genButton.addEventListener('click', (e) => {
            if (e.detail > 0 && !('ontouchstart' in window)) {
                this.doGenerate();
            }
        });
    }

    /** Fires one generation batch. Stays on this tab - the preview is right here. */
    doGenerate() {
        let input = mState.buildGenInput();
        if (!`${input['prompt'] || ''}`.trim() && !input['promptimages'] && mState.activePresets.length == 0) {
            mUI.warn('Type a prompt or pick a preset first.');
            return;
        }
        // The header error strip is sticky, so clear it here: from this point the last failure describes an
        // attempt the user has already moved on from. Cleared on the way out rather than on the way in so a
        // rejected input (the guard above) still leaves the reason it was rejected on screen.
        mUI.clearError();
        mAutoComplete.hide();
        if (this.previewCollapsed) {
            this.previewCollapsed = false;
            localStorage.setItem('m_client_preview_collapsed', 'no');
            this.renderPreviewState();
        }
        if (document.activeElement && document.activeElement.blur) {
            document.activeElement.blur();
        }
        this.setPending(true);
        mGen.generate(input);
    }

    /** Re-renders every dynamic region from state. */
    render() {
        this.renderArch();
        this.renderPresets();
        this.renderModelButton();
        if (document.activeElement != this.promptBox) {
            this.promptBox.value = mState.params['prompt'] || '';
            this.autoGrow(this.promptBox);
        }
        if (document.activeElement != this.negBox) {
            this.negBox.value = mState.params['negativeprompt'] || '';
        }
        if ((mState.params['negativeprompt'] || '') != '') {
            this.negWrap.open = true;
        }
        this.renderImageStrip();
        this.renderQuickParams();
        let loras = mState.getLoras();
        this.loraButton.textContent = `LoRAs (${loras.length})`;
        this.renderAdvChips();
    }

    /** Architecture picker: one entry per preset folder. Hidden unless there are at least two groups to
     * choose between, since a single-group picker is a control that can only ever say one thing. A stored
     * filter naming a group that no longer exists falls back to "all" rather than showing an empty list. */
    renderArch() {
        let groups = mState.presetGroups();
        if (groups.length < 2) {
            this.archSelect.style.display = 'none';
            return;
        }
        this.archSelect.style.display = '';
        if (mState.archFilter && !groups.includes(mState.archFilter)) {
            mState.archFilter = '';
        }
        this.archSelect.innerHTML = '';
        let all = document.createElement('option');
        all.value = '';
        all.textContent = 'All';
        this.archSelect.appendChild(all);
        for (let group of groups) {
            let option = document.createElement('option');
            option.value = group;
            option.textContent = group;
            this.archSelect.appendChild(option);
        }
        this.archSelect.value = mState.archFilter;
    }

    /** Preset picklist: starred first, selecting an entry toggles it, selection order remains merge order. */
    renderPresets() {
        this.presetSelect.innerHTML = '';
        let placeholder = document.createElement('option');
        placeholder.value = '';
        if (mState.presets.length == 0) {
            placeholder.textContent = 'No presets';
            this.presetSelect.appendChild(placeholder);
            this.presetSelect.disabled = true;
            return;
        }
        this.presetSelect.disabled = false;
        placeholder.textContent = mState.activePresets.length == 0 ? 'Presets' : `Presets (${mState.activePresets.length})`;
        this.presetSelect.appendChild(placeholder);
        // An ACTIVE preset always shows, even when the architecture filter would hide it. Filtering it out
        // of the list would not deactivate it - it would keep merging into every generation with no option
        // left on screen to toggle off, which is a trap rather than a filter.
        let visible = mState.presets.filter(preset => !mState.archFilter
            || MState.presetGroup(preset.title) == mState.archFilter
            || mState.activePresets.includes(preset.title));
        if (visible.length == 0) {
            placeholder.textContent = 'No presets';
            this.presetSelect.disabled = true;
            return;
        }
        let sorted = [...visible].sort((a, b) => (b.is_starred ? 1 : 0) - (a.is_starred ? 1 : 0));
        for (let preset of sorted) {
            let option = document.createElement('option');
            option.value = preset.title;
            // With a group selected the folder prefix is the same on every visible option, so it is spending
            // scarce picker width to say nothing. Under "all" it is the only architecture cue there is.
            let label = preset.title;
            if (mState.archFilter && label.startsWith(`${mState.archFilter}/`)) {
                label = label.substring(mState.archFilter.length + 1);
            }
            option.textContent = `${mState.activePresets.includes(preset.title) ? '✓ ' : ''}${label}`;
            this.presetSelect.appendChild(option);
        }
        this.presetSelect.value = '';
    }

    /** Model button label. Hidden entirely when the user lacks the model parameter permission, since
     * ListT2IParams only reports parameters the session is allowed to set. */
    renderModelButton() {
        if (!mState.paramMeta['model']) {
            this.modelButton.style.display = 'none';
            return;
        }
        this.modelButton.style.display = '';
        this.modelButton.classList.remove('m-selected', 'm-overridden');
        let manual = mState.params['model'];
        // The value that will actually be sent: buildGenInput() applies active presets AFTER the manual
        // pick (matching the server, which applies `presets:[]` after raw params - T2IAPI.cs), so a preset
        // that also sets 'model' wins on every generate for as long as its chip stays selected, not just
        // once. Showing `manual` here without checking this is what made the button say "Klein" while every
        // image still came out as the preset's "Anima" - the button must show what will actually be used.
        let effective = mState.buildGenInput()['model'];
        if (!effective) {
            this.modelButton.textContent = 'Model: default';
            return;
        }
        // Normalised, because a preset stores 'qwen/Foo' where the picker stores 'qwen/Foo.safetensors'.
        // Compared raw, picking the very model a preset already sets would report it as an override.
        if (manual && MState.stripModelExt(effective) != MState.stripModelExt(manual)) {
            this.modelButton.textContent = `${mUI.modelName(effective)} (preset overrides your pick)`;
            this.modelButton.classList.add('m-overridden');
            return;
        }
        if (manual) {
            this.modelButton.textContent = mUI.modelName(manual);
            this.modelButton.classList.add('m-selected');
            return;
        }
        this.modelButton.textContent = `${mUI.modelName(effective)} (preset)`;
    }

    /** How deep the picker listings recurse. The pickers are flat searchable lists, not folder browsers, so
     * this has to reach the bottom of the tree - at the previous depth of 5, anything nested deeper simply
     * did not exist as far as the picker was concerned. */
    static ListDepth = 32;

    /** How many rows a picker renders at once. Truncation is reported rather than silent - see buildCountRow. */
    static ListCap = 120;

    /** Footer telling you how much of the list you are actually looking at. A cap that says nothing is
     * indistinguishable from models that are missing. */
    buildCountRow(shown, total, noun) {
        if (total == 0) {
            return mUI.el('div', 'm-strip-empty', `No ${noun} match that search.`);
        }
        if (shown >= total) {
            return mUI.el('div', 'm-list-count', `${total} ${noun}`);
        }
        return mUI.el('div', 'm-list-count', `Showing ${shown} of ${total} ${noun} - search to narrow it down`);
    }

    /** Failed-list row with a working Retry, for the model/LoRA sheets. Without this a failed ListModels left
     *  the sheet reading "Loading..." forever: the cached list stays null, so re-opening silently re-fires the
     *  same request and lands on the same dead row, with the only visible sign a toast that has since gone. */
    buildRetryRow(message, onRetry) {
        let wrap = mUI.el('div', 'm-strip-empty', message);
        let retry = mUI.el('button', 'm-model-plain-row', 'Retry');
        retry.addEventListener('click', onRetry);
        wrap.appendChild(retry);
        return wrap;
    }

    /** Search filter shared by both pickers: matches the file name, the folder path, the metadata title,
     * and the trigger phrase, so a LoRA can be found by the word you actually type into prompts. */
    static filterModels(list, term) {
        let low = `${term || ''}`.toLowerCase().trim();
        if (!low) {
            return list;
        }
        return list.filter(model => {
            // A phone should lowercase each 18K-LoRA search corpus once, not once per model per keystroke.
            if (model._mSearchText == null) {
                model._mSearchText = `${model.name || ''} ${model.title || ''} ${model.trigger_phrase || ''}`.toLowerCase();
            }
            return model._mSearchText.includes(low);
        });
    }

    /** Narrows a picker list to the selected architecture and builds the row that explains what happened.
     * Returns {list, row}, where row is null when there is nothing worth saying - no filter selected, or a
     * filter that turned out to hide nothing. The escape hatch is deliberate: the group's compat classes are
     * inferred from what its presets happen to select, so it can be wrong, and a picker that silently omits
     * a model with no way to get it back is worse than no filter at all. */
    applyArchFilter(list, subtype, state, rerender) {
        if (!mState.archFilter) {
            return { 'list': list, 'row': null };
        }
        let narrowed = mState.filterByArch(list, subtype);
        if (narrowed.length == list.length) {
            return { 'list': list, 'row': null };
        }
        let row = mUI.el('button', 'm-arch-note');
        row.textContent = state.showAll
            ? `Showing all - tap to limit to ${mState.archFilter}`
            : `Limited to ${mState.archFilter}, ${list.length - narrowed.length} hidden - tap to show all`;
        row.addEventListener('click', () => {
            state.showAll = !state.showAll;
            rerender();
        });
        return { 'list': state.showAll ? list : narrowed, 'row': row };
    }

    /** Checkpoint picker sheet. Same shape as the LoRA sheet: search plus a lazily fetched list. */
    openModelSheet() {
        mState.refreshUserData();
        let content = mUI.el('div', 'm-lora-sheet');
        content.appendChild(mUI.el('div', 'm-sheet-title', 'Model'));
        let search = document.createElement('input');
        search.type = 'text';
        search.placeholder = 'Search checkpoints...';
        search.className = 'm-lora-search';
        content.appendChild(search);
        let results = mUI.el('div', 'm-model-results');
        content.appendChild(results);
        let close = null;
        let archState = { 'showAll': false };
        let renderResults = () => {
            results.innerHTML = '';
            let clear = mUI.el('button', 'm-model-plain-row', 'Use server default');
            clear.addEventListener('click', () => {
                delete mState.params['model'];
                mState.changed();
                close();
            });
            results.appendChild(clear);
            if (!this.modelList) {
                results.appendChild(this.modelListError
                    ? this.buildRetryRow('Could not load checkpoints.', () => loadModelList())
                    : mUI.el('div', 'm-strip-empty', 'Loading...'));
                return;
            }
            let arch = this.applyArchFilter(this.modelList, 'Stable-Diffusion', archState, renderResults);
            if (arch.row) {
                results.appendChild(arch.row);
            }
            let matches = mState.starredFirst(MCreate.filterModels(arch.list, search.value), 'Stable-Diffusion');
            let shown = 0;
            for (let model of matches) {
                let item = mUI.el('div', 'm-model-result');
                let thumb = mUI.modelThumb(model, 'm-model-thumb');
                if (thumb) {
                    item.appendChild(thumb);
                }
                item.appendChild(mUI.modelText(model, null));
                let star = mUI.starBadge('Stable-Diffusion', model.name);
                if (star) {
                    item.appendChild(star);
                }
                if (mState.params['model'] == model.name) {
                    item.classList.add('m-selected');
                }
                item.addEventListener('click', () => {
                    mState.params['model'] = model.name;
                    mState.changed();
                    close();
                });
                results.appendChild(item);
                if (++shown >= MCreate.ListCap) {
                    break;
                }
            }
            results.appendChild(this.buildCountRow(shown, matches.length, 'checkpoints'));
        };
        search.addEventListener('input', renderResults);
        let loadModelList = () => {
            this.modelListError = false;
            renderResults();
            genericRequest('ListModels', { 'path': '', 'depth': MCreate.ListDepth, 'subtype': 'Stable-Diffusion', 'sortBy': 'Name', 'allowRemote': true, 'sortReverse': false, 'dataImages': false }, data => {
                this.modelList = data.files || [];
                renderResults();
            }, 0, err => {
                this.modelListError = true;
                renderResults();
                showError(err);
            });
        };
        if (!this.modelList) {
            loadModelList();
        }
        renderResults();
        close = mUI.openSheet(content);
    }

    /** Prompt-image strip: thumbs, remove, add tile, long-press drag reorder (DOM order == request order). */
    renderImageStrip() {
        this.imageStrip.innerHTML = '';
        for (let i = 0; i < mState.promptImages.length; i++) {
            let entry = mState.promptImages[i];
            let tile = mUI.el('div', 'm-image-tile');
            tile.dataset.index = `${i}`;
            let img = document.createElement('img');
            img.src = entry.kind == 'data' ? entry.value : `${getImageOutPrefix()}/${entry.value}`;
            tile.appendChild(img);
            // A tap was a no-op here before this existed, so opening the editor doesn't compete with
            // anything - long-press+drag (wireReorder, below) is unaffected, and a real drag never lets a
            // synthetic click fire afterward, so this never fires mid-reorder either.
            tile.addEventListener('click', () => mImageEdit.open(i));
            let remove = mUI.el('span', 'm-image-tile-remove', '×');
            remove.addEventListener('click', (e) => {
                // Without this the click also bubbles to the tile's own listener above and opens the editor
                // on top of the tile that was just removed from under it.
                e.stopPropagation();
                mState.promptImages.splice(i, 1);
                mState.changed();
            });
            tile.appendChild(remove);
            this.wireReorder(tile);
            this.imageStrip.appendChild(tile);
        }
        let add = mUI.el('button', 'm-image-tile m-image-add', '+');
        add.addEventListener('click', () => this.fileInput.click());
        this.imageStrip.appendChild(add);
        // With no images attached the add tile shrinks to a plain button rather than holding a full
        // thumbnail-sized square of empty space open at the top of every session.
        this.imageStrip.classList.toggle('m-image-strip-empty', mState.promptImages.length == 0);
        this.ratioRow.style.display = mState.promptImages.length > 0 ? '' : 'none';
    }

    /** Reads the natural size of the first prompt image (the primary one) and reports its width/height
     * ratio, or 0 if it cannot be measured. */
    primaryImageRatio(callback) {
        let entry = mState.promptImages[0];
        if (!entry) {
            callback(0);
            return;
        }
        let img = new Image();
        img.onload = () => callback(img.naturalHeight > 0 ? img.naturalWidth / img.naturalHeight : 0);
        img.onerror = () => callback(0);
        img.src = entry.kind == 'data' ? entry.value : `${getImageOutPrefix()}/${entry.value}`;
    }

    /** Sets the aspect ratio from the primary prompt image. Exact keeps the image's real ratio (sent as
     * Custom with computed pixels, and still scaled by whatever the Size setting says); otherwise it snaps
     * to the nearest ratio in the picker. */
    applyImageRatio(exact) {
        this.primaryImageRatio(ratio => {
            if (!ratio) {
                mUI.warn('Could not read that image\'s size.');
                return;
            }
            if (exact) {
                mState.params['aspectratio'] = 'Custom';
                mState.customRatio = ratio;
            }
            else {
                mState.params['aspectratio'] = MState.closestAspect(ratio);
                mState.customRatio = 0;
            }
            mState.changed();
        });
    }

    /** Long-press (150ms) arms a horizontal drag that live-reorders the tile among its siblings; on release
     * the promptImages array is rebuilt from DOM order. We own this DOM, so order is authoritative here. */
    wireReorder(tile) {
        let armTimer = null;
        let dragging = false;
        let startX = 0;
        let startY = 0;
        tile.addEventListener('touchstart', (e) => {
            let touch = e.touches.item(0);
            startX = touch ? touch.clientX : 0;
            startY = touch ? touch.clientY : 0;
            armTimer = setTimeout(() => {
                dragging = true;
                tile.classList.add('m-dragging');
            }, 150);
        }, { passive: true });
        tile.addEventListener('touchmove', (e) => {
            let touch = e.touches.item(0);
            if (!touch) {
                return;
            }
            if (!dragging) {
                if (armTimer) {
                    clearTimeout(armTimer);
                    armTimer = null;
                }
                return;
            }
            // Axis lock. The 150ms arm alone is not intent: a deliberate vertical scroll routinely rests on a
            // tile longer than that before the finger starts moving, and this handler is the ONLY thing that can
            // release it - the branch below preventDefaults every move, and the reorder reads clientX only, so a
            // vertical drag was previously swallowed while doing nothing at all. Scrolling the Create panel from
            // a prompt-image tile was therefore dead. Same TapSlopPx the Generate long-press uses: once the
            // gesture is decisively more vertical than horizontal, disarm and hand the touch back to the scroller.
            let dx = Math.abs(touch.clientX - startX);
            let dy = Math.abs(touch.clientY - startY);
            if (dy > MCreate.TapSlopPx && dy > dx) {
                dragging = false;
                tile.classList.remove('m-dragging');
                this.renderImageStrip();
                return;
            }
            e.preventDefault();
            let x = touch.clientX;
            for (let sibling of this.imageStrip.querySelectorAll('.m-image-tile:not(.m-image-add)')) {
                if (sibling == tile) {
                    continue;
                }
                let rect = sibling.getBoundingClientRect();
                let mid = rect.left + rect.width / 2;
                if (x < mid && tile.compareDocumentPosition(sibling) & Node.DOCUMENT_POSITION_PRECEDING) {
                    this.imageStrip.insertBefore(tile, sibling);
                    break;
                }
                if (x > mid && tile.compareDocumentPosition(sibling) & Node.DOCUMENT_POSITION_FOLLOWING) {
                    this.imageStrip.insertBefore(tile, sibling.nextSibling);
                    break;
                }
            }
        }, { passive: false });
        tile.addEventListener('touchend', () => {
            if (armTimer) {
                clearTimeout(armTimer);
                armTimer = null;
            }
            if (dragging) {
                dragging = false;
                tile.classList.remove('m-dragging');
                let order = [];
                for (let t of this.imageStrip.querySelectorAll('.m-image-tile:not(.m-image-add)')) {
                    order.push(mState.promptImages[parseInt(t.dataset.index)]);
                }
                mState.promptImages = order;
                mState.changed();
            }
        });
        // A touch the system takes away mid-drag (incoming call, notification, gesture escalation) never
        // fires touchend, so without this the tile keeps 'dragging' and its half-transparent styling for the
        // rest of the session. The half-finished DOM order is discarded rather than committed - a cancelled
        // drag should leave the order it started with, and rendering from state is what restores it.
        tile.addEventListener('touchcancel', () => {
            if (armTimer) {
                clearTimeout(armTimer);
                armTimer = null;
            }
            if (dragging) {
                dragging = false;
                tile.classList.remove('m-dragging');
                this.renderImageStrip();
            }
        });
    }

    /** Clipboard paste on the prompt box: image items become prompt images (the user's screenshot-paste
     * flow). Text is deliberately left alone here - this box is where prompts are typed, so a pasted path
     * belongs in the text, not attached as an image. That is what the clipboard button is for. */
    onPaste(e) {
        if (this.attachFromTransfer(e.clipboardData, false) > 0) {
            e.preventDefault();
        }
    }

    /** Attaches a text payload as a prompt image when it is one: a data URI, or a Swarm output path / View
     * URL. Returns whether it attached anything. */
    attachFromText(text) {
        let val = `${text || ''}`.trim();
        if (!val) {
            return false;
        }
        if (val.startsWith('data:image/')) {
            mState.promptImages.push({ 'kind': 'data', 'value': val });
            mState.changed();
            return true;
        }
        let entry = typeof mImages != 'undefined' ? mImages.promptPathEntry(val) : null;
        if (entry) {
            mState.promptImages.push(entry);
            mState.changed();
            return true;
        }
        return false;
    }

    /** Attaches every image a paste event's DataTransfer carries, falling back to its text payload when it
     * carries no file and allowText says text counts. Returns how many prompt images it added.
     * This is the clipboard path that always works: a paste event hands the page its own data with no
     * permission prompt and no secure-context rule involved, unlike navigator.clipboard.read. */
    attachFromTransfer(data, allowText) {
        if (!data) {
            return 0;
        }
        let count = 0;
        let items = data.items || [];
        for (let i = 0; i < items.length; i++) {
            let item = items[i];
            if (item.kind == 'file' && item.type && item.type.startsWith('image/')) {
                let file = item.getAsFile();
                if (file) {
                    this.addImageFile(file);
                    count++;
                }
            }
        }
        // .files rather than .items is what some browsers populate for a dropped or pasted file, so it is a
        // fallback and not a second pass - counting both would attach the same screenshot twice.
        if (count == 0 && data.files) {
            for (let i = 0; i < data.files.length; i++) {
                let file = data.files[i];
                if (file.type && file.type.startsWith('image/')) {
                    this.addImageFile(file);
                    count++;
                }
            }
        }
        if (count == 0 && allowText && data.getData && this.attachFromText(data.getData('text/plain'))) {
            count++;
        }
        return count;
    }

    /** Reads a File to a data URI and appends it to the prompt images. */
    addImageFile(file) {
        if (!file) {
            return;
        }
        let reader = new FileReader();
        reader.onload = () => {
            mState.promptImages.push({ 'kind': 'data', 'value': reader.result });
            mState.changed();
        };
        reader.readAsDataURL(file);
    }

    /** Clipboard button: attach whatever is on the clipboard as prompt image(s). Image blobs go through
     * addImageFile (the same path as paste-on-the-prompt-box). A Swarm output path or a data URI uses the
     * existing attach helpers. Empty or non-image clipboard is a warning, not an error.
     *
     * **The read API is the optimistic path, not the only one.** `navigator.clipboard` is undefined outside a
     * secure context, and this client is normally reached at a LAN address over plain HTTP - which is
     * insecure by that rule no matter how local it is, so the button used to dead-end on every phone that
     * wasn't pointed at localhost. `read()` also rejects when the clipboard-read permission is denied or
     * dismissed, when the document isn't focused, and on browsers that expose it to extensions only. Every
     * one of those ends in openPasteSheet(), where the user's own paste gesture hands the page the data no
     * API here is allowed to take. The old readText() retry is gone with them: it fails for the same reasons
     * read() just did, costs a second permission prompt to find that out, and the sheet accepts pasted text
     * anyway. */
    pasteFromClipboard() {
        let attached = (count) => {
            if (count > 0) {
                mUI.note(count == 1 ? 'Pasted image.' : `Pasted ${count} images.`);
            }
            else {
                mUI.warn('Clipboard has no image.');
            }
        };
        if (navigator.clipboard && navigator.clipboard.read) {
            navigator.clipboard.read().then(items => {
                let files = [];
                let texts = [];
                let pending = items.length;
                if (pending == 0) {
                    attached(0);
                    return;
                }
                let finish = () => {
                    if (--pending > 0) {
                        return;
                    }
                    for (let i = 0; i < files.length; i++) {
                        this.addImageFile(files[i]);
                    }
                    let extra = 0;
                    if (files.length == 0) {
                        for (let i = 0; i < texts.length; i++) {
                            if (this.attachFromText(texts[i])) {
                                extra++;
                            }
                        }
                    }
                    attached(files.length + extra);
                };
                for (let i = 0; i < items.length; i++) {
                    let item = items[i];
                    let imageType = null;
                    for (let t = 0; t < item.types.length; t++) {
                        if (item.types[t].startsWith('image/')) {
                            imageType = item.types[t];
                            break;
                        }
                    }
                    if (imageType) {
                        item.getType(imageType).then(blob => {
                            files.push(new File([blob], 'clipboard.png', { 'type': blob.type || imageType }));
                            finish();
                        }, finish);
                    }
                    else if (item.types.indexOf('text/plain') >= 0) {
                        item.getType('text/plain').then(blob => blob.text()).then(text => {
                            texts.push(text);
                            finish();
                        }, finish);
                    }
                    else {
                        finish();
                    }
                }
            }, () => this.openPasteSheet());
            return;
        }
        this.openPasteSheet();
    }

    /** The clipboard fallback: a focused paste box in a sheet, for every browser and context that will not
     * hand the page the clipboard on its own (see pasteFromClipboard above - over plain LAN HTTP that is all
     * of them). A paste event carries its own data with no permission and no secure context involved, so this
     * path always works.
     *
     * **contenteditable, not a textarea**, which is the whole reason this is a box of its own rather than a
     * pointer at the prompt field: iOS only offers Paste for a copied image over a region that can hold one,
     * and a plain textarea is not one. The old message sent people to the prompt box, where a phone's paste
     * menu would silently decline to offer the image they had just copied.
     *
     * "Choose an image instead" reuses the strip's own hidden file input - on a phone that opens the photo
     * library, which is where a screenshot actually lives, and it is the guaranteed path when a paste gesture
     * is unavailable entirely. */
    openPasteSheet() {
        let content = mUI.el('div', 'm-paste-sheet');
        content.appendChild(mUI.el('div', 'm-sheet-title', 'Paste an image'));
        content.appendChild(mUI.el('div', 'm-paste-hint', 'This browser will not hand the page your clipboard on its own (that needs HTTPS or localhost). Tap the box below and paste: long-press then Paste on a phone, Ctrl+V on a desktop.'));
        let box = mUI.el('div', 'm-paste-box');
        box.contentEditable = 'true';
        box.setAttribute('role', 'textbox');
        box.setAttribute('aria-label', 'Paste an image here');
        box.dataset.placeholder = 'Paste here';
        content.appendChild(box);
        let pickButton = mUI.el('button', 'm-wide-button', 'Choose an image instead');
        content.appendChild(pickButton);
        let close = mUI.openSheet(content);
        pickButton.addEventListener('click', () => {
            close();
            if (this.fileInput) {
                this.fileInput.click();
            }
        });
        let done = (count) => {
            box.innerHTML = '';
            if (count > 0) {
                close();
                mUI.note(count == 1 ? 'Pasted image.' : `Pasted ${count} images.`);
            }
            else {
                // The sheet stays open on a miss - the user is already in the paste gesture, and closing it
                // would mean tapping the clipboard button again to try the other thing on their clipboard.
                mUI.warn('Nothing usable pasted - copy an image, a data URI, or a Swarm image path.');
            }
        };
        box.addEventListener('paste', (e) => {
            let count = this.attachFromTransfer(e.clipboardData, true);
            if (count > 0) {
                e.preventDefault();
                done(count);
                return;
            }
            // An image copied out of a web page - or, on a phone, out of the photo library - can arrive as
            // markup with no file and no usable text behind it. Let that default paste land in the box, then
            // read the <img> back out of it on the next task. A data: src is the bytes themselves and a View
            // URL from this same server resolves to an output path, so attachFromText takes both; a blob:
            // src is neither, but it is real bytes this page is allowed to read, so fetch it into a file.
            // The box is cleared on every one of those paths, so nothing is left sitting in it.
            setTimeout(() => {
                let src = box.querySelector('img') ? box.querySelector('img').src : '';
                if (!src || this.attachFromText(src)) {
                    done(src ? 1 : 0);
                    return;
                }
                fetch(src).then(response => response.blob()).then(blob => {
                    if (!blob.type || !blob.type.startsWith('image/')) {
                        done(0);
                        return;
                    }
                    this.addImageFile(new File([blob], 'pasted.png', { 'type': blob.type }));
                    done(1);
                }, () => done(0));
            }, 0);
        });
        // Focused SYNCHRONOUSLY, inside the click that opened the sheet, and that timing is the whole point:
        // a browser places a caret and raises the on-screen keyboard for a focus() only while the user's own
        // tap is still the live gesture. This first shipped as a focus() from a 300ms timer, to let the open
        // transition finish - which lands outside that window, so a phone ignored it and the box sat there
        // unfocused. That cost a second tap on the box before a long-press would even offer Paste, and made
        // one clipboard button feel like two button presses.
        // preventScroll because the sheet is still parked at translateY(100%) for the frame this runs in:
        // without it the browser scrolls the page toward where the box is not yet.
        box.focus({ 'preventScroll': true });
    }

    /** Quick params row: seed mode, images count, tuning steppers, and one combined resolution picker. */
    buildQuickParams() {
        let wrap = mUI.el('div', 'm-quick-wrap');
        let row = mUI.el('div', 'm-quick-row');
        let seedWrap = mUI.el('div', 'm-quick-item m-seed-control');
        this.seedRandom = mUI.el('button', 'm-seed-random', 'Random');
        this.seedRandom.addEventListener('click', () => {
            mState.seedLocked = true;
            if (!mState.params['seed'] || `${mState.params['seed']}` == '-1') {
                mState.params['seed'] = `${Math.floor(Math.random() * 2147483647)}`;
            }
            mState.changed();
            requestAnimationFrame(() => {
                this.seedInput.focus();
                this.seedInput.select();
            });
        });
        seedWrap.appendChild(this.seedRandom);
        this.seedInput = document.createElement('input');
        this.seedInput.type = 'text';
        this.seedInput.inputMode = 'numeric';
        this.seedInput.className = 'm-seed-input';
        this.seedInput.setAttribute('aria-label', 'Seed');
        this.seedInput.addEventListener('input', () => {
            mState.params['seed'] = this.seedInput.value;
            mState.save();
        });
        seedWrap.appendChild(this.seedInput);
        this.seedClear = mUI.el('button', 'm-seed-clear', '×');
        this.seedClear.setAttribute('aria-label', 'Use random seed');
        this.seedClear.addEventListener('click', () => {
            mState.seedLocked = false;
            mState.params['seed'] = '-1';
            mState.changed();
        });
        seedWrap.appendChild(this.seedClear);
        row.appendChild(seedWrap);
        this.imagesGroup = mUI.el('div', 'm-quick-item m-seg-group m-batch-group');
        for (let n of ['1', '2', '4']) {
            let btn = mUI.el('button', 'm-seg-button', n);
            btn.dataset.count = n;
            btn.addEventListener('click', () => {
                mState.params['images'] = n;
                mState.changed();
            });
            this.imagesGroup.appendChild(btn);
        }
        let clipBtn = mUI.el('button', 'm-seg-button', '📋');
        clipBtn.title = 'Paste clipboard as prompt image';
        clipBtn.setAttribute('aria-label', 'Paste clipboard as prompt image');
        clipBtn.addEventListener('click', () => this.pasteFromClipboard());
        this.imagesGroup.appendChild(clipBtn);
        let clearBtn = mUI.el('button', 'm-seg-button', 'CLR');
        clearBtn.title = 'Clear prompt images and prefix';
        clearBtn.setAttribute('aria-label', 'Clear prompt images and prefix');
        clearBtn.addEventListener('click', () => {
            mUI.confirm('Clear prompt images and the Prefix field? The text prompt is kept.', () => {
                mState.promptImages = [];
                delete mState.params['filenameprefix'];
                mState.changed();
            });
        });
        this.imagesGroup.appendChild(clearBtn);
        row.appendChild(this.imagesGroup);
        wrap.appendChild(row);
        // Filename prefix sits directly above Steps/CFG: a label for the session's saved files, used as
        // often as the steppers, so it should not live below aspect/size. Same control as before - only
        // the DOM order changed. resetParams still preserves it; the CLR button above is what clears it.
        this.prefixRow = mUI.el('div', 'm-quick-row');
        this.prefixRow.appendChild(mUI.el('span', 'm-quick-label', 'Prefix'));
        this.prefixInput = document.createElement('input');
        this.prefixInput.type = 'text';
        this.prefixInput.className = 'm-prefix-input';
        this.prefixInput.placeholder = 'none';
        this.prefixInput.addEventListener('input', () => {
            let val = this.prefixInput.value.trim();
            // Deleting rather than storing '' keeps m_client_state clean and avoids sending a no-op key.
            if (val == '') {
                delete mState.params['filenameprefix'];
            }
            else {
                mState.params['filenameprefix'] = val;
            }
            // save(), not changed(): a full re-render per keystroke would fight the user's typing.
            mState.save();
        });
        this.prefixRow.appendChild(this.prefixInput);
        wrap.appendChild(this.prefixRow);
        let tuneRow = mUI.el('div', 'm-quick-row m-tune-row');
        tuneRow.appendChild(this.buildNumberStepper('steps', 'Steps', { 'default': 20, 'min': 0, 'max': 500, 'step': 1 }));
        tuneRow.appendChild(this.buildNumberStepper('cfgscale', 'CFG', { 'default': 7, 'min': 0, 'max': 100, 'step': 0.5 }));
        wrap.appendChild(tuneRow);
        // Aspect and size are two controls, not one fused list. The ratio is a framing decision that changes
        // rarely; the size is a cost decision nudged constantly. Fusing them turned every size nudge into a
        // scroll past every other ratio's rungs, which is what the one-picker version cost in practice.
        let resRow = mUI.el('div', 'm-quick-row m-res-row');
        this.aspectSelect = document.createElement('select');
        this.aspectSelect.className = 'm-aspect-select';
        this.aspectSelect.setAttribute('aria-label', 'Aspect ratio');
        this.aspectSelect.addEventListener('change', () => {
            mState.params['aspectratio'] = this.aspectSelect.value;
            // A change event only fires when the value actually moved, so any change leaves whatever ratio a
            // prompt image had matched - including a move onto Custom, which is the manual escape hatch.
            mState.customRatio = 0;
            mState.changed();
        });
        resRow.appendChild(this.aspectSelect);
        resRow.appendChild(this.buildSideLengthStepper());
        wrap.appendChild(resRow);
        return wrap;
    }

    /** The size ladder as a stepper. Deliberately not buildNumberStepper: side length walks a fixed ladder of
     * model-friendly rungs rather than a uniform increment, and the label line carries the pixels that rung
     * produces at the current ratio - so the number the buttons move and the number that gets generated are
     * both on screen, in the same shape as the Steps/CFG steppers directly above. */
    buildSideLengthStepper() {
        let wrap = mUI.el('div', 'm-number-stepper m-size-stepper');
        this.sizeLabel = mUI.el('span', 'm-stepper-label', 'Size');
        wrap.appendChild(this.sizeLabel);
        let minus = mUI.el('button', 'm-stepper-button', '−');
        minus.setAttribute('aria-label', 'Decrease size');
        minus.addEventListener('click', () => this.adjustSideLength(-1));
        wrap.appendChild(minus);
        this.sizeValue = mUI.el('span', 'm-stepper-value');
        wrap.appendChild(this.sizeValue);
        let plus = mUI.el('button', 'm-stepper-button', '+');
        plus.setAttribute('aria-label', 'Increase size');
        plus.addEventListener('click', () => this.adjustSideLength(1));
        wrap.appendChild(plus);
        return wrap;
    }

    /** The rungs the size stepper walks, as stored-state strings. Whatever the state currently holds and the
     * ladder does not - Auto (''), or a side length reused from an older image - is carried as an extra rung
     * in sorted position so reuse reproduces that image, and drops off once stepped away from. */
    sideLengthLadder() {
        let meta = mState.paramMeta['sidelength'];
        let min = meta && parseInt(meta.min) ? parseInt(meta.min) : 0;
        let max = meta && parseInt(meta.max) ? parseInt(meta.max) : 16384;
        let ladder = MCreate.SideLengths.filter(v => v >= min && v <= max);
        if (ladder.length == 0) {
            ladder.push(Math.min(max, Math.max(min, MCreate.SideLengths[0])));
        }
        let rungs = ladder.map(v => `${v}`);
        let current = mState.params['sidelength'];
        if (current != null && !rungs.includes(`${current}`)) {
            // '' parses to NaN -> 0, which lands Auto below every concrete rung. That is the right place for
            // it: stepping down from the smallest size hands back the model's own native resolution.
            let stored = parseInt(current) || 0;
            let at = rungs.findIndex(v => parseInt(v) > stored);
            rungs.splice(at < 0 ? rungs.length : at, 0, `${current}`);
        }
        return rungs;
    }

    /** Walks the size ladder one rung, clamped at both ends rather than wrapping - a '+' that jumps from the
     * largest size back to the smallest would silently undo a deliberate choice. */
    adjustSideLength(direction) {
        let rungs = this.sideLengthLadder();
        let at = rungs.indexOf(`${mState.params['sidelength'] ?? ''}`);
        if (at < 0) {
            at = Math.max(0, rungs.indexOf('1024'));
        }
        mState.params['sidelength'] = rungs[Math.min(rungs.length - 1, Math.max(0, at + direction))];
        mState.changed();
    }

    /** Builds one compact minus/value/plus control. Server metadata remains authoritative; fallback values only
     * cover the short interval before ListT2IParams lands. */
    buildNumberStepper(paramId, label, fallback) {
        let wrap = mUI.el('div', 'm-number-stepper');
        wrap.appendChild(mUI.el('span', 'm-stepper-label', label));
        let minus = mUI.el('button', 'm-stepper-button', '−');
        minus.setAttribute('aria-label', `Decrease ${label}`);
        minus.addEventListener('click', () => this.adjustQuickNumber(paramId, -1));
        wrap.appendChild(minus);
        let value = mUI.el('span', 'm-stepper-value');
        wrap.appendChild(value);
        let plus = mUI.el('button', 'm-stepper-button', '+');
        plus.setAttribute('aria-label', `Increase ${label}`);
        plus.addEventListener('click', () => this.adjustQuickNumber(paramId, 1));
        wrap.appendChild(plus);
        this.numberSteppers[paramId] = { 'wrap': wrap, 'value': value, 'fallback': fallback };
        return wrap;
    }

    /** Moves a quick numeric parameter by its declared increment and clamps it to the server range. */
    adjustQuickNumber(paramId, direction) {
        let control = this.numberSteppers[paramId];
        let meta = mState.paramMeta[paramId] || control.fallback;
        let step = parseFloat(meta.step);
        step = Number.isFinite(step) && step > 0 ? step : control.fallback.step;
        let current = parseFloat(mState.buildGenInput()[paramId]);
        if (!Number.isFinite(current)) {
            current = parseFloat(meta.default);
        }
        if (!Number.isFinite(current)) {
            current = control.fallback.default;
        }
        let min = Number.isFinite(parseFloat(meta.min)) ? parseFloat(meta.min) : control.fallback.min;
        let max = Number.isFinite(parseFloat(meta.max)) ? parseFloat(meta.max) : control.fallback.max;
        let next = Math.min(max, Math.max(min, current + step * direction));
        mState.params[paramId] = `${parseFloat(next.toFixed(6))}`;
        mState.changed();
    }

    /** Syncs the quick-param controls from state. */
    renderQuickParams() {
        this.seedRandom.style.display = mState.seedLocked ? 'none' : '';
        this.seedInput.style.display = mState.seedLocked ? '' : 'none';
        this.seedClear.style.display = mState.seedLocked ? '' : 'none';
        if (document.activeElement != this.seedInput) {
            this.seedInput.value = `${mState.params['seed'] ?? ''}`;
        }
        // Visibility is recomputed every render rather than decided at build time: this panel can be built
        // before ListT2IParams lands, when paramMeta is still empty, and the row would stay hidden forever.
        // Absent from paramMeta means the session may not set the param (or the extension is disabled).
        this.prefixRow.style.display = mState.paramMeta['filenameprefix'] ? '' : 'none';
        if (document.activeElement != this.prefixInput) {
            this.prefixInput.value = `${mState.params['filenameprefix'] ?? ''}`;
        }
        for (let btn of this.imagesGroup.querySelectorAll('.m-seg-button')) {
            btn.classList.toggle('m-selected', btn.dataset.count == `${mState.params['images'] || '1'}`);
        }
        let metadataReady = Object.keys(mState.paramMeta).length > 0;
        let effective = mState.buildGenInput();
        for (let paramId in this.numberSteppers) {
            let control = this.numberSteppers[paramId];
            let meta = mState.paramMeta[paramId];
            control.wrap.style.display = !metadataReady || meta ? '' : 'none';
            let shown = effective[paramId];
            if (shown == null || shown == '') {
                shown = meta && meta.default != null ? meta.default : control.fallback.default;
            }
            control.value.textContent = `${shown}`;
        }
        this.renderResolutionControls();
    }

    /** Aspect ratio and size, kept in step. The ratio list carries no pixel sizes and the stepper reads out
     * the final width x height, so moving either control shows the real output size without asking the user
     * to reconcile two dropdowns against a third readout. */
    renderResolutionControls() {
        let stateChanged = false;
        let aspectMeta = mState.paramMeta['aspectratio'];
        let serverValues = aspectMeta && aspectMeta.values ? aspectMeta.values : ['1:1', '4:3', '3:2', '16:9', '2:3', '9:16', 'Custom'];
        // Server ratios first, then the fork-added ones, with Custom kept last as the manual escape hatch.
        let aspects = serverValues.filter(v => v != 'Custom').concat(Object.keys(MState.ExtraAspects)).concat(['Custom']);
        // Seed the state from the shown default rather than leaving it unset: an absent aspectratio is not
        // the same as the displayed one, and the server would otherwise fall through to raw dimensions.
        if (!mState.params['aspectratio']) {
            mState.params['aspectratio'] = aspectMeta && aspectMeta.default ? aspectMeta.default : '1:1';
            stateChanged = true;
        }
        if (!aspects.includes(mState.params['aspectratio'])) {
            aspects.splice(aspects.length - 1, 0, mState.params['aspectratio']);
        }
        // Seeded rather than left blank so the default is a concrete, visible 1024 instead of an Auto value
        // that resolves differently per checkpoint.
        let rungs = this.sideLengthLadder();
        if (!mState.params['sidelength'] && mState.params['sidelength'] !== '') {
            mState.params['sidelength'] = rungs.includes('1024') ? '1024' : rungs[0];
            stateChanged = true;
        }
        this.aspectSelect.innerHTML = '';
        for (let aspect of aspects) {
            let opt = document.createElement('option');
            opt.value = aspect;
            // Custom is two different things depending on whether a prompt image supplied a ratio, and the
            // label has to say which - one sends matched pixels, the other defers to the full UI.
            opt.textContent = aspect != 'Custom' ? aspect : (mState.customRatio ? 'Custom · matched' : 'Custom · full UI');
            this.aspectSelect.appendChild(opt);
        }
        this.aspectSelect.value = mState.params['aspectratio'];
        let side = `${mState.params['sidelength'] ?? ''}`;
        this.sizeValue.textContent = side == '' ? 'Auto' : side;
        // Read from previewResolution, not from a local recomputation: it derives from a real buildGenInput,
        // so the pixels on screen cannot drift from the ones that get sent.
        let dims = mState.previewResolution();
        this.sizeLabel.textContent = dims ? `${dims[0]} × ${dims[1]}` : 'full UI';
        if (stateChanged) {
            mState.save();
        }
    }

    /** Advanced chips: every param set by preset/reuse without a dedicated control, X-clearable. */
    renderAdvChips() {
        this.advChips.innerHTML = '';
        let keys = Object.keys(mState.params).filter(k => !this.coveredParams.includes(k));
        for (let key of keys) {
            let val = mState.params[key];
            let text = `${MCreate.paramLabel(key)}: ${MCreate.paramValueLabel(key, val)}`;
            if (text.length > 40) {
                text = text.substring(0, 38) + '…';
            }
            let chip = mUI.el('span', 'm-adv-chip', text);
            let x = mUI.el('span', 'm-adv-chip-x', '×');
            x.addEventListener('click', () => {
                delete mState.params[key];
                mState.changed();
            });
            chip.appendChild(x);
            this.advChips.appendChild(chip);
        }
        // No "Open full UI" link here - the header and the More tab both already carry one, and on a short
        // Create page it was spending a whole row on a third copy.
    }

    /** A parameter's human name, falling back to its raw id when the server did not report it. */
    static paramLabel(key) {
        let meta = mState.paramMeta[key];
        return meta && meta.name ? meta.name : key;
    }

    /** A parameter value as the server would label it. ListT2IParams splits `id///Display Name` into parallel
     * `values` and `value_names` arrays, so a chip reading 'exactbackendid: 2' can read 'Exact Backend ID:
     * 2: ComfyUI Self-Starting' instead. Falls through to the raw value for params with no name table. */
    static paramValueLabel(key, val) {
        let shown = Array.isArray(val) ? val.join(',') : `${val}`;
        let meta = mState.paramMeta[key];
        if (meta && meta.values && meta.value_names) {
            let index = meta.values.indexOf(shown);
            if (index >= 0 && meta.value_names[index]) {
                return meta.value_names[index];
            }
        }
        return shown;
    }

    /** Backend picker sheet. `exactbackendid` pins every generation to one backend, which is the point on a
     * multi-GPU box - but it is also a foot-gun, so 'Automatic' is the first row and deletes the param rather
     * than setting a sentinel value (the server treats the key's presence as the choice).
     *
     * Rows come from ListBackends, not from the param's own `values`: that list is a snapshot taken when
     * ListT2IParams was called at boot, so it goes stale the moment a backend is added or restarted, and it
     * carries no status or loaded model. paramMeta is the fallback for a session that may set the parameter
     * but lacks ViewBackendsList permission. */
    openBackendSheet() {
        let content = mUI.el('div', 'm-lora-sheet');
        content.appendChild(mUI.el('div', 'm-sheet-title', 'Backend'));
        let results = mUI.el('div', 'm-model-results');
        content.appendChild(results);
        let close = null;
        let pick = (value) => {
            if (value == null) {
                delete mState.params['exactbackendid'];
            }
            else {
                mState.params['exactbackendid'] = value;
            }
            mState.changed();
            close();
        };
        let renderRows = (backends) => {
            results.innerHTML = '';
            let auto = mUI.el('button', 'm-model-plain-row', 'Automatic (let Swarm choose)');
            if (mState.params['exactbackendid'] == null) {
                auto.classList.add('m-selected');
            }
            auto.addEventListener('click', () => pick(null));
            results.appendChild(auto);
            if (backends.length == 0) {
                results.appendChild(mUI.el('div', 'm-strip-empty', 'No backends reported.'));
                return;
            }
            for (let backend of backends) {
                let item = mUI.el('div', 'm-model-result');
                let text = mUI.el('div', 'm-model-text');
                text.appendChild(mUI.el('div', 'm-model-name', backend.label));
                if (backend.sub) {
                    text.appendChild(mUI.el('div', 'm-model-sub', backend.sub));
                }
                item.appendChild(text);
                if (`${mState.params['exactbackendid']}` == backend.id) {
                    item.classList.add('m-selected');
                }
                item.addEventListener('click', () => pick(backend.id));
                results.appendChild(item);
            }
        };
        // Fallback list, shown immediately so the sheet is never empty, then replaced by live data.
        let meta = mState.paramMeta['exactbackendid'];
        let fallback = [];
        for (let i = 0; i < ((meta && meta.values) || []).length; i++) {
            fallback.push({ 'id': meta.values[i], 'label': (meta.value_names || [])[i] || meta.values[i], 'sub': '' });
        }
        renderRows(fallback);
        genericRequest('ListBackends', { 'nonreal': false, 'full_data': true }, data => {
            let live = [];
            for (let key of Object.keys(data)) {
                let backend = data[key];
                // The response is keyed by backend id, but skip anything that is not a backend object in
                // case a top-level field is ever added alongside them.
                if (!backend || backend.id == null) {
                    continue;
                }
                let sub = `${backend.status}${backend.enabled ? '' : ', disabled'}`;
                if (backend.current_model) {
                    sub += ` - ${mUI.modelName(backend.current_model)}`;
                }
                live.push({ 'id': `${backend.id}`, 'label': `${backend.id}: ${backend.title}`, 'sub': sub });
            }
            renderRows(live);
        }, 0, () => {
            // Enrichment only. A session allowed to set the parameter but not to view the backend list is a
            // legitimate configuration, and the fallback rows above already work - so this stays silent
            // rather than throwing a toast over a sheet that is functioning.
            console.log('ListBackends unavailable - using the parameter list instead.');
        });
        close = mUI.openSheet(content);
    }

    /** Inserts text into the prompt at the remembered caret (end of prompt if there isn't one), spacing it
     * off from its neighbours without inventing punctuation. Works on mState rather than the textarea
     * because render() rewrites the box from state whenever it isn't focused - which it never is here, the
     * caller is a chip inside a bottom sheet. */
    insertIntoPrompt(text) {
        let current = `${mState.params['prompt'] || ''}`;
        let caret = this.promptCaret == null ? current.length : Math.min(this.promptCaret, current.length);
        let before = current.substring(0, caret);
        let after = current.substring(caret);
        let insert = text;
        if (before.length > 0 && !/\s$/.test(before)) {
            insert = ` ${insert}`;
        }
        if (after.length > 0 && !/^\s/.test(after)) {
            insert = `${insert} `;
        }
        mState.params['prompt'] = before + insert + after;
        this.promptCaret = (before + insert).length;
        mState.changed();
    }

    /** Inserts the `<trigger>` prompt tag, which the server expands to the trigger phrases of the current
     * model AND every active LoRA. That is the whole set in one tag, so a second copy would repeat all of
     * them - hence the guard. Inserting the tag rather than the literal phrase also means the prompt stays
     * correct when LoRAs are swapped afterwards. */
    insertTriggerTag() {
        if (`${mState.params['prompt'] || ''}`.includes('<trigger>')) {
            mUI.note('<trigger> is already in your prompt - it covers every active LoRA.');
            return;
        }
        this.insertIntoPrompt('<trigger>');
        mUI.note('Added <trigger> to the prompt.');
    }

    /** Indexes a ListModels LoRA list by both the full name and the extension-stripped form. Presets and
     * starred_models store `ill/foo`; ListModels reports `ill/foo.safetensors`. Looking up only the full
     * name left every active row as a bare stem with no title or thumbnail. */
    indexLoras(list) {
        this.loraList = list || [];
        this.loraMap = new Map();
        for (let i = 0; i < this.loraList.length; i++) {
            let model = this.loraList[i];
            this.loraMap.set(model.name, model);
            this.loraMap.set(MState.stripModelExt(model.name), model);
        }
    }

    /** The cached LoRA model object for a name, or a minimal stand-in before the list has loaded. */
    loraByName(name) {
        if (!this.loraMap) {
            return { 'name': name };
        }
        return this.loraMap.get(name) || this.loraMap.get(MState.stripModelExt(name)) || { 'name': name };
    }

    /** LoRA bottom sheet: active LoRAs with exact 0.05-step weight pickers, add-picker from ListModels. */
    openLoraSheet() {
        mState.refreshUserData();
        let content = mUI.el('div', 'm-lora-sheet');
        let renderRows;
        let listWrap = mUI.el('div', 'm-lora-rows');
        content.appendChild(listWrap);
        renderRows = () => {
            listWrap.innerHTML = '';
            let loras = mState.getLoras();
            if (loras.length == 0) {
                listWrap.appendChild(mUI.el('div', 'm-strip-empty', 'No active LoRAs.'));
            }
            for (let i = 0; i < loras.length; i++) {
                let row = mUI.el('div', 'm-lora-row');
                let top = mUI.el('div', 'm-lora-row-top');
                // Look the full model up so an active LoRA shows the same thumbnail and trigger phrase as it
                // does in the picker; falls back to a bare name until the lazy ListModels call lands.
                let model = this.loraByName(loras[i].name);
                let thumb = mUI.modelThumb(model, 'm-lora-thumb');
                if (thumb) {
                    top.appendChild(thumb);
                }
                top.appendChild(mUI.modelText(model, () => mCreate.insertTriggerTag(), true));
                let remove = mUI.el('button', 'm-lora-remove', '×');
                remove.setAttribute('aria-label', `Remove ${mUI.modelName(loras[i].name)}`);
                remove.addEventListener('click', () => {
                    let cur = mState.getLoras();
                    cur.splice(i, 1);
                    mState.setLoras(cur);
                    renderRows();
                });
                top.appendChild(remove);
                row.appendChild(top);
                let weight = mUI.el('div', 'm-lora-weight-picker');
                let minus = mUI.el('button', 'm-lora-weight-button', '−');
                minus.setAttribute('aria-label', `Decrease ${mUI.modelName(loras[i].name)} weight`);
                weight.appendChild(minus);
                let input = document.createElement('input');
                input.type = 'number';
                input.inputMode = 'decimal';
                input.min = '-2';
                input.max = '2';
                input.step = '0.05';
                input.value = `${loras[i].weight}`;
                input.className = 'm-lora-weight-input';
                input.setAttribute('aria-label', `${mUI.modelName(loras[i].name)} weight`);
                weight.appendChild(input);
                let plus = mUI.el('button', 'm-lora-weight-button', '+');
                plus.setAttribute('aria-label', `Increase ${mUI.modelName(loras[i].name)} weight`);
                weight.appendChild(plus);
                let setWeight = (value) => {
                    let next = Math.min(2, Math.max(-2, Math.round(value * 20) / 20));
                    input.value = `${parseFloat(next.toFixed(2))}`;
                    let cur = mState.getLoras();
                    cur[i].weight = next;
                    mState.setLoras(cur);
                };
                minus.addEventListener('click', () => setWeight((parseFloat(input.value) || 0) - 0.05));
                plus.addEventListener('click', () => setWeight((parseFloat(input.value) || 0) + 0.05));
                input.addEventListener('change', () => setWeight(parseFloat(input.value) || 0));
                row.appendChild(weight);
                listWrap.appendChild(row);
            }
        };
        renderRows();
        let addWrap = mUI.el('div', 'm-lora-add-wrap');
        let search = document.createElement('input');
        search.type = 'text';
        search.placeholder = 'Search LoRAs to add...';
        search.className = 'm-lora-search';
        addWrap.appendChild(search);
        let results = mUI.el('div', 'm-lora-results');
        addWrap.appendChild(results);
        let archState = { 'showAll': false };
        let renderResults = () => {
            results.innerHTML = '';
            if (!this.loraList) {
                results.appendChild(this.loraListError
                    ? this.buildRetryRow('Could not load LoRAs.', () => loadLoraList())
                    : mUI.el('div', 'm-strip-empty', 'Loading...'));
                return;
            }
            // LoRAs are filtered by the same compat classes as checkpoints, which is what compat classes are
            // for - an SDXL LoRA on a Flux checkpoint is not a near miss, it simply does not load.
            let arch = this.applyArchFilter(this.loraList, 'LoRA', archState, renderResults);
            if (arch.row) {
                results.appendChild(arch.row);
            }
            let active = new Set();
            let curLoras = mState.getLoras();
            for (let i = 0; i < curLoras.length; i++) {
                active.add(MState.stripModelExt(curLoras[i].name));
            }
            let matches = mState.starredFirst(MCreate.filterModels(arch.list, search.value).filter(m => !active.has(MState.stripModelExt(m.name))), 'LoRA');
            let shown = 0;
            for (let model of matches) {
                let item = mUI.el('div', 'm-model-result');
                let thumb = mUI.modelThumb(model, 'm-model-thumb');
                if (thumb) {
                    item.appendChild(thumb);
                }
                item.appendChild(mUI.modelText(model, null, true));
                let star = mUI.starBadge('LoRA', model.name);
                if (star) {
                    item.appendChild(star);
                }
                item.addEventListener('click', () => {
                    let cur = mState.getLoras();
                    if (!cur.some(l => MState.sameModel(l.name, model.name))) {
                        cur.push({ 'name': model.name, 'weight': model.lora_default_weight || 1 });
                        mState.setLoras(cur);
                    }
                    renderRows();
                    renderResults();
                });
                results.appendChild(item);
                if (++shown >= MCreate.ListCap) {
                    break;
                }
            }
            results.appendChild(this.buildCountRow(shown, matches.length, 'LoRAs'));
        };
        search.addEventListener('input', renderResults);
        content.appendChild(addWrap);
        let loadLoraList = () => {
            this.loraListError = false;
            renderResults();
            genericRequest('ListModels', { 'path': '', 'depth': MCreate.ListDepth, 'subtype': 'LoRA', 'sortBy': 'Name', 'allowRemote': true, 'sortReverse': false, 'dataImages': false }, data => {
                this.indexLoras(data.files || []);
                // The active rows are re-rendered too: until this lands they show a bare name, with no
                // thumbnail and no trigger phrase, because those live on the model object not in params.
                renderRows();
                renderResults();
            }, 0, err => {
                this.loraListError = true;
                renderResults();
                showError(err);
            });
        };
        if (!this.loraList) {
            loadLoraList();
        }
        renderResults();
        mUI.openSheet(content);
    }

    /** Grid-gen sheet: >=2 axes, >=2 values each ("2x2+n"); longest axis is auto-placed horizontal by
     * mGen.runGrid. Base params are the current Create state - "predetermined parameters". */
    openGridSheet() {
        if (typeof permissions != 'undefined' && permissions.hasPermission && !permissions.hasPermission('gridgen_generate_grids')) {
            mUI.warn('You do not have grid generation permission.');
            return;
        }
        let content = mUI.el('div', 'm-grid-sheet');
        content.appendChild(mUI.el('div', 'm-sheet-title', 'Grid Generate'));
        let axesWrap = mUI.el('div', 'm-grid-axes');
        content.appendChild(axesWrap);
        let axisParams = ['steps', 'cfgscale', 'seed', 'model', 'loraweights', 'prompt', 'sidelength', 'aspectratio'].filter(p => p == 'prompt' || mState.paramMeta[p]);
        let addAxis = () => {
            if (axesWrap.children.length >= 3) {
                return;
            }
            let row = mUI.el('div', 'm-grid-axis-row');
            let select = document.createElement('select');
            select.className = 'm-grid-axis-param';
            for (let p of axisParams) {
                let opt = document.createElement('option');
                opt.value = p;
                opt.textContent = p;
                select.appendChild(opt);
            }
            row.appendChild(select);
            let vals = document.createElement('input');
            vals.type = 'text';
            vals.placeholder = 'values, comma, separated';
            vals.className = 'm-grid-axis-vals';
            row.appendChild(vals);
            axesWrap.appendChild(row);
        };
        addAxis();
        addAxis();
        let addBtn = mUI.el('button', 'm-wide-button', '+ Add axis');
        addBtn.addEventListener('click', addAxis);
        content.appendChild(addBtn);
        let runBtn = mUI.el('button', 'm-generate-button m-grid-run', 'Run Grid');
        runBtn.addEventListener('click', () => {
            let axes = [];
            for (let row of axesWrap.querySelectorAll('.m-grid-axis-row')) {
                let mode = row.querySelector('.m-grid-axis-param').value;
                let vals = row.querySelector('.m-grid-axis-vals').value.trim();
                if (vals) {
                    axes.push({ 'mode': mode, 'vals': vals });
                }
            }
            if (axes.length < 2 || axes.some(a => MState.toList(a.vals).length < 2)) {
                mUI.warn('Grids need at least 2 axes with 2+ values each.');
                return;
            }
            let base = mState.buildGenInput();
            delete base['images'];
            mGen.runGrid(base, axes);
            close();
        });
        content.appendChild(runBtn);
        let close = mUI.openSheet(content);
    }

    /** Auto-grows a textarea up to ~6 lines. */
    autoGrow(box) {
        box.style.height = 'auto';
        box.style.height = `${Math.min(box.scrollHeight, 160)}px`;
    }
}

/** The size rungs the Create panel's size stepper walks. Floored at 1024 and capped at 1536: every current
 * architecture is 1024-native, the sub-1024 rungs only ever served SD1.x, and past 1536 a base generation
 * costs more than upscaling the same image would. Kept short on purpose - this is a stepper, not a list. */
MCreate.SideLengths = [1024, 1152, 1280, 1536];

mCreate = new MCreate();
