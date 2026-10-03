/** MobileEnhancements standalone client - Models tab.
 * Browse checkpoints and LoRAs via ListModels; tap a checkpoint to set it as the generation model, tap a
 * LoRA to add it to the active set. Local cards also expose Load CivitAI: hash lookup + metadata enrich +
 * save via the same ForwardMetadataRequest / GetModelHash / EditModelMetadata / imageToData path Classic
 * uses, without pulling utiltab.js's ModelDownloader (genpage DOM). */
class MModels {

    constructor() {
        /** Current subtype ('Stable-Diffusion' or 'LoRA'). */
        this.subtype = 'Stable-Diffusion';
        /** Current folder path within the subtype. */
        this.folder = '';
        /** True while a Load CivitAI run is in flight, so a second tap does not stack requests. */
        this.civitaiBusy = false;
        /** Current folder's starred-first model rows. */
        this.folderModels = [];
        /** Number of folder cards currently attached to the DOM. */
        this.folderRendered = 0;
        /** Monotonic token that invalidates stale folder listing callbacks. */
        this.folderRequestVersion = 0;
    }

    /** Builds the Models panel once. */
    build(panel) {
        let toggle = mUI.el('div', 'm-seg-group m-models-toggle');
        for (let [label, sub] of [['Checkpoints', 'Stable-Diffusion'], ['LoRAs', 'LoRA']]) {
            let btn = mUI.el('button', 'm-seg-button', label);
            btn.dataset.subtype = sub;
            btn.addEventListener('click', () => {
                this.subtype = sub;
                this.folder = '';
                this.refresh();
            });
            toggle.appendChild(btn);
        }
        panel.appendChild(toggle);
        this.toggle = toggle;
        // Searches the whole subtype, not the current folder: the point is finding a model without knowing
        // which folder it is in. Reuses the Create-tab picker lists, so both surfaces match the same way.
        this.search = document.createElement('input');
        this.search.type = 'search';
        this.search.className = 'm-lora-search m-models-search';
        this.search.addEventListener('input', () => {
            // The debounce only delays the replacement search. It must not leave the old folder request
            // eligible to repaint the grid during that 150ms window.
            this.invalidateFolderRender();
            this.grid.innerHTML = '';
            clearTimeout(this.searchTimer);
            this.searchTimer = setTimeout(() => this.refresh(), 150);
        });
        panel.appendChild(this.search);
        this.folderChips = mUI.el('div', 'm-folder-chips');
        panel.appendChild(this.folderChips);
        this.grid = mUI.el('div', 'm-model-grid');
        panel.appendChild(this.grid);
        this.folderSentinel = mUI.el('div', 'm-scroll-sentinel');
        panel.appendChild(this.folderSentinel);
        this.folderLoadMore = mUI.el('button', 'm-model-plain-row', 'Load More');
        this.folderLoadMore.type = 'button';
        this.folderLoadMore.hidden = true;
        this.folderLoadMore.addEventListener('click', () => this.renderFolderMore());
        panel.appendChild(this.folderLoadMore);
        this.panel = panel;
        if (typeof IntersectionObserver != 'undefined') {
            this.folderObserver = new IntersectionObserver(entries => {
                if (!this.panel.classList.contains('m-tab-active')) {
                    return;
                }
                for (let entry of entries) {
                    if (entry.isIntersecting) {
                        this.renderFolderMore();
                        return;
                    }
                }
            }, { 'root': panel, 'rootMargin': '100% 0px' });
        }
    }

    /** Every activation: fetch fresh (models change rarely; the call is cheap at depth 1). */
    onShow() {
        this.refresh();
    }

