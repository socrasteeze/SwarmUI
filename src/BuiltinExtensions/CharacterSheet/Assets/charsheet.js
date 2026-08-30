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
            used++;
        }
        if (this.info.reference_cap < this.slots.length) {
            notice.innerText = this.info.cap_reason;
        }
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
