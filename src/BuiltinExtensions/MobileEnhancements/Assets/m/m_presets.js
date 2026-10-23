/** MobileEnhancements standalone client - preset editor.
 *
 * The Create tab could select presets but never change one: every edit meant opening the classic UI on a
 * desktop. This is the missing half - create, rename, retitle, re-describe, star, set an output root,
 * edit the parameter map, duplicate and delete - reached from More > Presets rather than from the Create tab, because it is a
 * management surface rather than part of the generate flow.
 *
 * Server-side this is entirely the existing routes (AddNewPreset with is_edit, DuplicatePreset,
 * DeletePreset). Nothing here needs a new API.
 *
 * The parameter map is edited as labelled rows: dropdowns when ListT2IParams ships `values` (and a fixed
 * scale picklist for Refiner/SeedVR upscale), free text otherwise. A preset can carry any parameter the
 * server knows, including ones this client has no dedicated Create control for - those stay free text so
 * nothing is silently dropped on save. */
class MPresets {

    /** Parameters never captured by "Use current Create settings".
     *
     * These describe the run rather than the look: the batch size, which backend to pin to, and the prompt
     * images attached to this one generation. Baking any of them into a preset means every later use of it
     * silently inherits a choice that had nothing to do with the preset. Everything else - including the
     * seed, which is occasionally wanted - is captured, and can be removed by hand in the editor. */
    static Uncaptured = ['images', 'exactbackendid', 'promptimages', 'initimage', 'videoendimage',
        'controlnetimageinput', 'controlnettwoimageinput', 'controlnetthreeimageinput', 'session_id'];

    /** How many rows the parameter picker renders at once. Truncation is reported rather than silent. */
    static PickerLimit = 60;

    /** Replaces each run of title whitespace with one underscore while preserving folder slashes. */
    static normalizeTitle(title) {
        return `${title || ''}`.replace(/\s+/g, '_');
    }

    /** Image To Video parameters shown in the preset editor's Video section, with suggested starting values from the
     * H3 docs. This client's Create tab has no video controls, so a preset is the only way to set them here. A null
     * value means "the FL2VA model if one is listed". The frame images (Init Image, Video End Image) are images, not
     * text, so they cannot live in this editor. */
    static FL2VAParams = [
        ['videomodel', null],
        ['videoframes', '124'],
        ['videosteps', '20'],
        ['videocfg', '1'],
        ['videofps', '24'],
        ['initimagecreativity', '0'],
        ['audiosilentprefixduration', '0.1'],
        ['h3memmlpmemory', 'auto']
    ];

    /** Prompt, then negative prompt, then every other key in its existing order.
     * `keys` is already sorted by the caller. Video keys are filtered out before this and stay in the
     * video section. */
    static orderPromptFirst(keys) {
        let rest = [];
        let prompt = false;
        let negative = false;
        for (let i = 0; i < keys.length; i++) {
            if (keys[i] == 'prompt') {
                prompt = true;
            }
            else if (keys[i] == 'negativeprompt') {
                negative = true;
            }
            else {
                rest.push(keys[i]);
            }
        }
        let ordered = [];
        if (prompt) {
            ordered.push('prompt');
        }
        if (negative) {
            ordered.push('negativeprompt');
        }
        for (let i = 0; i < rest.length; i++) {
            ordered.push(rest[i]);
        }
        return ordered;
    }

    /** When a label-sorted list already places prompt and negative prompt next to each other, put prompt first. */
    static preferAdjacentPrompt(keys) {
        let promptAt = keys.indexOf('prompt');
        let negativeAt = keys.indexOf('negativeprompt');
        if (promptAt >= 0 && negativeAt == promptAt - 1) {
            keys[negativeAt] = 'prompt';
            keys[promptAt] = 'negativeprompt';
        }
        return keys;
    }

    /** Registers the More-tab entry. Called at script load: registerMoreItem's contract is that every
     * registration happens before m_app.js builds that tab. */
    install() {
        if (typeof mUI == 'undefined' || !mUI.registerMoreItem) {
            return;
        }
        mUI.registerMoreItem('Presets', () => this.openManager());
    }

    /** Whether the session may add/edit/delete presets. Checked at click rather than at build, matching the
     * TagDex sheet and the restart row: hasPermission() fails OPEN before the session lands, so a check made
     * while the More tab was built by a #more deep link would be answered before there was an answer. */
    canManage() {
        return typeof permissions == 'undefined' || !permissions.hasPermission
            || permissions.hasPermission('manage_presets');
    }

