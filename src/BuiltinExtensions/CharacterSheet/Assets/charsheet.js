/** Character Sheet - build a multi-view reference sheet from a few reference images.
 *
 * Lives in the Tools panel and takes over the main Generate button while selected, the same way the Image Edit
 * Batcher does. That means it inherits the whole parameter panel - model, resolution, steps, sampler, LoRAs -
 * instead of duplicating any of it, and only adds the controls that are actually specific to sheets.
 *
 * Reference slots adapt to the loaded model. The families differ in how many reference images they will accept
 * (Qwen Image Edit Plus hard-stops at three, MiniMax H3 takes nine), so the server is asked what the current model
 * supports rather than the UI guessing.
 */
class CharacterSheetToolClass {

    constructor() {
        /** The tool's root div, set at registration. */
        this.mainDiv = null;
        /** Server-reported capabilities for the current model, or null before the first query. */
        this.info = null;
        /** Reference slot definitions, in the order they are handed to the model. */
        this.slots = [
            { role: 'face', label: 'Face / Identity', hint: 'Who the character is: face, hair, build. This is the identity source.' },
            { role: 'outfit', label: 'Outfit', hint: 'What they wear. Crop below the neck - a visible face here tends to override the identity reference.' },
            { role: 'pose', label: 'Pose (optional)', hint: 'A pose to echo in the first extra panel.' },
            { role: 'prop', label: 'Prop (optional)', hint: 'An item for the character to hold. Props often repeat across panels - ask for one and you may get three.' },
            { role: 'environment', label: 'Environment (optional)', hint: 'A setting to place the character in.' }
        ];
        /** Incremented on every "Analyze pose" click, so a stale in-flight request's callbacks can tell they
         * were superseded by a newer click and skip acting - see analyzePose(). */
        this.analyzeRequestId = 0;
    }

    /** Reads the reference images the user has loaded, in slot order, skipping empty slots. */
    gatherReferences() {
        let references = [];
        for (let slot of this.slots) {
            let elem = document.getElementById(`charsheet_ref_${slot.role}`);
            if (elem && elem.dataset.filedata) {
                references.push({ 'role': slot.role, 'image': elem.dataset.filedata });
            }
        }
        return references;
    }

    /** Reads the selected view keys in the catalogue's own order, so the sheet always reads front-to-back. */
    gatherViews() {
        if (!this.info) {
            return [];
        }
        let views = [];
        for (let view of this.info.views) {
            let box = document.getElementById(`charsheet_view_${view.key}`);
            if (box && box.checked) {
                views.push(view.key);
            }
        }
        return views;
    }

    /** Fires the sheet build. */
    doGenerate() {
        let views = this.gatherViews();
        let extras = getRequiredElementById('charsheet_extra_panels').value;
        if (views.length == 0 && !extras.trim()) {
            showError('Pick at least one view, or write an extra panel request.');
            return;
        }
        let references = this.gatherReferences();
        if (references.length == 0) {
            showError('Load at least a face reference image.');
            return;
        }
        resetBatchIfNeeded();
        let inData = {
            'baseParams': getGenInput(),
            'references': references,
            'views': views.join(','),
            'mode': getRequiredElementById('charsheet_mode').value,
            'layout': getRequiredElementById('charsheet_layout').value,
            'extraPanels': extras,
            'labelPanels': getRequiredElementById('charsheet_label_panels').checked,
            'sheetPrompt': getRequiredElementById('charsheet_extra_prompt').value,
            'savePanels': getRequiredElementById('charsheet_save_panels').checked
        };
        let timeLastGenHit = [Date.now()];
        let images = {};
        let discardable = {};
        makeWSRequestT2I('CharacterSheetRun', inData, data => {
            if (data.warning) {
                // Reference-drop and partial-failure notices are advisory: the sheet still arrives, so report them
                // without aborting the run the way showError would imply.
                console.warn(`Character Sheet: ${data.warning}`);
                getRequiredElementById('charsheet_notice').innerText = data.warning;
                return;
            }
            mainGenHandler.internalHandleData(data, images, discardable, timeLastGenHit, inData.baseParams, null, null, false);
        });
    }

