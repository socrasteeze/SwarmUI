/** MobileEnhancements standalone client - state.
 * Holds the flat parameter dict that goes to GenerateText2ImageWS, the active preset list, prompt images,
 * and the two mapping algorithms ported (DOM-free) from the genpage: preset merge (presets.js applyOnePreset)
 * and reuse-params (currentimagehandler.js copy_current_image_params). Presets are merged CLIENT-SIDE at send
 * time and the base state is never mutated by them: the server applies `presets:[...]` AFTER raw params, which
 * would let a preset clobber reused-history params and prompt edits, and server-side has no {value} support. */
class MState {

    constructor() {
        /** Flat param id -> value. Exactly what gets sent to the server (numbers may be strings; arrays allowed). */
        this.params = { 'prompt': '', 'images': '1', 'seed': '-1' };
        /** Ordered list of active preset titles (selection order = merge order). */
        this.activePresets = [];
        /** Prompt images, ordered: {kind: 'data'|'path', value: dataURI-or-serverRelativePath}. */
        this.promptImages = [];
        /** True when the seed is locked (kept between generations) rather than randomized (-1). */
        this.seedLocked = false;
        /** Param metadata map (id -> param object) from ListT2IParams. */
        this.paramMeta = {};
        /** Preset objects from GetMyUserData ({title, description, param_map, preview_image, is_starred}). */
        this.presets = [];
        /** Model name lists from ListT2IParams (subtype -> [[name, class], ...]). */
        this.models = {};
        /** Callbacks fired after any state change that should re-render the Create surface. */
        this.changeListeners = [];
    }

    /** Registers a change listener. */
    onChange(callback) {
        this.changeListeners.push(callback);
    }

    /** Notifies listeners and persists. Call after any mutation. */
    changed() {
        this.save();
        for (let callback of this.changeListeners) {
            callback();
        }
    }

    /** Stores param metadata from a ListT2IParams response. */
    loadParamMeta(data) {
        this.paramMeta = {};
        for (let param of (data.list || [])) {
            this.paramMeta[param.id] = param;
        }
        this.models = data.models || {};
    }

    /** Normalizes a list-ish param value (JS array, or comma/pipe-joined string) to a real array. */
    static toList(val) {
        if (val == null || val == '') {
            return [];
        }
        if (Array.isArray(val)) {
            return [...val];
        }
        let str = `${val}`;
        if (str.includes('\n|||\n')) {
            return str.split('\n|||\n');
        }
        return str.split(',');
    }

    /** Applies one preset's param_map onto an outgoing input dict (port of presets.js applyOnePreset, no DOM).
     * {value} in a string substitutes the current outgoing value - but only the text before any
     * <segment:/<object:/<region: tag, with the tag block re-appended, matching the genpage behavior.
     * loras/loraweights concat onto existing values instead of replacing. Everything else overwrites. */
    applyPresetMap(input, paramMap) {
        for (let key in paramMap) {
            let val = paramMap[key];
            if (typeof val == 'string' && val.includes('{value}')) {
                let curVal = `${input[key] ?? ''}`;
                let tagIndex = -1;
                for (let tag of ['<segment:', '<object:', '<region:']) {
                    let idx = curVal.indexOf(tag);
                    if (idx != -1 && (tagIndex == -1 || idx < tagIndex)) {
                        tagIndex = idx;
                    }
                }
                if (tagIndex == -1) {
                    input[key] = val.replaceAll('{value}', curVal);
                }
                else {
                    input[key] = val.replaceAll('{value}', curVal.substring(0, tagIndex)) + curVal.substring(tagIndex);
                }
            }
            else if (key == 'loras' || key == 'loraweights') {
                let existing = MState.toList(input[key]);
                let added = MState.toList(val);
                input[key] = existing.concat(added);
            }
            else {
                input[key] = val;
            }
        }
    }

    /** Builds the flat input dict for one generation: base params + active presets merged in selection order
     * + prompt images + image count. session_id is added by the transport. Base state is not mutated. */
    buildGenInput() {
        let input = {};
        for (let key in this.params) {
            let val = this.params[key];
            input[key] = Array.isArray(val) ? [...val] : val;
        }
        for (let title of this.activePresets) {
            let preset = this.presets.find(p => p.title == title);
            if (preset && preset.param_map) {
                this.applyPresetMap(input, preset.param_map);
            }
        }
        if (this.promptImages.length > 0) {
            input['promptimages'] = this.promptImages.map(img => img.value);
        }
        else {
            delete input['promptimages'];
        }
        if (!this.seedLocked) {
            input['seed'] = '-1';
        }
        return input;
    }