    /** Refetches presets, updates the shared state so the Create tab's picklist follows, then calls back.
     * Deliberately not mState.refreshUserData(): that is throttled to one call per 10s, which is exactly the
     * window an edit lands in - the sheet would redraw from the copy it just replaced. */
    reload(after) {
        genericRequest('GetMyUserData', { 'includeAutocompletions': false }, data => {
            mState.presets = data.presets || [];
            mState.starredModels = data.starred_models || {};
            // A deleted or renamed preset that is still selected would otherwise stay in the merge list
            // forever, where buildGenInput silently skips it while the Create tab counts it as active.
            let titles = mState.presets.map(preset => preset.title);
            mState.activePresets = mState.activePresets.filter(title => titles.includes(title));
            if (mState.control?.selection.startsWith('preset:') && !titles.includes(mState.control.selection.substring(7))) {
                mState.control.selection = 'off';
            }
            mState.changed();
            if (after) {
                after();
            }
        }, 0, error => mUI.warn(`Could not reload presets: ${error}`));
    }

    /** The preset list. Rows open the editor; the button above them starts a new preset from whatever the
     * Create tab currently has set. */
    openManager() {
        let content = mUI.el('div', 'm-preset-sheet');
        content.appendChild(mUI.el('div', 'm-sheet-title', 'Presets'));
        let newButton = mUI.el('button', 'm-preset-new-button', 'New Preset');
        newButton.addEventListener('click', () => {
            if (!this.canManage()) {
                mUI.warn('You do not have permission to manage presets.');
                return;
            }
            this.openEditor(null, () => render());
        });
        content.appendChild(newButton);
        if (typeof MControlNet != 'undefined') {
            let newControl = mUI.el('button', 'm-preset-new-button', 'New Control Preset');
            newControl.addEventListener('click', () => {
                if (this.canManage()) {
                    this.openEditor(null, () => render(), 'control');
                }
                else {
                    mUI.warn('You do not have permission to manage presets.');
                }
            });
            content.appendChild(newControl);
        }
        let search = mUI.el('input', 'm-preset-search');
        search.type = 'search';
        search.placeholder = 'Search presets';
        content.appendChild(search);
        let results = mUI.el('div', 'm-preset-results');
        content.appendChild(results);
        let render = () => {
            results.innerHTML = '';
            let term = search.value.trim().toLowerCase();
            let list = mState.presets.filter(preset => !term
                || `${preset.title} ${preset.description || ''}`.toLowerCase().includes(term));
            // Starred first, then by title, matching the Create tab's picklist so one preset sits in the same
            // relative place on both surfaces.
            list = [...list].sort((a, b) => {
                if (!!a.is_starred != !!b.is_starred) {
                    return a.is_starred ? -1 : 1;
                }
                return `${a.title}`.localeCompare(`${b.title}`);
            });
            if (list.length == 0) {
                results.appendChild(mUI.el('div', 'm-strip-empty', mState.presets.length == 0
                    ? 'No presets yet.' : 'No presets match that search.'));
                return;
            }
            for (let preset of list) {
                let row = mUI.el('button', 'm-preset-row-item');
                let text = mUI.el('span', 'm-preset-row-text');
                text.appendChild(mUI.el('span', 'm-preset-row-name',
                    `${preset.is_starred ? '\u2605 ' : ''}${preset.title}`));
                let count = Object.keys(preset.param_map || {}).length;
                text.appendChild(mUI.el('span', 'm-preset-row-sub', preset.description
                    ? `${preset.description}` : `${count} parameter${count == 1 ? '' : 's'}`));
                row.appendChild(text);
                row.addEventListener('click', () => {
                    if (!this.canManage()) {
                        mUI.warn('You do not have permission to manage presets.');
                        return;
                    }
                    this.openEditor(preset, () => render());
                });
                results.appendChild(row);
            }
        };
        search.addEventListener('input', () => render());
        render();
        // Presets can be changed from the classic UI or another device, so the list is re-fetched on open
        // rather than trusted from boot. Rendered first, so the sheet is never briefly empty.
        this.reload(() => render());
        return mUI.openSheet(content);
    }

