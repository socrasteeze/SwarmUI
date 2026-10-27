/** Represents a model compatibility class (a set of related model classes) (eg all of SDXL's sub-variants and parts share one compat class). */
class ModelCompatClass {

    constructor(data) {
        this.id = data.id;
        this.shortCode = data.short_code;
        this.isText2Video = data.is_text2video;
        this.isImage2Video = data.is_image2video;
        this.lorasTargetTextEnc = data.loras_target_text_enc;
        this.isAudioModel = data.is_audio_model;
        this.resolutionPrecision = data.resolution_precision || 16;
    }
}

/** Represents a class of models (ie an architecture) (eg SDXL 1.0 Base). */
class ModelClass {

    constructor(data, compatClass) {
        this.id = data.id;
        this.name = data.name;
        this.compatClass = compatClass;
        this.standardWidth = data.standard_width;
        this.standardHeight = data.standard_height;
        if (!compatClass) {
            console.warn(`Model class '${this.id}' has missing compat class!`);
        }
    }
}

/** Represents a single model (eg a safetensors file). */
class Model {

    constructor(name, subType, modelClass) {
        this.name = name;
        this.cleanName = cleanModelName(name);
        this.subType = subType;
        this.modelClass = modelClass;
    }

    /** Returns the 'data-cleanname' for use in a dropdown. */
    cleanDropdown() {
        return `${escapeHtmlNoBr(this.cleanName)} <span class="model-short-code">${this.modelClass?.compatClass?.shortCode ?? ''}</span>`;
    }
}

/** Collection of helper functions and data related to models. */
class ModelsHelpers {

    constructor() {
        this.imageBlockElem = getRequiredElementById('edit_model_image_block');
        let imageHtml = makeImageInput(null, 'edit_model_image', null, 'Image', 'Image', true, false);
        this.imageBlockElem.innerHTML = imageHtml;
        this.imageElem = getRequiredElementById('edit_model_image');
        this.enableImageElem = getRequiredElementById('edit_model_image_toggle');
        this.currentModelSelectorElem = getRequiredElementById('current_model');
        this.compatClasses = {};
        this.modelClasses = {};
        this.models = {};
    }

    /** Loads the model classes and models from the server data (ListT2IParams). */
    loadClassesFromServer(modelsMap, compatClasses, modelClasses) {
        this.compatClasses = {};
        this.modelClasses = {};
        for (let compatClass of Object.values(compatClasses)) {
            this.compatClasses[compatClass.id] = new ModelCompatClass(compatClass);
        }
        for (let modelClass of Object.values(modelClasses)) {
            this.modelClasses[modelClass.id] = new ModelClass(modelClass, this.compatClasses[modelClass.compat_class]);
        }
        this.models = {};
        for (let key of Object.keys(modelsMap)) {
            let set = {};
            for (let modelData of modelsMap[key]) {
                set[modelData[0]] = new Model(modelData[0], key, this.modelClasses[modelData[1]]);
            }
            this.models[key] = set;
        }
        let selectorVal = this.currentModelSelectorElem.value;
        this.currentModelSelectorElem.innerHTML = '';
        let emptyOption = document.createElement('option');
        emptyOption.value = '';
        emptyOption.innerText = '';
        this.currentModelSelectorElem.appendChild(emptyOption);
        for (let model of Object.values(this.models['Stable-Diffusion'])) {
            let option = document.createElement('option');
            option.value = model.cleanName;
            option.innerText = model.cleanName;
            option.dataset.cleanname = model.cleanDropdown();
            this.currentModelSelectorElem.appendChild(option);
        }
        this.currentModelSelectorElem.value = selectorVal;
    }

    /** Returns the model data for the given model sub-type and model name, or null if not found. */
    getDataFor(subType, modelName) {
        if (!(subType in this.models)) {
            console.warn(`Model sub-type '${subType}' not found!`);
            return null;
        }
        let set = this.models[subType];
        if (modelName in set) {
            return set[modelName];
        }
        if (`${modelName}.safetensors` in set) {
            return set[`${modelName}.safetensors`];
        }
        return null;
    }

    /** Returns a list of all model names for the given sub-type. */
    listModelNames(subType) {
        if (!(subType in this.models)) {
            console.warn(`Model sub-type '${subType}' not found!`);
            return [];
        }
        let set = this.models[subType];
        return Object.keys(set);
    }
}

/** Collection of helper functions and data related to models, just an instance of {@link ModelsHelpers}. */
let modelsHelpers = new ModelsHelpers();

//////////// TODO: Merge all the below into the class above (or multiple separate classes)

let models = {};
let curModelMenuModel = null;
let curModelMenuBrowser = null;
let nativelySupportedModelExtensions = ["safetensors", "sft", "engine", "gguf"];
let modelIconUrlCache = {};
let starredModels = null;

function editModelGetHashNow() {
    if (curModelMenuModel == null) {
        return;
    }
    let model = curModelMenuModel;
    genericRequest('GetModelHash', { 'modelName': curModelMenuModel.name, 'subtype': curModelMenuBrowser.subType }, data => {
        model.hash = data.hash;
        if (curModelMenuModel == model) {
            editModelFillTechnicalInfo(curModelMenuModel);
        }
    });
}

function editModelFillTechnicalInfo(model) {
    let technical = `${translate('Created')}: ${escapeHtml(formatDateTime(new Date(model.time_created)))}\n<br>${translate('Modified')}: ${escapeHtml(formatDateTime(new Date(model.time_modified)))}`;
    if (model.hash) {
        technical += `\n<br>${translate('Hash')}: ${escapeHtml(model.hash)}`;
    }
    else {
        technical += `\n<br>${translate('Hash')}: ${translate('(Not available)')} <button class="btn btn-primary basic-button small-button translate" onclick="editModelGetHashNow()" title="Scan the file data and build a hash, then update its value into the model metadata">${translate('Load Hash')}</button>`;
    }
    getRequiredElementById('edit_model_technical_data').innerHTML = technical;
}

/** Returns either the expected CivitAI url for a model, or empty string if unknown. */
function getCivitUrlGuessFor(model) {
    if (!model.description) {
        return '';
    }
    let civitUrl = '';
    // (Hacky but we don't have a dedicated datastore for this, just included at the top of descriptions generally)
    let civitUrlStartIndex = model.description.indexOf('<a href="https://civitai.red/models/');
    if (civitUrlStartIndex == -1) {
        civitUrlStartIndex = model.description.indexOf('<a href="https://civitai.com/models/');
    }
    if (civitUrlStartIndex != -1) {
        let end = model.description.indexOf('"', civitUrlStartIndex + '<a href="'.length);
        if (end != -1) {
            civitUrl = model.description.substring(civitUrlStartIndex + '<a href="'.length, end);
            if (civitUrl.startsWith('https://civitai.com/')) {
                civitUrl = `https://civitai.red/${civitUrl.substring('https://civitai.com/'.length)}`;
            }
            if (!civitUrl.includes("?modelVersionId=") || civitUrl.length > 200 || civitUrl.includes("?modelVersionId=null")) {
                console.log(`Invalid CivitAI URL (failed sanity check): ${civitUrl}`);
                civitUrl = '';
            }
        }
    }
    return civitUrl;
}

function deleteModel(model, browser) {
    if (model == null) {
        return;
    }
    curModelMenuModel = model;
    curModelMenuBrowser = browser;
    getRequiredElementById('delete_model_name').innerText = model.name;
    $('#delete_model_modal').modal('show');
}

function doDeleteModelNow() {
    let model = curModelMenuModel;
    if (model == null) {
        return;
    }
    genericRequest('DeleteModel', { 'modelName': model.name, 'subtype': curModelMenuBrowser.subType }, data => {
        curModelMenuBrowser.browser.lightRefresh();
    });
    $('#delete_model_modal').modal('hide');
}

function renameModel(model, browser) {
    if (model == null) {
        return;
    }
    curModelMenuModel = model;
    curModelMenuBrowser = browser;
    let lastSlash = model.name.lastIndexOf('/');
    let name = lastSlash != -1 ? model.name.substring(lastSlash + 1) : model.name;
    let selector = getRequiredElementById('model_rename_downloader_folder');
    modelDownloader.buildFolderSelector(selector);
    selector.value = lastSlash != -1 ? model.name.substring(0, lastSlash) : '(None)';
    getRequiredElementById('rename_model_name').innerText = model.name;
    getRequiredElementById('model_rename_downloader_name').value = name;
    $('#rename_model_modal').modal('show');
}

