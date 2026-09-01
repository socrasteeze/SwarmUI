/** Interrogate - turn an image into tags or a descriptive prompt.
 *
 * One registerMediaButton() call puts the entry point on every image surface at once: the button row under the
 * current image, the right-click menu on a batch thumbnail, the full-view overlay, and the Image History browser
 * popover. Adding it per-surface would mean four core-file edits for the same result.
 *
 * The image is converted to base64 in the browser rather than passing a path to the server. Both shapes reach the
 * button - a fresh generation arrives as a 'data:' URI, a history image as a URL - and converting here means one
 * code path server-side and no user-supplied path for the backend to have to validate.
 */
class InterrogateHelperClass {

    constructor() {
        /** Backend descriptors from the server, or null before the first load. */
        this.backends = null;
        /** WD14 model names reported by the connected ComfyUI backend. */
        this.wd14Models = [];
        /** Florence-2 model names reported by the connected ComfyUI backend. */
        this.florence2Models = [];
        /** The modal element, built lazily on first use. */
        this.modal = null;
        /** Source of the image currently loaded in the modal. */
        this.currentSrc = null;
        /** True while a request is in flight, to keep the Interrogate button from double-firing. */
        this.running = false;
        /** Florence-2 tasks worth offering. The node accepts more, but the rest are detection and segmentation
         * modes whose output is coordinates rather than text. */
        this.captionTasks = ['more_detailed_caption', 'detailed_caption', 'caption', 'prompt_gen_mixed_caption', 'prompt_gen_mixed_caption_plus', 'prompt_gen_tags', 'prompt_gen_analyze', 'ocr'];
    }

    /** Adds the media button. Called once at script load. */
    install() {
        if (typeof registerMediaButton != 'function') {
            console.warn('Interrogate: registerMediaButton is unavailable, the SwarmUI version may be too old.');
            return;
        }
        registerMediaButton('Interrogate', src => this.open(src), 'Generate tags or a text prompt describing this image.', ['image'], false, true);
        // Installing a node pack restarts the ComfyUI backend, which changes the feature set. Re-read the backend
        // list when that happens so an open modal switches from "not installed" to usable on its own.
        featureSetChangedCallbacks.push(() => {
            if (this.modal && this.modal.classList.contains('show')) {
                this.refreshBackends();
            }
        });
    }

    /** Reads a stored preference, falling back to a default. */
    pref(key, fallback) {
        let stored = localStorage.getItem(`interrogate_${key}`);
        return stored == null ? fallback : stored;
    }

    /** Stores a preference so the next interrogation starts where this one left off. */
    setPref(key, value) {
        localStorage.setItem(`interrogate_${key}`, value);
    }