    /** The editor for one preset. `preset` null means a new one seeded from the Create tab's settings.
     * `onSaved` re-renders whatever opened this. */
    openEditor(preset, onSaved, kind = 'generation') {
        let controlOnly = kind == 'control' || (typeof MControlNet != 'undefined' && MControlNet.isPreset(preset));
        let working = {};
        if (preset) {
            for (let key in (preset.param_map || {})) {
                working[key] = `${preset.param_map[key]}`;
            }
        }
        else {
            working = controlOnly ? MControlNet.settings(mControlNet.config(mState.mergedParams()).values) : this.captureCurrent();
        }
        let original = { ...working };
        let content = mUI.el('div', 'm-preset-sheet');
        content.appendChild(mUI.el('div', 'm-sheet-title', controlOnly ? 'Control Preset' : (preset ? 'Edit Preset' : 'New Preset')));
        content.appendChild(mUI.el('div', 'm-preset-label', 'Title'));
        let titleInput = mUI.el('input', 'm-preset-field');
        titleInput.type = 'text';
        titleInput.placeholder = controlOnly ? 'ControlNet/Anima/Pose' : 'Anima/Portrait';
        titleInput.value = preset ? preset.title : '';
        let composingTitle = false;
        /** Normalizes direct edits without moving the current selection. */
        let normalizeTitleInput = () => {
            let start = titleInput.selectionStart;
            let end = titleInput.selectionEnd;
            let direction = titleInput.selectionDirection;
            let value = titleInput.value;
            let normalized = value.trim() ? MPresets.normalizeTitle(value) : '';
            if (normalized == value) {
                return;
            }
            let normalizedStart = MPresets.normalizeTitle(value.substring(0, start)).length;
            let normalizedEnd = MPresets.normalizeTitle(value.substring(0, end)).length;
            titleInput.value = normalized;
            titleInput.setSelectionRange(normalizedStart, normalizedEnd, direction);
        };
        titleInput.addEventListener('compositionstart', () => {
            composingTitle = true;
        });
        titleInput.addEventListener('compositionend', () => {
            composingTitle = false;
            normalizeTitleInput();
        });
        titleInput.addEventListener('input', () => {
            if (!composingTitle) {
                normalizeTitleInput();
            }
        });
        content.appendChild(titleInput);
        content.appendChild(mUI.el('div', 'm-preset-label', 'Description'));
        let descInput = mUI.el('input', 'm-preset-field');
        descInput.type = 'text';
        descInput.placeholder = 'Optional';
        descInput.value = preset ? (preset.description || '') : '';
        content.appendChild(descInput);
        content.appendChild(mUI.el('div', 'm-preset-label', 'Output Root'));
        let rootInput = mUI.el('input', 'm-preset-field');
        rootInput.type = 'text';
        rootInput.autocomplete = 'off';
        rootInput.spellcheck = false;
        rootInput.placeholder = 'Blank uses the server output folder';
        rootInput.value = preset ? (preset.output_root || '') : '';
        content.appendChild(rootInput);
        let starred = preset ? !!preset.is_starred : false;
        let starButton = mUI.el('button', 'm-preset-star-toggle');
        let renderStar = () => {
            starButton.textContent = starred ? '\u2605 Starred' : '\u2606 Not starred';
            starButton.setAttribute('aria-pressed', `${starred}`);
        };
        renderStar();
        starButton.addEventListener('click', () => {
            starred = !starred;
            renderStar();
        });
        content.appendChild(starButton);
        content.appendChild(mUI.el('div', 'm-preset-label', 'Parameters'));
        let paramList = mUI.el('div', 'm-preset-params');
        content.appendChild(paramList);
        let videoSection = mUI.el('details', 'm-preset-video');
        videoSection.appendChild(mUI.el('summary', 'm-preset-label', 'Video (MiniMax H3 FL2VA)'));
        let videoList = mUI.el('div', 'm-preset-video-params');
        videoSection.appendChild(videoList);
        let videoKeys = MPresets.FL2VAParams.map(([key]) => key).filter(key => mState.paramMeta[key]);
        videoSection.open = videoKeys.some(key => key in working);
        let renderVideo = () => {
            let oldFields = videoList.querySelectorAll('.m-preset-textarea');
            for (let i = 0; i < oldFields.length; i++) {
                if (oldFields[i].mRelease) {
                    oldFields[i].mRelease();
                }
            }
            videoList.innerHTML = '';
            for (let key of videoKeys) {
                let row = mUI.el('div', 'm-preset-param-row');
                let label = mUI.el('div', 'm-preset-param-label', MCreate.paramLabel(key));
                label.title = key;
                row.appendChild(label);
                let valueWrap = mUI.el('div', 'm-preset-param-value');
                // An empty field is not saved, so the section never adds anything the user did not type.
                valueWrap.appendChild(this.buildParamValueControl(key, working, {
                    'allowEmpty': true,
                    'placeholder': this.fl2vaSuggestion(key)
                }));
                row.appendChild(valueWrap);
                videoList.appendChild(row);
            }
        };
        let renderParams = () => {
            let oldFields = paramList.querySelectorAll('.m-preset-textarea');
            for (let i = 0; i < oldFields.length; i++) {
                if (oldFields[i].mRelease) {
                    oldFields[i].mRelease();
                }
            }
            paramList.innerHTML = '';
            renderVideo();
            let compat = mState.compatClassOf('Stable-Diffusion', working.model || mState.mergedParams().model);
            let structuredControl = typeof MControlNet != 'undefined' && (controlOnly || `${compat}`.startsWith('anima'));
            videoSection.hidden = controlOnly || (`${compat}`.startsWith('anima') && !videoKeys.some(key => key in working));
            let keys = MPresets.orderPromptFirst(Object.keys(working).filter(key => !videoKeys.includes(key)
                && !(structuredControl && MControlNet.Keys.includes(key))).sort());
            let groups = {};
            let groupFor = (key) => {
                let name = MPresets.groupFor(key);
                if (!groups[name]) {
                    let group = mUI.el('details', 'm-preset-section');
                    group.open = true;
                    group.appendChild(mUI.el('summary', 'm-preset-label', name));
                    groups[name] = group;
                }
                return groups[name];
            };
            if (Object.keys(working).length == 0) {
                paramList.appendChild(mUI.el('div', 'm-strip-empty',
                    'No parameters. A preset with none does nothing.'));
            }
            for (let key of keys) {
                let row = mUI.el('div', 'm-preset-param-row');
                let label = mUI.el('div', 'm-preset-param-label', MCreate.paramLabel(key));
                // The raw id is what the server stores and what any other editor shows, so it stays reachable
                // rather than being replaced outright by the display name.
                label.title = key;
                row.appendChild(label);
                let valueWrap = mUI.el('div', 'm-preset-param-value');
                valueWrap.appendChild(this.buildParamValueControl(key, working, { 'onChanged': key == 'model' ? renderParams : null }));
                let remove = mUI.el('button', 'm-preset-param-remove', '×');
                remove.setAttribute('aria-label', `Remove ${MCreate.paramLabel(key)}`);
                remove.addEventListener('click', () => {
                    delete working[key];
                    renderParams();
                });
                valueWrap.appendChild(remove);
                row.appendChild(valueWrap);
                groupFor(key).appendChild(row);
            }
            for (let name of ['Model', 'Prompts', 'LoRAs', 'Sampling', 'Resolution', 'Upscale', 'ControlNet', 'Advanced']) {
                if (groups[name]) {
                    paramList.appendChild(groups[name]);
                }
            }
            if (structuredControl) {
                paramList.appendChild(this.buildControlFields(working, controlOnly));
            }
            requestAnimationFrame(() => {
                let areas = paramList.querySelectorAll('.m-preset-textarea');
                for (let i = 0; i < areas.length; i++) {
                    if (areas[i].mGrow) {
                        areas[i].mGrow();
                    }
                }
            });
        };
        content.appendChild(videoSection);
        renderParams();
        let paramActions = mUI.el('div', 'm-preset-param-actions');
        let addCurrent = mUI.el('button', 'm-preset-small-button', 'Capture Settings');
        addCurrent.addEventListener('click', () => {
            this.openCapture(working, renderParams, controlOnly);
        });
        paramActions.appendChild(addCurrent);
        let addOne = mUI.el('button', 'm-preset-small-button', 'Add Parameter');
        addOne.addEventListener('click', () => this.openParamPicker(working, () => renderParams(), controlOnly));
        paramActions.appendChild(addOne);
        content.appendChild(paramActions);
        let actions = mUI.el('div', 'm-edit-actions');
        let cancel = mUI.el('button', 'm-edit-cancel-button', 'Cancel');
        cancel.addEventListener('click', () => close());
        actions.appendChild(cancel);
        let save = mUI.el('button', 'm-edit-save-button', 'Save');
        save.addEventListener('click', () => {
            let title = MPresets.normalizeTitle(titleInput.value.trim());
            titleInput.value = title;
            if (!title) {
                mUI.warn('A preset needs a title.');
                return;
            }
            if (controlOnly && !/^controlnet\//i.test(title)) {
                mUI.warn('Control preset titles must start with ControlNet/.');
                return;
            }
            if (!controlOnly && typeof MControlNet != 'undefined' && MControlNet.isPreset({ title })) {
                mUI.warn('Use New Control Preset to create a control-only preset.');
                return;
            }
            let controlChanged = typeof MControlNet != 'undefined' && MControlNet.Keys.some(key => working[key] != original[key]);
            if (controlOnly || controlChanged) {
                let error = this.validateControl(working, controlOnly);
                if (error) {
                    mUI.warn(error);
                    return;
                }
            }
            save.disabled = true;
            let payload = {
                'title': title,
                'description': descInput.value.trim(),
                'param_map': working,
                'is_starred': starred,
                'is_edit': !!preset,
                'output_root': rootInput.value.trim()
            };
            if (preset) {
                payload['editing'] = preset.title;
            }
            // preview_image is deliberately absent. The list copy of it is a /ViewSpecial/Preset/<title> URL,
            // which AddNewPreset rejects by design, and omitting the field is what makes the server keep the
            // image the preset already has (its blank-and-existing fallback) - including through a rename.
            genericRequest('AddNewPreset', payload, data => {
                save.disabled = false;
                if (data.preset_fail) {
                    mUI.warn(data.preset_fail);
                    return;
                }
                // A rename has to carry the active selection with it, or the preset stays switched on under a
                // title that no longer exists and quietly stops applying to generations.
                if (preset && preset.title != title) {
                    let idx = mState.activePresets.indexOf(preset.title);
                    if (idx >= 0) {
                        mState.activePresets[idx] = title;
                    }
                    if (mState.control?.selection == `preset:${preset.title}`) {
                        mState.control.selection = `preset:${title}`;
                    }
                }
                mUI.note(`Saved ${title}.`);
                close();
                this.reload(onSaved);
            }, 0, error => {
                save.disabled = false;
                mUI.warn(`Save failed: ${error}`);
            });
        });
        actions.appendChild(save);
        if (preset) {
            let extra = mUI.el('div', 'm-preset-param-actions');
            let duplicate = mUI.el('button', 'm-preset-small-button', 'Duplicate');
            duplicate.addEventListener('click', () => {
                duplicate.disabled = true;
                genericRequest('DuplicatePreset', { 'preset': preset.title }, data => {
                    duplicate.disabled = false;
                    if (data.preset_fail) {
                        mUI.warn(data.preset_fail);
                        return;
                    }
                    mUI.note(`Duplicated ${preset.title}.`);
                    close();
                    this.reload(onSaved);
                }, 0, error => {
                    duplicate.disabled = false;
                    mUI.warn(`Duplicate failed: ${error}`);
                });
            });
            extra.appendChild(duplicate);
            content.appendChild(extra);
            let remove = mUI.el('button', 'm-edit-remove-button', 'Delete this preset');
            remove.addEventListener('click', () => {
                mUI.confirm(`Delete the preset "${preset.title}"? This cannot be undone.`, () => {
                    genericRequest('DeletePreset', { 'preset': preset.title }, () => {
                        mUI.note(`Deleted ${preset.title}.`);
                        close();
                        this.reload(onSaved);
                    }, 0, error => mUI.warn(`Delete failed: ${error}`));
                });
            });
            content.appendChild(remove);
        }
        // Last, so the sticky Save/Cancel bar (m.css) never sits over Duplicate/Delete.
        content.appendChild(actions);
        let close = mUI.openSheet(content);
        for (let area of content.querySelectorAll('.m-preset-textarea')) {
            area.mGrow();
        }
        return close;
    }