function doRenameModelNow() {
    let model = curModelMenuModel;
    if (model == null) {
        return;
    }
    let name = getRequiredElementById('model_rename_downloader_name').value.trim();
    if (name == '') {
        return;
    }
    let folder = getRequiredElementById('model_rename_downloader_folder').value;
    let newName = folder == '(None)' ? name : `${folder}/${name}`;
    genericRequest('RenameModel', { 'oldName': model.name, 'newName': newName, 'subtype': curModelMenuBrowser.subType }, data => {
        curModelMenuBrowser.browser.refresh();
    });
    $('#rename_model_modal').modal('hide');
}

function modelRenameNameInput() {
    let name = getRequiredElementById('model_rename_downloader_name');
    if (name.value.trim() == '') {
        name.style.borderColor = 'red';
    }
    else {
        name.style.borderColor = '';
    }
    if (name.value.includes(' ')) {
        name.value = name.value.replaceAll(' ', '_');
    }
}

function editModel(model, browser) {
    if (model == null) {
        return;
    }
    curModelMenuModel = model;
    curModelMenuBrowser = browser;
    clearMediaFileInput(modelsHelpers.imageElem);
    modelsHelpers.enableImageElem.checked = false;
    triggerChangeFor(modelsHelpers.enableImageElem);
    editModelFillTechnicalInfo(model);
    getRequiredElementById('edit_model_civitai_url').value = getCivitUrlGuessFor(model);
    getRequiredElementById('edit_model_civitai_info').innerText = '';
    getRequiredElementById('edit_model_name').value = model.title || model.name;
    let modelTypeSelector = getRequiredElementById('edit_model_type');
    modelTypeSelector.value = model.architecture || '';
    for (let opt of modelTypeSelector.options) {
        let slash = opt.value.indexOf('/');
        let postSlash = slash > 0 ? opt.value.substring(slash + 1) : '';
        if (opt.value == model.architecture || browser.subIds.includes(postSlash)) {
            opt.style.display = 'block';
        }
        else {
            opt.style.display = 'none';
        }
    }
    getRequiredElementById('edit_model_prediction_type').value = model.prediction_type || '';
    getRequiredElementById('edit_model_resolution').value = `${model.standard_width}x${model.standard_height}`;
    for (let val of ['description', 'author', 'usage_hint', 'date', 'license', 'trigger_phrase', 'tags']) {
        getRequiredElementById(`edit_model_${val}`).value = model[val] || '';
    }
    getRequiredElementById('edit_model_is_negative').checked = model.is_negative_embedding || false;
    getRequiredElementById('edit_model_is_negative_div').style.display = model.architecture && model.architecture.endsWith('/textual-inversion') ? 'block' : 'none';
    getRequiredElementById('edit_model_lora_default_weight').value = model.lora_default_weight || '';
    getRequiredElementById('edit_model_lora_default_weight_div').style.display = model.architecture && model.architecture.endsWith('/lora') ? 'block' : 'none';
    getRequiredElementById('edit_model_lora_default_confinement').value = model.lora_default_confinement || '';
    getRequiredElementById('edit_model_lora_default_confinement_div').style.display = model.architecture && model.architecture.endsWith('/lora') ? 'block' : 'none';
    let run = () => {
		modelPresetLinkManager.buildPresetLinkSelectorForModel(curModelMenuBrowser.subType, model.name, 'edit_model_preset_id');
        triggerChangeFor(modelsHelpers.enableImageElem);
        $('#edit_model_modal').modal('show');
    };
    let curImg = currentImageHelper.getCurrentImage();
    if (curImg && curImg.tagName == 'IMG') {
        setMediaFileDirect(modelsHelpers.imageElem, curImg.src, 'image', 'cur', 'cur', () => {
            modelsHelpers.enableImageElem.checked = false;
            run();
        });
    }
    else {
        run();
    }
}

function denseStringifyHeaderJson(header) {
    let output = '{';
    for (let key in header) {
        let value = header[key];
        // if keys within the sub-object are exactly 'dtype', 'shape', 'data_offsets', then special render.
        if (typeof value == 'object' && Object.keys(value).length == 3 && value.dtype && value.shape && value.data_offsets) {
            output += `\n    "${key}": "dtype": "${value.dtype}", "shape": ${JSON.stringify(value.shape)}, "data_offsets": ${JSON.stringify(value.data_offsets)},`;
        }
        else {
            let procd = JSON.stringify({ [key]: value }, null, 4);
            output += `\n${procd.substring(2, procd.length - 2)},`;
        }
    }
    output += '\n}\n\n\n';
    return output;
}

function viewRawHeader(model, browser) {
    if (model == null) {
        return;
    }
    genericRequest('GetModelHeaders', { 'model': model.name, 'subtype': browser.subType }, data => {
        let header = data.headers;
        let headerText = denseStringifyHeaderJson(header);
        getRequiredElementById('view_raw_header_modal_content').innerText = headerText;
        getRequiredElementById('view_raw_header_modal_title').innerText = model.name;
        $('#view_raw_header_modal').modal('show');
    });
}

function edit_model_load_civitai() {
    let url = getRequiredElementById('edit_model_civitai_url').value;
    let info = getRequiredElementById('edit_model_civitai_info');
    if (!url) {
        let model = curModelMenuModel;
        info.innerText = 'Loading hash...';
        genericRequest('GetModelHash', { 'modelName': curModelMenuModel.name, 'subtype': curModelMenuBrowser.subType }, data => {
            model.hash = data.hash;
            if (curModelMenuModel == model) {
                editModelFillTechnicalInfo(curModelMenuModel);
                info.innerText = 'Hash loaded, searching civitai...';
                modelDownloader.searchCivitaiForHash(model.hash, (url) => {
                    if (url) {
                        info.innerText = 'URL found, loading...';
                        getRequiredElementById('edit_model_civitai_url').value = url;
                        edit_model_load_civitai();
                    }
                    else {
                        info.innerText = 'No CivitAI URL found for this model hash.';
                    }
                });
            }
        });
        return;
    }
    let [id, versId] = modelDownloader.parseCivitaiUrl(url);
    if (!id && !versId) {
        info.innerText = 'Invalid URL.';
        return;
    }
    info.innerText = 'Loading...';
    modelDownloader.getCivitaiMetadata(id, versId, (rawData, rawVersion, metadata, modelType, url, img, imgs, errMsg) => {
        if (!rawData) {
            info.innerText = `Failed to load metadata. ${(errMsg ?? '')}`;
            return;
        }
        if (!img) {
            info.innerText = 'No preview image on CivitAI. Title, tags, and description were left unchanged.';
            return;
        }
        info.innerText = 'Saving preview...';
        genericRequest('SaveModelPreviewImage', {
            'model': curModelMenuModel.name,
            'subtype': curModelMenuBrowser.subType,
            'image': img
        }, () => {
            setMediaFileDirect(modelsHelpers.imageElem, img, 'image', 'cur', 'cur', () => {
                modelsHelpers.enableImageElem.checked = false;
                triggerChangeFor(modelsHelpers.enableImageElem);
            });
            info.innerText = 'Preview saved. Title, tags, and description were left unchanged. Save in this editor still rewrites the .swarm.json sidecar and can replace tags.';
            if (curModelMenuBrowser && curModelMenuBrowser.browser) {
                curModelMenuBrowser.browser.lightRefresh();
            }
        }, 0, (err) => {
            info.innerText = `Could not save preview. ${err || ''}`;
        });
    }, curModelMenuModel.name, false);
}

function save_edit_model() {
    let model = curModelMenuModel;
    if (model == null) {
        console.log("Model do save: no model");
        return;
    }
    let resolution = getRequiredElementById('edit_model_resolution').value.split('x');
    let data = {
        'model': model.name,
        'title': getRequiredElementById('edit_model_name').value,
        'standard_width': parseInt(resolution[0]),
        'standard_height': parseInt(resolution[1]),
        'preview_image': '',
        'preview_image_metadata': currentMetadataVal
    };
    for (let val of ['author', 'type', 'description', 'usage_hint', 'date', 'license', 'trigger_phrase', 'tags', 'prediction_type']) {
        data[val] = getRequiredElementById(`edit_model_${val}`).value;
    }
    data['is_negative_embedding'] = (model.architecture || '').endsWith('/textual-inversion') ? getRequiredElementById('edit_model_is_negative').checked : false;
    data['lora_default_weight'] = (model.architecture || '').endsWith('/lora') ? getRequiredElementById('edit_model_lora_default_weight').value : '';
    data['lora_default_confinement'] = (model.architecture || '').endsWith('/lora') ? getRequiredElementById('edit_model_lora_default_confinement').value : '';
    data.subtype = curModelMenuBrowser.subType;
    function complete() {
        genericRequest('EditModelMetadata', data, data => {
            curModelMenuBrowser.browser.lightRefresh();
        });
        let presetSelect = document.getElementById('edit_model_preset_id');
        let presetTitle = presetSelect?.value || '';
        modelPresetLinkManager.setLink(curModelMenuBrowser.subType, model.name, presetTitle);
        $('#edit_model_modal').modal('hide');
    }
    if (modelsHelpers.enableImageElem.checked) {
        let imageVal = getInputVal(modelsHelpers.imageElem);
        if (imageVal) {
            data['preview_image_metadata'] = currentMetadataVal;
            imageToData(imageVal, (dataURL) => {
                data['preview_image'] = dataURL;
                complete();
            }, true);
            return;
        }
        else {
            data['preview_image'] = 'clear';
            delete data['preview_image_metadata'];
        }
    }
    complete();
}