    /** Builds the modal DOM once and appends it to the page. */
    buildModal() {
        if (this.modal) {
            return;
        }
        let modal = createDiv('interrogate_modal', 'modal');
        modal.setAttribute('tabindex', '-1');
        modal.setAttribute('role', 'dialog');
        modal.innerHTML = `
            <div class="modal-dialog modal-lg" role="document">
                <div class="modal-content interrogate-modal-content">
                    <div class="modal-header">
                        <h5 class="modal-title translate">Interrogate Image</h5>
                    </div>
                    <div class="modal-body">
                        <div class="interrogate-top-row">
                            <img class="interrogate-preview" id="interrogate_preview" alt="">
                            <div class="interrogate-controls">
                                <label class="translate" for="interrogate_backend">Method</label>
                                <select class="auto-dropdown interrogate-select" id="interrogate_backend"></select>
                                <div class="interrogate-backend-desc" id="interrogate_backend_desc"></div>
                                <div class="interrogate-tagger-options" id="interrogate_tagger_options">
                                    <label class="translate" for="interrogate_model">Tagger model</label>
                                    <select class="auto-dropdown interrogate-select" id="interrogate_model"></select>
                                    <label class="translate" for="interrogate_threshold">Tag threshold</label>
                                    <input type="number" class="auto-number interrogate-number" id="interrogate_threshold" min="0" max="1" step="0.05">
                                    <label class="translate" for="interrogate_char_threshold">Character threshold</label>
                                    <input type="number" class="auto-number interrogate-number" id="interrogate_char_threshold" min="0" max="1" step="0.05">
                                    <label class="translate" for="interrogate_exclude">Exclude tags</label>
                                    <input type="text" class="auto-text interrogate-text" id="interrogate_exclude" placeholder="comma, separated">
                                </div>
                                <div class="interrogate-caption-options" id="interrogate_caption_options">
                                    <label class="translate" for="interrogate_caption_model">Caption model</label>
                                    <select class="auto-dropdown interrogate-select" id="interrogate_caption_model"></select>
                                    <label class="translate" for="interrogate_task">Caption style</label>
                                    <select class="auto-dropdown interrogate-select" id="interrogate_task"></select>
                                </div>
                                <div class="interrogate-install" id="interrogate_install"></div>
                            </div>
                        </div>
                        <div class="interrogate-status" id="interrogate_status"></div>
                        <textarea class="auto-text interrogate-result" id="interrogate_result" rows="6" placeholder="Results appear here."></textarea>
                        <div class="interrogate-chips" id="interrogate_chips"></div>
                    </div>
                    <div class="modal-footer">
                        <button type="button" class="btn btn-primary translate" id="interrogate_run">Interrogate</button>
                        <button type="button" class="btn btn-secondary translate" id="interrogate_copy">Copy</button>
                        <button type="button" class="btn btn-secondary translate" id="interrogate_to_prompt">Send To Prompt</button>
                        <button type="button" class="btn btn-secondary translate" id="interrogate_add_prompt">Add To Prompt</button>
                        <button type="button" class="btn btn-secondary translate" id="interrogate_to_negative">Send To Negative</button>
                        <button type="button" class="btn btn-secondary translate" data-bs-dismiss="modal">Close</button>
                    </div>
                </div>
            </div>`;
        document.body.appendChild(modal);
        this.modal = modal;
        getRequiredElementById('interrogate_run').addEventListener('click', () => this.run());
        getRequiredElementById('interrogate_copy').addEventListener('click', () => this.copyResult());
        getRequiredElementById('interrogate_to_prompt').addEventListener('click', () => this.sendToBox('alt_prompt_textbox', false));
        getRequiredElementById('interrogate_add_prompt').addEventListener('click', () => this.sendToBox('alt_prompt_textbox', true));
        getRequiredElementById('interrogate_to_negative').addEventListener('click', () => this.sendToBox('alt_negativeprompt_textbox', false));
        getRequiredElementById('interrogate_backend').addEventListener('change', () => {
            this.setPref('backend', getRequiredElementById('interrogate_backend').value);
            this.syncBackendUI();
        });
        getRequiredElementById('interrogate_result').addEventListener('change', () => this.renderChips());
        let taskSelect = getRequiredElementById('interrogate_task');
        for (let task of this.captionTasks) {
            let option = document.createElement('option');
            option.value = task;
            option.innerText = task.replaceAll('_', ' ');
            taskSelect.appendChild(option);
        }
    }

    /** Opens the modal for one image. */
    open(src) {
        this.buildModal();
        this.currentSrc = src;
        // Reset the in-flight lock on every open, so a request that died without ever calling back - a failed
        // image fetch, a dropped socket - cannot leave the button permanently dead.
        this.running = false;
        getRequiredElementById('interrogate_preview').src = src;
        getRequiredElementById('interrogate_result').value = '';
        getRequiredElementById('interrogate_chips').innerHTML = '';
        this.setStatus('');
        this.fillOptionDefaults();
        $('#interrogate_modal').modal('show');
        this.refreshBackends();
    }