    /** Named editor groups leave unsupported parameters visible under Advanced. */
    static groupFor(key) {
        if (key == 'model' || key == 'vae') {
            return 'Model';
        }
        if (key == 'prompt' || key == 'negativeprompt') {
            return 'Prompts';
        }
        if (key.startsWith('lora')) {
            return 'LoRAs';
        }
        if (['seed', 'steps', 'cfgscale', 'sampler', 'scheduler'].includes(key)) {
            return 'Sampling';
        }
        if (['aspectratio', 'sidelength', 'width', 'height'].includes(key)) {
            return 'Resolution';
        }
        if (key.startsWith('refiner') || key.startsWith('seedvr')) {
            return 'Upscale';
        }
        if (key.startsWith('controlnet')) {
            return 'ControlNet';
        }
        return 'Advanced';
    }

    /** Control-only presets can never save a checkpoint, prompt, image, or an unrelated parameter. */
    validateControl(working, controlOnly) {
        if (controlOnly && Object.keys(working).some(key => !MControlNet.Keys.includes(key))) {
            return 'This control preset contains other parameters. Remove those parameters or keep it as a generation preset.';
        }
        let model = working.controlnetmodel;
        if (!model && !controlOnly) {
            return '';
        }
        let compat = mState.compatClassOf('ControlNet', model);
        if (!['anima', 'anima-2.9b', 'anima-3.8b'].includes(compat) || !MControlNet.typeOf(model)
            || !mState.archIdOf('ControlNet', model).endsWith('/controlnet')) {
            return 'Select a compatible Anima control model.';
        }
        let baseCompat = mState.compatClassOf('Stable-Diffusion', working.model);
        if (baseCompat && baseCompat != compat) {
            return 'The control model does not match the checkpoint architecture.';
        }
        let strength = Number(working.controlnetstrength ?? 1);
        let start = Number(working.controlnetstart ?? 0);
        let end = Number(working.controlnetend ?? 1);
        if (![strength, start, end].every(Number.isFinite) || strength < 0 || strength > 5 || start < 0 || end > 1 || start >= end) {
            return 'Use a strength from 0 to 5. Start must be less than End within 0 to 1.';
        }
        return '';
    }