/** Fork-owned cache behind {@link getActiveModelCompatClasses}. A microtask clears it, so one synchronous sort or render pass computes the list once. */
let activeModelCompatCache = null;

/**
 * Fork-owned. The distinct compat class IDs of the Stable-Diffusion model params in use: every enabled one that has a value (Model, Refiner Model, Video Model, ...),
 * plus the value an active Classic preset sets for any of them. Presets apply after raw params at generate time, so a preset that sets the model decides which LoRAs load.
 * Cached until the current task ends, because sorting and rendering a model page asks this once per comparison and per row.
 */
function getActiveModelCompatClasses() {
    if (activeModelCompatCache) {
        return activeModelCompatCache;
    }
    let found = [];
    let addCompat = (modelName) => {
        let compat = modelName ? modelsHelpers.getDataFor('Stable-Diffusion', modelName)?.modelClass?.compatClass?.id : null;
        if (compat && !found.includes(compat)) {
            found.push(compat);
        }
    };
    let paramTypes = typeof gen_param_types != 'undefined' ? gen_param_types : null;
    let presets = typeof currentPresets != 'undefined' ? currentPresets : null;
    for (let param of paramTypes || []) {
        if (param.type != 'model' || param.subtype != 'Stable-Diffusion') {
            continue;
        }
        let input = document.getElementById(`input_${param.id}`);
        if (input && input.value && isParamEnabled(param)) {
            addCompat(input.value);
        }
        for (let preset of presets || []) {
            let presetValue = preset.param_map ? preset.param_map[param.id] : null;
            if (typeof presetValue == 'string') {
                addCompat(presetValue);
            }
        }
    }
    activeModelCompatCache = found;
    queueMicrotask(() => {
        activeModelCompatCache = null;
    });
    return found;
}

/** Fork-owned. Every compat class a LoRA, VAE, or ControlNet may match right now: {@link getActiveModelCompatClasses} plus the current model's own. This is the set {@link isModelArchCorrect} accepts. */
function getAcceptedModelCompatClasses() {
    let accepted = getActiveModelCompatClasses().slice();
    let current = currentModelHelper.curCompatClass;
    if (current && !accepted.includes(current)) {
        accepted.push(current);
    }
    return accepted;
}

/** Fork-owned. The compat class set {@link getAcceptedModelCompatClasses} returns, sorted and comma-joined, so two sets compare equal regardless of order. */
function acceptedCompatKey() {
    return getAcceptedModelCompatClasses().slice().sort().join(',');
}

/** Fork-owned. The {@link acceptedCompatKey} of the last sub-model listing that was sorted. {@link refreshLoraCompatIfChanged} compares against it. */
let lastAcceptedCompatKey = '';

function isModelArchCorrect(model, curCompat = null) {
    if (curCompat == null) {
        for (let compat of getActiveModelCompatClasses()) {
            if (isModelArchCorrect(model, compat)) {
                return true;
            }
        }
        curCompat = currentModelHelper.curCompatClass;
    }
    if (model.compat_class && curCompat) {
        let slash = model.architecture.indexOf('/');
        if (slash != -1) { // Base models are excluded
            // VAEs have more mixed intercompat
            if (model.architecture.endsWith('/vae') && model.compat_class.startsWith('stable-diffusion-v3') && curCompat.startsWith('stable-diffusion-v3')) {
                return true;
            }
            if (model.architecture.endsWith('/vae') && model.compat_class.startsWith('flux-1') && curCompat.startsWith('hidream-i1')) {
                return true;
            }
            if (model.architecture.endsWith('/lora') && model.compat_class.startsWith('flux-1') && curCompat.startsWith('chroma')) {
                return true;
            }
            return model.compat_class == curCompat;
        }
    }
    return true;
}

function cleanModelName(name) {
    return name.endsWith('.safetensors') ? name.substring(0, name.length - '.safetensors'.length) : name;
}

/** Switches to the History tab and filters to images generated with the given model. */
function browseModelHistory(type, model) {
    let filterInput = getRequiredElementById('imagehistorybrowser_filter_input');
    filterInput.value = `${type}: ${cleanModelName(model.name)}`;
    filterInput.dispatchEvent(new Event('input'));
    getRequiredElementById('imagehistorytabclickable').click();
}

class ModelBrowserWrapper {
    /** One page of a LoRA listing. Search and Load more use the same size. */
    static ClientModelListLimit = 500;

    constructor(subType, subIds, container, id, selectOne, extraHeader = '') {
        this.subType = subType;
        this.subIds = subIds;
        this.selectOne = selectOne;
        let format = subType == 'Wildcards' ? 'Small Cards' : 'Cards';
        extraHeader += `<label for="models_${subType}_sort_by">Sort:</label> <select id="models_${subType}_sort_by"><option>Name</option><option>Title</option><option>DateCreated</option><option>DateModified</option></select> <input type="checkbox" id="models_${subType}_sort_reverse"> <label for="models_${subType}_sort_reverse">Reverse</label>`;
        if (subType == 'LoRA') {
            extraHeader += ` <input type="checkbox" id="models_${subType}_compat_only" title="Hide LoRAs that do not match the model, refiner, video model, or preset in use"> <label for="models_${subType}_compat_only" title="Hide LoRAs that do not match the model, refiner, video model, or preset in use">Compatible only</label>`;
        }
        this.browser = new GenPageBrowserClass(container, this.listModelFolderAndFiles.bind(this), id, format, this.describeModel.bind(this), this.selectModel.bind(this), extraHeader);
        this.browser.deferInitialRefresh = true;
        this.browser.maxPreBuild = 50;
        this.promptBox = getRequiredElementById('alt_prompt_textbox');
        this.models = {};
        this.listCache = new Map();
        this.listToken = 0;
        this.missingLookups = {};
        this.pageMore = false;
        this.pageMoreBusy = false;
        this.pageShown = 0;
        this.pageTotal = 0;
        this.pageCompat = '';
        this.pageCompatHidden = 0;
        this.unfilteredTruncated = false;
        this.browser.afterBuildContent = container => this.appendListMore(container);
        this.browser.resolveMissingFile = name => this.resolveMissingModel(name);
        this.browser.refreshHandler = (callback) => {
            refreshParameterValues(true, subType == 'Wildcards' ? 'wildcards' : null, callback);
        };
        this.modelDescribeCallbacks = [];
    }

    sortModelLocal(a, b, files) {
        if (this.subType != 'Stable-Diffusion') {
            let aCorrect = isModelArchCorrect(a);
            let bCorrect = isModelArchCorrect(b);
            if (aCorrect && !bCorrect) {
                return -1;
            }
            if (!aCorrect && bCorrect) {
                return 1;
            }
        }
        let aStarred = this.isStarred(a.name);
        let bStarred = this.isStarred(b.name);
        if (aStarred && !bStarred) {
            return -1;
        }
        if (!aStarred && bStarred) {
            return 1;
        }
        let aName = a.name.toLowerCase();
        let bName = b.name.toLowerCase();
        if (aName.endsWith('.safetensors') && !bName.endsWith('.safetensors')) {
            return -1;
        }
        if (!aName.endsWith('.safetensors') && bName.endsWith('.safetensors')) {
            return 1;
        }
        if (aName.endsWith('.engine') && !bName.endsWith('.engine')) {
            return -1;
        }
        if (!aName.endsWith('.engine') && bName.endsWith('.engine')) {
            return 1;
        }
        let aIndex = files.indexOf(a);
        let bIndex = files.indexOf(b);
        return aIndex - bIndex;
    }

    listModelFolderAndFiles(path, isRefresh, callback, depth) {
        if (!starredModels) {
            setTimeout(() => {
                this.listModelFolderAndFiles(path, isRefresh, callback, depth);
            }, 100);
            return;
        }
        let sort = this.readSort();
        let fix = sort.fix;
        this.fetchModels(path, depth, sort.sortBy, sort.reverse, '', 0, isRefresh, callback, fix, false);
    }