    /** Maps a generated/history image's metadata back onto the state (Reuse Parameters). DOM-free simplified
     * port of currentimagehandler.js copy_current_image_params: parse, apply parameter_remaps renames, prefer
     * original_prompt/original_negativeprompt, drop prompt-syntax LoRAs (prompted_loras on modern images,
     * confinement==-1 on old ones) keeping the arrays index-aligned, fix missing aspectratio, then filter to
     * params the server actually reports (dropping nonreusable ones). Returns true on success. */
    applyMetadata(metadata) {
        try {
            let full = typeof metadata == 'string' ? JSON.parse(metadata) : metadata;
            let meta = full.sui_image_params || full;
            let extra = full.sui_extra_data || meta;
            let remaps = window.parameter_remaps || {};
            for (let key in remaps) {
                if (key in meta) {
                    meta[remaps[key]] = meta[key];
                    delete meta[key];
                }
            }
            if (extra.original_prompt) {
                meta.prompt = extra.original_prompt;
            }
            if (extra.original_negativeprompt) {
                meta.negativeprompt = extra.original_negativeprompt;
            }
            if (meta.loras) {
                let loras = MState.toList(meta.loras);
                let weights = MState.toList(meta.loraweights);
                let confinements = MState.toList(meta.lorasectionconfinement);
                let prompted = extra.prompted_loras || null;
                for (let i = loras.length - 1; i >= 0; i--) {
                    let isPrompted = prompted ? prompted.includes(loras[i]) : (confinements.length == loras.length && `${confinements[i]}` == '-1');
                    if (isPrompted) {
                        loras.splice(i, 1);
                        if (weights.length > i) {
                            weights.splice(i, 1);
                        }
                    }
                }
                meta.loras = loras;
                meta.loraweights = weights;
                delete meta.lorasectionconfinement;
            }
            if (!meta.aspectratio && meta.width && meta.height) {
                meta.aspectratio = 'Custom';
            }
            let clean = { 'prompt': '', 'images': this.params['images'] || '1', 'seed': '-1' };
            for (let key in meta) {
                let pm = this.paramMeta[key];
                if (!pm || pm.nonreusable) {
                    continue;
                }
                clean[key] = meta[key];
            }
            this.params = clean;
            this.activePresets = [];
            this.changed();
            return true;
        }
        catch (e) {
            console.error('applyMetadata failed', e);
            return false;
        }
    }

    /** Active LoRAs as [{name, weight}] from the index-aligned params arrays. */
    getLoras() {
        let names = MState.toList(this.params['loras']);
        let weights = MState.toList(this.params['loraweights']);
        return names.map((name, i) => ({ 'name': name, 'weight': weights.length > i ? parseFloat(weights[i]) || 1 : 1 }));
    }

    /** Writes [{name, weight}] back into the params arrays (or removes them when empty). */
    setLoras(loras) {
        if (loras.length == 0) {
            delete this.params['loras'];
            delete this.params['loraweights'];
        }
        else {
            this.params['loras'] = loras.map(l => l.name);
            this.params['loraweights'] = loras.map(l => `${l.weight}`);
        }
        this.changed();
    }

    /** Persists reusable state to localStorage. Data-URI prompt images are deliberately not persisted (size). */
    save() {
        try {
            let data = {
                'params': this.params,
                'activePresets': this.activePresets,
                'seedLocked': this.seedLocked,
                'promptImagePaths': this.promptImages.filter(img => img.kind == 'path').map(img => img.value),
            };
            localStorage.setItem('m_client_state', JSON.stringify(data));
        }
        catch (e) {
            console.error('state save failed', e);
        }
    }

    /** Restores persisted state. */
    load() {
        try {
            let raw = localStorage.getItem('m_client_state');
            if (!raw) {
                return;
            }
            let data = JSON.parse(raw);
            if (data.params) {
                this.params = data.params;
            }
            this.activePresets = data.activePresets || [];
            this.seedLocked = !!data.seedLocked;
            this.promptImages = (data.promptImagePaths || []).map(path => ({ 'kind': 'path', 'value': path }));
        }
        catch (e) {
            console.error('state load failed', e);
        }
    }
}

mState = new MState();
