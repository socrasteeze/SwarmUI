/** MobileEnhancements standalone client - preset editor.
 *
 * The Create tab could select presets but never change one: every edit meant opening the classic UI on a
 * desktop. This is the missing half - create, rename, retitle, re-describe, star, edit the parameter map,
 * duplicate and delete - reached from More > Presets rather than from the Create tab, because it is a
 * management surface rather than part of the generate flow.
 *
 * Server-side this is entirely the existing routes (AddNewPreset with is_edit, DuplicatePreset,
 * DeletePreset). Nothing here needs a new API.
 *
 * The parameter map is edited as raw key/value text rows on purpose. A preset can carry any parameter the
 * server knows, including ones this client has no control for, and a typed editor would have to either hide
 * those or grow a widget per type - so the honest first version shows every entry, labels it with the
 * server's display name where there is one, and lets the value be typed. Nothing is silently dropped on
 * save: a row this client cannot render specially still round-trips exactly as it arrived. */
class MPresets {

    /** Parameters never captured by "Use current Create settings".
     *
     * These describe the run rather than the look: the batch size, which backend to pin to, and the prompt
     * images attached to this one generation. Baking any of them into a preset means every later use of it
     * silently inherits a choice that had nothing to do with the preset. Everything else - including the
     * seed, which is occasionally wanted - is captured, and can be removed by hand in the editor. */
    static Uncaptured = ['images', 'exactbackendid', 'promptimages'];

    /** How many rows the parameter picker renders at once. Truncation is reported rather than silent. */
    static PickerLimit = 60;

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
        let newButton = mUI.el('button', 'm-preset-new-button', 'New preset from current settings');
        newButton.addEventListener('click', () => {
            if (!this.canManage()) {
                mUI.warn('You do not have permission to manage presets.');
                return;
            }
            this.openEditor(null, () => render());
        });
        content.appendChild(newButton);
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
                    `${preset.is_starred ? '★ ' : ''}${preset.title}`));
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
    openEditor(preset, onSaved) {
        let working = {};
        if (preset) {
            for (let key in (preset.param_map || {})) {
                working[key] = `${preset.param_map[key]}`;
            }
        }
        else {
            working = this.captureCurrent();
        }
        let content = mUI.el('div', 'm-preset-sheet');
        content.appendChild(mUI.el('div', 'm-sheet-title', preset ? 'Edit preset' : 'New preset'));
        content.appendChild(mUI.el('div', 'm-preset-label', 'Title'));
        let titleInput = mUI.el('input', 'm-preset-field');
        titleInput.type = 'text';
        titleInput.placeholder = 'Title - a "/" makes a folder, e.g. flux/Portrait';
        titleInput.value = preset ? preset.title : '';
        content.appendChild(titleInput);
        content.appendChild(mUI.el('div', 'm-preset-label', 'Description'));
        let descInput = mUI.el('input', 'm-preset-field');
        descInput.type = 'text';
        descInput.placeholder = 'Optional';
        descInput.value = preset ? (preset.description || '') : '';
        content.appendChild(descInput);
        let starred = preset ? !!preset.is_starred : false;
        let starButton = mUI.el('button', 'm-preset-star-toggle');
        let renderStar = () => {
            starButton.textContent = starred ? '★ Starred' : '☆ Not starred';
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
        let renderParams = () => {
            paramList.innerHTML = '';
            let keys = Object.keys(working).sort();
            if (keys.length == 0) {
                paramList.appendChild(mUI.el('div', 'm-strip-empty',
                    'No parameters. A preset with none does nothing.'));
                return;
            }
            for (let key of keys) {
                let row = mUI.el('div', 'm-preset-param-row');
                let label = mUI.el('div', 'm-preset-param-label', MCreate.paramLabel(key));
                // The raw id is what the server stores and what any other editor shows, so it stays reachable
                // rather than being replaced outright by the display name.
                label.title = key;
                row.appendChild(label);
                let valueWrap = mUI.el('div', 'm-preset-param-value');
                let input = mUI.el('input', 'm-preset-field');
                input.type = 'text';
                input.value = working[key];
                input.addEventListener('input', () => {
                    working[key] = input.value;
                });
                valueWrap.appendChild(input);
                let remove = mUI.el('button', 'm-preset-param-remove', '×');
                remove.setAttribute('aria-label', `Remove ${MCreate.paramLabel(key)}`);
                remove.addEventListener('click', () => {
                    delete working[key];
                    renderParams();
                });
                valueWrap.appendChild(remove);
                row.appendChild(valueWrap);
                paramList.appendChild(row);
            }
        };
        renderParams();
        let paramActions = mUI.el('div', 'm-preset-param-actions');
        let addCurrent = mUI.el('button', 'm-preset-small-button', 'Use current Create settings');
        addCurrent.addEventListener('click', () => {
            let captured = this.captureCurrent();
            let keys = Object.keys(captured);
            if (keys.length == 0) {
                mUI.warn('Nothing is set on the Create tab to capture.');
                return;
            }
            for (let key of keys) {
                working[key] = captured[key];
            }
            renderParams();
            mUI.note(`Captured ${keys.length} parameter${keys.length == 1 ? '' : 's'}.`);
        });
        paramActions.appendChild(addCurrent);
        let addOne = mUI.el('button', 'm-preset-small-button', 'Add parameter');
        addOne.addEventListener('click', () => this.openParamPicker(working, () => renderParams()));
        paramActions.appendChild(addOne);
        content.appendChild(paramActions);
        let actions = mUI.el('div', 'm-edit-actions');
        let cancel = mUI.el('button', 'm-edit-cancel-button', 'Cancel');
        cancel.addEventListener('click', () => close());
        actions.appendChild(cancel);
        let save = mUI.el('button', 'm-edit-save-button', 'Save');
        save.addEventListener('click', () => {
            let title = titleInput.value.trim();
            if (!title) {
                mUI.warn('A preset needs a title.');
                return;
            }
            save.disabled = true;
            let payload = {
                'title': title,
                'description': descInput.value.trim(),
                'param_map': working,
                'is_starred': starred,
                'is_edit': !!preset
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
        content.appendChild(actions);
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
        let close = mUI.openSheet(content);
        return close;
    }

    /** The Create tab's currently-set parameters, as the string map a preset stores.
     *
     * Reads mState.params rather than buildGenInput(): params holds exactly what the user has set, while
     * buildGenInput folds in the presets that are already active and resolves the aspect ratio to concrete
     * pixels - so capturing that would bake another preset's values into this one and freeze the resolution. */
    captureCurrent() {
        let out = {};
        for (let key in mState.params) {
            if (MPresets.Uncaptured.includes(key)) {
                continue;
            }
            let val = mState.params[key];
            if (val == null || `${val}` == '') {
                continue;
            }
            // ParamMap is a string dictionary server-side, so the list params (loras, loraweights) are stored
            // comma-joined - the same form applyPresetMap and the server both already parse.
            out[key] = Array.isArray(val) ? val.join(',') : `${val}`;
        }
        return out;
    }

    /** Picklist of every parameter the server advertises that this preset does not already set. */
    openParamPicker(working, onPicked) {
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
                && (!term || `${key} ${MCreate.paramLabel(key)}`.toLowerCase().includes(term)));
            keys.sort((a, b) => MCreate.paramLabel(a).localeCompare(MCreate.paramLabel(b)));
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