    /** Resets the tagger/caption option fields (threshold, character threshold, exclude tags, caption task) to
     * their stored preferences. Split out of open() so a headless caller that built the modal DOM itself (eg
     * Character Sheet's "Analyze pose" button, via buildModal()) can get the same defaults without opening the
     * modal UI. */
    fillOptionDefaults() {
        getRequiredElementById('interrogate_threshold').value = this.pref('threshold', '0.35');
        getRequiredElementById('interrogate_char_threshold').value = this.pref('char_threshold', '0.85');
        getRequiredElementById('interrogate_exclude').value = this.pref('exclude', '');
        getRequiredElementById('interrogate_task').value = this.pref('task', 'more_detailed_caption');
    }

    /** Fills a select with options, preserving a stored choice when it is still offered. */
    fillSelect(selectId, values, prefKey) {
        let select = getRequiredElementById(selectId);
        let preferred = this.pref(prefKey, null);
        select.innerHTML = '';
        for (let value of values) {
            let option = document.createElement('option');
            option.value = value;
            option.innerText = value;
            select.appendChild(option);
        }
        if (preferred && values.includes(preferred)) {
            select.value = preferred;
        }
    }

    /** Loads the backend list from the server and rebuilds the dropdowns.
     * @param callback optional, called once the list and dropdowns are ready - lets another extension (eg
     * Character Sheet's "Analyze pose" button) wait for the backend list before calling selectedBackend().
     * @param errorCallback optional, called with an error message if the request fails - without it, a failure
     * falls back to genericRequest's own default of a showError toast with no further callback.
     * @param timeoutMs optional XHR timeout in milliseconds, forwarded to genericRequest (0 = no timeout). */
    refreshBackends(callback = null, errorCallback = null, timeoutMs = 0) {
        genericRequest('ListInterrogateBackends', {}, data => {
            this.backends = data.backends;
            this.wd14Models = data.wd14_models || [];
            this.florence2Models = data.florence2_models || [];
            let select = getRequiredElementById('interrogate_backend');
            let preferred = this.pref('backend', null);
            select.innerHTML = '';
            for (let backend of this.backends) {
                let option = document.createElement('option');
                option.value = backend.id;
                option.innerText = backend.available ? backend.display : `${backend.display} (not installed)`;
                select.appendChild(option);
            }
            let available = this.backends.filter(b => b.available);
            select.value = preferred && this.backends.some(b => b.id == preferred) ? preferred : (available.length > 0 ? available[0].id : (this.backends.length > 0 ? this.backends[0].id : ''));
            this.fillSelect('interrogate_model', this.wd14Models, 'model');
            this.fillSelect('interrogate_caption_model', this.florence2Models, 'caption_model');
            this.syncBackendUI();
            if (callback) {
                callback();
            }
        }, 0, errorCallback, timeoutMs);
    }

    /** Returns the descriptor for the currently selected backend, or null. */
    selectedBackend() {
        if (!this.backends) {
            return null;
        }
        let id = getRequiredElementById('interrogate_backend').value;
        return this.backends.find(b => b.id == id) || null;
    }

    /** Shows or hides the per-backend controls and the install prompt to match the current selection. */
    syncBackendUI() {
        let backend = this.selectedBackend();
        let desc = getRequiredElementById('interrogate_backend_desc');
        let install = getRequiredElementById('interrogate_install');
        let taggerOptions = getRequiredElementById('interrogate_tagger_options');
        let captionOptions = getRequiredElementById('interrogate_caption_options');
        let runButton = getRequiredElementById('interrogate_run');
        install.innerHTML = '';
        if (!backend) {
            desc.innerText = 'No interrogation methods are registered.';
            taggerOptions.style.display = 'none';
            captionOptions.style.display = 'none';
            runButton.disabled = true;
            return;
        }
        desc.innerText = backend.description;
        taggerOptions.style.display = backend.output_kind == 'tags' ? '' : 'none';
        captionOptions.style.display = backend.output_kind == 'prose' ? '' : 'none';
        runButton.disabled = !backend.available;
        if (!backend.available) {
            if (backend.install_feature) {
                install.innerHTML = `<button class="basic-button" onclick="installFeatureById('${escapeHtmlNoBr(backend.install_feature)}')">Install ${escapeHtmlNoBr(backend.display)}</button>`;
            }
            else {
                install.innerText = 'The ComfyUI nodes for this method are not installed.';
            }
        }
    }