    /** The sort the header is showing, or the stored sort on the first call before that header exists. */
    readSort() {
        let sortBy = localStorage.getItem(`models_${this.subType}_sort_by`) ?? 'Name';
        let reverse = localStorage.getItem(`models_${this.subType}_sort_reverse`) == 'true';
        let sortElem = document.getElementById(`models_${this.subType}_sort_by`);
        let sortReverseElem = document.getElementById(`models_${this.subType}_sort_reverse`);
        let fix = null;
        if (sortElem) {
            sortBy = sortElem.value;
            reverse = sortReverseElem.checked;
        }
        else { // first call happens before headers are added built atm
            fix = () => {
                let sortElem = document.getElementById(`models_${this.subType}_sort_by`);
                let sortReverseElem = document.getElementById(`models_${this.subType}_sort_reverse`);
                sortElem.value = sortBy;
                sortReverseElem.checked = reverse;
                sortElem.addEventListener('change', () => {
                    localStorage.setItem(`models_${this.subType}_sort_by`, sortElem.value);
                    this.browser.lightRefresh();
                });
                sortReverseElem.addEventListener('change', () => {
                    localStorage.setItem(`models_${this.subType}_sort_reverse`, sortReverseElem.checked);
                    this.browser.lightRefresh();
                });
                this.wireCompatToggle();
            }
        }
        return { 'sortBy': sortBy, 'reverse': reverse, 'fix': fix };
    }

    /** Whether the LoRA "Compatible only" filter is on: the header checkbox once it exists, else the stored choice. On when never set. */
    isCompatOnly() {
        if (this.subType != 'LoRA') {
            return false;
        }
        let elem = document.getElementById('models_LoRA_compat_only');
        if (elem) {
            return elem.checked;
        }
        return localStorage.getItem('models_LoRA_compat_only') != 'false';
    }

    /** Stores the "Compatible only" choice, mirrors it into the header checkbox if that exists, and re-lists. */
    setCompatOnly(value) {
        localStorage.setItem('models_LoRA_compat_only', value);
        let elem = document.getElementById('models_LoRA_compat_only');
        if (elem) {
            elem.checked = value;
        }
        this.browser.lightRefresh();
    }

    /** Sets the "Compatible only" checkbox from storage and listens for changes. Runs once the header exists, like the sort controls. */
    wireCompatToggle() {
        let elem = document.getElementById('models_LoRA_compat_only');
        if (!elem) {
            return;
        }
        elem.checked = localStorage.getItem('models_LoRA_compat_only') != 'false';
        elem.addEventListener('change', () => {
            this.setCompatOnly(elem.checked);
        });
    }

    /** The comma-joined compat classes to send as the ListModels `compat` filter, or '' when this listing is not filtered. */
    compatFilterValue() {
        if (!this.isCompatOnly()) {
            return '';
        }
        return getAcceptedModelCompatClasses().join(',');
    }

    /** Cache key for one folder page. Offset is not part of the key: the entry stores every page loaded so far. The compat filter is part of it, so toggling it or changing the model does not serve a stale page. */
    listCacheKey(path, depth, sortBy, reverse, search, compat = '') {
        return `${path}\n${Math.round(depth)}\n${sortBy}\n${reverse ? '1' : '0'}\n${search || ''}\n${compat}`;
    }

    /**
     * Loads one ListModels window. LoRA sends limit/offset/search. Other subtypes keep the uncapped request.
     * A saved filter on a truncated LoRA folder is sent as a follow-up search instead of hiding the first page locally.
     */
    fetchModels(path, depth, sortBy, reverse, search, offset, isRefresh, callback, fix, append) {
        if (isRefresh && offset == 0 && !append) {
            this.listCache = new Map();
            this.unfilteredTruncated = false;
        }
        // Load more keeps the filter its first page used, even if the inputs moved since.
        let compat = append ? this.pageCompat : this.compatFilterValue();
        let key = this.listCacheKey(path, depth, sortBy, reverse, search, compat);
        if (!append && offset == 0 && !isRefresh) {
            let cached = this.listCache.get(key);
            if (cached) {
                this.applyCached(path, depth, sortBy, reverse, search, cached, callback, fix);
                return;
            }
        }
        let token = ++this.listToken;
        this.pageMoreBusy = true;
        let request = {
            'path': path,
            'depth': Math.round(depth),
            'subtype': this.subType,
            'sortBy': sortBy,
            'sortReverse': reverse
        };
        if (this.subType == 'LoRA') {
            request.limit = ModelBrowserWrapper.ClientModelListLimit;
            request.offset = offset;
            request.search = search || '';
            if (compat != '') {
                request.compat = compat;
            }
        }
        genericRequest('ListModels', request, data => {
            if (token != this.listToken) {
                return;
            }
            this.pageMoreBusy = false;
            this.browser.loadRequested = false;
            let pageFiles = data.files || [];
            let prior = append ? this.listCache.get(key) : null;
            let files = pageFiles;
            if (prior) {
                let seen = {};
                files = prior.files.slice();
                for (let file of files) {
                    seen[file.name] = true;
                }
                for (let file of pageFiles) {
                    if (!seen[file.name]) {
                        files.push(file);
                        seen[file.name] = true;
                    }
                }
            }
            let total = data.total != null ? data.total : files.length;
            let cached = {
                'folders': prior && prior.folders ? prior.folders : (data.folders || []),
                'files': files,
                'total': total,
                'compat': compat,
                'compatHidden': data.compat_hidden || 0
            };
            this.listCache.set(key, cached);
            if (search == '' && this.subType == 'LoRA' && files.length < total && this.browser.filter) {
                this.unfilteredTruncated = true;
                this.fetchModels(path, depth, sortBy, reverse, this.browser.filter, 0, false, callback, fix, false);
                return;
            }
            this.publishListing(path, depth, sortBy, reverse, search, cached, callback, fix);
        }, 0, e => {
            if (token != this.listToken) {
                return;
            }
            this.pageMoreBusy = false;
            this.browser.loadRequested = false;
            let hadLoaded = this.browser.everLoaded;
            showError(`Failed to list models: ${e}`);
            if (callback) {
                callback([], []);
            }
            if (!hadLoaded) {
                this.browser.everLoaded = false;
            }
        });
    }

    /** Publishes a cache hit, or follows a saved filter with a server search when the folder is still truncated. */
    applyCached(path, depth, sortBy, reverse, search, cached, callback, fix) {
        if (search == '' && this.subType == 'LoRA' && cached.files.length < cached.total && this.browser.filter) {
            this.unfilteredTruncated = true;
            this.fetchModels(path, depth, sortBy, reverse, this.browser.filter, 0, false, callback, fix, false);
            return;
        }
        this.browser.loadRequested = false;
        this.publishListing(path, depth, sortBy, reverse, search, cached, callback, fix);
    }

    /** Hands the window to the browser and remembers how to load the next page. */
    publishListing(path, depth, sortBy, reverse, search, cached, callback, fix) {
        if (search == '') {
            this.unfilteredTruncated = this.subType == 'LoRA' && cached.files.length < cached.total;
        }
        this.pagePath = path;
        this.pageDepth = depth;
        this.pageSortBy = sortBy;
        this.pageReverse = reverse;
        this.pageSearch = search || '';
        this.pageShown = cached.files.length;
        this.pageTotal = cached.total;
        this.pageCompat = cached.compat || '';
        this.pageCompatHidden = cached.compatHidden || 0;
        this.pageMore = this.subType == 'LoRA' && this.pageShown < this.pageTotal;
        this.browser.serverFilter = (this.subType == 'LoRA' && this.unfilteredTruncated) ? text => this.onServerFilter(text) : null;
        this.browser.skipClientFilter = this.pageSearch != '';
        this.browser.countText = this.pageMore ? `${this.pageShown} / ${this.pageTotal}` : null;
        let folders = (cached.folders || []).slice().sort((a, b) => a.localeCompare(b));
        let files = this.decorateFiles(path, cached.files);
        if (callback) {
            callback(folders, files);
        }
        else {
            this.browser.lastListCache = { 'folder': path, 'folders': folders, 'files': files };
            this.browser.build(path, folders, files);
        }
        if (fix) {
            fix();
        }
    }