    /** Anima control fields use known architecture classes and explicit preprocessing choices. Blank fields inherit defaults. */
    buildControlFields(working, controlOnly) {
        let wrap = mUI.el('details', 'm-preset-section m-preset-control');
        wrap.appendChild(mUI.el('summary', 'm-preset-label', 'ControlNet'));
        wrap.open = controlOnly || MControlNet.Keys.some(key => key in working);
        let fields = mUI.el('div', 'm-preset-control-fields');
        wrap.appendChild(fields);
        let patchCompat = mState.compatClassOf('ControlNet', working.controlnetmodel);
        let checkpointCompat = mState.compatClassOf('Stable-Diffusion', working.model || mState.mergedParams().model);
        let compat = (controlOnly ? patchCompat || checkpointCompat : checkpointCompat || patchCompat) || 'anima';
        let type = MControlNet.typeOf(working.controlnetmodel) || 'pose';
        let render = () => {
            fields.innerHTML = '';
            let row = (label, key, entries, selected, change) => {
                let labelEl = mUI.el('label', 'm-control-field', label);
                let select = mUI.el('select', 'm-preset-field');
                select.dataset.param = key;
                select.setAttribute('aria-label', label);
                for (let entry of entries) {
                    let option = document.createElement('option');
                    option.value = entry[0];
                    option.textContent = entry[1];
                    select.appendChild(option);
                }
                if (selected && !entries.some(entry => entry[0] == selected)) {
                    let option = document.createElement('option');
                    option.value = selected;
                    option.textContent = `${selected} (Unavailable)`;
                    select.appendChild(option);
                }
                select.value = selected;
                select.addEventListener('change', () => change(select.value));
                labelEl.appendChild(select);
                fields.appendChild(labelEl);
            };
            if (controlOnly) {
                row('Architecture', 'control-architecture', [['anima', 'Anima'], ['anima-2.9b', 'Anima 2.9B'], ['anima-3.8b', 'Anima 3.8B']], compat, value => {
                    compat = value;
                    delete working.controlnetmodel;
                    render();
                });
            }
            row('Type', 'control-type', Object.entries(MControlNet.Types), type, value => {
                type = value;
                delete working.controlnetmodel;
                delete working.controlnetpreprocessor;
                render();
            });
            let models = (mState.models.ControlNet || []).map(entry => entry[0]).filter(name =>
                mState.compatClassOf('ControlNet', name) == compat && MControlNet.typeOf(name) == type
                && mState.archIdOf('ControlNet', name).endsWith('/controlnet'));
            row('Model', 'controlnetmodel', [['', 'Not Set'], ...models.map(name => [name, name])], working.controlnetmodel || '', value => {
                if (value) {
                    working.controlnetmodel = value;
                }
                else {
                    delete working.controlnetmodel;
                }
            });
            let processors = MControlNet.Processors[type] || [];
            row('Preprocessor', 'controlnetpreprocessor', [['', 'Auto'], ['None', 'Prepared Image'], ...processors.map(name => [name, name])], working.controlnetpreprocessor || '', value => {
                if (value) {
                    working.controlnetpreprocessor = value;
                }
                else {
                    delete working.controlnetpreprocessor;
                }
            });
            for (let [key, label, max, placeholder] of [['controlnetstrength', 'Strength', 5, '1'], ['controlnetstart', 'Start', 1, '0'], ['controlnetend', 'End', 1, '1']]) {
                let labelEl = mUI.el('label', 'm-control-field', label);
                let input = mUI.el('input', 'm-preset-field');
                input.type = 'number';
                input.min = '0';
                input.max = `${max}`;
                input.step = '0.05';
                input.placeholder = placeholder;
                input.value = working[key] ?? '';
                input.dataset.param = key;
                input.addEventListener('input', () => {
                    if (input.value == '') {
                        delete working[key];
                    }
                    else {
                        working[key] = input.value;
                    }
                });
                labelEl.appendChild(input);
                fields.appendChild(labelEl);
            }
        };
        render();
        return wrap;
    }