    /** Writes a line into the status area. */
    setStatus(text) {
        getRequiredElementById('interrogate_status').innerText = text;
    }

    /** Collects the options blob for the selected backend. */
    gatherOptions(backend) {
        if (backend.output_kind == 'prose') {
            let options = {
                'model': getRequiredElementById('interrogate_caption_model').value,
                'task': getRequiredElementById('interrogate_task').value
            };
            this.setPref('caption_model', options.model);
            this.setPref('task', options.task);
            return options;
        }
        let options = {
            'model': getRequiredElementById('interrogate_model').value,
            'threshold': parseFloat(getRequiredElementById('interrogate_threshold').value),
            'character_threshold': parseFloat(getRequiredElementById('interrogate_char_threshold').value),
            'exclude_tags': getRequiredElementById('interrogate_exclude').value
        };
        this.setPref('model', options.model);
        this.setPref('threshold', options.threshold);
        this.setPref('char_threshold', options.character_threshold);
        this.setPref('exclude', options.exclude_tags);
        return options;
    }

    /** Runs the interrogation for the loaded image. */
    run() {
        if (this.running) {
            return;
        }
        let backend = this.selectedBackend();
        if (!backend || !backend.available) {
            return;
        }
        let options = this.gatherOptions(backend);
        this.running = true;
        this.setStatus('Preparing image...');
        this.withImageData(this.currentSrc, imageData => {
            // The first run of a given model also downloads it, which can take minutes with no other feedback,
            // so say so up front rather than looking hung.
            this.setStatus('Interrogating - the first run of a model also downloads it, which can take a while...');
            this.interrogate(imageData, backend.id, options, data => {
                if (data.result != null) {
                    this.running = false;
                    this.setStatus('Done.');
                    getRequiredElementById('interrogate_result').value = data.result;
                    this.renderChips();
                }
                else if (data.overall_percent != null) {
                    this.setStatus(`Working... ${Math.round(data.overall_percent * 100)}%`);
                }
            }, error => {
                this.running = false;
                this.setStatus('');
                showError(error);
            });
        });
    }

    /** Sends one interrogation request for already-resolved image data, without touching the modal UI or
     * `running`/status state - the shared entry point behind run(), and available headlessly to other extensions
     * that want a result without opening the Interrogate modal (eg Character Sheet's "Analyze pose" button).
     * <p>Also guards the one failure makeWSRequest doesn't: a socket that closes without ever sending a result
     * or error frame (a server-side fault mid-job) would otherwise leave the caller waiting forever, so onError
     * is called once with a fixed message if that happens - applies equally to run() and to any other caller.</p>
     * @param imageData full `data:` URI for the image to interrogate.
     * @param backendId ID of the backend to use, from ListInterrogateBackends / this.backends.
     * @param options backend-specific options object, from gatherOptions().
     * @param onFrame called with every non-error frame from the server - a `result` frame is the terminal one,
     * an `overall_percent` frame is progress.
     * @param onError called with an error message if the request fails, or if the socket closes with no result.
     * @returns the underlying WebSocket, or undefined if it could not be opened. */
    interrogate(imageData, backendId, options, onFrame, onError) {
        let settled = false;
        let socket = makeWSRequest('InterrogateImage', { 'image': imageData, 'backend': backendId, 'options': JSON.stringify(options) }, data => {
            if (data.result != null) {
                settled = true;
            }
            onFrame(data);
        }, 0, error => {
            settled = true;
            onError(error);
        });
        if (socket) {
            socket.addEventListener('close', () => {
                if (!settled) {
                    settled = true;
                    onError('The interrogation connection closed with no result. Check the server logs.');
                }
            });
        }
        return socket;
    }