    /** Starred and architecture order, display names, and the VAE sentinels. */
    decorateFiles(path, serverFiles) {
        let prefix = path == '' ? '' : (path.endsWith('/') ? path : `${path}/`);
        let ordered = (serverFiles || []).slice();
        ordered.sort((a, b) => this.sortModelLocal(a, b, ordered));
        if (this.subType != 'Stable-Diffusion' && this.subType != 'Wildcards') {
            lastAcceptedCompatKey = acceptedCompatKey();
        }
        let files = ordered.map(f => { return { 'name': f.name, 'data': f }; });
        for (let file of files) {
            file.data.display = cleanModelName(file.data.name.substring(prefix.length));
            this.models[file.name] = file;
            if (this.subType == 'Stable-Diffusion') {
                modelIconUrlCache[file.name] = file.data.preview_image;
            }
        }
        if (this.subType == 'VAE') {
            let autoFile = {
                'name': `Automatic`,
                'data': {
                    'name': 'Automatic',
                    'title': 'Automatic',
                    'author': '(Internal)',
                    'architecture': 'VAE',
                    'class': 'VAE',
                    'description': translate('Use the VAE sepcified in your User Settings, the system default VAE for the selected model class, or the VAE built-in to the selected model'),
                    'preview_image': '/imgs/automatic.jpg',
                    'is_supported_model_format': true,
                    'local': true,
                    standard_width: 0,
                    standard_height: 0
                }
            };
            let noneFile = {
                'name': `None`,
                'data': {
                    'name': 'None',
                    'title': 'None',
                    'author': '(Internal)',
                    'architecture': 'VAE',
                    'class': 'VAE',
                    'description': translate('Use the system default VAE for the selected model class, or the VAE built-in to the selected model'),
                    'preview_image': '/imgs/none.jpg',
                    'is_supported_model_format': true,
                    'local': true,
                    standard_width: 0,
                    standard_height: 0
                }
            };
            files = [autoFile, noneFile].concat(files);
        }
        return files;
    }

    /** Filter box on a truncated LoRA folder. Clearing returns to the cached first pages. */
    onServerFilter(text) {
        let sort = this.readSort();
        let path = this.browser.folder || '';
        let depth = this.browser.depth;
        if (!text) {
            this.browser.skipClientFilter = false;
            let key = this.listCacheKey(path, depth, sort.sortBy, sort.reverse, '', this.compatFilterValue());
            let cached = this.listCache.get(key);
            if (cached) {
                this.publishListing(path, depth, sort.sortBy, sort.reverse, '', cached, null, null);
                return;
            }
        }
        this.fetchModels(path, depth, sort.sortBy, sort.reverse, text, 0, false, null, null, false);
    }

    /** Requests the next LoRA page and appends it to the cached window. */
    loadMoreModels() {
        if (this.pageMoreBusy || !this.pageMore) {
            return;
        }
        this.fetchModels(this.pagePath, this.pageDepth, this.pageSortBy, this.pageReverse, this.pageSearch, this.pageShown, false, null, null, true);
    }

    /** The rows under a LoRA listing: the window row when it is truncated, then the row naming what the compat filter hid. */
    appendListMore(container) {
        if (!container) {
            return;
        }
        if (this.pageMore) {
            let row = createDiv(null, 'browser-list-more');
            let label = createSpan(null, 'browser-list-more-label');
            let shown = this.pageShown.toLocaleString();
            let total = this.pageTotal.toLocaleString();
            label.innerText = `Showing ${shown} of ${total} - search or open a subfolder to see more`;
            row.appendChild(label);
            let button = document.createElement('button');
            button.type = 'button';
            button.className = 'basic-button browser-list-more-button';
            button.innerText = 'Load more';
            button.disabled = this.pageMoreBusy == true;
            button.addEventListener('click', () => {
                button.disabled = true;
                this.loadMoreModels();
            });
            row.appendChild(button);
            container.appendChild(row);
        }
        if (this.pageCompatHidden > 0) {
            let row = createDiv(null, 'browser-list-more browser-list-compat-hidden');
            let label = createSpan(null, 'browser-list-more-label');
            label.innerText = `${this.pageCompatHidden.toLocaleString()} LoRAs hidden as incompatible with ${this.pageCompat.split(',').join(', ')}`;
            row.appendChild(label);
            let button = document.createElement('button');
            button.type = 'button';
            button.className = 'basic-button browser-list-more-button';
            button.innerText = 'Show all';
            button.addEventListener('click', () => {
                button.disabled = true;
                this.setCompatOnly(false);
            });
            row.appendChild(button);
            container.appendChild(row);
        }
    }

    /** One model that was not in the loaded page. DescribeModel fills the browser cache for later lookups. */
    resolveMissingModel(name) {
        if (!name || this.models[name] || this.missingLookups[name]) {
            return;
        }
        this.missingLookups[name] = true;
        genericRequest('DescribeModel', { 'modelName': name, 'subtype': this.subType }, data => {
            if (!data || !data.model) {
                return;
            }
            let canonical = data.model.name || name;
            let file = { 'name': canonical, 'data': data.model };
            this.models[name] = file;
            this.models[canonical] = file;
            if (this.browser.lastFiles) {
                this.browser.lastFiles.push(file);
            }
        }, 0, () => {
            delete this.missingLookups[name];
        });
    }

    /** Loads this browser once when its tab is first shown. */
    loadIfNeeded() {
        if (this.browser.everLoaded || this.browser.loadRequested) {
            return;
        }
        this.browser.loadRequested = true;
        this.browser.navigate('');
    }

    isStarred(name) {
        return name && starredModels[this.subType] && starredModels[this.subType].includes(name);
    }

    toggleStar(name) {
        let starred = this.isStarred(name);
        if (starred) {
            starredModels[this.subType] = starredModels[this.subType].filter(n => n != name);
            if (starredModels[this.subType].length == 0) {
                delete starredModels[this.subType];
            }
        }
        else {
            if (!starredModels[this.subType]) {
                starredModels[this.subType] = [];
            }
            starredModels[this.subType].push(name);
        }
        genericRequest('SetStarredModels', starredModels, data => { });
        this.browser.update();
    }

    createCopyableTriggerPhrase(phrase) {
        let copyPhrase = phrase;
        if (getUserSetting('ui.copytriggerphrasewithtrailingcomma', false) && !phrase.endsWith(',')) {
          copyPhrase += ', ';
        }
        let safePhrase = escapeHtmlNoBr(escapeJsString(phrase));
        let safeCopyPhrase = escapeHtmlNoBr(escapeJsString(copyPhrase));
        return `${safePhrase}<button title="Click to copy" class="basic-button trigger-phrase-copy-button" onclick="copyText('${safeCopyPhrase}');doNoticePopover('Copied!', 'notice-pop-green');">&#x29C9;</button>`;
    }

    formatTriggerPhrases(val) {
        let phrases = val.split(';').map(phrase => phrase.trim()).filter(phrase => phrase.length > 0);
        if (phrases.length > 128) {
            phrases = phrases.slice(0, 128);
        }
        return phrases.map(phrase => this.createCopyableTriggerPhrase(phrase)).join('');
    }