    /** Asks the server what the currently selected model supports, and adapts the slots to match. */
    refreshInfo() {
        let modelElem = document.getElementById('current_model');
        genericRequest('CharacterSheetInfo', { 'model': modelElem ? modelElem.value : '' }, data => {
            let firstLoad = this.info == null;
            this.info = data;
            if (firstLoad) {
                this.buildViewList();
            }
            this.syncSlots();
            if (firstLoad) {
                getRequiredElementById('charsheet_mode').value = data.prefers_one_shot ? 'one_shot' : 'per_panel';
            }
        });
    }

    /** Builds the view checkbox row once, from the server's catalogue. */
    buildViewList() {
        let container = getRequiredElementById('charsheet_views');
        container.innerHTML = '';
        let defaults = ['front', 'side', 'back'];
        for (let view of this.info.views) {
            let wrapper = createDiv(null, 'charsheet-view-toggle');
            wrapper.innerHTML = `<input type="checkbox" id="charsheet_view_${escapeHtmlNoBr(view.key)}"${defaults.includes(view.key) ? ' checked' : ''}> <label for="charsheet_view_${escapeHtmlNoBr(view.key)}">${escapeHtmlNoBr(view.label)}</label>`;
            container.appendChild(wrapper);
        }
    }

    /** Greys out reference slots the current model cannot use, and explains why. */
    syncSlots() {
        let engineLine = getRequiredElementById('charsheet_engine');
        engineLine.innerText = `Model family: ${this.info.engine_display} - up to ${this.info.reference_cap} reference image${this.info.reference_cap == 1 ? '' : 's'}.`;
        let notice = getRequiredElementById('charsheet_notice');
        notice.innerText = '';
        let used = 0;
        for (let slot of this.slots) {
            let elem = document.getElementById(`charsheet_ref_${slot.role}`);
            if (!elem) {
                continue;
            }
            let box = findParentOfClass(elem, 'auto-input');
            let overCap = used >= this.info.reference_cap;
            if (box) {
                box.classList.toggle('charsheet-slot-disabled', overCap);
                box.title = overCap ? this.info.cap_reason : slot.hint;
            }
            // Deliberately not touched here: the Analyze pose button. Interrogation reads the pose slot's image
            // directly and has nothing to do with how many references the sheet model accepts, so it stays
            // enabled purely on "a pose image is loaded and no request is in flight" - see setupAnalyzePose()
            // and setAnalyzeButtonBusy().
            used++;
        }
        if (this.info.reference_cap < this.slots.length) {
            notice.innerText = this.info.cap_reason;
        }
    }

    /** Returns the HTML for the "Analyze pose" button, or an empty string if the Interrogate extension is not
     * present. Only meaningful for the pose slot. */
    buildAnalyzePoseButtonHtml() {
        if (typeof interrogateHelper == 'undefined') {
            return '';
        }
        return '<button type="button" class="basic-button charsheet-analyze-pose-button translate" id="charsheet_analyze_pose_button" title="Run this pose image through the Interrogate tool\'s currently selected backend, and add the result to Extra Panels." style="display: none;">Analyze pose</button>';
    }

    /** Wires the Analyze pose button, if it was rendered, to show only while the pose slot has an image loaded
     * and to run the analysis on click. No-op if the Interrogate extension is not present. */
    setupAnalyzePose() {
        if (typeof interrogateHelper == 'undefined') {
            return;
        }
        let poseInput = document.getElementById('charsheet_ref_pose');
        let button = document.getElementById('charsheet_analyze_pose_button');
        if (!poseInput || !button) {
            return;
        }
        let syncVisibility = () => {
            button.style.display = poseInput.dataset.filedata ? '' : 'none';
        };
        // 'change' fires on this element from both setMediaFileDirect and clearMediaFileInput, so this catches
        // upload, paste, input-browser selection, and the remove button.
        poseInput.addEventListener('change', syncVisibility);
        syncVisibility();
        button.addEventListener('click', () => this.analyzePose(button, poseInput));
    }

