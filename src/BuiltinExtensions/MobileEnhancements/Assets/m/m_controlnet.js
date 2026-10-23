/** Anima guidance for /simple. Model compatibility is authoritative; folder names never establish compatibility. */
class MControlNet {
    /** First-slot settings that a control-only preset may change. Images and unrelated generation keys are excluded. */
    static Keys = ['controlnetmodel', 'controlnetpreprocessor', 'controlnetstrength', 'controlnetstart', 'controlnetend'];
    /** Deliberately small v1 surface. Preprocessed images remain usable when an annotator checkpoint is absent. */
    static Types = { 'pose': 'Pose', 'lineart': 'Lines', 'scribble': 'Sketch', 'depth': 'Depth' };
    /** Explicit mappings avoid core's filename-based preprocessor guesses. */
    static Processors = { 'pose': ['DWPreprocessor'], 'lineart': ['LineartStandardPreprocessor'],
        'scribble': ['ScribblePreprocessor', 'Scribble_XDoG_Preprocessor'], 'depth': ['DepthAnythingV2Preprocessor'] };
    /** Starting values, not a claim of visual acceptance on every checkpoint. */
    static Levels = { 'light': ['0.55', '0.6'], 'normal': ['0.8', '0.8'], 'strong': ['1', '1'] };

    constructor() {
        /** Capabilities belong to individual backends, never a union of different machines. */
        this.backends = [];
        this.waiters = null;
    }

    /** Reserved title namespace uses the existing preset API and storage. */
    static isPreset(preset) {
        return /^controlnet\//i.test(preset?.title || '');
    }

    /** Copies only control settings, including numeric zero. */
    static settings(map) {
        let out = {};
        for (let key of MControlNet.Keys) {
            if (map && map[key] != null && `${map[key]}` != '') {
                out[key] = `${map[key]}`;
            }
        }
        return out;
    }

    /** Reads the real checkpoint class after normal preset application. */
    isAnima(input) {
        return ['anima', 'anima-2.9b', 'anima-3.8b'].includes(mState.compatClassOf('Stable-Diffusion', input.model));
    }

    /** Infers intent only after the model's known Anima class passes compatibility checks. */
    static typeOf(name) {
        let value = `${name || ''}`.replaceAll('\\', '/').split('/').pop().toLowerCase();
        if (/inpaint|any.?test|tile|recolor|segmentation/.test(value)) {
            return '';
        }
        return Object.keys(MControlNet.Types).find(type => value.includes(type)) || '';
    }

    /** Strict patch list for a specific checkpoint. Unknown classes and different Anima depths are excluded. */
    modelsFor(input, type = '') {
        let compat = mState.compatClassOf('Stable-Diffusion', input.model);
        if (!this.isAnima(input)) {
            return [];
        }
        return (mState.models['ControlNet'] || []).filter(row => {
            let arch = mState.archIdOf('ControlNet', row[0]);
            let kind = MControlNet.typeOf(row[0]);
            return arch.endsWith('/controlnet') && mState.compatClassOf('ControlNet', row[0]) == compat
                && kind && (!type || kind == type);
        }).map(row => row[0]).sort();
    }

    /** Registered model names can use either path separator and may omit the extension in Swarm's catalog. */
    static contains(list, name) {
        return !!name && (list || []).some(value => MState.starKey(value) == MState.starKey(name));
    }

    /** Picks one verified backend that has both the checkpoint and patch. A selected remote is never replaced silently. */
    backendFor(input, model) {
        let target = mState.resolveGenTarget();
        return this.backends.find(backend => backend.supported && (target.id == null || `${target.id}` == `${backend.id}`)
            && MControlNet.contains(backend.patches, model) && MControlNet.contains(backend.checkpoints, input.model));
    }

    /** Refreshes cached node contracts without submitting work or installing dependencies. */
    refresh(callback = () => {}) {
        if (this.waiters) {
            this.waiters.push(callback);
            return;
        }
        this.waiters = [callback];
        let finish = (data) => {
            this.backends = Array.isArray(data.backends) ? data.backends : [];
            let callbacks = this.waiters;
            this.waiters = null;
            for (let done of callbacks) {
                done();
            }
            mState.changed();
        };
        genericRequest('GetSimpleControlNetCapabilities', {}, finish, 0, () => finish({}));
    }