    describeModel(model) {
        let description = '';
        let buttons = [];
        let detail_list = [escapeHtml(model.data.name)];
        if (this.subType == 'Stable-Diffusion') {
            modelIconUrlCache[model.name] = model.data.preview_image;
        }
        if (this.subType == 'Stable-Diffusion' && model.data.local) {
            let buttonLoad = () => {
                currentModelHelper.directSetModel(model.data);
                if (currentModelHelper.doModelInstallRequiredCheck()) {
                    return;
                }
                makeWSRequestT2I('SelectModelWS', {'model': model.data.name}, data => {
                    this.browser.navigate(lastModelDir);
                });
            };
            let buttonRefiner = () => {
                let refinerInput = document.getElementById('input_refinermodel');
                if (!refinerInput) {
                    return;
                }
                let name = model.data.name;
                if (name.endsWith('.safetensors')) {
                    name = name.substring(0, name.length - '.safetensors'.length);
                }
                forceSetDropdownValue(refinerInput, name);
                let toggler = document.getElementById('input_group_content_refineupscale_toggle');
                if (toggler && !toggler.checked) {
                    toggler.click();
                    toggleGroupOpen(toggler, true);
                }
            };
            let buttonSetAsImageToVideo = () => {
                let input = document.getElementById('input_videomodel');
                if (!input) {
                    return;
                }
                let name = model.data.name;
                if (name.endsWith('.safetensors')) {
                    name = name.substring(0, name.length - '.safetensors'.length);
                }
                forceSetDropdownValue(input, name);
                triggerChangeFor(input);
                let toggler = document.getElementById('input_group_content_imagetovideo_toggle');
                if (toggler && !toggler.checked) {
                    toggler.click();
                    toggleGroupOpen(toggler, true);
                }
            };
            buttons = [];
            if (permissions.hasPermission('load_models_now')) {
                buttons.push({ label: 'Load Now', onclick: buttonLoad });
            }
            buttons.push({ label: 'Set as Refiner', onclick: buttonRefiner });
            let videoModelInput = document.getElementById('input_videomodel');
            if (videoModelInput && [...videoModelInput.options].map(o => o.value).includes(cleanModelName(model.data.name))) {
                buttons.push({ label: 'Set as Image To Video', onclick: buttonSetAsImageToVideo });
            }
        }
        else if (this.subType == 'Embedding') {
            buttons = [
                { label: 'Add To Prompt', onclick: () => embedAddToPrompt(model.data, 'alt_prompt_textbox'), can_multi: true },
                { label: 'Add To Negative', onclick: () => embedAddToPrompt(model.data, 'alt_negativeprompt_textbox'), can_multi: true },
                { label: 'Remove All Usages', onclick: () => { embedClearFromPrompt(model.data, 'alt_prompt_textbox'); embedClearFromPrompt(model.data, 'alt_negativeprompt_textbox'); }, can_multi: true }
            ];
        }
        else if (this.subType == 'LoRA') {
            buttons = [{ label: 'Add To Prompt', onclick: () => {
                let promptBox = getRequiredElementById('alt_prompt_textbox');
                let name = model.data.name;
                if (name.endsWith('.safetensors')) {
                    name = name.substring(0, name.length - '.safetensors'.length);
                }
                promptBox.value += ` <lora:${name}>`;
                triggerChangeFor(promptBox);
            }, can_multi: true }];
        }
        let isStarred = this.isStarred(model.data.name);
        let starButton = { label: isStarred ? 'Unstar' : 'Star', onclick: () => { this.toggleStar(model.data.name); } };
        buttons.push(starButton);
        if (this.subType == 'Stable-Diffusion') {
            buttons.push({ label: 'Browse History', onclick: () => browseModelHistory('Model', model.data) });
        }
        else if (this.subType == 'LoRA') {
            buttons.push({ label: 'Browse History', onclick: () => browseModelHistory('LoRAs', model.data) });
        }
        else if (this.subType == 'Embedding') {
            buttons.push({ label: 'Browse History', onclick: () => browseModelHistory('used_embeddings', model.data) });
        }
        let name = cleanModelName(model.data.name);
        let display = (model.data.display || name).replaceAll('/', ' / ');
        if (this.subType == 'Wildcards') {
            buttons = [starButton];
            buttons.push({ label: 'Browse History', onclick: () => browseModelHistory('used_wildcards', model.data) });
            if (permissions.hasPermission('edit_wildcards')) {
                buttons.push({ label: 'Edit Wildcard', onclick: () => wildcardHelpers.editWildcard(model.data) });
                buttons.push({ label: 'Duplicate Wildcard', onclick: () => wildcardHelpers.duplicateWildcard(model.data), can_multi: true });
            }
            buttons.push({ label: 'Test Wildcard', onclick: () => wildcardHelpers.testWildcard(model.data) });
            if (permissions.hasPermission('edit_wildcards')) {
                buttons.push({ label: 'Delete Wildcard', onclick: () => {
                    if (confirm("Are you sure want to delete that wildcard?")) {
                        genericRequest('DeleteWildcard', { card: model.data.name }, data => {
                            wildcardsBrowser.browser.refresh();
                        });
                    }
                    // TODO: Only ask once for the multi-set rather than once per each
                }, can_multi: true });
            }
            let raw = model.data.raw;
            detail_list.push(escapeHtml(raw).trim().replaceAll('\n', '').replaceAll('<br>', '<span class="browser-details-list-entry-text-separator">, </span>'));
            description = `<span class="wildcard_title">${escapeHtml(name)}</span><br>${escapeHtml(raw)}`;
            let match = wildcardHelpers.matchWildcard(this.promptBox.value, model.data.name);
            let isSelected = match && match.length > 0;
            let className = isSelected ? 'model-selected' : '';
            let searchable = `${model.data.name}, ${name}, ${raw}`;
            let result = { name, description, buttons, className, searchable, 'image': model.data.image, display, detail_list };
            for (let callback of this.modelDescribeCallbacks) {
                callback(result, model);
            }
            return result;
        }
        let isCorrect = this.subType == 'Stable-Diffusion' || isModelArchCorrect(model.data);
        let interject = '';
        if (!isCorrect && this.subType != 'Stable-Diffusion') {
            interject = `<b>(Incompatible with current model!)</b><br>`;
        }
        let searchableAdded = '';
        if (model.data.is_supported_model_format) {
            let getLine = (label, val) => {
                let content = val == null ? '(Unset)' : (label == 'Trigger Phrase' ? this.formatTriggerPhrases(val) : safeHtmlOnly(val));
                return `<b>${label}:</b> <span>${content}</span><br>`;
            };
            let getOptLine = (label, val) => val ? getLine(label, val) : '';
            let helperData = modelsHelpers.getDataFor(this.subType, model.data.name);
            if (this.subType == 'LoRA' || this.subType == 'Stable-Diffusion') {
                if (!helperData?.modelClass?.compatClass?.isAudioModel) {
                    interject += `${getLine("Resolution", `${model.data.standard_width}x${model.data.standard_height}`)}`;
                }
            }
            if (!model.data.local) {
                interject += `<b>(This model is only available on some backends.)</b><br>`;
            }
            searchableAdded = `${display}, ${isStarred ? 'starred' : 'unstarred'}, Title: ${model.data.title}, Resolution: ${model.data.standard_width}x${model.data.standard_height}, Author: ${model.data.author}, Type: ${model.data.class}, Usage Hint: ${model.data.usage_hint}, Trigger Phrase: ${model.data.trigger_phrase}, Description: ${model.data.description}`;
            if (this.subType == 'LoRA') {
                let confinementName = model.data.lora_default_confinement == '' ? '' : loraHelper.confinementNames[model.data.lora_default_confinement];
                interject += `${getOptLine("Default LoRA Weight", model.data.lora_default_weight)}${getOptLine("Default LoRA Confinement", confinementName)}`;
                searchableAdded += `, Default LoRA Weight: ${model.data.lora_default_weight}, Default LoRA Confinement: ${confinementName}`;
            }
            let linkedPresets = modelPresetLinkManager.getLinks(this.subType, model.data.name);
            if (linkedPresets.length > 0) {
                searchableAdded += `, Linked Presets: ${linkedPresets.join(', ')}`;
            }
            description = `<span class="model_filename">${isStarred ? 'Starred: ' : ''}${escapeHtml(display)}</span><br>${getLine("Title", model.data.title)}${getOptLine("Author", model.data.author)}${getLine("Type", model.data.class)}${interject}${getOptLine('Trigger Phrase', model.data.trigger_phrase)}${getOptLine("Linked Presets", linkedPresets.join(', '))}${getOptLine('Usage Hint', model.data.usage_hint)}${getLine("Description", model.data.description)}<br>`;
            let cleanForDetails = (val) => val == null ? '(Unset)' : safeHtmlOnly(val).replaceAll('<br>', '&emsp;');
            detail_list.push(cleanForDetails(model.data.title), cleanForDetails(model.data.class), cleanForDetails(model.data.usage_hint ?? model.data.trigger_phrase), cleanForDetails(model.data.description));
            if (model.data.local && permissions.hasPermission('edit_model_metadata')) {
                buttons.push({ label: 'Edit Metadata', onclick: () => editModel(model.data, this) });
                buttons.push({ label: 'View Raw Header', onclick: () => viewRawHeader(model.data, this) });
            }
            if (model.data.local && permissions.hasPermission('delete_models')) {
                buttons.push({ label: 'Delete Model', onclick: () => deleteModel(model.data, this), can_multi: true });
            }
            if (model.data.local && permissions.hasPermission('delete_models')) {
                buttons.push({ label: 'Rename Model', onclick: () => renameModel(model.data, this) });
            }
            if (model.data.local && this.subType == 'Stable-Diffusion' && !model.data.name.endsWith('.engine') && permissions.hasPermission('create_tensorrt')) {
                buttons.push({ label: 'Create TensorRT Engine', onclick: () => showTrtMenu(model.data) });
            }
        }
        else {
            description = `${escapeHtml(name)}<br>(Metadata only available for 'safetensors' models.)<br><b>WARNING:</b> 'ckpt' pickle files can contain malicious code! Use with caution.<br>`;
            detail_list.push(`(Metadata only available for 'safetensors' models.)`, `<b>WARNING:</b> 'ckpt' pickle files can contain malicious code! Use with caution.`);
        }
        let className = this.getClassFor(model, isCorrect);
        let searchable = `${model.data.name}, ${searchableAdded}, ${model.data.license}, ${model.data.architecture||'no-arch'}, ${model.data.usage_hint}, ${model.data.trigger_phrase}, ${model.data.merged_from}, ${model.data.tags}`;
        let result = { name, description, buttons, 'image': model.data.preview_image, className, searchable, display, detail_list };
        for (let callback of this.modelDescribeCallbacks) {
            callback(result, model);
        }
        return result;
    }