    /** Toggles the Analyze pose button's busy state. Gating is deliberately just this plus visibility
     * (setupAnalyzePose's syncVisibility) - see the note in syncSlots(). */
    setAnalyzeButtonBusy(button, busy) {
        button.classList.toggle('charsheet-analyze-busy', busy);
        button.disabled = busy;
        button.innerText = translate(busy ? 'Analyzing...' : 'Analyze pose');
    }

    /** Resolves the pose slot's raw `dataset.filedata` to a full `data:` URI, handling every shape it can take:
     * an already-resolved `data:` URI (the common case - upload, paste, or drag-drop all land here directly, see
     * setMediaFileDirect() in site.js), a bare server-relative path such as `inputs/...` (the Input Browser
     * "Select" button - see setInputFile() in site.js, which stores `file.name` verbatim with no host or
     * prefix), or a plain URL.
     * <p>Implemented directly against XMLHttpRequest rather than reusing util.js's toDataURL()/imageToData():
     * neither checks the HTTP status, so a 404 for a stale server path would otherwise be base64'd and sent as
     * if it were image data; neither has a timeout, so a hung request would never call back; and imageToData()
     * only adds the `getImageOutPrefix()` prefix for an `inputs/...` path specifically, not the `raw/...` or
     * `Starred/...` paths `isValidMediaPath()` also accepts (see the same full-prefix pattern in params.js's
     * `setDirectParamValue`).</p>
     * @param src raw `dataset.filedata` value.
     * @param callback called with a full `data:` URI on success.
     * @param onError called with an error message on failure. */
    resolvePoseImageData(src, callback, onError) {
        if (src.startsWith('data:')) {
            callback(src);
            return;
        }
        let url = isValidMediaPath(src) ? `${getImageOutPrefix()}/${src}` : src;
        let xhr = new XMLHttpRequest();
        xhr.open('GET', url);
        xhr.responseType = 'blob';
        xhr.timeout = 15000;
        xhr.onload = () => {
            if (xhr.status < 200 || xhr.status >= 300) {
                onError(`Could not load the pose image (HTTP ${xhr.status}).`);
                return;
            }
            let reader = new FileReader();
            // onload, not onloadend - onloadend also fires after a failed read, which would call both callback()
            // and (below) onError() for the same failure.
            reader.onload = () => callback(reader.result);
            reader.onerror = () => onError('Could not read the pose image data.');
            reader.readAsDataURL(xhr.response);
        };
        xhr.onerror = () => onError('Could not load the pose image (network error).');
        xhr.ontimeout = () => onError('Timed out loading the pose image.');
        xhr.send();
    }

    /** Appends one line of text to the Extra Panels box, without touching whatever is already there.
     * Collapses any internal line breaks first - CharacterSheetAPI.cs splits Extra Panels on '\n' into one panel
     * request per line, and some Interrogate outputs (eg the 'ocr' caption task) are naturally multi-line, which
     * would otherwise silently turn one result into several unrelated panel requests. */
    appendToExtraPanels(text) {
        let trimmed = `${text}`.replace(/\r/g, '').split('\n').map(line => line.trim()).filter(line => line.length > 0).join(', ');
        if (!trimmed) {
            return;
        }
        let box = getRequiredElementById('charsheet_extra_panels');
        box.value = box.value.length > 0 ? `${box.value}\n${trimmed}` : trimmed;
        triggerChangeFor(box);
    }