    /** Resolves a control-only overlay. Normal preset keys can never escape through this map. */
    config(input, state = mState.control) {
        let values = MControlNet.settings(input);
        let selection = state.selection;
        let error = '';
        if (selection == 'off') {
            return { 'values': {}, 'enabled': false, 'type': '', 'error': '' };
        }
        if (selection.startsWith('preset:')) {
            let preset = mState.presets.find(row => row.title == selection.substring(7) && MControlNet.isPreset(row));
            values = preset ? MControlNet.settings(preset.param_map) : {};
            error = preset ? '' : 'The control preset is unavailable. Select another preset.';
        }
        else if (MControlNet.Types[selection]) {
            let candidates = this.modelsFor(input, selection);
            values = { 'controlnetmodel': candidates.find(name => this.backendFor(input, name)) || candidates[0] || '',
                'controlnetstrength': '0.8', 'controlnetstart': '0', 'controlnetend': '0.8' };
        }
        Object.assign(values, MControlNet.settings(state.values));
        if (values.controlnetpreprocessor == 'Auto') {
            delete values.controlnetpreprocessor;
        }
        let model = values.controlnetmodel || '';
        let canonical = this.modelsFor(input).find(name => MControlNet.contains([name], model));
        if (canonical) {
            model = canonical;
            values.controlnetmodel = canonical;
        }
        let type = MControlNet.typeOf(model) || (MControlNet.Types[selection] ? selection : '');
        let enabled = selection != 'inherit' || !!model;
        if (!enabled) {
            return { values, enabled, type, error };
        }
        if (Object.keys(input).some(key => /^(controlnettwo|controlnetthree)model$/.test(key) && input[key])) {
            error ||= 'Simple supports one control. Remove the extra controls or use Classic UI.';
        }
        if (!mState.paramMeta.exactbackendid) {
            error ||= 'ControlNet requires permission to select a verified backend.';
        }
        if (!MControlNet.contains(this.modelsFor(input), model)) {
            error ||= 'No compatible control model is available for this checkpoint.';
        }
        let backend = this.backendFor(input, model);
        if (!backend) {
            error ||= 'The selected backend cannot verify this control. Refresh or select another backend.';
        }
        if (state.prepared) {
            values.controlnetpreprocessor = 'None';
        }
        else if (!values.controlnetpreprocessor) {
            values.controlnetpreprocessor = (MControlNet.Processors[type] || []).find(name => backend?.preprocessors?.[name]) || '';
        }
        if (!values.controlnetpreprocessor || (values.controlnetpreprocessor != 'None' && !backend?.preprocessors?.[values.controlnetpreprocessor])) {
            error ||= 'This preprocessor is unavailable. Select Prepared Image for an existing control map.';
        }
        let strength = Number(values.controlnetstrength ?? 1);
        let start = Number(values.controlnetstart ?? 0);
        let end = Number(values.controlnetend ?? 1);
        if (![strength, start, end].every(Number.isFinite) || strength < 0 || strength > 5 || start < 0 || end > 1 || start >= end) {
            error ||= 'Control strength or step range is invalid. Use a strength from 0 to 5 and Start less than End.';
        }
        return { values, enabled, type, error, backend };
    }

    /** Applies guidance after the base preset and frame serialization. Hidden video frames never become Anima img2img inputs. */
    apply(input) {
        if (!this.isAnima(input)) {
            // A base Anima preset may leave control params behind during a manual model switch.
            for (let prefix of ['controlnet', 'controlnettwo', 'controlnetthree']) {
                let compat = mState.compatClassOf('ControlNet', input[`${prefix}model`]);
                if (`${compat}`.startsWith('anima')) {
                    for (let key of Object.keys(input).filter(key => key.startsWith(prefix))) {
                        delete input[key];
                    }
                }
            }
            return;
        }
        let config = this.config(input);
        for (let key of Object.keys(input).filter(key => key.startsWith('controlnet'))) {
            delete input[key];
        }
        delete input.initimage;
        delete input.videoendimage;
        if (!config.enabled || config.error || !mState.control.image) {
            return;
        }
        Object.assign(input, config.values);
        let image = mState.control.image;
        input.controlnetimageinput = image.kind == 'path' && typeof mImages != 'undefined'
            ? (mImages.urlToPath(image.value) || image.value) : image.value;
        // Keep a control job on the backend whose contracts and model list were checked.
        input.exactbackendid = config.backend.id;
    }

