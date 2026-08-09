/** MobileEnhancements standalone client - Create tab: live preview, preset strip, model picker, prompt +
 * prompt-image strip, quick params, LoRA sheet, advanced chips, generate bar, grid form. All state lives in
 * mState; this file is DOM. The live batch preview lives here rather than on the Images tab so that
 * generating never navigates away from the prompt box - mImages owns history plus the shared viewer. */
class MCreate {

    constructor() {
        /** Cached LoRA model list from ListModels (fetched lazily on first sheet open). */
        this.loraList = null;
        /** Cached checkpoint list from ListModels (fetched lazily on first model sheet open). */
        this.modelList = null;
        /** Live preview tiles by `${request_id}_${batch_index}`. Only ever one batch's worth. */
        this.liveTiles = {};
        /** Request id currently on display; a different one wipes the preview. */
        this.currentRequest = null;
        /** [{url, metadata}] of the last batch that actually finished, for the cancelled-batch fallback. */
        this.lastCompleted = [];
        /** Covered param ids that have dedicated controls (everything else renders as an Advanced chip).
         * width/height are covered because the resolution controls own them - see mState.buildGenInput. */
        this.coveredParams = ['prompt', 'negativeprompt', 'images', 'seed', 'aspectratio', 'sidelength', 'width', 'height', 'model', 'loras', 'loraweights', 'promptimages', 'filenameprefix'];
        /** Whether the user has manually collapsed the preview. */
        this.previewCollapsed = localStorage.getItem('m_client_preview_collapsed') == 'yes';
        // The preview is built here, detached, rather than in build(). Generation frames can arrive before
        // the Create panel has ever been built (deep-link to #models, then generate), and a tile handler
        // that assumed its container existed is exactly the crash this ordering avoids.
        this.buildPreview();
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
        // Shown from the instant Generate is tapped until the first frame lands. Queueing behind a loading
        // model can take a while, and without this the whole screen sits unchanged - indistinguishable from
        // a button that did nothing.
        this.previewPending = mUI.el('div', 'm-preview-pending');
        this.previewPending.appendChild(mUI.el('div', 'm-preview-pending-label', 'Queued...'));
        this.previewPending.appendChild(mUI.el('div', 'm-preview-pending-bar'));
        this.previewWrap.appendChild(this.previewPending);
        this.pending = false;
        this.renderPreviewState();
    }

    /** Marks a batch as requested; cleared by the first frame or by a failure. */
    setPending(pending) {
        this.pending = pending;
        this.renderPreviewState();
    }

