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
        /** True once a save() has failed, so the "not being saved" warning fires once and not per keystroke. */
        this.saveFailed = false;
        /** Param metadata map (id -> param object) from ListT2IParams. */
        this.paramMeta = {};
        /** Preset objects from GetMyUserData ({title, description, param_map, preview_image, is_starred}). */
        this.presets = [];
        /** Model name lists from ListT2IParams (subtype -> [[name, classId], ...]). */
        this.models = {};
        /** Starred ("favourite") model names from GetMyUserData, as subtype -> [name, ...]. Same store the
         * genpage's star buttons write through SetStarredModels, so a star set over there shows up here. */
        this.starredModels = {};
        /** Model class data from ListT2IParams (classId -> {standard_width, standard_height, ...}). */
        this.modelClasses = {};
        /** subtype -> Map(strippedName -> compat class), built lazily by compatMapFor. */
        this.compatCache = {};
        /** Wildcard file names from ListT2IParams (used by prompt autocompletion). */
        this.wildcards = [];
        /** Numeric width/height ratio backing a 'Custom' aspect selection (eg matched from a prompt image),
         * or 0 when 'Custom' means "whatever width/height are already set". Kept out of params because it is
         * a client-side concept - the server only ever sees the resulting width/height. */
        this.customRatio = 0;
        /** Selected architecture group (a preset-title folder prefix), or '' for "all". Purely a client-side
         * browsing filter over presets and the model/LoRA pickers - never sent to the server. */
        this.archFilter = '';
        /** Callbacks fired after any state change that should re-render the Create surface. */
        this.changeListeners = [];
        /** Whether a state-change notification is already booked for the next animation frame. */
        this.changeScheduled = false;
    }

    /** Registers a change listener. */
    onChange(callback) {
        this.changeListeners.push(callback);
    }

    /** Persists immediately and coalesces listener redraws to one per animation frame. Slider input and the two
     * parallel boot responses can otherwise rebuild the entire Create surface several times before a paint. */
    changed() {
        this.save();
        if (this.changeScheduled) {
            return;
        }
        this.changeScheduled = true;
        requestAnimationFrame(() => {
            this.changeScheduled = false;
            for (let callback of this.changeListeners) {
                callback();
            }
        });
    }

    /** Stores param metadata from a ListT2IParams response. */
    loadParamMeta(data) {
        this.paramMeta = {};
        for (let param of (data.list || [])) {
            this.paramMeta[param.id] = param;
        }
        this.models = data.models || {};
        this.modelClasses = data.model_classes || {};
        this.wildcards = data.wildcards || [];
        // Both inputs to the compat map just changed.
        this.compatCache = {};
    }

    /** The selected model's native side length, via its model class's standard width. 0 when unknown. */
    modelNativeSize(modelName) {
        if (!modelName) {
            return 0;
        }
        for (let entry of (this.models['Stable-Diffusion'] || [])) {
            if (entry[0] == modelName) {
                let clazz = this.modelClasses[entry[1]];
                return clazz && clazz.standard_width ? clazz.standard_width : 0;
            }
        }
        return 0;
    }

    /** Resolves the side length for an outgoing input: an explicit pick wins, then any width the input
     * already carries (so a 1024 preset switched to 16:9 scales the way you'd expect rather than
     * collapsing to the 512 default), then the selected model's native size, then 512. */
    resolveSideLength(input) {
        let explicit = parseInt(input['sidelength']);
        if (explicit) {
            return explicit;
        }
        let width = parseInt(input['width']);
        if (width) {
            return width;
        }
        return this.modelNativeSize(input['model']) || 1024;
    }

    /** Width/height for an arbitrary numeric ratio at a given side length: the same area-matched idea as the
     * genpage's "match this image's aspect ratio" branch (params.js, sqrt(512*512*ratio)), but solved
     * directly at the target side length instead of computing a 512-reference and scaling it. That skips one
     * rounding step, so the area lands exactly on sideLength^2 and the extreme ratios stay honest - via the
     * scaled form, 3:1 at 1024 came out 3.5% off.
     * Rounds to 64, NOT 16 (unlike the server's own native-table path, T2IParamInput.GetImageWidth/Height,
     * which this deliberately does not mirror here): the SideLength param's own doc comment
     * (T2IParamTypes.cs) says models "almost always want a multiple of 64", and 5:7 at a 1024 side length
     * rounded to 16 landed on 864x1216 - 864 is a multiple of 16 but NOT of 64, and generating at that size
     * against a Flux 2 Klein checkpoint crashed the backend with a numpy "inhomogeneous shape" error out of
     * its position-embedding grid construction. The server's native ratio table is hand-curated to already
     * land on 64-multiples at the standard side lengths, so it doesn't need this; these are the two paths
     * that invent their own width/height (fork-added ratios, and an image-matched exact ratio) rather than
     * reusing a curated pair, so they're the two places that can drift onto an unsafe size. */
    static dimsForRatio(ratio, sideLength) {
        if (!ratio || !sideLength) {
            return null;
        }
        return [roundTo(Math.sqrt(sideLength * sideLength * ratio), 64), roundTo(Math.sqrt(sideLength * sideLength / ratio), 64)];
    }

    /** Every aspect ratio the picker offers, label -> numeric width/height ratio. */
    static allAspectRatios() {
        let all = {};
        for (let key in MState.AspectReferences) {
            all[key] = MState.AspectReferences[key][0] / MState.AspectReferences[key][1];
        }
        for (let key in MState.ExtraAspects) {
            all[key] = MState.ExtraAspects[key];
        }
        return all;
    }

    /** The offered aspect ratio closest to a numeric ratio, compared in log space so that being 10% off is
     * judged the same whether the image is wide or tall. */
    static closestAspect(ratio) {
        let all = MState.allAspectRatios();
        let best = null;
        let bestDelta = 0;
        for (let key in all) {
            let delta = Math.abs(Math.log(ratio / all[key]));
            if (best == null || delta < bestDelta) {
                best = key;
                bestDelta = delta;
            }
        }
        return best;
    }

    /** The width/height the server will derive for an aspect ratio at a given side length, or null for an
     * aspect ratio with no reference entry. Mirrors T2IParamInput.GetImageWidth/GetImageHeight exactly. */
    static resolutionFor(aspect, sideLength) {
        let ref = MState.AspectReferences[aspect];
        if (!ref || !sideLength) {
            return null;
        }
        return [roundTo(ref[0] * (sideLength / 512), 16), roundTo(ref[1] * (sideLength / 512), 16)];
    }

    /** The width/height the next generation will actually use, or null when it is not aspect-driven.
     * Derived from a real buildGenInput() so the on-screen readout cannot drift from what gets sent. */
    previewResolution() {
        let input = this.buildGenInput();
        if (input['width'] && input['height']) {
            return [parseInt(input['width']), parseInt(input['height'])];
        }
        return MState.resolutionFor(input['aspectratio'], parseInt(input['sidelength']));
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
        // These two controls are always visible and explicitly user-editable. Once tapped, their stored base
        // values must win over a preset or the buttons would appear to work while generation kept using the
        // preset value. Untouched controls have no key in params and therefore still inherit the preset/default.
        for (let key of ['steps', 'cfgscale']) {
            if (key in this.params) {
                input[key] = this.params[key];
            }
        }
        // Resolution. An aspect ratio on its own does nothing server-side: T2IParamInput.GetImageWidth only
        // consults the aspect table when a side length is ALSO present, and otherwise falls through to raw
        // width/height (default 512) - so a picked aspect ratio was silently ignored. Whenever a known
        // aspect ratio is active we therefore resolve a concrete side length and drop width/height, which is
        // both what the picker implies and what keeps the recorded metadata honest. 'Custom' is the opposite
        // case: the server ignores side length there, so it must not be sent.
        let aspect = input['aspectratio'];
        let sideLength = this.resolveSideLength(input);
        if (aspect && MState.AspectReferences[aspect]) {
            input['sidelength'] = `${sideLength}`;
            delete input['width'];
            delete input['height'];
        }
        else {
            // Ratios the server has no table entry for - the fork-added ones, and any ratio matched from a
            // prompt image - are resolved to concrete pixels here and sent as 'Custom'. The label the picker
            // shows is a client-side concept; the server only ever sees Custom plus a width and height.
            let ratio = MState.ExtraAspects[aspect] || (aspect == 'Custom' ? this.customRatio : 0);
            let dims = MState.dimsForRatio(ratio, sideLength);
            if (dims) {
                input['aspectratio'] = 'Custom';
                input['width'] = `${dims[0]}`;
                input['height'] = `${dims[1]}`;
            }
            delete input['sidelength'];
        }
        if (this.promptImages.length > 0) {
            // Path entries must be output-root-relative (raw/..., Starred/..., inputs/...). A leftover
            // View/ URL or data URI here is what ValidateParam interpolates into the "string too long"
            // error, so strip known prefixes on the way out rather than trusting every stored value.
            let sent = [];
            for (let i = 0; i < this.promptImages.length; i++) {
                let img = this.promptImages[i];
                if (img.kind == 'path') {
                    let path = (typeof mImages != 'undefined' && mImages.urlToPath) ? (mImages.urlToPath(img.value) || img.value) : img.value;
                    if (path && !`${path}`.startsWith('data:')) {
                        sent.push(path);
                    }
                }
                else {
                    sent.push(img.value);
                }
            }
            if (sent.length > 0) {
                input['promptimages'] = sent;
            }
            else {
                delete input['promptimages'];
            }
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

    /** Resets generation params back to blank: prompt, negative, model, LoRAs, images, resolution picks,
     * active presets, and prompt images all clear. Leaves session data (paramMeta/presets/models/wildcards)
     * and unrelated client prefs (haptics, image sort mode, preview collapse state) untouched - this is
     * "start a fresh generation", not "wipe the client" (that's the More tab's Reset mobile client state,
     * which also clears localStorage and reloads). */
    resetParams() {
        // The filename prefix deliberately survives: this button means "start a fresh generation", and the
        // prefix is a label for the whole working session, not part of any one generation's settings.
        let keepPrefix = this.params['filenameprefix'];
        this.params = { 'prompt': '', 'images': '1', 'seed': '-1' };
        if (keepPrefix) {
            this.params['filenameprefix'] = keepPrefix;
        }
        this.activePresets = [];
        this.promptImages = [];
        this.seedLocked = false;
        this.customRatio = 0;
        this.changed();
    }

    /** Re-fetches presets and starred models. Boot loads them once, but stars set from the genpage (or
     * another device) after that were invisible until a full reload - on an installed PWA that can be days.
     * Called when a picker opens: that is the moment staleness is visible, and the response is small.
     * Throttled so a picker opened repeatedly doesn't re-ask for the same answer. */
    refreshUserData() {
        let now = Date.now();
        if (this.userDataRefreshedAt && now - this.userDataRefreshedAt < 10 * 1000) {
            return;
        }
        this.userDataRefreshedAt = now;
        genericRequest('GetMyUserData', { 'includeAutocompletions': false }, data => {
            this.presets = data.presets || [];
            this.starredModels = data.starred_models || {};
            this.changed();
        }, 0, () => {
            // A failed refresh keeps the boot-time copy; nothing to report - the picker still works.
            this.userDataRefreshedAt = 0;
        });
    }

    /** The architecture group a preset belongs to: its title's leading folder segment ('ill/PLATT Pose' ->
     * 'ill'). Presets saved at the root of the preset list have no group and return ''. */
    static presetGroup(title) {
        let slash = `${title || ''}`.indexOf('/');
        return slash == -1 ? '' : title.substring(0, slash);
    }

    /** Every group that has at least one preset, sorted. */
    presetGroups() {
        let groups = new Set();
        for (let preset of this.presets) {
            let group = MState.presetGroup(preset.title);
            if (group) {
                groups.add(group);
            }
        }
        return [...groups].sort((a, b) => a.localeCompare(b));
    }

    /** A model name with its file extension removed, folders kept. The two sources of model names disagree:
     * ListT2IParams and ListModels report 'qwen/Foo.safetensors', while a preset's param_map stores
     * 'qwen/Foo'. Comparing them raw silently fails to match, which is what made the architecture filter
     * resolve every preset group to zero compat classes and therefore filter nothing at all. Anything
     * comparing a preset's model against a listed model must normalise both sides through this. */
    static stripModelExt(name) {
        return `${name || ''}`.replace(/\.(safetensors|ckpt|sft|gguf|engine|pt|bin)$/i, '');
    }

    /** True when two model-name strings name the same file, ignoring a trailing weight-file extension.
     * Presets, starred_models, and ListModels do not agree on whether the extension is present. */
    static sameModel(a, b) {
        return MState.stripModelExt(a) == MState.stripModelExt(b);
    }

    /** Leading folder segment of a model path ('ill/foo.safetensors' -> 'ill'). Empty for a root file. */
    static modelFolder(name) {
        let n = MState.stripModelExt(name);
        let slash = n.indexOf('/');
        return slash == -1 ? '' : n.substring(0, slash);
    }

    /** starKey'd model name -> compat class, for one subtype. Built once and cached.
     * This has to be a map, not a scan: filterByArch calls compatClassOf once per model, so a linear scan
     * made it O(models^2) - 18,561 LoRAs measured at 3,972 ms per call on desktop, and it runs on every
     * keystroke in the picker search. Cleared by loadParamMeta, which is the only thing that replaces
     * `models`/`modelClasses`. */
    compatMapFor(subtype) {
        if (!this.compatCache[subtype]) {
            let map = new Map();
            for (let entry of (this.models[subtype] || [])) {
                let clazz = this.modelClasses[entry[1]];
                map.set(MState.starKey(entry[0]), clazz && clazz.compat_class ? clazz.compat_class : null);
            }
            this.compatCache[subtype] = map;
        }
        return this.compatCache[subtype];
    }

    /** The compat class of one model, via the class id that ListT2IParams already shipped alongside it.
     * Null when the model is unknown or its class declares no compat class. Uses no extra request: both
     * `models` and `modelClasses` are loaded once at boot. */
    compatClassOf(subtype, modelName) {
        if (!modelName) {
            return null;
        }
        return this.compatMapFor(subtype).get(MState.starKey(modelName)) || null;
    }

    /** The compat classes an architecture group covers, inferred from the checkpoints its presets select.
     * Empty when the group names no resolvable model - callers must treat empty as "don't filter" rather
     * than "match nothing", or a group of presets that only set a sampler would hide every model. */
    groupCompatClasses(group) {
        let classes = new Set();
        if (!group) {
            return classes;
        }
        for (let preset of this.presets) {
            if (MState.presetGroup(preset.title) != group || !preset.param_map) {
                continue;
            }
            let compat = this.compatClassOf('Stable-Diffusion', preset.param_map['model']);
            if (compat) {
                classes.add(compat);
            }
        }
        return classes;
    }

    /** Filters a ListModels result down to the selected architecture.
     *
     * Folder prefix is the first gate, because that is how the architecture picker itself is defined (the
     * leading segment of preset titles: 'ill/PLATT Pose' -> 'ill') and how this library is laid out on disk.
     * Compat class alone cannot tell Illustrious from Pony from Anima - they all report SDXL - so a qwen or
     * flux LoRA sitting in its own folder used to survive an 'ill' filter whenever it had no class, or the
     * wrong shared one. A model whose first folder is a *different* known group is out. A model in the
     * selected group is in, even if its class is missing.
     *
     * Models outside any known group still use compat class. Unknown class is kept: unknown is not the same
     * as incompatible, and silently hiding a model the user can see in the full UI is worse than showing one
     * extra. An empty class set still means "don't class-filter" - a group whose presets set no checkpoint
     * would otherwise hide everything that isn't in that folder. */
    filterByArch(models, subtype) {
        if (!this.archFilter) {
            return models;
        }
        // Case-folded on both sides: the filter's group names come from preset titles and the folders from
        // disk paths, and 'Flux2/' vs a 'flux2/...' preset group is the same architecture, not a different one.
        let filter = this.archFilter.toLowerCase();
        let groups = new Set(this.presetGroups().map(g => g.toLowerCase()));
        let classes = this.groupCompatClasses(this.archFilter);
        let starred = this.starredNameSet(subtype);
        return models.filter(model => {
            // A starred model is always shown, exactly like an active preset survives the same filter: the
            // user explicitly pinned it, and a misclassified folder or compat class silently hiding a
            // favourite is the worst failure this filter can produce.
            if (starred.has(MState.starKey(model.name))) {
                return true;
            }
            let folder = MState.modelFolder(model.name).toLowerCase();
            if (folder == filter) {
                return true;
            }
            if (folder && groups.has(folder)) {
                return false;
            }
            if (classes.size == 0) {
                return true;
            }
            let compat = this.compatClassOf(subtype, model.name);
            return !compat || classes.has(compat);
        });
    }

    /** One model name reduced to the form starred-name matching runs on: extension stripped, lowercased,
     * backslashes folded to forward slashes. The genpage stars whatever string its ListModels happened to
     * report, and that disagrees with this client's ListModels in more ways than the extension - Windows
     * paths can differ in separator, and a model renamed only by case keeps its old starred entry. Every
     * one of those mismatches used to read as "my favorite isn't pinned". Case-folding cannot collide two
     * genuinely different models unless they share a filename up to case, which the filesystem forbids. */
    static starKey(name) {
        return MState.stripModelExt(name).replaceAll('\\', '/').toLowerCase();
    }

    /** Starred names for one subtype, as starKey forms. SetStarredModels stores whatever name the genpage's
     * star button had - ListModels' full name, usually with .safetensors - but presets and some older rows
     * omit it. Matching only the exact string dropped every favourite whose stored form disagreed, which on
     * a 120-row cap looks like "my stars are missing". */
    starredNameSet(subtype) {
        let set = new Set();
        let starred = this.starredModels[subtype];
        if (!starred) {
            return set;
        }
        for (let i = 0; i < starred.length; i++) {
            set.add(MState.starKey(starred[i]));
        }
        return set;
    }

    /** Whether a model is starred - extension-, case-, and separator-insensitive. */
    isStarred(subtype, name) {
        if (!name) {
            return false;
        }
        return this.starredNameSet(subtype).has(MState.starKey(name));
    }

    /** Lifts starred models to the front of a picker list, leaving everything else in the order it arrived.
     *
     * This is ordering, not filtering: the pickers cap how many rows they render (MCreate.ListCap), so on a
     * library of any size a starred model living late in the alphabet was simply never on screen unless you
     * searched for it by name - which defeats the point of starring it. Sorted before the cap, deliberately.
     *
     * Array.sort is stable (spec-guaranteed since ES2019), so ties keep the server's own sortBy: Name order
     * and this stays a lift rather than a reshuffle. Returns a copy: the caller's list is the cached
     * ListModels result, and reordering that in place would make the cache order depend on view history. */
    starredFirst(list, subtype) {
        let set = this.starredNameSet(subtype);
        if (set.size == 0) {
            return list;
        }
        let hit = (name) => set.has(MState.starKey(name));
        return list.slice().sort((a, b) => (hit(b.name) ? 1 : 0) - (hit(a.name) ? 1 : 0));
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
                'customRatio': this.customRatio,
                'archFilter': this.archFilter,
                'promptImagePaths': this.promptImages.filter(img => img.kind == 'path').map(img => img.value),
            };
            localStorage.setItem('m_client_state', JSON.stringify(data));
            this.saveFailed = false;
        }
        catch (e) {
            console.error('state save failed', e);
            // Warn once per failure run, not on every keystroke: save() is called from changed(), so a full
            // localStorage (or Safari private mode, where setItem throws outright) would otherwise repaint the
            // error strip continuously. Silence here used to mean the prompt/preset state stopped persisting
            // with nothing to show for it, and the next load quietly restored a stale copy instead.
            if (!this.saveFailed) {
                this.saveFailed = true;
                mUI.warn('Settings are not being saved on this device - browser storage is full or blocked.');
            }
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
            this.customRatio = data.customRatio || 0;
            this.archFilter = data.archFilter || '';
            this.promptImages = (data.promptImagePaths || []).map(path => ({ 'kind': 'path', 'value': path }));
        }
        catch (e) {
            console.error('state load failed', e);
            // A corrupt/unparseable blob would otherwise be re-read and re-fail on every boot with no sign.
            // Drop it so the client starts clean next time, and say so - the user's prompt and preset
            // selections are gone either way, and finding that out silently is worse.
            try {
                localStorage.removeItem('m_client_state');
            }
            catch (e2) {
                console.error('state reset failed', e2);
            }
            mUI.warn('Saved mobile settings could not be read and have been reset.');
        }
    }
}