    /** Selective capture previews old/new values before it changes the editor's unsaved map. */
    openCapture(working, onApplied, controlOnly) {
        let content = mUI.el('div', 'm-preset-sheet');
        content.appendChild(mUI.el('div', 'm-sheet-title', 'Capture Settings'));
        let source = mUI.el('select', 'm-preset-field');
        source.setAttribute('aria-label', 'Settings Source');
        for (let [value, text] of [['explicit', 'Manual Settings'], ['effective', 'With Preset']]) {
            let option = document.createElement('option');
            option.value = value;
            option.textContent = text;
            source.appendChild(option);
        }
        content.appendChild(source);
        let list = mUI.el('div', 'm-preset-capture-list');
        content.appendChild(list);
        let selected = new Set();
        let captured = {};
        let render = () => {
            let map = source.value == 'effective' ? mState.mergedParams() : mState.params;
            if (controlOnly) {
                map = mControlNet.config(mState.mergedParams()).values;
            }
            captured = this.captureMap(map);
            selected = new Set(Object.keys(captured));
            list.innerHTML = '';
            for (let key of Object.keys(captured)) {
                let row = mUI.el('label', 'm-preset-capture-row');
                let check = document.createElement('input');
                check.type = 'checkbox';
                check.checked = true;
                check.dataset.param = key;
                check.addEventListener('change', () => {
                    if (check.checked) {
                        selected.add(key);
                    }
                    else {
                        selected.delete(key);
                    }
                });
                let text = mUI.el('span', 'm-preset-capture-text');
                text.appendChild(mUI.el('span', 'm-preset-param-label', MCreate.paramLabel(key)));
                text.appendChild(mUI.el('span', 'm-preset-capture-value', `${working[key] ?? '(Not Set)'} → ${captured[key]}`));
                row.append(check, text);
                list.appendChild(row);
            }
            if (!selected.size) {
                list.appendChild(mUI.el('div', 'm-strip-empty', 'No settings are available to capture.'));
            }
        };
        source.addEventListener('change', render);
        render();
        let actions = mUI.el('div', 'm-edit-actions');
        let cancel = mUI.el('button', 'm-edit-cancel-button', 'Cancel');
        let apply = mUI.el('button', 'm-edit-save-button', 'Apply');
        let close = null;
        cancel.addEventListener('click', () => close());
        apply.addEventListener('click', () => {
            for (let key of selected) {
                working[key] = captured[key];
            }
            close();
            onApplied();
        });
        actions.append(cancel, apply);
        content.appendChild(actions);
        close = mUI.openSheet(content);
    }