    /** Runs the pose reference image through the Interrogate extension's currently selected backend, then
     * appends the resulting tags or caption to the Extra Panels box. Reuses the Interrogate helper singleton's
     * own headless entry points (interrogate(), fillOptionDefaults(), selectedBackend(), gatherOptions()) rather
     * than duplicating its WS handling or driving its modal DOM by hand.
     * <p>Deliberately does not touch `interrogateHelper.running` - that flag is Interrogate's own re-entrancy
     * guard for its "Interrogate" button, and setting it from outside would make that button silently do nothing
     * if clicked while this button's request is in flight, with no feedback. A concurrent request against the
     * same backend is just extra load, not a correctness problem, so it is left alone.</p>
     * <p>Every step that can stall without ever calling back - the backend list load, and the pose image fetch -
     * is bounded by a timeout with an error callback, and every callback checks a per-call request ID before
     * touching the button or Extra Panels, so a superseded or very-late callback can never clobber a newer
     * click's state or double-append a result. The pose slot's `dataset.filedata` is re-read right before the
     * fetch, not captured once at the top, so clearing the slot mid-request is caught instead of analyzing a
     * stale image.</p> */
    analyzePose(button, poseInput) {
        if (typeof interrogateHelper == 'undefined') {
            return;
        }
        if (!poseInput.dataset.filedata) {
            showError('Load a pose reference image first.');
            return;
        }
        this.analyzeRequestId++;
        let requestId = this.analyzeRequestId;
        // True only while this call is still the most recent one and nothing has settled it yet - checked before
        // every side effect below so a superseded or already-finished call can never double-fire showError,
        // double-append a result, or clobber a newer request's busy state.
        let stillPending = () => requestId == this.analyzeRequestId && button.classList.contains('charsheet-analyze-busy');
        let finish = (resultText, errorText) => {
            if (!stillPending()) {
                return;
            }
            this.setAnalyzeButtonBusy(button, false);
            if (resultText != null) {
                this.appendToExtraPanels(resultText);
            }
            else {
                showError(errorText);
            }
        };
        this.setAnalyzeButtonBusy(button, true);
        // Builds the (hidden) Interrogate modal DOM if it does not exist yet - idempotent, and required before
        // refreshBackends()/gatherOptions() can touch its elements.
        let modalIsFresh = !interrogateHelper.modal;
        interrogateHelper.buildModal();
        if (modalIsFresh) {
            // Matches what open() does for a fresh modal. If the modal already existed, its fields are left as
            // they are - including a field the user deliberately left blank - rather than overwritten here.
            interrogateHelper.fillOptionDefaults();
        }
        let proceed = () => {
            if (!stillPending()) {
                return;
            }
            let backend = interrogateHelper.selectedBackend();
            if (!backend) {
                finish(null, 'No interrogation backend is registered.');
                return;
            }
            if (!backend.available) {
                finish(null, `The '${backend.display}' interrogation backend is not installed.`);
                return;
            }
            let options = interrogateHelper.gatherOptions(backend);
            // Re-read the slot at fire time, not the value captured when the button was clicked - the backend
            // list load above can take a while, and the user may have cleared the Pose slot in the meantime.
            let currentSrc = poseInput.dataset.filedata;
            if (!currentSrc) {
                finish(null, 'The pose image was cleared before the request could start.');
                return;
            }
            this.resolvePoseImageData(currentSrc, imageData => {
                if (!stillPending()) {
                    return;
                }
                // interrogate() itself covers the case of a socket that closes with no result or error frame -
                // no separate handling needed here for that.
                interrogateHelper.interrogate(imageData, backend.id, options, data => {
                    if (data.result == null) {
                        // Intermediate 'overall_percent' frames are ignored here - only the final result matters
                        // for this button, unlike the Interrogate modal's own progress display.
                        return;
                    }
                    let trimmedResult = `${data.result}`.trim();
                    if (trimmedResult) {
                        finish(data.result, null);
                    }
                    else {
                        finish(null, backend.output_kind == 'prose' ? 'The backend returned no caption.' : 'The backend returned no tags.');
                    }
                }, error => finish(null, error));
            }, error => finish(null, error));
        };
        // Refreshed on every click, not just once - it's one cheap request, and it means a node pack installed
        // since the last click (which changes backend availability) is picked up without ever opening the
        // Interrogate modal, the only other place this list gets reloaded. genericRequest's ajax-level failure
        // path (network error / XHR timeout) passes the raw ProgressEvent/TimeoutEvent, not a string, so that
        // is coerced to a fixed message here rather than handed to showError as-is.
        interrogateHelper.refreshBackends(proceed, error => finish(null, typeof error == 'string' ? error : 'Could not load the Interrogate backend list.'), 15000);
    }