    /** Fetches and renders the current folder. */
    refresh() {
        this.invalidateFolderRender();
        for (let btn of this.toggle.querySelectorAll('.m-seg-button')) {
            btn.classList.toggle('m-selected', btn.dataset.subtype == this.subtype);
        }
        let isLora = this.subtype == 'LoRA';
        this.search.placeholder = isLora ? 'Search all LoRAs' : 'Search all checkpoints';
        if (this.search.value.trim()) {
            this.renderSearch();
            return;
        }
        this.folderChips.style.display = '';
        this.grid.innerHTML = '';
        this.grid.appendChild(mUI.el('div', 'm-strip-empty', 'Loading...'));
        let version = this.folderRequestVersion;
        genericRequest('ListModels', { 'path': this.folder, 'depth': 1, 'subtype': this.subtype, 'sortBy': 'Name', 'allowRemote': true, 'sortReverse': false, 'dataImages': false }, data => {
            if (version != this.folderRequestVersion) {
                return;
            }
            this.renderFolders(data.folders || []);
            this.grid.innerHTML = '';
            // Starred first, same as the Create-tab pickers and the genpage's own browsers. The folder result
            // remains complete, then renders in chunks: a favourite belongs in the first visible chunk even
            // when the folder has hundreds of rows.
            this.folderModels = mState.starredFirst(data.files || [], this.subtype);
            if (this.folderModels.length == 0) {
                this.grid.appendChild(mUI.el('div', 'm-strip-empty', 'No models here.'));
                return;
            }
            this.renderFolderMore();
        }, 0, err => {
            if (version != this.folderRequestVersion) {
                return;
            }
            mUI.warn(`Could not list models: ${err}`);
        });
    }

    /** Clears folder-listing state and prevents an older request from changing the current view. */
    invalidateFolderRender() {
        this.folderRequestVersion++;
        this.folderModels = [];
        this.folderRendered = 0;
        if (this.folderObserver) {
            this.folderObserver.disconnect();
        }
        if (this.folderObserveFrame) {
            cancelAnimationFrame(this.folderObserveFrame);
            this.folderObserveFrame = null;
        }
        if (this.folderLoadMore) {
            this.folderLoadMore.hidden = true;
        }
    }

    /** Renders the next bounded group of folder cards and keeps the sentinel active while rows remain. */
    renderFolderMore() {
        if (!this.folderModels || this.folderRendered >= this.folderModels.length || !this.panel.classList.contains('m-tab-active')) {
            return;
        }
        let target = Math.min(this.folderRendered + MModels.FolderChunkSize, this.folderModels.length);
        let fragment = document.createDocumentFragment();
        for (let i = this.folderRendered; i < target; i++) {
            fragment.appendChild(this.buildCard(this.folderModels[i]));
        }
        this.grid.appendChild(fragment);
        this.folderRendered = target;
        let more = this.folderRendered < this.folderModels.length;
        this.folderLoadMore.hidden = !more;
        if (more && this.folderObserver) {
            this.queueFolderObserve();
        }
        else if (this.folderObserver) {
            this.folderObserver.disconnect();
        }
    }

    /** Re-arms the sentinel after layout so a still-visible sentinel can request another bounded chunk. */
    queueFolderObserve() {
        this.folderObserver.disconnect();
        if (this.folderObserveFrame) {
            cancelAnimationFrame(this.folderObserveFrame);
        }
        this.folderObserveFrame = requestAnimationFrame(() => {
            this.folderObserveFrame = null;
            if (this.panel.classList.contains('m-tab-active') && this.folderRendered < this.folderModels.length) {
                this.folderObserver.observe(this.folderSentinel);
            }
        });
    }

    /** Number of model cards inserted per folder-listing pass. */
    static FolderChunkSize = 40;