/** Reference width/height per aspect ratio at a 512 side length. UPSTREAM COUPLING: this table and the
 * scaling math in resolutionFor must stay identical to T2IParamInput.ResolutionAspectReferences (C#) and
 * to aspectRatios in genpage params.js - the server does the real computation, this copy only powers the
 * on-screen readout, so a drift here shows up as a readout that lies about the output size. */
MState.AspectReferences = {
    '1:1': [512, 512],
    '4:3': [576, 448],
    '3:2': [608, 416],
    '8:5': [608, 384],
    '16:9': [672, 384],
    '21:9': [768, 320],
    '3:4': [448, 576],
    '2:3': [416, 608],
    '5:8': [384, 608],
    '9:16': [384, 672],
    '9:21': [320, 768]
};

/** Fork-added aspect ratios the server's table does not carry, label -> width/height. These cannot be sent
 * as an aspectratio value (the server would not recognise them and would silently fall back to raw
 * width/height), so buildGenInput converts them to 'Custom' plus computed pixels. */
MState.ExtraAspects = {
    '3:1': 3 / 1,
    '2:1': 2 / 1,
    '7:4': 7 / 4,
    '7:5': 7 / 5,
    '5:7': 5 / 7,
    '4:7': 4 / 7,
    '1:2': 1 / 2,
    '1:3': 1 / 3
};

mState = new MState();