    /** Normalizes reusable maps without baking resolved image dimensions or attached media into a preset. */
    captureMap(map) {
        let out = {};
        for (let key of Object.keys(map)) {
            let meta = mState.paramMeta[key];
            let value = map[key];
            if (MPresets.Uncaptured.includes(key) || meta?.nonreusable || /image/i.test(meta?.type || '')
                || value == null || `${value}` == '' || `${value}`.startsWith('data:')) { continue; }
            out[key] = Array.isArray(value) ? value.join(',') : `${value}`;
        }
        return out;
    }

    /** The Create tab's currently-set parameters, as the string map a preset stores.
     *
     * Reads mState.params rather than buildGenInput(): params holds exactly what the user has set, while
     * buildGenInput folds in the presets that are already active and resolves the aspect ratio to concrete
     * pixels - so capturing that would bake another preset's values into this one and freeze the resolution. */
    captureCurrent() {
        return this.captureMap(mState.params);
    }

    /** The suggested starting value shown as a placeholder for an FL2VA video parameter, or '' if none. Video Model
     * suggests the first listed model whose name contains "fl2va". */

    /** Value control for one preset parameter. Dropdown when the server advertises `values`, fixed-scale
     * picklist for Refiner/SeedVR upscale, otherwise a free-text field. `allowEmpty` (video section) deletes
     * the key when cleared so untouched suggestions are never saved. */
    buildParamValueControl(key, working, opts = {}) {
        let meta = mState.paramMeta[key];
        let current = working[key] ?? '';
        let allowEmpty = !!opts.allowEmpty;
        let onCommit = (val) => {
            if (allowEmpty && val == '') {
                delete working[key];
            }
            else {
                working[key] = val;
            }
            if (opts.onChanged) {
                opts.onChanged();
            }
        };
        let values = null;
        let names = null;
        if (meta && meta.values && meta.values.length > 0) {
            values = meta.values.map(v => `${v}`);
            names = meta.value_names && meta.value_names.length == meta.values.length
                ? meta.value_names : values;
        }
        else if (key == 'model' && mState.models['Stable-Diffusion']?.length) {
            values = mState.models['Stable-Diffusion'].map(entry => entry[0]);
            names = values;
        }
        else if (MCreate.UpscaleScaleParams.includes(key)) {
            values = MCreate.upscaleScaleOptions(meta, current);
            names = values;
        }
        if (values) {
            let select = document.createElement('select');
            select.className = 'm-preset-field';
            if (allowEmpty) {
                let blank = document.createElement('option');
                blank.value = '';
                blank.textContent = opts.placeholder || '';
                select.appendChild(blank);
            }
            for (let i = 0; i < values.length; i++) {
                let option = document.createElement('option');
                option.value = values[i];
                option.textContent = names[i];
                select.appendChild(option);
            }
            let shown = `${current}`;
            if (shown != '' && !values.includes(shown)) {
                let extra = document.createElement('option');
                extra.value = shown;
                extra.textContent = shown;
                select.appendChild(extra);
            }
            select.value = shown;
            select.addEventListener('change', () => onCommit(select.value));
            return select;
        }
        let multiline = meta && (meta.view_type == 'prompt' || meta.view_type == 'big');
        let input = mUI.el(multiline ? 'textarea' : 'input', multiline ? 'm-preset-field m-preset-textarea' : 'm-preset-field');
        if (!multiline) {
            input.type = 'text';
        }
        input.value = current;
        if (opts.placeholder) {
            input.placeholder = opts.placeholder;
        }
        let grow = () => {
            if (!input.isConnected) {
                return;
            }
            input.style.height = 'auto';
            input.style.height = `${input.scrollHeight + 2}px`;
        };
        input.addEventListener('input', () => {
            onCommit(input.value);
            if (multiline) {
                grow();
            }
        });
        if (multiline) {
            // scrollHeight is 0 while detached, so openEditor calls this once the sheet is in the DOM.
            // renderParams also calls it after Add parameter, Use current, and remove. Width changes
            // (sheet resize, orientation) and late fonts need another pass; height-only notifications
            // are ignored so the resize observer does not loop on its own write.
            input.mGrow = grow;
            let lastWidth = -1;
            let observer = new ResizeObserver(entries => {
                if (!input.isConnected) {
                    observer.disconnect();
                    return;
                }
                let width = Math.round(entries[0].contentRect.width);
                if (width == lastWidth) {
                    return;
                }
                lastWidth = width;
                grow();
            });
            observer.observe(input);
            input.mRelease = () => observer.disconnect();
            requestAnimationFrame(grow);
            if (document.fonts && document.fonts.ready) {
                document.fonts.ready.then(() => grow());
            }
        }
        return input;
    }
    fl2vaSuggestion(key) {
        let entry = MPresets.FL2VAParams.find(([k]) => k == key);
        if (!entry) {
            return '';
        }
        if (entry[1] != null) {
            return entry[1];
        }
        // ListT2IParams lists each model as [name, architecture].
        let names = (mState.models['Stable-Diffusion'] || []).map(model => Array.isArray(model) ? model[0] : model);
        return names.find(name => `${name}`.toLowerCase().includes('fl2va')) || '';
    }