    /** Search results across every folder of the current subtype, capped like the Create-tab pickers. The
     * lists are loaded on first search and cached on mCreate, which the pickers share. */
    renderSearch() {
        this.folderChips.style.display = 'none';
        this.grid.innerHTML = '';
        let isLora = this.subtype == 'LoRA';
        let list = isLora ? mCreate.loraList : mCreate.modelList;
        if (!list) {
            this.grid.appendChild(mUI.el('div', 'm-strip-empty', 'Loading...'));
            this.loadSearchList();
            return;
        }
        let matches = mState.starredFirst(MCreate.filterModels(list, this.search.value), this.subtype);
        let shown = 0;
        for (let model of matches) {
            if (shown >= MCreate.ListCap) {
                break;
            }
            this.grid.appendChild(this.buildCard(model));
            shown++;
        }
        let count = mCreate.buildCountRow(shown, matches.length, isLora ? 'LoRAs' : 'checkpoints');
        count.classList.add('m-models-search-count');
        this.grid.appendChild(count);
    }

    /** Loads the list the current search needs, once, then redraws if the search is still showing. */
    loadSearchList() {
        let redraw = () => {
            if (this.search.value.trim()) {
                this.refresh();
            }
        };
        if (this.subtype == 'LoRA') {
            if (this.loadingLoras) {
                return;
            }
            this.loadingLoras = true;
            // The uncapped name list is searchable immediately; titles and triggers fill in as folders land.
            mCreate.indexLoras([]);
            redraw();
            mCreate.enrichLoraMetadata(() => {
                this.loadingLoras = false;
                redraw();
            });
            return;
        }
        if (this.loadingModels) {
            return;
        }
        this.loadingModels = true;
        genericRequest('ListModels', { 'path': '', 'depth': MCreate.ListDepth, 'subtype': 'Stable-Diffusion', 'sortBy': 'Name', 'allowRemote': true, 'sortReverse': false, 'dataImages': false }, data => {
            this.loadingModels = false;
            mCreate.modelList = data.files || [];
            redraw();
        }, 0, err => {
            this.loadingModels = false;
            mUI.warn(`Could not list models: ${err}`);
        });
    }

    /** Folder chips with a back chip when nested. */
    renderFolders(folders) {
        this.folderChips.innerHTML = '';
        if (this.folder != '') {
            let up = mUI.el('button', 'm-folder-chip m-folder-up', '\u2190');
            up.addEventListener('click', () => {
                this.folder = this.folder.includes('/') ? this.folder.substring(0, this.folder.lastIndexOf('/')) : '';
                this.refresh();
            });
            this.folderChips.appendChild(up);
            this.folderChips.appendChild(mUI.el('span', 'm-folder-current', this.folder));
        }
        for (let folder of folders) {
            let chip = mUI.el('button', 'm-folder-chip', folder);
            chip.addEventListener('click', () => {
                this.folder = this.folder == '' ? folder : `${this.folder}/${folder}`;
                this.refresh();
            });
            this.folderChips.appendChild(chip);
        }
    }

    /** EditModelMetadata / ForwardMetadataRequest / GetModelHash share this permission. Fail open before the
     * session lands (same pattern as presets/restart), so a slow boot does not hide the button forever. */
    canEditMetadata() {
        return typeof permissions == 'undefined' || !permissions.hasPermission
            || permissions.hasPermission('edit_model_metadata');
    }