    /** Registers the tool and builds its panel. */
    register() {
        let doGenWrapper = () => {
            currentModelHelper.ensureCurrentModel(() => {
                if (document.getElementById('current_model').value == '') {
                    showError('Cannot build a character sheet, no model selected.');
                    return;
                }
                this.doGenerate();
            });
        };
        this.mainDiv = registerNewTool('character_sheet', 'Character Sheet', 'Build Sheet', doGenWrapper);
        let slotHtml = '';
        for (let slot of this.slots) {
            slotHtml += makeImageInput(null, `charsheet_ref_${slot.role}`, '', slot.label, slot.hint, false, true, true, true);
            if (slot.role == 'pose') {
                slotHtml += this.buildAnalyzePoseButtonHtml();
            }
        }
        this.mainDiv.innerHTML = `<span class="translate hoverable-minor-hint-text">Builds a multi-view character reference sheet from your reference images, then composites the panels into one image. Uses the model, resolution and sampler settings from the parameter panel - a wide resolution suits a multi-view sheet better than a square one.</span>
            <div class="charsheet-engine" id="charsheet_engine"></div>
            <div class="charsheet-notice" id="charsheet_notice"></div>
            <div class="charsheet-slots">${slotHtml}</div>
            <div class="charsheet-section-title translate">Views</div>
            <div class="charsheet-views" id="charsheet_views"></div>`
            + makeDropdownInput(null, 'charsheet_mode', '', 'Mode', 'One-shot puts every view in a single generation, which keeps them consistent with each other. Per-panel generates each view separately, which works on any edit model and lets you redo one bad panel.', ['one_shot', 'per_panel'], 'one_shot', false, true, ['One-shot (all views in one image)', 'Per-panel (one generation per view)'])
            + makeDropdownInput(null, 'charsheet_layout', '', 'Layout', 'How the finished panels are arranged.', ['sheet16x9', 'row', 'grid2x2', 'tall_left', 'wide_top'], 'sheet16x9', false, true, ['16:9 sheet', 'Single row', '2x2 grid', 'Tall left + two right (3 panels)', 'Wide top + two below (3 panels)'])
            + makeTextInput(null, 'charsheet_extra_prompt', '', 'Extra Prompt', 'Appended to every panel prompt. Use it for style, or to correct the build.', '', 'normal', 'Example: slender adult build, narrower shoulders, anime style', false, true, true)
            + makeTextInput(null, 'charsheet_extra_panels', '', 'Extra Panels', 'One request per line. Each line becomes its own extra panel on the sheet.', '', 'big', 'jump while aiming the water gun\nlow stance, holding the weapon with both hands', false, true, true)
            + makeCheckboxInput(null, 'charsheet_label_panels', '', 'Label Panels', 'Whether to caption each panel on the finished sheet.', true, false, true, true)
            + makeCheckboxInput(null, 'charsheet_save_panels', '', 'Save Individual Panels', 'Whether to also save each panel to image history, not just the finished sheet.', false, false, true, true);
        this.setupAnalyzePose();
        this.refreshInfo();
        this.mainDiv.addEventListener('tool-opened', () => this.refreshInfo());
        // The reference cap and the sensible default mode both depend on the model, so re-ask whenever it changes.
        let modelElem = document.getElementById('current_model');
        if (modelElem) {
            modelElem.addEventListener('change', () => {
                if (toolSelector.value == 'character_sheet') {
                    this.refreshInfo();
                }
            });
        }
        // Deliberately no revisionRevealerSources hook here. The Image Batcher reveals the Image Prompting group
        // because it feeds the prompt-box image channel; this tool has its own reference slots and passes them
        // through directly, so opening that group would only imply a second place to put reference images.
    }
}

characterSheetTool = new CharacterSheetToolClass();
sessionReadyCallbacks.push(() => {
    characterSheetTool.register();
});