    /** Picklist of every parameter the server advertises that this preset does not already set. */
    openParamPicker(working, onPicked, controlOnly = false) {
        let content = mUI.el('div', 'm-preset-sheet');
        content.appendChild(mUI.el('div', 'm-sheet-title', 'Add parameter'));
        let search = mUI.el('input', 'm-preset-search');
        search.type = 'search';
        search.placeholder = 'Search parameters';
        content.appendChild(search);
        let results = mUI.el('div', 'm-preset-results');
        content.appendChild(results);
        let close = null;
        let render = () => {
            results.innerHTML = '';
            let term = search.value.trim().toLowerCase();
            let keys = Object.keys(mState.paramMeta).filter(key => !(key in working)
                && (!controlOnly || MControlNet.Keys.includes(key))
                && !MPresets.Uncaptured.includes(key)
                && (!term || `${key} ${MCreate.paramLabel(key)}`.toLowerCase().includes(term)));
            keys.sort((a, b) => MCreate.paramLabel(a).localeCompare(MCreate.paramLabel(b)));
            MPresets.preferAdjacentPrompt(keys);
            if (keys.length == 0) {
                results.appendChild(mUI.el('div', 'm-strip-empty', Object.keys(mState.paramMeta).length == 0
                    ? 'The parameter list has not loaded yet.' : 'No parameters match.'));
                return;
            }
            // Bounded like the model pickers: the full parameter list is long, and scrolling all of it on a
            // phone is slower than typing two letters into the search above.
            let shown = keys.slice(0, MPresets.PickerLimit);
            for (let key of shown) {
                let row = mUI.el('button', 'm-preset-row-item');
                let text = mUI.el('span', 'm-preset-row-text');
                text.appendChild(mUI.el('span', 'm-preset-row-name', MCreate.paramLabel(key)));
                text.appendChild(mUI.el('span', 'm-preset-row-sub', key));
                row.appendChild(text);
                row.addEventListener('click', () => {
                    let meta = mState.paramMeta[key];
                    working[key] = meta && meta.default != null ? `${meta.default}` : '';
                    close();
                    onPicked();
                });
                results.appendChild(row);
            }
            if (keys.length > shown.length) {
                results.appendChild(mUI.el('div', 'm-list-count',
                    `${keys.length - shown.length} more - search to narrow.`));
            }
        };
        search.addEventListener('input', () => render());
        render();
        close = mUI.openSheet(content);
    }
}

mPresets = new MPresets();
mPresets.install();