    isSelected(name) {
        let selector = 'current_model';
        switch (this.subType) {
            case 'Stable-Diffusion': selector = 'current_model'; break;
            case 'VAE': selector = 'input_vae'; break;
            case 'LoRA': selector = 'input_loras'; break;
            case 'ControlNet': selector = 'input_controlnetmodel'; break;
        }
        let selectorElem = document.getElementById(selector);
        let clean = cleanModelName(name);
        let isSelected;
        if (!selectorElem) {
            isSelected = false;
        }
        else if (this.subType == 'VAE' && !document.getElementById('input_vae_toggle').checked) {
            isSelected = name == 'Automatic';
        }
        else if (this.subType == 'LoRA') {
            isSelected = [...selectorElem.selectedOptions].map(option => option.value).filter(value => value == clean).length > 0;
        }
        else if (this.subType == 'Embedding') {
            isSelected = this.promptBox.value.includes(`<embed:${clean}>`);
            let negativePrompt = document.getElementById('input_negativeprompt');
            if (negativePrompt) {
                isSelected = isSelected || negativePrompt.value.includes(`<embed:${clean}>`);
            }
        }
        else if (this.subType == 'Wildcards') {
            let match = wildcardHelpers.matchWildcard(this.promptBox.value, name);
            isSelected = match && match.length > 0;
        }
        else {
            isSelected = selectorElem.value == clean;
        }
        return isSelected;
    }

    getClassFor(model, isCorrect) {
        let isSelected = this.isSelected(model.data.name);
        let className = isSelected ? 'model-selected' : (model.data.loaded ? 'model-loaded' : (!isCorrect ? 'model-unavailable' : ''));
        if (!model.data.local) {
            className += ' model-remote';
        }
        if (this.isStarred(model.data.name)) {
            className += ' model-starred';
        }
        return className;
    }

    rebuildSelectedClasses() {
        if (this.willRebuildSelected || !this.browser.contentDiv) {
            return;
        }
        this.willRebuildSelected = true;
        setTimeout(() => {
            this.willRebuildSelected = false;
            for (let child of this.browser.contentDiv.children) {
                if (child.dataset.name) {
                    let hasSelectedClass = child.classList.contains('model-selected');
                    let isSelected = this.isSelected(child.dataset.name);
                    if (hasSelectedClass == isSelected) {
                        continue;
                    }
                    if (this.isStarred(child.dataset.name)) {
                        child.classList.add('model-starred');
                    }
                    else {
                        child.classList.remove('model-starred');
                    }
                    if (isSelected) {
                        child.classList.add('model-selected');
                        child.classList.remove('model-loaded');
                        child.classList.remove('model-unavailable');
                    }
                    else {
                        child.classList.remove('model-selected');
                        let model = this.models[child.dataset.name];
                        if (!model) {
                            continue;
                        }
                        if (this.subType != 'Wildcards') {
                            if (model.data.loaded) {
                                child.classList.add('model.loaded');
                            }
                            else {
                                let isCorrect = this.subType == 'Stable-Diffusion' || isModelArchCorrect(model.data);
                                if (!isCorrect) {
                                    child.classList.add('model-unavailable');
                                }
                            }
                        }
                    }
                }
            }
        }, 1);
    }

    selectModel(model) {
        this.selectOne(model);
        this.rebuildSelectedClasses();
    }
}

let sdModelBrowser = new ModelBrowserWrapper('Stable-Diffusion', ['', 'inpaint', 'tensorrt', 'depth', 'canny', 'kontext'], 'model_list', 'modelbrowser', (model) => { currentModelHelper.directSetModel(model.data); });
let sdVAEBrowser = new ModelBrowserWrapper('VAE', ['vae'], 'vae_list', 'sdvaebrowser', (vae) => { directSetVae(vae.data); });
let sdLoraBrowser = new ModelBrowserWrapper('LoRA', ['lora', 'lora-depth', 'lora-canny'], 'lora_list', 'sdlorabrowser', (lora) => { loraHelper.selectLora(lora.data); });
let sdEmbedBrowser = new ModelBrowserWrapper('Embedding', ['embedding', 'textual-inversion'], 'embedding_list', 'sdembedbrowser', (embed) => { selectEmbedding(embed.data); });
let sdControlnetBrowser = new ModelBrowserWrapper('ControlNet', ['controlnet', 'control-lora', 'control-diffpatch', 'controlnet-alimamainpaint'], 'controlnet_list', 'sdcontrolnetbrowser', (controlnet) => { setControlNet(controlnet.data); });
let wildcardsBrowser = new ModelBrowserWrapper('Wildcards', [], 'wildcard_list', 'wildcardsbrowser', (wildcard) => { wildcardHelpers.selectWildcard(wildcard.data); }, `<button id="wildcards_list_create_new_button" class="refresh-button" onclick="wildcardHelpers.createNewWildcardButton()">Create New Wildcard</button>`);

let allModelBrowsers = [sdModelBrowser, sdVAEBrowser, sdLoraBrowser, sdEmbedBrowser, sdControlnetBrowser, wildcardsBrowser];
let subModelBrowsers = [sdVAEBrowser, sdLoraBrowser, sdEmbedBrowser, sdControlnetBrowser];

/**
 * Fork-owned. Re-lists the sub-model browsers when the accepted compat classes differ from the ones their last listing used.
 * Applying or removing a Classic preset can change which checkpoint decides the LoRAs, and the LoRA listing filters on that server-side.
 * A browser that was never opened skips the re-list.
 */
function refreshLoraCompatIfChanged() {
    activeModelCompatCache = null;
    let key = acceptedCompatKey();
    if (key == lastAcceptedCompatKey) {
        return;
    }
    lastAcceptedCompatKey = key;
    for (let browser of subModelBrowsers) {
        browser.browser.lightRefresh();
    }
}

function embedClearFromPrompt(model, element) {
    let box = getRequiredElementById(element);
    let chunk = `<embed:${cleanModelName(model.name)}>`;
    box.value = box.value.replace(` ${chunk}`, '').replace(chunk, '').trim();
    triggerChangeFor(box);
    sdEmbedBrowser.rebuildSelectedClasses();
}

function embedAddToPrompt(model, element) {
    let box = getRequiredElementById(element);
    box.value += ` <embed:${cleanModelName(model.name)}>`;
    triggerChangeFor(box);
    sdEmbedBrowser.rebuildSelectedClasses();
}

function selectEmbedding(model) {
    let promptBox = getRequiredElementById(model.is_negative_embedding ? 'alt_negativeprompt_textbox' : 'alt_prompt_textbox');
    let chunk = `<embed:${cleanModelName(model.name)}>`;
    if (promptBox.value.endsWith(chunk)) {
        promptBox.value = promptBox.value.substring(0, promptBox.value.length - chunk.length).trim();
    }
    else {
        promptBox.value += ` ${chunk}`;
    }
    triggerChangeFor(promptBox);
}

let lastPromptForEmbedMonitor = {};

function monitorPromptChangeForEmbed(promptText, type) {
    let last = lastPromptForEmbedMonitor[type];
    if (!last) {
        last = "";
    }
    if (promptText == last) {
        return;
    }
    let countEndsNew = promptText.split(`>`).length - 1;
    let countEndsOld = last.split(`>`).length - 1;
    lastPromptForEmbedMonitor[type] = promptText;
    let countNew = promptText.split(`<embed:`).length - 1;
    let countOld = last.split(`<embed:`).length - 1;
    if (countNew != countOld || (countNew > 0 && countEndsNew != countEndsOld)) {
        sdEmbedBrowser.rebuildSelectedClasses();
    }
    let countNewWc = (promptText.split(`<wildcard`).length - 1) + (promptText.split(`<wc`).length - 1);
    let countOldWc = (last.split(`<wildcard`).length - 1) + (last.split(`<wc`).length - 1);
    if (countNewWc != countOldWc || (countNewWc > 0 && countEndsNew != countEndsOld)) {
        wildcardsBrowser.rebuildSelectedClasses();
    }
}

function setControlNet(model) {
    let input = document.getElementById('input_controlnetmodel');
    if (!input) {
        return;
    }
    forceSetDropdownValue(input, cleanModelName(model.name));
    let group = document.getElementById('input_group_content_controlnet_toggle');
    if (group) {
        group.checked = true;
    }
}