    /** Blocks an explicitly enabled but incomplete guide. Unsupported architectures remain ordinary generation jobs. */
    validate(input) {
        let source = mState.mergedParams();
        if (!this.isAnima(source)) {
            return '';
        }
        let config = this.config(source);
        if (!config.enabled) {
            return '';
        }
        return config.error || (!mState.control.image ? 'Add a control image before generation.' : '')
            || (!input.controlnetimageinput ? 'The control image is unavailable. Attach the image again.' : '');
    }

    /** Rechecks the selected backend immediately before a request, then builds the actual outgoing payload. */
    prepare(build, ready, failed = () => {}) {
        this.refresh(() => {
            let input = build();
            let error = this.validate(input);
            if (error) {
                mUI.warn(error);
                failed();
                return;
            }
            ready(input);
        });
    }

    /** Grid presets apply after the base input on the server. Reject cells that would invalidate an enabled Anima guide. */
    validateGrid(input, presets) {
        if (!input.controlnetimageinput) {
            return '';
        }
        for (let title of presets) {
            let preset = mState.presets.find(row => row.title == title);
            if (!preset || MControlNet.isPreset(preset)) {
                return 'Select generation presets for the grid. Select the control preset on Create.';
            }
            let cell = { ...input };
            mState.applyPresetMap(cell, preset.param_map || {});
            let base = mState.compatClassOf('Stable-Diffusion', cell.model);
            let control = mState.compatClassOf('ControlNet', cell.controlnetmodel);
            let backend = this.backendFor(cell, cell.controlnetmodel);
            if (base != control || !backend || `${backend.id}` != `${input.exactbackendid}`
                || Object.keys(preset.param_map || {}).some(key => key.startsWith('controlnet'))) {
                return 'A grid preset changes the control setup. Use presets with the same checkpoint architecture and no control overrides.';
            }
        }
        return '';
    }

    /** Builds the compact Anima panel using the existing upload, paste, and server-browser slot implementation. */
    build() {
        this.wrap = mUI.el('details', 'm-neg-wrap m-controlnet');
        this.wrap.appendChild(mUI.el('summary', 'm-neg-summary', 'ControlNet'));
        this.preset = this.select('Control Preset', () => {
            mState.control.selection = this.preset.value;
            mState.control.values = {};
            mState.control.prepared = false;
            let input = mState.mergedParams();
            let type = mState.control.selection;
            if (MControlNet.Types[type]) {
                let model = this.modelsFor(input, type).find(name => this.backendFor(input, name));
                let backend = this.backendFor(input, model);
                mState.control.prepared = !(MControlNet.Processors[type] || []).some(name => backend?.preprocessors?.[name]);
            }
        });
        this.model = this.select('Control Model', () => { mState.control.values.controlnetmodel = this.model.value; });
        this.level = this.select('Strength', () => {
            let level = MControlNet.Levels[this.level.value];
            if (level) {
                mState.control.values.controlnetstrength = level[0];
                mState.control.values.controlnetend = level[1];
            }
        });
        let label = mUI.el('label', 'm-control-prepared');
        this.prepared = document.createElement('input');
        this.prepared.type = 'checkbox';
        this.prepared.addEventListener('change', () => {
            mState.control.prepared = this.prepared.checked;
            mState.control.values.controlnetpreprocessor = this.prepared.checked ? 'None' : 'Auto';
            mState.changed();
        });
        label.append(this.prepared, document.createTextNode('Prepared Image'));
        this.wrap.appendChild(label);
        this.slot = mCreate.buildFrameSlot('Control Image', () => mState.control.image, entry => { mState.control.image = entry; });
        this.slot.pickTitle = 'Control Image';
        this.wrap.appendChild(this.slot);
        this.notice = mUI.el('div', 'm-control-notice');
        this.notice.setAttribute('role', 'status');
        this.wrap.appendChild(this.notice);
        let actions = mUI.el('div', 'm-control-actions');
        let save = mUI.el('button', 'm-preset-small-button', 'Save Preset');
        save.type = 'button';
        save.addEventListener('click', () => {
            if (mPresets.canManage()) {
                mPresets.openEditor(null, null, 'control');
            }
            else {
                mUI.warn('You do not have permission to manage presets.');
            }
        });
        let refresh = mUI.el('button', 'm-preset-small-button', 'Refresh');
        refresh.type = 'button';
        refresh.addEventListener('click', () => this.refresh());
        actions.append(save, refresh);
        this.wrap.appendChild(actions);
        return this.wrap;
    }