    /** Syncs the preview's collapsed/empty/pending classes and the toggle glyph. */
    renderPreviewState() {
        let count = Object.keys(this.liveTiles).length;
        this.previewWrap.classList.toggle('m-preview-empty', count == 0 && !this.pending);
        this.previewPending.style.display = this.pending && count == 0 ? '' : 'none';
        this.previewWrap.classList.toggle('m-preview-collapsed', this.previewCollapsed);
        this.previewToggle.textContent = this.previewCollapsed ? '▾ Preview' : '▴ Preview';
        this.previewGrid.style.gridTemplateColumns = `repeat(${count > 1 ? 2 : 1}, 1fr)`;
        this.previewGrid.style.setProperty('--m-preview-cell-h', count > 1 ? '19dvh' : '38dvh');
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
            tile.classList.add('m-tile-done');
            tile.querySelector('.m-tile-progress').style.width = '';
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
                snapshot.push({ 'url': tile.dataset.url, 'metadata': tile.dataset.metadata || '' });
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
            tile.classList.add('m-tile-done');
            this.liveTiles[`restored_${i}`] = tile;
            this.previewGrid.appendChild(tile);
        }
    }

    /** One preview cell: image, progress bar, tap-to-open in the shared viewer. */
    buildTile() {
        let tile = mUI.el('div', 'm-preview-cell');
        tile.appendChild(document.createElement('img'));
        tile.appendChild(mUI.el('div', 'm-tile-progress'));
        tile.addEventListener('click', () => {
            if (tile.dataset.url) {
                mImages.openViewer({ 'url': tile.dataset.url, 'metadata': tile.dataset.metadata, 'fullsrc': mImages.urlToPath(tile.dataset.url) });
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
        this.panel = panel;
        // Flex column so children keep their natural height rather than being shrunk to fit (see m.css).
        panel.classList.add('m-create-panel');
        panel.appendChild(this.previewWrap);
        this.archRow = mUI.el('div', 'm-arch-row');
        this.archSelect = mUI.el('select', 'm-arch-select');
        this.archSelect.addEventListener('change', () => {
            mState.archFilter = this.archSelect.value;
            mState.changed();
        });
        this.archRow.appendChild(this.archSelect);
        panel.appendChild(this.archRow);
        this.presetStrip = mUI.el('div', 'm-preset-strip');
        panel.appendChild(this.presetStrip);
        // Model and LoRAs share one row: two taps that open two sheets, no reason to spend two rows on them.
        this.pickerRow = mUI.el('div', 'm-picker-row');
        this.modelButton = mUI.el('button', 'm-picker-button m-model-button');
        this.modelButton.addEventListener('click', () => this.openModelSheet());
        this.pickerRow.appendChild(this.modelButton);
        this.loraButton = mUI.el('button', 'm-picker-button');
        this.loraButton.addEventListener('click', () => this.openLoraSheet());
        this.pickerRow.appendChild(this.loraButton);
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
     * filter naming a group that no longer exists falls back to "all" rather than showing an empty strip. */
    renderArch() {
        let groups = mState.presetGroups();
        if (groups.length < 2) {
            this.archRow.style.display = 'none';
            return;
        }
        this.archRow.style.display = '';
        if (mState.archFilter && !groups.includes(mState.archFilter)) {
            mState.archFilter = '';
        }
        this.archSelect.innerHTML = '';
        let all = document.createElement('option');
        all.value = '';
        all.textContent = 'All architectures';
        this.archSelect.appendChild(all);
        for (let group of groups) {
            let option = document.createElement('option');
            option.value = group;
            option.textContent = group;
            this.archSelect.appendChild(option);
        }
        this.archSelect.value = mState.archFilter;
    }

    /** Preset chip strip: starred first, tap toggles, selection order preserved (merge order). */
    renderPresets() {
        this.presetStrip.innerHTML = '';
        if (mState.presets.length == 0) {
            this.presetStrip.appendChild(mUI.el('span', 'm-strip-empty', 'No presets yet - create some in the full UI.'));
            return;
        }
        // An ACTIVE preset always shows, even when the architecture filter would hide it. Filtering it out
        // of the strip would not deactivate it - it would keep merging into every generation with no chip
        // left on screen to tap off, which is a trap rather than a filter.
        let visible = mState.presets.filter(preset => !mState.archFilter
            || MState.presetGroup(preset.title) == mState.archFilter
            || mState.activePresets.includes(preset.title));
        if (visible.length == 0) {
            this.presetStrip.appendChild(mUI.el('span', 'm-strip-empty', `No presets under "${mState.archFilter}".`));
            return;
        }
        let sorted = [...visible].sort((a, b) => (b.is_starred ? 1 : 0) - (a.is_starred ? 1 : 0));
        for (let preset of sorted) {
            let chip = mUI.el('button', 'm-preset-chip');
            if (preset.preview_image) {
                let img = document.createElement('img');
                img.src = preset.preview_image;
                img.loading = 'lazy';
                chip.appendChild(img);
            }
            // With a group selected the folder prefix is the same on every visible chip, so it is spending
            // scarce chip width to say nothing. Under "all" it is the only architecture cue there is.
            let label = preset.title;
            if (mState.archFilter && label.startsWith(`${mState.archFilter}/`)) {
                label = label.substring(mState.archFilter.length + 1);
            }
            chip.appendChild(mUI.el('span', 'm-preset-chip-title', label));
            chip.classList.toggle('m-selected', mState.activePresets.includes(preset.title));
            chip.addEventListener('click', () => {
                let idx = mState.activePresets.indexOf(preset.title);
                if (idx == -1) {
                    mState.activePresets.push(preset.title);
                }
                else {
                    mState.activePresets.splice(idx, 1);
                }
                mState.changed();
            });
            this.presetStrip.appendChild(chip);
        }
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

    /** Search filter shared by both pickers: matches the file name, the folder path, the metadata title,
     * and the trigger phrase, so a LoRA can be found by the word you actually type into prompts. */
    static filterModels(list, term) {
        let low = `${term || ''}`.toLowerCase().trim();
        if (!low) {
            return list;
        }
        return list.filter(model => `${model.name || ''} ${model.title || ''} ${model.trigger_phrase || ''}`.toLowerCase().includes(low));
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
                results.appendChild(mUI.el('div', 'm-strip-empty', 'Loading...'));
                return;
            }
            let arch = this.applyArchFilter(this.modelList, 'Stable-Diffusion', archState, renderResults);
            if (arch.row) {
                results.appendChild(arch.row);
            }
            let matches = MCreate.filterModels(arch.list, search.value);
            let shown = 0;
            for (let model of matches) {
                let item = mUI.el('div', 'm-model-result');
                let thumb = mUI.modelThumb(model, 'm-model-thumb');
                if (thumb) {
                    item.appendChild(thumb);
                }
                item.appendChild(mUI.modelText(model, null));
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
        if (!this.modelList) {
            genericRequest('ListModels', { 'path': '', 'depth': MCreate.ListDepth, 'subtype': 'Stable-Diffusion', 'sortBy': 'Name', 'allowRemote': true, 'sortReverse': false, 'dataImages': false }, data => {
                this.modelList = data.files || [];
                renderResults();
            });
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
            let remove = mUI.el('span', 'm-image-tile-remove', '×');
            remove.addEventListener('click', () => {
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
        tile.addEventListener('touchstart', (e) => {
            armTimer = setTimeout(() => {
                dragging = true;
                tile.classList.add('m-dragging');
            }, 150);
        }, { passive: true });
        tile.addEventListener('touchmove', (e) => {
            if (!dragging) {
                if (armTimer) {
                    clearTimeout(armTimer);
                    armTimer = null;
                }
                return;
            }
            e.preventDefault();
            let x = e.touches.item(0).clientX;
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

    /** Clipboard paste: image items become prompt images (the user's screenshot-paste flow). */
    onPaste(e) {
        let items = (e.clipboardData || {}).items || [];
        let found = false;
        for (let item of items) {
            if (item.type && item.type.startsWith('image/')) {
                found = true;
                this.addImageFile(item.getAsFile());
            }
        }
        if (found) {
            e.preventDefault();
        }
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

    /** Quick params row: seed lock + value, images count, aspect ratio, side length, resolution readout. */
    buildQuickParams() {
        let wrap = mUI.el('div', 'm-quick-wrap');
        let row = mUI.el('div', 'm-quick-row');
        let seedWrap = mUI.el('div', 'm-quick-item');
        this.seedLock = mUI.el('button', 'm-seed-lock');
        this.seedLock.addEventListener('click', () => {
            mState.seedLocked = !mState.seedLocked;
            if (mState.seedLocked && (!mState.params['seed'] || `${mState.params['seed']}` == '-1')) {
                mState.params['seed'] = `${Math.floor(Math.random() * 2147483647)}`;
            }
            mState.changed();
        });
        seedWrap.appendChild(this.seedLock);
        this.seedInput = document.createElement('input');
        this.seedInput.type = 'text';
        this.seedInput.inputMode = 'numeric';
        this.seedInput.className = 'm-seed-input';
        this.seedInput.addEventListener('input', () => {
            mState.params['seed'] = this.seedInput.value;
            mState.save();
        });
        seedWrap.appendChild(this.seedInput);
        row.appendChild(seedWrap);
        this.imagesGroup = mUI.el('div', 'm-quick-item m-seg-group');
        for (let n of ['1', '2', '4']) {
            let btn = mUI.el('button', 'm-seg-button', n);
            btn.dataset.count = n;
            btn.addEventListener('click', () => {
                mState.params['images'] = n;
                mState.changed();
            });
            this.imagesGroup.appendChild(btn);
        }
        row.appendChild(this.imagesGroup);
        wrap.appendChild(row);
        let resRow = mUI.el('div', 'm-quick-row');
        this.aspectSelect = document.createElement('select');
        this.aspectSelect.className = 'm-aspect-select';
        this.aspectSelect.addEventListener('change', () => {
            mState.params['aspectratio'] = this.aspectSelect.value;
            // Picking from the list replaces any image-matched ratio: choosing 'Custom' by hand means
            // "leave width/height alone", not "keep scaling the ratio I matched earlier".
            mState.customRatio = 0;
            mState.changed();
        });
        resRow.appendChild(this.aspectSelect);
        this.sizeSelect = document.createElement('select');
        this.sizeSelect.className = 'm-size-select';
        this.sizeSelect.addEventListener('change', () => {
            // Empty string, not delete: '' means "the user chose Auto", absent means "never set", and only
            // the latter gets seeded to 1024. Deleting here would make Auto snap straight back to 1024.
            mState.params['sidelength'] = this.sizeSelect.value;
            mState.changed();
        });
        resRow.appendChild(this.sizeSelect);
        wrap.appendChild(resRow);
        this.resReadout = mUI.el('div', 'm-res-readout');
        wrap.appendChild(this.resReadout);
        // Filename prefix: a label for the saved file's name, not a generation parameter. Server-side it is
        // inserted at the start of the filename whatever outpath format is active, so it survives presets.
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
        return wrap;
    }

    /** Syncs the quick-param controls from state. */
    renderQuickParams() {
        this.seedLock.textContent = mState.seedLocked ? '🔒' : '🎲';
        this.seedLock.classList.toggle('m-selected', mState.seedLocked);
        if (document.activeElement != this.seedInput) {
            this.seedInput.value = mState.seedLocked ? `${mState.params['seed'] ?? ''}` : '-1';
        }
        this.seedInput.disabled = !mState.seedLocked;
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
        let aspectMeta = mState.paramMeta['aspectratio'];
        let serverValues = aspectMeta && aspectMeta.values ? aspectMeta.values : ['1:1', '4:3', '3:2', '16:9', '2:3', '9:16', 'Custom'];
        // Server ratios first, then the fork-added ones, with Custom kept last as the manual escape hatch.
        let values = serverValues.filter(v => v != 'Custom').concat(Object.keys(MState.ExtraAspects)).concat(['Custom']);
        if (this.aspectSelect.options.length != values.length) {
            this.aspectSelect.innerHTML = '';
            for (let v of values) {
                let opt = document.createElement('option');
                opt.value = v;
                opt.textContent = v;
                this.aspectSelect.appendChild(opt);
            }
        }
        // Seed the state from the shown default rather than leaving it unset: an absent aspectratio is not
        // the same as the displayed one, and the difference is invisible - the picker would read "1:1"
        // while the server fell through to its raw width/height defaults.
        if (!mState.params['aspectratio']) {
            mState.params['aspectratio'] = aspectMeta && aspectMeta.default ? aspectMeta.default : '1:1';
            mState.save();
        }
        this.aspectSelect.value = mState.params['aspectratio'];
        this.renderSizeSelect();
    }

    /** Side-length ladder plus the live width x height readout. A ladder rather than the desktop's
     * 32-step slider: every value anyone actually uses is on it, and each entry is a thumb-sized target. */
    renderSizeSelect() {
        let meta = mState.paramMeta['sidelength'];
        // Floor at 1024 regardless of what the parameter allows: every current architecture is a 1024-native
        // model, and the sub-1024 rungs only existed to serve SD1.x. Auto still reports a model's real native
        // size if that model happens to be smaller - that's better information, not a rung on this ladder.
        let min = Math.max(1024, meta && meta.min ? meta.min : 0);
        let max = meta && meta.max ? meta.max : 16384;
        let ladder = [1024, 1152, 1280, 1408, 1536, 1792, 2048].filter(v => v >= min && v <= max);
        // A stored side length below the new floor (or off the ladder entirely) is carried as its own option
        // rather than silently snapping - reusing params from an old image must reproduce that image.
        let stored = parseInt(mState.params['sidelength']) || 0;
        if (stored && !ladder.includes(stored)) {
            ladder = [...ladder, stored].sort((a, b) => a - b);
        }
        if (this.sizeSelect.options.length != ladder.length + 1) {
            this.sizeSelect.innerHTML = '';
            for (let v of ladder) {
                let opt = document.createElement('option');
                opt.value = `${v}`;
                opt.textContent = `${v}px`;
                this.sizeSelect.appendChild(opt);
            }
            let auto = document.createElement('option');
            auto.value = '';
            auto.textContent = 'Auto (model native)';
            this.sizeSelect.appendChild(auto);
        }
        // Seeded rather than left blank so the default is a concrete, visible 1024 instead of an "Auto" that
        // resolves somewhere else - a Qwen checkpoint's native size is 1328, which is not what you expect to
        // get from a control showing no number.
        if (!mState.params['sidelength'] && mState.params['sidelength'] !== '') {
            mState.params['sidelength'] = `${ladder.includes(1024) ? 1024 : ladder[0]}`;
            mState.save();
        }
        this.sizeSelect.value = `${mState.params['sidelength']}`;
        // The size only stops applying when there is no ratio at all to scale - ie 'Custom' picked by hand
        // with no image-matched ratio behind it. A matched ratio, however odd, still scales with the length.
        let aspect = this.aspectSelect.value;
        let hasRatio = MState.AspectReferences[aspect] || MState.ExtraAspects[aspect] || (aspect == 'Custom' && mState.customRatio);
        this.sizeSelect.disabled = !hasRatio;
        let res = mState.previewResolution();
        if (!hasRatio) {
            this.resReadout.textContent = res ? `Custom ${res[0]} × ${res[1]} — set width/height in the full UI` : 'Custom — set width/height in the full UI';
            return;
        }
        let label = aspect == 'Custom' && mState.customRatio ? 'matched to image' : aspect;
        this.resReadout.textContent = res ? `${res[0]} × ${res[1]} (${label})` : '';
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

    /** The cached LoRA model object for a name, or a minimal stand-in before the list has loaded. */
    loraByName(name) {
        for (let model of (this.loraList || [])) {
            if (model.name == name) {
                return model;
            }
        }
        return { 'name': name };
    }

    /** LoRA bottom sheet: active LoRAs with weight sliders, add-picker from ListModels. */
    openLoraSheet() {
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
                top.appendChild(mUI.modelText(model, () => mCreate.insertTriggerTag()));
                let readout = mUI.el('span', 'm-lora-weight-readout', `${loras[i].weight}`);
                top.appendChild(readout);
                let remove = mUI.el('span', 'm-lora-remove', '×');
                remove.addEventListener('click', () => {
                    let cur = mState.getLoras();
                    cur.splice(i, 1);
                    mState.setLoras(cur);
                    renderRows();
                });
                top.appendChild(remove);
                row.appendChild(top);
                let slider = document.createElement('input');
                slider.type = 'range';
                slider.min = '-2';
                slider.max = '2';
                slider.step = '0.05';
                slider.value = `${loras[i].weight}`;
                slider.className = 'm-lora-slider';
                slider.addEventListener('input', () => {
                    readout.textContent = slider.value;
                    let cur = mState.getLoras();
                    cur[i].weight = parseFloat(slider.value);
                    mState.setLoras(cur);
                });
                row.appendChild(slider);
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
                results.appendChild(mUI.el('div', 'm-strip-empty', 'Loading...'));
                return;
            }
            // LoRAs are filtered by the same compat classes as checkpoints, which is what compat classes are
            // for - an SDXL LoRA on a Flux checkpoint is not a near miss, it simply does not load.
            let arch = this.applyArchFilter(this.loraList, 'LoRA', archState, renderResults);
            if (arch.row) {
                results.appendChild(arch.row);
            }
            let active = mState.getLoras().map(l => l.name);
            let matches = MCreate.filterModels(arch.list, search.value).filter(m => !active.includes(m.name));
            let shown = 0;
            for (let model of matches) {
                let item = mUI.el('div', 'm-model-result');
                let thumb = mUI.modelThumb(model, 'm-model-thumb');
                if (thumb) {
                    item.appendChild(thumb);
                }
                item.appendChild(mUI.modelText(model, null));
                item.addEventListener('click', () => {
                    let cur = mState.getLoras();
                    cur.push({ 'name': model.name, 'weight': model.lora_default_weight || 1 });
                    mState.setLoras(cur);
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
        if (!this.loraList) {
            genericRequest('ListModels', { 'path': '', 'depth': MCreate.ListDepth, 'subtype': 'LoRA', 'sortBy': 'Name', 'allowRemote': true, 'sortReverse': false, 'dataImages': false }, data => {
                this.loraList = data.files || [];
                // The active rows are re-rendered too: until this lands they show a bare name, with no
                // thumbnail and no trigger phrase, because those live on the model object not in params.
                renderRows();
                renderResults();
            });
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

mCreate = new MCreate();
