/** MobileEnhancements standalone client - Models tab.
 * Browse checkpoints and LoRAs via ListModels; tap a checkpoint to set it as the generation model, tap a
 * LoRA to add it to the active set. A local card with no real preview and no CivitAI model link in its
 * description exposes Load CivitAI preview: hash lookup, then the first still image (or a video frame)
 * saved through SaveModelPreviewImage. That writes a JPEG beside the model and updates the preview cache
 * only. It does not call EditModelMetadata, so tags and the .swarm.json sidecar stay untouched. */
class MModels {

    constructor() {
        /** Current subtype ('Stable-Diffusion' or 'LoRA'). */
        this.subtype = 'Stable-Diffusion';
        /** Current folder path within the subtype. */
        this.folder = '';
        /** True while a Load CivitAI preview run is in flight, so a second tap does not stack requests. */
        this.civitaiBusy = false;
        /** Current folder's starred-first model rows. */
        this.folderModels = [];
        /** Warning shown when ListModels reports a capped folder result that this tab cannot page. */
        this.folderIncomplete = false;
        /** Server files accumulated for the current folder, before the starred reorder. */
        this.folderServerFiles = [];
        /** Match count reported for the current folder. */
        this.folderTotal = 0;
        /** True when the current LoRA folder still has pages past folderServerFiles. */
        this.folderHasMore = false;
        /** True while renderPage is drawing a search result rather than the open folder. */
        this.showingSearch = false;
        /** Current page in either the folder or global-search result set. */
        this.page = 0;
        /** Monotonic token that invalidates stale folder listing callbacks. */
        this.folderRequestVersion = 0;
        /** Architecture selections are independent for checkpoints and LoRAs. */
        this.architectureFilters = {};
        /** Uncapped name-to-architecture index for the current subtype. */
        this.architectureMap = new Map();
        /** Prevents overlapping writes to SwarmUI's complete favorites dictionary. */
        this.favoriteBusy = false;
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
                this.page = 0;
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
            this.page = 0;
            clearTimeout(this.searchTimer);
            this.searchTimer = setTimeout(() => this.refresh(), 150);
        });
        panel.appendChild(this.search);
        let architectureRow = mUI.el('div', 'm-models-sort');
        this.architectureSelect = document.createElement('select');
        this.architectureSelect.className = 'm-sort-select m-models-architecture';
        this.architectureSelect.setAttribute('aria-label', 'Architecture');
        this.architectureSelect.addEventListener('change', () => {
            this.architectureFilters[this.subtype] = this.architectureSelect.value;
            this.page = 0;
            this.refresh();
        });
        architectureRow.appendChild(this.architectureSelect);
        panel.appendChild(architectureRow);
        this.sortRow = mUI.el('div', 'm-models-sort');
        this.sortSelect = document.createElement('select');
        this.sortSelect.className = 'm-sort-select';
        this.sortSelect.setAttribute('aria-label', 'Sort Models');
        for (let entry of MModels.SortModes) {
            let option = document.createElement('option');
            option.value = entry[0];
            option.textContent = entry[1];
            this.sortSelect.appendChild(option);
        }
        this.sortSelect.addEventListener('change', () => {
            this.saveSortSetting(this.sortSelect.value, this.sortReverse.classList.contains('m-selected'));
            this.page = 0;
            this.refresh();
        });
        this.sortReverse = mUI.el('button', 'm-models-sort-reverse', 'Reverse');
        this.sortReverse.type = 'button';
        this.sortReverse.addEventListener('click', () => {
            let selected = !this.sortReverse.classList.contains('m-selected');
            this.sortReverse.classList.toggle('m-selected', selected);
            this.sortReverse.setAttribute('aria-pressed', selected ? 'true' : 'false');
            this.saveSortSetting(this.sortSelect.value, selected);
            this.page = 0;
            this.refresh();
        });
        this.sortRow.appendChild(this.sortSelect);
        this.sortRow.appendChild(this.sortReverse);
        panel.appendChild(this.sortRow);
        this.breadcrumb = mUI.el('div', 'm-model-breadcrumb');
        panel.appendChild(this.breadcrumb);
        this.folderChips = mUI.el('div', 'm-folder-chips');
        panel.appendChild(this.folderChips);
        this.grid = mUI.el('div', 'm-model-grid');
        panel.appendChild(this.grid);
        this.pager = mUI.el('div', 'm-pagination');
        this.prevPage = mUI.el('button', 'm-pagination-button', 'Previous');
        this.nextPage = mUI.el('button', 'm-pagination-button', 'Next');
        this.pageStatus = mUI.el('span', 'm-pagination-status');
        this.prevPage.addEventListener('click', () => this.changePage(-1));
        this.nextPage.addEventListener('click', () => this.changePage(1));
        this.pager.appendChild(this.prevPage);
        this.pager.appendChild(this.pageStatus);
        this.pager.appendChild(this.nextPage);
        panel.appendChild(this.pager);
        this.panel = panel;
        mState.onChange(() => {
            if (this.architectureInventory != mState.models || this.architectureClasses != mState.modelClasses) {
                this.updateArchitectures();
            }
            this.updateFavoriteButtons();
        });
    }

    /** Every activation: fetch fresh (models change rarely; the call is cheap at depth 1). */
    onShow() {
        mState.refreshUserData();
        this.refresh();
    }

    /** Reflects confirmed SwarmUI favorites on the visible card buttons. */
    updateFavoriteButtons() {
        for (let button of this.grid.querySelectorAll('.m-model-favorite')) {
            let favorite = mState.isStarred(button.dataset.subtype, button.dataset.model);
            button.textContent = favorite ? '\u2605' : '\u2606';
            button.setAttribute('aria-pressed', favorite ? 'true' : 'false');
            button.setAttribute('aria-label', favorite ? 'Remove Favorite' : 'Add Favorite');
            button.title = favorite ? 'Remove favorite' : 'Add favorite';
            button.disabled = this.favoriteBusy;
        }
    }

    /** Reads the latest complete dictionary before saving through Classic's favorites API. */
    toggleFavorite(subtype, name) {
        if (this.favoriteBusy) {
            return;
        }
        let favorite = !mState.isStarred(subtype, name);
        this.favoriteBusy = true;
        this.updateFavoriteButtons();
        let fail = err => {
            this.favoriteBusy = false;
            this.updateFavoriteButtons();
            mUI.warn(`Could not save favorite: ${err || 'request failed'}`);
        };
        genericRequest('GetMyUserData', { 'includeAutocompletions': false }, data => {
            let favorites = data.starred_models || {};
            let names = (favorites[subtype] || []).filter(entry => MState.starKey(entry) != MState.starKey(name));
            if (favorite) {
                names.push(name);
            }
            if (names.length > 0) {
                favorites[subtype] = names;
            }
            else {
                delete favorites[subtype];
            }
            genericRequest('SetStarredModels', favorites, () => {
                this.favoriteBusy = false;
                mState.starredModels = favorites;
                mState.changed();
                this.updateFavoriteButtons();
                this.refresh();
            }, 0, fail);
        }, 0, fail);
    }

    /** Fetches and renders the current folder. */
    refresh() {
        this.invalidateFolderRender();
        for (let btn of this.toggle.querySelectorAll('.m-seg-button')) {
            btn.classList.toggle('m-selected', btn.dataset.subtype == this.subtype);
        }
        let isLora = this.subtype == 'LoRA';
        if (!isLora && mCreate.cancelLoraMetaScope) {
            mCreate.cancelLoraMetaScope('models-lora');
        }
        let sort = this.sortSetting();
        this.sortSelect.value = sort.mode;
        this.sortReverse.classList.toggle('m-selected', sort.reverse);
        this.sortReverse.setAttribute('aria-pressed', sort.reverse ? 'true' : 'false');
        this.search.placeholder = isLora ? 'Search all LoRAs' : 'Search all checkpoints';
        this.updateArchitectures();
        if (this.search.value.trim() || this.architectureFilters[this.subtype]) {
            this.breadcrumb.style.display = 'none';
            this.renderSearch();
            return;
        }
        this.breadcrumb.style.display = '';
        this.folderChips.style.display = '';
        this.grid.innerHTML = '';
        this.grid.appendChild(mUI.el('div', 'm-strip-empty', 'Loading...'));
        let version = this.folderRequestVersion;
        if (isLora && mCreate.enrichLoraFolder) {
            mCreate.enrichLoraFolder(this.folder, sort, 0, (failed, error, data) => {
                if (version != this.folderRequestVersion) {
                    return;
                }
                if (failed) {
                    mUI.warn(`Could not list models: ${error}`);
                    return;
                }
                this.applyFolderResult(data || {});
            });
            return;
        }
        genericRequest('ListModels', { 'path': this.folder, 'depth': 1, 'subtype': this.subtype, 'sortBy': sort.mode, 'allowRemote': true, 'sortReverse': sort.reverse, 'dataImages': false }, data => {
            if (version != this.folderRequestVersion) {
                return;
            }
            this.applyFolderResult(data || {});
        }, 0, err => {
            if (version != this.folderRequestVersion) {
                return;
            }
            mUI.warn(`Could not list models: ${err}`);
        });
    }

    /** Renders one folder response. LoRA pages that stop early offer Load more; other subtypes keep the cap note. */
    applyFolderResult(data) {
        this.renderFolders(data.folders || []);
        this.grid.innerHTML = '';
        this.showingSearch = false;
        this.folderServerFiles = (data.files || []).slice();
        this.folderTotal = data.total != null ? data.total : this.folderServerFiles.length;
        this.folderHasMore = this.subtype == 'LoRA' && this.folderServerFiles.length < this.folderTotal;
        // Starred first, same as the Create-tab pickers and the genpage's own browsers. The folder result
        // remains complete, then renders in pages: a favourite belongs in the first visible page even
        // when the folder has hundreds of rows.
        this.folderModels = mState.compatFirst(mState.starredFirst(this.folderServerFiles, this.subtype), this.subtype);
        this.updateArchitectures();
        if (this.folderModels.length == 0) {
            this.grid.appendChild(mUI.el('div', 'm-strip-empty', 'No models here.'));
            this.pager.hidden = true;
            return;
        }
        this.folderIncomplete = data.complete === false && !this.folderHasMore;
        this.renderPage();
    }

    /** Appends the next page of the open LoRA folder. */
    loadMoreFolder() {
        if (this.folderMoreBusy || !this.folderHasMore || !mCreate.enrichLoraFolder) {
            return;
        }
        this.folderMoreBusy = true;
        let version = this.folderRequestVersion;
        let sort = this.sortSetting();
        mCreate.enrichLoraFolder(this.folder, sort, this.folderServerFiles.length, (failed, error, data) => {
            this.folderMoreBusy = false;
            if (version != this.folderRequestVersion) {
                return;
            }
            if (failed) {
                mUI.warn(`Could not list models: ${error}`);
                return;
            }
            let seen = {};
            for (let file of this.folderServerFiles) {
                seen[file.name] = true;
            }
            for (let file of ((data && data.files) || [])) {
                if (!seen[file.name]) {
                    this.folderServerFiles.push(file);
                    seen[file.name] = true;
                }
            }
            this.folderTotal = data && data.total != null ? data.total : this.folderTotal;
            this.folderHasMore = this.folderServerFiles.length < this.folderTotal;
            this.folderModels = mState.compatFirst(mState.starredFirst(this.folderServerFiles, this.subtype), this.subtype);
            this.renderPage();
        });
    }

    /** Clears folder-listing state and prevents an older request from changing the current view. */
    invalidateFolderRender() {
        this.folderRequestVersion++;
        this.folderModels = [];
        this.folderIncomplete = false;
        this.folderHasMore = false;
        this.folderServerFiles = [];
        this.pager.hidden = true;
    }

    /** Builds architecture choices from the uncapped inventory and available rich metadata. */
    updateArchitectures() {
        this.architectureInventory = mState.models;
        this.architectureClasses = mState.modelClasses;
        let architectures = new Set();
        this.architectureMap = new Map();
        for (let entry of (mState.models[this.subtype] || [])) {
            let architecture = entry[1] || '__unknown__';
            this.architectureMap.set(MState.stripModelExt(entry[0]), architecture);
            architectures.add(architecture);
        }
        let cached = this.subtype == 'LoRA' ? mCreate.loraList : mCreate.modelList;
        for (let model of [...(cached || []), ...this.folderModels]) {
            architectures.add(this.architectureOf(model));
        }
        let selected = this.architectureFilters[this.subtype] || '';
        if (selected) {
            architectures.add(selected);
        }
        let label = architecture => architecture == '__unknown__' ? 'Unknown' : (mState.modelClasses[architecture] || {}).name || architecture;
        this.architectureSelect.innerHTML = '';
        let all = document.createElement('option');
        all.value = '';
        all.textContent = 'All Architectures';
        this.architectureSelect.appendChild(all);
        for (let architecture of [...architectures].sort((a, b) => label(a).localeCompare(label(b)))) {
            let option = document.createElement('option');
            option.value = architecture;
            option.textContent = label(architecture);
            this.architectureSelect.appendChild(option);
        }
        this.architectureSelect.value = selected;
    }

    /** Uses rich metadata first, then the boot inventory for LoRA rows awaiting enrichment. */
    architectureOf(model) {
        return model.architecture || this.architectureMap.get(MState.stripModelExt(model.name)) || '__unknown__';
    }

    /** Number of cards on one explicit page. */
    static PageSize = 48;

    /** Sort choices shared with Classic. */
    static SortModes = [['Name', 'Name'], ['Title', 'Title'], ['DateCreated', 'Date Created'], ['DateModified', 'Date Modified']];

    /** Reads the current subtype's Classic-compatible sort setting. */
    sortSetting() {
        let mode = 'Name';
        let reverse = false;
        try {
            let stored = localStorage.getItem(`models_${this.subtype}_sort_by`);
            if (MModels.SortModes.some(entry => entry[0] == stored)) {
                mode = stored;
            }
            reverse = localStorage.getItem(`models_${this.subtype}_sort_reverse`) == 'true';
        }
        catch (e) { /* storage can be unavailable */ }
        return { 'mode': mode, 'reverse': reverse };
    }

    /** Saves the same keys Classic reads. */
    saveSortSetting(mode, reverse) {
        try {
            localStorage.setItem(`models_${this.subtype}_sort_by`, mode);
            localStorage.setItem(`models_${this.subtype}_sort_reverse`, reverse ? 'true' : 'false');
        }
        catch (e) { /* storage can be unavailable */ }
    }

    /** Renders one complete page and updates the explicit controls. */
    renderPage(models = this.folderModels) {
        let pages = Math.max(1, Math.ceil(models.length / MModels.PageSize));
        this.page = Math.min(this.page, pages - 1);
        this.grid.innerHTML = '';
        let start = this.page * MModels.PageSize;
        let end = Math.min(start + MModels.PageSize, models.length);
        for (let i = start; i < end; i++) {
            this.grid.appendChild(this.buildCard(models[i]));
        }
        if (!this.showingSearch && this.folderHasMore) {
            let more = mUI.el('div', 'm-models-search-count m-list-count', `Showing ${this.folderServerFiles.length} of ${this.folderTotal} - search or open a subfolder to see more`);
            let button = mUI.el('button', 'm-model-plain-row', 'Load more');
            button.type = 'button';
            button.addEventListener('click', () => this.loadMoreFolder());
            more.appendChild(button);
            this.grid.appendChild(more);
        }
        else if (!this.showingSearch && this.folderIncomplete) {
            this.grid.appendChild(mUI.el('div', 'm-models-search-count m-list-count', 'The server capped this folder listing. Search or open a narrower folder to find more models.'));
        }
        this.pager.hidden = models.length <= MModels.PageSize;
        this.prevPage.disabled = this.page == 0;
        this.nextPage.disabled = this.page >= pages - 1;
        this.pageStatus.textContent = `Page ${this.page + 1} of ${pages} · ${models.length}`;
        this.pageModels = models;
        if (this.subtype == 'LoRA' && mCreate.ensureLoraMetadata) {
            let visible = [];
            for (let n = start; n < end; n++) {
                visible.push(models[n]);
            }
            mCreate.ensureLoraMetadata(visible, () => {
                if (this.subtype != 'LoRA' || !this.grid || !this.grid.isConnected) {
                    return;
                }
                mCreate.paintLoraMetadataRows(this.grid, '.m-model-card', {
                    'thumbClass': null,
                    'preferTitle': true,
                    'expandable': true,
                    'placeholderClass': 'm-model-card-placeholder',
                    'onTrigger': trigger => mCreate.insertTriggerPhrase(trigger),
                    'after': (row, model) => {
                        let civit = row.querySelector('.m-model-civitai-btn');
                        if (civit && !this.shouldOfferCivitaiPreview(model)) {
                            civit.remove();
                        }
                        let title = [model.title, model.name, model.author, model.trigger_phrase].filter(Boolean).join('\n');
                        row.title = title;
                        row.setAttribute('aria-label', title.replaceAll('\n', '. '));
                    }
                });
                this.scheduleTriggerFit();
            }, 'models-lora');
        }
    }

    /** Moves one page without issuing another request. */
    changePage(delta) {
        this.page = Math.max(0, this.page + delta);
        this.renderPage(this.pageModels || this.folderModels);
        this.sortRow.scrollIntoView({ 'block': 'start' });
    }

    /** Search results across every folder of the current subtype. The lists are loaded on first search and
     * cached on mCreate, which the pickers share; explicit pages keep every cached match reachable. */
    renderSearch() {
        this.paintSearch();
        let term = `${this.search.value || ''}`.trim();
        if (this.subtype == 'LoRA' && term && mCreate.searchLoraMetadata) {
            mCreate.searchLoraMetadata(term, () => {
                if (`${this.search.value || ''}`.trim().toLowerCase() != term.toLowerCase()) {
                    return;
                }
                this.paintSearch();
            });
        }
    }

    /** Draws the current search from the local corpus. Does not fetch. */
    paintSearch() {
        this.folderChips.style.display = 'none';
        this.grid.innerHTML = '';
        this.showingSearch = true;
        let isLora = this.subtype == 'LoRA';
        let list = isLora ? mCreate.loraList : mCreate.modelList;
        if (!list) {
            this.grid.appendChild(mUI.el('div', 'm-strip-empty', 'Loading...'));
            this.loadSearchList();
            return;
        }
        let architecture = this.architectureFilters[this.subtype];
        let matches = MCreate.filterModels(list, this.search.value);
        if (architecture) {
            matches = matches.filter(model => this.architectureOf(model) == architecture);
        }
        matches = mState.compatFirst(mState.starredFirst(MCreate.sortModels(matches, this.sortSetting()), this.subtype), this.subtype);
        this.renderPage(matches);
        let count = mCreate.buildCountRow(matches.length, matches.length, isLora ? 'LoRAs' : 'checkpoints');
        count.classList.add('m-models-search-count');
        this.grid.appendChild(count);
    }

    /** Loads the list the current search needs, once, then redraws if the search is still showing. */
    loadSearchList() {
        let redraw = () => {
            if (this.search.value.trim() || this.architectureFilters[this.subtype]) {
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
        this.breadcrumb.innerHTML = '';
        if (this.folder != '') {
            let up = mUI.el('button', 'm-folder-chip m-folder-up', '\u2190');
            up.addEventListener('click', () => {
                this.folder = this.folder.includes('/') ? this.folder.substring(0, this.folder.lastIndexOf('/')) : '';
                this.page = 0;
                this.refresh();
            });
            this.breadcrumb.appendChild(up);
            this.breadcrumb.appendChild(mUI.el('span', 'm-folder-current', this.folder));
        }
        for (let folder of folders) {
            let chip = mUI.el('button', 'm-folder-chip', folder);
            chip.addEventListener('click', () => {
                this.folder = this.folder == '' ? folder : `${this.folder}/${folder}`;
                this.page = 0;
                this.refresh();
            });
            this.folderChips.appendChild(chip);
        }
    }

    /** SaveModelPreviewImage / ForwardMetadataRequest / GetModelHash share edit_model_metadata. Fail open before the
     * session lands (same pattern as presets/restart), so a slow boot does not hide the button forever. */
    canEditMetadata() {
        return typeof permissions == 'undefined' || !permissions.hasPermission
            || permissions.hasPermission('edit_model_metadata');
    }

    /** SwarmUI's generic model image. A card still showing this has no real preview. */
    static PlaceholderPreview = 'imgs/model_placeholder.jpg';

    /** True when preview_image is a saved or served image, not blank and not the generic placeholder. */
    hasRealPreview(model) {
        let preview = `${model.preview_image || ''}`.trim();
        if (!preview) {
            return false;
        }
        let path = preview.split('?')[0].split('#')[0].replace(/\\/g, '/');
        if (path == MModels.PlaceholderPreview || path.endsWith(`/${MModels.PlaceholderPreview}`) || path.endsWith('/model_placeholder.jpg')) {
            return false;
        }
        return true;
    }

    /** Load CivitAI preview is only for a local card that still needs an image.
     * Hidden when a real preview is already present, or when the description already holds a CivitAI model
     * link (the same link guessCivitUrl reads). A trigger phrase, title, or author does not hide it: those
     * often ship in the file, and the button only saves a preview. There is no card details sheet, so a
     * card that already has a preview or that link does not grow a second control. */
    shouldOfferCivitaiPreview(model) {
        if (model.local === false || !this.canEditMetadata()) {
            return false;
        }
        if (this.hasRealPreview(model) || this.guessCivitUrl(model)) {
            return false;
        }
        return true;
    }

    /** One model card: preview, heading, subtitle, trigger phrase; tap = select (checkpoint) or add (LoRA).
     * Checkpoints stay file-name first; LoRAs prefer the metadata title - see mUI.modelLines.
     * Local models that still need a preview get Load CivitAI preview (stopPropagation so it does not select/add). */
    buildCard(model) {
        let card = mUI.el('div', 'm-model-card');
        card.tabIndex = 0;
        card.setAttribute('role', 'button');
        if (this.subtype == 'LoRA') {
            card.dataset.loraName = model.name;
            if (mCreate.loraMetadataKnown && mCreate.loraMetadataKnown(model)) {
                card.dataset.loraMetaRev = `${model._mMetaRev || 0}`;
            }
        }
        let thumb = mUI.modelThumb(model, null);
        if (thumb) {
            card.appendChild(thumb);
        }
        else {
            card.appendChild(mUI.el('div', 'm-model-card-placeholder', 'No Preview'));
        }
        card.title = [model.title, model.name, model.author, model.trigger_phrase].filter(Boolean).join('\n');
        card.setAttribute('aria-label', card.title.replace(/\n/g, '. '));
        if (!mState.rowMatchesActive(model, this.subtype)) {
            card.classList.add('m-model-unavailable');
            card.title = `${card.title}\nIncompatible with current model`;
            card.setAttribute('aria-label', `${card.getAttribute('aria-label')}. Incompatible with current model`);
        }
        let subtype = this.subtype;
        let favorite = mState.isStarred(subtype, model.name);
        let star = mUI.el('button', 'm-model-favorite', favorite ? '\u2605' : '\u2606');
        star.type = 'button';
        star.dataset.subtype = subtype;
        star.dataset.model = model.name;
        star.setAttribute('aria-pressed', favorite ? 'true' : 'false');
        star.setAttribute('aria-label', favorite ? 'Remove Favorite' : 'Add Favorite');
        star.title = favorite ? 'Remove favorite' : 'Add favorite';
        star.disabled = this.favoriteBusy;
        star.addEventListener('click', e => {
            e.stopPropagation();
            this.toggleFavorite(subtype, model.name);
        });
        card.appendChild(star);
        card.appendChild(mUI.modelText(model, trigger => mCreate.insertTriggerPhrase(trigger), this.subtype == 'LoRA', true));
        if (this.shouldOfferCivitaiPreview(model)) {
            let civitBtn = mUI.el('button', 'm-model-civitai-btn', 'Load CivitAI preview');
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
        if (card.querySelector('.m-trigger-more')) {
            this.scheduleTriggerFit();
        }
        return card;
    }

    /** Coalesces one measurement so more appears only when the two-line clamp still hides text. */
    scheduleTriggerFit() {
        if (this.triggerFitQueued) {
            return;
        }
        this.triggerFitQueued = true;
        requestAnimationFrame(() => {
            this.triggerFitQueued = false;
            this.fitTriggerExpands();
        });
    }

    /** Reveals more on a clamped trigger that still hides text. A shortened preview keeps more. */
    fitTriggerExpands() {
        if (!this.grid) {
            return;
        }
        let rows = this.grid.querySelectorAll('.m-trigger-block');
        for (let i = 0; i < rows.length; i++) {
            let more = rows[i].querySelector('.m-trigger-more');
            let text = rows[i].querySelector('.m-trigger-chip-text');
            if (!more || !text || rows[i].classList.contains('m-trigger-open')) {
                continue;
            }
            if (more.dataset.force == '1') {
                more.hidden = false;
                continue;
            }
            if (text.clientHeight <= 0) {
                continue;
            }
            more.hidden = text.scrollHeight <= text.clientHeight + 1;
        }
    }

    /** Opens the Load CivitAI preview sheet and saves one still image for a local model card. */
    openCivitaiLoad(model) {
        if (this.civitaiBusy) {
            mUI.warn('CivitAI preview load already in progress.');
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
        content.appendChild(mUI.el('div', 'm-sheet-title', 'Load CivitAI preview'));
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

    /** Hash (or description URL) -> version metadata -> first still image or video frame ->
     * SaveModelPreviewImage. setStatus updates the sheet; done(ok, message) finishes. */
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
            this.fetchCivitaiMetadata(id, versId, (metadata, img, errMsg, imageUrl) => {
                if (!metadata) {
                    finishErr(`Failed to load metadata.${errMsg ? ' ' + errMsg : ''}`);
                    return;
                }
                if (!img && !imageUrl) {
                    finishErr('No preview image on CivitAI.');
                    return;
                }
                setStatus('Saving preview...');
                this.saveCivitaiPreview(model, subtype, img, imageUrl, (ok, msg) => {
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

    /** Fetches models/{id}, picks the matching version, and returns the first still-image URL
     * (or a video-frame data URL). Does not write metadata. */
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
            let applyPreview = (img, imageUrl) => callback(metadata, img || '', null, imageUrl || '');
            if (imgs.length > 0) {
                applyPreview('', imgs[0].url);
                return;
            }
            let videos = rawVersion.images ? rawVersion.images.filter(img => img.type == 'video') : [];
            if (videos.length > 0) {
                this.previewFromCivitaiVideo(videos[0].url, (frame) => applyPreview(frame, ''));
                return;
            }
            applyPreview('', '');
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

    /** Writes one preview through SaveModelPreviewImage. image is a data URL (video frame); imageUrl is
     * a still image the server fetches. Never sends title, tags, or other metadata. */
    saveCivitaiPreview(model, subtype, image, imageUrl, done) {
        let payload = { 'model': model.name, 'subtype': subtype };
        if (image) {
            payload['image'] = image;
        }
        else if (imageUrl) {
            payload['url'] = imageUrl;
        }
        else {
            done(false, 'No preview image on CivitAI.');
            return;
        }
        genericRequest('SaveModelPreviewImage', payload, (data) => {
            let preview = data && data.preview_image ? data.preview_image : (image || '');
            this.patchCachedPreview(model.name, subtype, preview);
            done(true, 'CivitAI preview saved.');
        }, 0, err => {
            done(false, `Could not save preview: ${err || 'request failed'}`);
        });
    }

    /** Updates preview_image on the Create-tab picker cache. Leaves title, tags, and description alone. */
    patchCachedPreview(name, subtype, img) {
        if (!img) {
            return;
        }
        let list = subtype == 'LoRA' ? mCreate.loraList : mCreate.modelList;
        if (!list) {
            return;
        }
        let row = list.find(m => MState.sameModel(m.name, name));
        if (row) {
            row.preview_image = img;
        }
    }
}

mModels = new MModels();