    /** One model card: preview, heading, subtitle, trigger phrase; tap = select (checkpoint) or add (LoRA).
     * Checkpoints stay file-name first; LoRAs prefer the metadata title - see mUI.modelLines.
     * Local models with edit permission also get Load CivitAI (stopPropagation so it does not select/add). */
    buildCard(model) {
        let card = mUI.el('div', 'm-model-card');
        card.tabIndex = 0;
        card.setAttribute('role', 'button');
        let thumb = mUI.modelThumb(model, null);
        if (thumb) {
            card.appendChild(thumb);
        }
        let star = mUI.starBadge(this.subtype, model.name);
        if (star) {
            // On the card the star is a corner badge over the thumbnail rather than a row item - a card with
            // no preview image has nothing to overlay, so it sits in the corner of the card itself.
            star.classList.add('m-model-star-badge');
            card.appendChild(star);
        }
        card.appendChild(mUI.modelText(model, () => mCreate.insertTriggerTag(), this.subtype == 'LoRA'));
        if (model.local !== false && this.canEditMetadata()) {
            let civitBtn = mUI.el('button', 'm-model-civitai-btn', 'Load CivitAI');
            civitBtn.type = 'button';
            civitBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.openCivitaiLoad(model);
            });
            card.appendChild(civitBtn);
        }
        if (this.subtype == 'Stable-Diffusion' && mState.params['model'] == model.name) {
            card.classList.add('m-selected');
        }
        let activate = () => {
            if (this.subtype == 'Stable-Diffusion') {
                mState.params['model'] = model.name;
                mState.changed();
                mUI.note(`Model set: ${mUI.modelName(model.name)}`);
                for (let other of this.grid.querySelectorAll('.m-model-card')) {
                    other.classList.remove('m-selected');
                }
                card.classList.add('m-selected');
            }
            else {
                let cur = mState.getLoras();
                if (!cur.some(l => MState.sameModel(l.name, model.name))) {
                    cur.push({ 'name': model.name, 'weight': model.lora_default_weight || 1 });
                    mState.setLoras(cur);
                }
                mUI.note(`LoRA added: ${mUI.modelLines(model, true).primary}`);
            }
        };
        card.addEventListener('click', e => {
            if (e.target.closest('button, a, input, select, textarea')) {
                return;
            }
            activate();
        });
        card.addEventListener('keydown', e => {
            if (e.target == card && (e.key == 'Enter' || e.key == ' ')) {
                e.preventDefault();
                activate();
            }
        });
        return card;
    }

    /** Opens the Load CivitAI progress sheet and starts enrich+save for one local model card. */
    openCivitaiLoad(model) {
        if (this.civitaiBusy) {
            mUI.warn('CivitAI load already in progress.');
            return;
        }
        if (!this.canEditMetadata()) {
            mUI.warn('You do not have permission to edit model metadata.');
            return;
        }
        if (model.local === false) {
            mUI.warn('Remote models cannot be edited here.');
            return;
        }
        let content = mUI.el('div', 'm-model-civitai-sheet');
        content.appendChild(mUI.el('div', 'm-sheet-title', 'Load CivitAI'));
        content.appendChild(mUI.el('div', 'm-model-civitai-name', mUI.modelLines(model, this.subtype == 'LoRA').primary));
        let status = mUI.el('div', 'm-model-civitai-status', 'Starting...');
        content.appendChild(status);
        let actions = mUI.el('div', 'm-edit-actions');
        let closeBtn = mUI.el('button', 'm-edit-cancel-button', 'Close');
        closeBtn.type = 'button';
        actions.appendChild(closeBtn);
        content.appendChild(actions);
        let close = mUI.openSheet(content);
        closeBtn.addEventListener('click', () => close());
        let setStatus = (text) => { status.textContent = text; };
        this.civitaiBusy = true;
        this.runCivitaiLoad(model, setStatus, (ok, message) => {
            this.civitaiBusy = false;
            setStatus(message);
            if (ok) {
                mUI.note(message);
                close();
                this.refresh();
            }
            else {
                mUI.warn(message);
            }
        });
    }

    /** Classic Load CivitAI pipeline, auto-saved: hash (or description URL) -> ForwardMetadataRequest ->
     * preview via imageToData -> EditModelMetadata. setStatus updates the sheet; done(ok, message) finishes. */
    runCivitaiLoad(model, setStatus, done) {
        let subtype = this.subtype;
        let finishErr = (msg) => done(false, msg);
        let afterUrl = (civitUrl) => {
            if (!civitUrl) {
                finishErr('No CivitAI match for this model hash.');
                return;
            }
            setStatus('Loading metadata from CivitAI...');
            let [id, versId] = this.parseCivitaiUrl(civitUrl);
            if (!id && !versId) {
                finishErr('Invalid CivitAI URL.');
                return;
            }
            this.fetchCivitaiMetadata(id, versId, (metadata, img, errMsg) => {
                if (!metadata) {
                    finishErr(`Failed to load metadata.${errMsg ? ' ' + errMsg : ''}`);
                    return;
                }
                setStatus(img ? 'Saving metadata and preview...' : 'Saving metadata...');
                this.saveCivitaiMetadata(model, subtype, metadata, img, (ok, msg) => {
                    if (ok) {
                        this.patchCachedModel(model.name, subtype, metadata, img);
                    }
                    done(ok, msg);
                });
            });
        };
        let urlGuess = this.guessCivitUrl(model);
        if (urlGuess) {
            setStatus('Using CivitAI URL from description...');
            afterUrl(urlGuess);
            return;
        }
        let withHash = (hash) => {
            if (!hash) {
                finishErr('Could not get a hash for this model.');
                return;
            }
            model.hash = hash;
            setStatus('Searching CivitAI by hash...');
            this.searchCivitaiForHash(hash, afterUrl);
        };
        if (model.hash) {
            withHash(model.hash);
            return;
        }
        setStatus('Computing hash...');
        genericRequest('GetModelHash', { 'modelName': model.name, 'subtype': subtype }, data => {
            withHash(data.hash);
        }, 0, err => {
            finishErr(`Could not get hash: ${err || 'request failed'}`);
        });
    }

    /** Same guess Classic edit-metadata uses: first civitai.red / civitai.com models link in description. */
    guessCivitUrl(model) {
        let description = model.description || '';
        let civitUrlStartIndex = description.indexOf('<a href="https://civitai.red/models/');
        let prefixLen = '<a href="'.length;
        if (civitUrlStartIndex < 0) {
            civitUrlStartIndex = description.indexOf('<a href="https://civitai.com/models/');
        }
        if (civitUrlStartIndex < 0) {
            return '';
        }
        let start = civitUrlStartIndex + prefixLen;
        let end = description.indexOf('"', start);
        if (end < 0) {
            return '';
        }
        let civitUrl = description.substring(start, end);
        if (civitUrl.startsWith('https://civitai.com/')) {
            civitUrl = `https://civitai.red/${civitUrl.substring('https://civitai.com/'.length)}`;
        }
        if (!civitUrl.startsWith('https://civitai.red/models/')) {
            return '';
        }
        return civitUrl;
    }

    /** Hash -> civitai.red model URL, or null. Same ForwardMetadataRequest by-hash route Classic uses. */
    searchCivitaiForHash(hash, callback) {
        if (hash.startsWith('0x')) {
            hash = hash.substring(2);
        }
        hash = hash.substring(0, 12);
        genericRequest('ForwardMetadataRequest', { 'url': `https://civitai.red/api/v1/model-versions/by-hash/${hash}` }, (rawData) => {
            if (!rawData.response || rawData.response['error']) {
                callback(null);
                return;
            }
            callback(`https://civitai.red/models/${rawData.response.modelId}?modelVersionId=${rawData.response.id}`);
        }, 0, () => {
            callback(null);
        });
    }

    /** Parses model id + version id from a civitai.red / civitai.com models URL. */
    parseCivitaiUrl(url) {
        url = (url || '').trim();
        if (url.startsWith('https://civitai.com/')) {
            url = `https://civitai.red/${url.substring('https://civitai.com/'.length)}`;
        }
        if (url.startsWith('https://civitai.green/')) {
            url = `https://civitai.red/${url.substring('https://civitai.green/'.length)}`;
        }
        let prefix = 'https://civitai.red/';
        if (!url.startsWith(prefix)) {
            return [null, null];
        }
        let rest = url.substring(prefix.length);
        let parts = typeof splitWithTail == 'function' ? splitWithTail(rest, '/', 4) : rest.split('/');
        if (parts.length >= 2 && parts[0] == 'models') {
            let idPart = parts[1];
            let q = idPart.indexOf('?');
            if (q >= 0) {
                let id = idPart.substring(0, q);
                let query = idPart.substring(q + 1);
                let versMatch = query.match(/(?:^|&)modelVersionId=([^&]+)/);
                return [id, versMatch ? versMatch[1] : null];
            }
            if (parts.length >= 3 && parts[2].startsWith('?')) {
                let versMatch = parts[2].substring(1).match(/(?:^|&)modelVersionId=([^&]+)/);
                return [idPart, versMatch ? versMatch[1] : null];
            }
            if (parts.length >= 3) {
                let sub = typeof splitWithTail == 'function' ? splitWithTail(parts[2], '?modelVersionId=', 2) : parts[2].split('?modelVersionId=');
                if (sub.length == 2) {
                    return [idPart, sub[1]];
                }
            }
            return [idPart, null];
        }
        return [null, null];
    }

    /** Fetches models/{id}, picks the matching version, builds modelspec.* fields, and loads the face/preview
     * image (or a video frame) through imageToData / ForwardImageRequest - same serverside proxies Classic uses. */
    fetchCivitaiMetadata(id, versId, callback) {
        let doError = (msg) => callback(null, null, msg);
        let loadByVersOnly = () => {
            genericRequest('ForwardMetadataRequest', { 'url': `https://civitai.red/api/v1/model-versions/${versId}` }, (rawData) => {
                let vers = rawData.response;
                if (!vers || !vers.modelId) {
                    doError();
                    return;
                }
                this.fetchCivitaiMetadata(vers.modelId, versId, callback);
            }, 0, () => doError());
        };
        if (!id && versId) {
            loadByVersOnly();
            return;
        }
        genericRequest('ForwardMetadataRequest', { 'url': `https://civitai.red/api/v1/models/${id}` }, (rawWrap) => {
            let rawData = rawWrap.response;
            if (!rawData || !rawData.modelVersions || !rawData.modelVersions.length) {
                doError();
                return;
            }
            let rawVersion = rawData.modelVersions[0];
            if (versId) {
                let matched = rawData.modelVersions.find(v => String(v.id) == String(versId));
                if (matched) {
                    rawVersion = matched;
                }
            }
            let url = versId
                ? `https://civitai.red/models/${id}?modelVersionId=${versId}`
                : `https://civitai.red/models/${id}`;
            let metadata = {
                'modelspec.title': `${rawData.name} - ${rawVersion.name}`,
                'modelspec.description': `From <a href="${url}" target="_blank">${url}</a>\n${rawVersion.description || ''}\n${rawData.description || ''}\n`,
                'modelspec.date': rawVersion.createdAt || ''
            };
            if (rawData.creator && rawData.creator.username) {
                metadata['modelspec.author'] = rawData.creator.username;
            }
            if (rawVersion.trainedWords && rawVersion.trainedWords.length) {
                metadata['modelspec.trigger_phrase'] = rawVersion.trainedWords.join('; ');
            }
            if (rawData.tags && rawData.tags.length) {
                metadata['modelspec.tags'] = rawData.tags.join(', ');
            }
            if (['Illustrious', 'Pony', 'NoobAI', 'Anima'].includes(rawVersion.baseModel)) {
                metadata['modelspec.usage_hint'] = rawVersion.baseModel;
            }
            let imgs = rawVersion.images ? rawVersion.images.filter(img => img.type == 'image') : [];
            let applyPreview = (img) => callback(metadata, img || '', null);
            if (imgs.length > 0) {
                imageToData(imgs[0].url, applyPreview, true);
                return;
            }
            let videos = rawVersion.images ? rawVersion.images.filter(img => img.type == 'video') : [];
            if (videos.length > 0) {
                this.previewFromCivitaiVideo(videos[0].url, applyPreview);
                return;
            }
            applyPreview('');
        }, 0, () => doError());
    }

    /** Grabs one frame from a CivitAI preview video via ForwardImageRequest (CORS-safe), matching Classic. */
    previewFromCivitaiVideo(url, done) {
        genericRequest('ForwardImageRequest', { 'url': url }, (data) => {
            if (!data.image) {
                done('');
                return;
            }
            let video = document.createElement('video');
            video.crossOrigin = 'Anonymous';
            video.preload = 'auto';
            video.onloadedmetadata = () => { video.currentTime = 0.001; };
            video.onseeked = () => {
                let canvas = document.createElement('canvas');
                canvas.width = video.videoWidth;
                canvas.height = video.videoHeight;
                canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
                done(canvas.toDataURL());
            };
            video.onerror = () => done('');
            video.src = data.image;
        }, 0, () => done(''));
    }

    /** Writes CivitAI fields through EditModelMetadata; keeps architecture / resolution / license / LoRA
     * defaults the card already had. preview_image is only set when a face/preview was pulled. */
    saveCivitaiMetadata(model, subtype, metadata, img, done) {
        let tags = metadata['modelspec.tags'];
        if (!tags && model.tags) {
            tags = Array.isArray(model.tags) ? model.tags.join(', ') : model.tags;
        }
        let payload = {
            'model': model.name,
            'subtype': subtype,
            'title': metadata['modelspec.title'] || model.title || '',
            'author': metadata['modelspec.author'] || model.author || '',
            'type': model.architecture || '',
            'description': metadata['modelspec.description'] || model.description || '',
            'standard_width': model.standard_width || 0,
            'standard_height': model.standard_height || 0,
            'date': metadata['modelspec.date'] || model.date || '',
            'license': model.license || '',
            'trigger_phrase': metadata['modelspec.trigger_phrase'] || model.trigger_phrase || '',
            'usage_hint': metadata['modelspec.usage_hint'] || model.usage_hint || '',
            'prediction_type': model.prediction_type || '',
            'tags': tags || '',
            'preview_image_metadata': null,
            'is_negative_embedding': !!model.is_negative_embedding,
            'lora_default_weight': model.lora_default_weight || '',
            'lora_default_confinement': model.lora_default_confinement || ''
        };
        if (img) {
            payload['preview_image'] = img;
        }
        genericRequest('EditModelMetadata', payload, () => {
            done(true, 'CivitAI metadata saved.');
        }, 0, err => {
            done(false, `Could not save metadata: ${err || 'request failed'}`);
        });
    }

    /** Keeps Create-tab picker caches in step with the Models-tab save so titles/triggers/previews match. */
    patchCachedModel(name, subtype, metadata, img) {
        let patch = (row) => {
            if (!row) {
                return;
            }
            if (metadata['modelspec.title']) {
                row.title = metadata['modelspec.title'];
            }
            if (metadata['modelspec.author']) {
                row.author = metadata['modelspec.author'];
            }
            if (metadata['modelspec.description']) {
                row.description = metadata['modelspec.description'];
            }
            if (metadata['modelspec.trigger_phrase']) {
                row.trigger_phrase = metadata['modelspec.trigger_phrase'];
            }
            if (metadata['modelspec.usage_hint']) {
                row.usage_hint = metadata['modelspec.usage_hint'];
            }
            if (metadata['modelspec.date']) {
                row.date = metadata['modelspec.date'];
            }
            if (metadata['modelspec.tags']) {
                row.tags = metadata['modelspec.tags'].split(',').map(t => t.trim()).filter(Boolean);
            }
            if (img) {
                row.preview_image = img;
            }
        };
        let list = subtype == 'LoRA' ? mCreate.loraList : mCreate.modelList;
        if (list) {
            patch(list.find(m => MState.sameModel(m.name, name)));
        }
    }
}

mModels = new MModels();
