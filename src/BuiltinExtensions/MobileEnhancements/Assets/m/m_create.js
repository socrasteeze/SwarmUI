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
        /** Live preview tiles by `${request_id}_${batch_index}`. */
        this.liveTiles = {};
        /** Covered param ids that have dedicated controls (everything else renders as an Advanced chip).
         * width/height are covered because the resolution controls own them - see mState.buildGenInput. */
        this.coveredParams = ['prompt', 'negativeprompt', 'images', 'seed', 'aspectratio', 'sidelength', 'width', 'height', 'model', 'loras', 'loraweights', 'promptimages'];
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
            this.setPending(false);
        }
        if (kind == 'progress' || kind == 'image') {
            this.pending = false;
        }
    }

    /** Gets or creates a live preview tile. A new request_id clears finished tiles from older requests
     * (mirrors the genpage Batch view the fork owner uses as the real preview). */
    getLiveTile(key) {
        if (this.liveTiles[key]) {
            return this.liveTiles[key];
        }
        let requestId = key.substring(0, key.lastIndexOf('_'));
        for (let existing in this.liveTiles) {
            if (!existing.startsWith(`${requestId}_`) && this.liveTiles[existing].classList.contains('m-tile-done')) {
                this.liveTiles[existing].remove();
                delete this.liveTiles[existing];
            }
        }
        let tile = mUI.el('div', 'm-preview-cell');
        let img = document.createElement('img');
        tile.appendChild(img);
        let bar = mUI.el('div', 'm-tile-progress');
        tile.appendChild(bar);
        tile.addEventListener('click', () => {
            if (tile.dataset.url) {
                mImages.openViewer({ 'url': tile.dataset.url, 'metadata': tile.dataset.metadata, 'fullsrc': mImages.urlToPath(tile.dataset.url) });
            }
        });
        this.liveTiles[key] = tile;
        this.previewGrid.appendChild(tile);
        this.renderPreviewState();
        return tile;
    }

    /** Builds the Create panel once. */
    build(panel) {
        this.panel = panel;
        // Flex column so the generate bar's margin-top:auto can claim the leftover height when the page is
        // short; when it is tall, the bar's position:sticky takes over and it stays pinned while scrolling.
        panel.classList.add('m-create-panel');
        panel.appendChild(this.previewWrap);
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
        panel.appendChild(this.pickerRow);
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
        let genBar = mUI.el('div', 'm-gen-bar');
        this.interruptButton = mUI.el('button', 'm-interrupt-button', 'Interrupt');
        this.interruptButton.style.display = 'none';
        this.interruptButton.addEventListener('click', () => mGen.interrupt());
        genBar.appendChild(this.interruptButton);
        this.genButton = mUI.el('button', 'm-generate-button', 'Generate');
        this.wireGenerateButton();
        genBar.appendChild(this.genButton);
        panel.appendChild(genBar);
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

    /** Generate on tap; long-press (600ms) opens the grid form. */
    wireGenerateButton() {
        let holdTimer = null;
        let held = false;
        let start = () => {
            held = false;
            holdTimer = setTimeout(() => {
                held = true;
                this.openGridSheet();
            }, 600);
        };
        let cancel = () => {
            if (holdTimer) {
                clearTimeout(holdTimer);
                holdTimer = null;
            }
        };
        this.genButton.addEventListener('touchstart', start, { passive: true });
        this.genButton.addEventListener('touchend', (e) => {
            cancel();
            if (!held) {
                e.preventDefault();
                this.doGenerate();
            }
        });
        this.genButton.addEventListener('touchmove', cancel, { passive: true });
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
            mUI.note('Type a prompt or pick a preset first.');
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

    /** Preset chip strip: starred first, tap toggles, selection order preserved (merge order). */
    renderPresets() {
        this.presetStrip.innerHTML = '';
        if (mState.presets.length == 0) {
            this.presetStrip.appendChild(mUI.el('span', 'm-strip-empty', 'No presets yet - create some in the full UI.'));
            return;
        }
        let sorted = [...mState.presets].sort((a, b) => (b.is_starred ? 1 : 0) - (a.is_starred ? 1 : 0));
        for (let preset of sorted) {
            let chip = mUI.el('button', 'm-preset-chip');
            if (preset.preview_image) {
                let img = document.createElement('img');
                img.src = preset.preview_image;
                img.loading = 'lazy';
                chip.appendChild(img);
            }
            chip.appendChild(mUI.el('span', 'm-preset-chip-title', preset.title));
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
        let name = mState.params['model'];
        if (!name) {
            let fromPreset = mState.buildGenInput()['model'];
            this.modelButton.textContent = fromPreset ? `${mUI.modelName(fromPreset)} (preset)` : 'Model: default';
            this.modelButton.classList.remove('m-selected');
            return;
        }
        this.modelButton.textContent = mUI.modelName(name);
        this.modelButton.classList.add('m-selected');
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
            let shown = 0;
            for (let model of MCreate.filterModels(this.modelList, search.value)) {
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
                if (++shown >= 40) {
                    break;
                }
            }
        };
        search.addEventListener('input', renderResults);
        if (!this.modelList) {
            genericRequest('ListModels', { 'path': '', 'depth': 5, 'subtype': 'Stable-Diffusion', 'sortBy': 'Name', 'allowRemote': true, 'sortReverse': false, 'dataImages': false }, data => {
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
                mUI.note('Could not read that image\'s size.');
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
            let text = `${key}: ${Array.isArray(val) ? val.join(',') : val}`;
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
        let renderResults = () => {
            results.innerHTML = '';
            if (!this.loraList) {
                results.appendChild(mUI.el('div', 'm-strip-empty', 'Loading...'));
                return;
            }
            let active = mState.getLoras().map(l => l.name);
            let shown = 0;
            for (let model of MCreate.filterModels(this.loraList, search.value)) {
                if (active.includes(model.name)) {
                    continue;
                }
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
                if (++shown >= 30) {
                    break;
                }
            }
        };
        search.addEventListener('input', renderResults);
        content.appendChild(addWrap);
        if (!this.loraList) {
            genericRequest('ListModels', { 'path': '', 'depth': 5, 'subtype': 'LoRA', 'sortBy': 'Name', 'allowRemote': true, 'sortReverse': false, 'dataImages': false }, data => {
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
            mUI.note('You do not have grid generation permission.');
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
                mUI.note('Grids need at least 2 axes with 2+ values each.');
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