    /** Resolves any image source to a data URI, fetching it first when it is a URL. */
    withImageData(src, callback) {
        if (src.startsWith('data:')) {
            callback(src);
            return;
        }
        toDataURL(src, dataUrl => callback(dataUrl));
    }

    /** Looks one tag up in TagDex, returning its record or null.
     * Matching goes through TagDex's own substring index and then filters to an exact name hit, since the index
     * has no exact-lookup entry point and rebuilding one here would duplicate its storage format. */
    tagDexLookup(tag) {
        if (typeof tagDexCore == 'undefined' || tagDexCore.status != 'ready') {
            return null;
        }
        let query = tag.trim().toLowerCase().replaceAll(' ', '_');
        if (query.length < 2) {
            return null;
        }
        let hits = tagDexCore.match(query);
        for (let i = 0; i < hits.length; i++) {
            let record = tagDexCore.recordAt(hits[i]);
            if (record.name.toLowerCase() == query) {
                return record;
            }
        }
        return null;
    }

    /** Renders the result as clickable chips, highlighting any that TagDex recognises as a character or artist.
     * Only meaningful for comma-separated tag output; prose captions get no chips. */
    renderChips() {
        let backend = this.selectedBackend();
        let container = getRequiredElementById('interrogate_chips');
        container.innerHTML = '';
        if (!backend || backend.output_kind != 'tags') {
            return;
        }
        let text = getRequiredElementById('interrogate_result').value;
        let tags = text.split(',').map(t => t.trim()).filter(t => t.length > 0);
        if (tags.length == 0) {
            return;
        }
        let build = () => {
            container.innerHTML = '';
            for (let tag of tags) {
                let record = this.tagDexLookup(tag);
                let chip = createDiv(null, record ? `interrogate-chip interrogate-chip-known tag-type-${record.tagType}` : 'interrogate-chip');
                chip.innerText = tag;
                chip.title = record ? `${record.trigger}${record.copyright ? ` (${record.copyright.replaceAll('_', ' ')})` : ''} - click to remove` : 'Click to remove';
                chip.addEventListener('click', () => {
                    tags = tags.filter(t => t != tag);
                    getRequiredElementById('interrogate_result').value = tags.join(', ');
                    build();
                });
                container.appendChild(chip);
            }
        };
        build();
        // TagDex loads its index lazily, so a first-run interrogation usually renders before the index is ready.
        // Ask it to load and repaint once it is, rather than showing every tag as unknown forever.
        if (typeof tagDexCore != 'undefined' && tagDexCore.status != 'ready') {
            tagDexCore.ensureLoaded(() => build());
        }
    }

    /** Copies the current result to the clipboard. */
    copyResult() {
        let text = getRequiredElementById('interrogate_result').value;
        if (!text) {
            return;
        }
        navigator.clipboard.writeText(text);
        this.setStatus('Copied.');
    }

    /** Sends the result to a prompt box, either replacing its contents or appending to them. */
    sendToBox(boxId, append) {
        let text = getRequiredElementById('interrogate_result').value.trim();
        if (!text) {
            return;
        }
        let box = document.getElementById(boxId);
        if (!box) {
            showError('That prompt box is not available on this page.');
            return;
        }
        if (append && box.value.trim()) {
            box.value = `${box.value.trim()}, ${text}`;
        }
        else {
            box.value = text;
        }
        triggerChangeFor(box);
        $('#interrogate_modal').modal('hide');
    }
}

interrogateHelper = new InterrogateHelperClass();
interrogateHelper.install();