function initialModelListLoad() {
    for (let browser of allModelBrowsers) {
        let pane = browser.browser.container.closest('.genpage-bottom-tab');
        let tab = document.querySelector(`a[href="#${pane?.id}"]`);
        if (tab && !tab.dataset.modelBrowserLoadBound) {
            tab.dataset.modelBrowserLoadBound = 'true';
            tab.addEventListener('click', () => browser.loadIfNeeded());
        }
        if (pane?.classList.contains('show') && pane.classList.contains('active') && tab?.classList.contains('active')) {
            browser.loadIfNeeded();
        }
    }
}

function directSetVae(vae) {
    let toggler = getRequiredElementById('input_vae_toggle');
    if (!vae) {
        toggler.checked = false;
        doToggleEnable('input_vae');
        return;
    }
    forceSetDropdownValue('input_vae', cleanModelName(vae.name));
    toggler.checked = true;
    doToggleEnable('input_vae');
}

function showTrtMenu(model) {
    if (!currentBackendFeatureSet.includes('tensorrt')) {
        getRequiredElementById('tensorrt_mustinstall').style.display = '';
        getRequiredElementById('tensorrt_modal_ready').style.display = 'none';
    }
    else {
        getRequiredElementById('tensorrt_mustinstall').style.display = 'none';
        getRequiredElementById('tensorrt_modal_ready').style.display = '';
    }
    getRequiredElementById('tensorrt_create_result_box').innerText = '';
    let modelSelect = getRequiredElementById('tensorrt_model_select');
    modelSelect.innerHTML = '';
    for (let model of allModels.filter(m => m.endsWith('.safetensors'))) {
        let option = document.createElement('option');
        let clean = cleanModelName(model);
        option.value = clean;
        option.innerText = clean;
        modelSelect.appendChild(option);
    }
    modelSelect.value = cleanModelName(model.name);
    $('#create_tensorrt_modal').modal('show');
}

function trt_modal_create() {
    let modelSelect = getRequiredElementById('tensorrt_model_select');
    let aspectSelect = getRequiredElementById('tensorrt_aspect_ratio');
    let rangeSelect = getRequiredElementById('tensorrt_aspect_range');
    let batchSize = getRequiredElementById('tensorrt_batch_size');
    let maxBatch = getRequiredElementById('tensorrt_max_batch_size');
    let contextLen = getRequiredElementById('tensorrt_context');
    let createButton = getRequiredElementById('trt_create_button');
    let resultBox = getRequiredElementById('tensorrt_create_result_box');
    let data = {
        'model': modelSelect.value,
        'aspect': aspectSelect.value,
        'aspectRange': rangeSelect.value,
        'optBatch': batchSize.value,
        'maxBatch': maxBatch.value,
        'contextLen': contextLen.value
    };
    createButton.disabled = true;
    resultBox.innerText = 'Creating TensorRT engine, please wait...';
    makeWSRequest('DoTensorRTCreateWS', data, data => {
        resultBox.innerText = data.status;
        if (data.complete) {
            setTimeout(() => {
                createButton.disabled = false;
                $('#create_tensorrt_modal').modal('hide');
            }, 2000);
        }
    }, 0, err => {
        createButton.disabled = false;
        resultBox.innerText = `Error: ${err}`;
    });
}

/** Helper class that manages the state of the currently selected model. */
class CurrentModelHelper {
    constructor() {
        this.antiDup = false;
        this.modelSelector = getRequiredElementById('current_model');
        this.curModel = null;
        this.curArch = null;
        this.curCompatClass = null;
        this.curSpecialFormat = null;
        this.curWidth = null;
        this.curHeight = null;
        this.desiredModel = null;
        this.modelSelector.addEventListener('change', () => this.currentModelChanged());
    }

    ensureCurrentModel(callback) {
        if (this.modelSelector.value != '') {
            callback?.();
            return;
        }
        genericRequest('ListLoadedModels', {}, data => {
            if (data.models.length > 0) {
                this.directSetModel(data.models[0]);
            }
            callback?.();
        });
    }

    directSetModel(model) {
        if (!model) {
            return;
        }
        this.antiDup = true;
        let priorModel = this.curModel;
        if (priorModel) {
            modelPresetLinkManager.removePresetsFrom('Stable-Diffusion', priorModel);
        }
        if (model.name) {
            this.curModel = model.name;
            let clean = cleanModelName(model.name);
            forceSetDropdownValue('input_model', clean);
            forceSetDropdownValue('current_model', clean);
            setCookie('selected_model', `${clean},${model.standard_width},${model.standard_height},${model.architecture},${model.compat_class},${model.special_format}`, 90);
            this.curWidth = model.standard_width;
            this.curHeight = model.standard_height;
            this.curArch = model.architecture;
            this.curCompatClass = model.compat_class;
            this.curSpecialFormat = model.special_format;
        }
        else if (model.includes(',')) {
            let [name, width, height, arch, compatClass, specialFormat] = model.split(',');
            forceSetDropdownValue('input_model', name);
            forceSetDropdownValue('current_model', name);
            setCookie('selected_model', `${name},${width},${height},${arch},${compatClass},${specialFormat}`, 90);
            this.curWidth = parseInt(width);
            this.curHeight = parseInt(height);
            this.curArch = arch;
            this.curCompatClass = compatClass;
            this.curSpecialFormat = specialFormat;
            this.curModel = name;
        }
        reviseBackendFeatureSet();
        modelPresetLinkManager.addPresetsFrom('Stable-Diffusion', this.curModel);
        this.getModelParam().dispatchEvent(new Event('change'));
        let aspect = document.getElementById('input_aspectratio');
        if (aspect) {
            aspect.dispatchEvent(new Event('change'));
        }
        sdModelBrowser.rebuildSelectedClasses();
        for (let browser of subModelBrowsers) {
            if (browser.subType != 'Stable-Diffusion') {
                browser.browser.lightRefresh();
            }
        }
        this.antiDup = false;
    }

    updateDesiredModel(callback) {
        if (!this.desiredModel || this.desiredModel == this.curModel) {
            callback?.();
            return;
        }
        let name = this.desiredModel;
        genericRequest('DescribeModel', {'modelName': this.desiredModel}, data => {
            if (name != this.desiredModel) {
                callback?.();
                return;
            }
            this.directSetModel(data.model);
            callback?.();
        }, 0, err => {
            this.antiDup = false;
            console.error('updateDesiredModel', name, err);
            callback?.();
        });
    }

    getModelParam() {
        return document.getElementById('input_model');
    }

    currentModelChanged() {
        if (this.antiDup) {
            return;
        }
        let name = this.modelSelector.value;
        if (name == '') {
            return;
        }
        this.desiredModel = name;
        this.updateDesiredModel();
    }

    doModelInstallRequiredCheck() {
        if ((this.curSpecialFormat == 'bnb_nf4' || this.curSpecialFormat == 'bnb_fp4') && !currentBackendFeatureSet.includes('bnb_nf4') && !localStorage.getItem('hide_bnb_nf4_check')) {
            $('#bnb_nf4_installer').modal('show');
            return true;
        }
        if ((this.curSpecialFormat == 'nunchaku' || this.curSpecialFormat == 'nunchaku-fp4') && !currentBackendFeatureSet.includes('nunchaku') && !localStorage.getItem('hide_nunchaku_check')) {
            $('#nunchaku_installer').modal('show');
            return true;
        }
        let hasGGUFModel = false;
        for (let param of gen_param_types) {
            if (param.type != 'model') {
                continue;
            }
            let modelInput = document.getElementById(`input_${param.id}`);
            if (isParamEnabled(param) && modelInput?.value.endsWith('.gguf')) {
                hasGGUFModel = true;
                break;
            }
        }
        if ((this.curSpecialFormat == 'gguf' || hasGGUFModel) && !currentBackendFeatureSet.includes('gguf') && !localStorage.getItem('hide_gguf_check')) {
            $('#gguf_installer').modal('show');
            return true;
        }
        if (this.curCompatClass == 'pixart-ms-sigma-xl-2' && !currentBackendFeatureSet.includes('extramodelspixart') && !localStorage.getItem('hide_extramodels_check')) {
            $('#extramodels_installer').modal('show');
            return true;
        }
        if (this.curCompatClass == 'nvidia-sana-1600' && !currentBackendFeatureSet.includes('extramodelssana') && !localStorage.getItem('hide_extramodels_check')) {
            $('#extramodels_installer').modal('show');
            return true;
        }
        return false;
    }
}

/** Helper instance that manages the state of the currently selected model. */
let currentModelHelper = new CurrentModelHelper();