    /** One labelled select; stable DOM preserves keyboard focus and scroll position across state notifications. */
    select(title, change) {
        let label = mUI.el('label', 'm-control-field', title);
        let select = mUI.el('select', 'm-preset-field');
        select.setAttribute('aria-label', title);
        select.addEventListener('change', () => {
            change();
            mState.changed();
        });
        label.appendChild(select);
        this.wrap.appendChild(label);
        return select;
    }

    /** Presents only compatible types and presets. An active unavailable choice remains visible with a reason. */
    render() {
        if (!this.wrap) {
            return;
        }
        let input = mState.mergedParams();
        let anima = this.isAnima(input);
        this.wrap.hidden = !anima || !mState.paramMeta.controlnetmodel;
        mCreate.framesWrap.hidden = anima;
        if (!anima) {
            return;
        }
        let state = mState.control;
        let entries = [['inherit', 'From Preset'], ['off', 'Off']];
        for (let type of Object.keys(MControlNet.Types)) {
            let backends = this.modelsFor(input, type).map(model => this.backendFor(input, model)).filter(Boolean);
            if (backends.length) {
                let automatic = backends.some(backend => MControlNet.Processors[type].some(name => backend.preprocessors?.[name]));
                entries.push([type, `${MControlNet.Types[type]}${automatic ? '' : ' (Prepared)'}`]);
            }
        }
        for (let preset of mState.presets.filter(MControlNet.isPreset)) {
            let choice = this.config(input, { selection: `preset:${preset.title}`, values: {}, prepared: false });
            if (!choice.error) {
                entries.push([`preset:${preset.title}`, preset.title.substring(preset.title.indexOf('/') + 1)]);
            }
        }
        if (!entries.some(row => row[0] == state.selection)) {
            entries.push([state.selection, 'Unavailable']);
        }
        MCreate.syncOptions(this.preset, entries, state.selection);
        let config = this.config(input);
        let models = this.modelsFor(input, config.type).filter(name => this.backendFor(input, name)).map(name => [name, name]);
        if (config.values.controlnetmodel && !models.some(row => MState.sameModel(row[0], config.values.controlnetmodel))) {
            models.push([config.values.controlnetmodel, 'Unavailable']);
        }
        if (!models.length) {
            models.push(['', 'No Compatible Model']);
        }
        MCreate.syncOptions(this.model, models, config.values.controlnetmodel || models[0][0]);
        this.model.disabled = !config.enabled;
        let level = Object.keys(MControlNet.Levels).find(key => {
            let pair = MControlNet.Levels[key];
            return Number(pair[0]) == Number(config.values.controlnetstrength) && Number(pair[1]) == Number(config.values.controlnetend);
        });
        MCreate.syncOptions(this.level, [['custom', 'Custom'], ['light', 'Light'], ['normal', 'Normal'], ['strong', 'Strong']], level || 'custom');
        this.level.disabled = !config.enabled;
        this.prepared.checked = state.prepared || config.values.controlnetpreprocessor == 'None';
        this.prepared.disabled = !config.enabled;
        this.slot.hidden = !config.enabled;
        this.notice.textContent = config.enabled ? (config.error || (!state.image ? 'Add a control image.' : ''))
            : (entries.length == 2 ? 'No compatible controls are available on this backend. Refresh after the backend starts.' : '');
        if (config.enabled && !this.wasEnabled) {
            this.wrap.open = true;
        }
        this.wasEnabled = config.enabled;
        mCreate.renderFrameSlot(this.slot);
    }
}

/** Shared control panel and pure compatibility helpers. */
let mControlNet = new MControlNet();
